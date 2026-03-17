import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { TextDecoder } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { maskSecrets } from "./mask.js";
import { ProviderBackupStore } from "./provider-backup.js";
import { getConfiguredSecretBaseUrls } from "./provider-reconcile.js";
import { restoreSecrets } from "./restore.js";
import { SecretRegistry } from "./secret-registry.js";
import { transformProtocolSsePayload } from "./sse/dispatch.js";
import { asRecord, restoreStructuredStrings } from "./sse/helpers.js";
import { createSseSemanticState } from "./sse/state.js";
import { TokenStore } from "./token-store.js";
import { buildUpstreamUrl, stripProviderPrefixFromPath } from "./url-forward.js";

// 代理主链路分两段：请求发出前统一脱敏，响应返回时再按同一批 token 做还原。
// 普通 HTTP 响应会整包处理；SSE 响应则按 event block 增量处理，避免流式输出时把半截 token 提前暴露给客户端。
export type ProxyLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

export type ProxyServerParams = {
  registry: SecretRegistry;
  logger: ProxyLogger;
  originalBaseUrls: Record<string, string>;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const SSE_BLOCK_SEPARATOR_REGEX = /\r?\n\r?\n/;

export async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function buildForwardHeaders(req: IncomingMessage, body: Buffer): Headers {
  const headers = new Headers();
  // content-length / transfer-encoding / content-encoding 都和“当前转发体”强相关：
  // 请求体经过脱敏后字节数可能变化，也不再沿用上游声明的压缩方式，所以这里统一过滤并按新的 body 重建。
  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null) {
      continue;
    }
    const lowerName = name.toLowerCase();
    if (
      lowerName === "host" ||
      lowerName === "content-length" ||
      lowerName === "content-encoding" ||
      lowerName === "accept-encoding" ||
      lowerName === "transfer-encoding"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }
    headers.set(name, value);
  }

  if (body.byteLength > 0) {
    headers.set("content-length", String(body.byteLength));
  }

  return headers;
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

function writeResponseHeaders(res: ServerResponse, headers: Headers): void {
  for (const [name, value] of headers.entries()) {
    res.setHeader(name, value);
  }
}

async function writeChunk(res: ServerResponse, chunk: string): Promise<void> {
  if (res.write(chunk)) {
    return;
  }
  await once(res, "drain");
}

function getSseFieldValue(line: string, prefix: string): string {
  const value = line.slice(prefix.length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

// 先按完整 SSE block（以空行分隔）切片，避免一个 JSON event 还没收全就进入还原逻辑。
// block 内部再配合 StreamBuffer 处理文本字段，专门兜住 token 跨 chunk / 跨 delta 的情况。
function takeCompleteSseBlocks(text: string): { blocks: string[]; remainder: string } {
  const blocks: string[] = [];
  let remainder = text;
  while (true) {
    const match = SSE_BLOCK_SEPARATOR_REGEX.exec(remainder);
    if (!match || typeof match.index !== "number") {
      return { blocks, remainder };
    }
    const end = match.index + match[0].length;
    blocks.push(remainder.slice(0, end));
    remainder = remainder.slice(end);
  }
}

// SSE 语义层还原不能只按原始字节流替换：像 OpenResponses / Anthropic 这类协议会把文本拆进 JSON delta 字段里，
// 如果 token 被切成多个分片，必须先按事件语义拼回“当前可安全输出的文本”，再做 restore，避免提前吐出半截 token。
function transformSseBlock(params: {
  block: string;
  state: SseSemanticState;
  store: TokenStore;
}): string {
  const normalizedBlock = params.block.replace(/\r\n/g, "\n");
  const trimmedBlock = normalizedBlock.replace(/\n+$/g, "");
  if (!trimmedBlock) {
    return normalizedBlock;
  }

  const parsedLines = trimmedBlock.split("\n").map((line) => {
    if (line.startsWith("event:")) {
      return { kind: "event" as const, value: getSseFieldValue(line, "event:") };
    }
    if (line.startsWith("data:")) {
      return { kind: "data" as const, value: getSseFieldValue(line, "data:") };
    }
    return { kind: "other" as const, value: line };
  });

  const dataLines = parsedLines.filter((line) => line.kind === "data");
  if (dataLines.length === 0) {
    return `${restoreSecrets(trimmedBlock, params.store)}\n\n`;
  }

  const rawData = dataLines.map((line) => line.value).join("\n");
  let nextData = rawData;

  if (rawData !== "[DONE]") {
    try {
      const parsedPayload = JSON.parse(rawData) as unknown;
      const payloadRecord = asRecord(parsedPayload);
      if (!payloadRecord) {
        nextData = JSON.stringify(restoreStructuredStrings(parsedPayload, params.store));
      } else {
        const transformedPayload = transformProtocolSsePayload({
          payload: payloadRecord,
          state: params.state,
          store: params.store,
        });
        if (!transformedPayload) {
          return "";
        }
        nextData = JSON.stringify(transformedPayload);
      }
    } catch {
      nextData = restoreSecrets(rawData, params.store);
    }
  }

  const nextDataLines = nextData.split("\n");
  const rebuiltLines: string[] = [];
  let dataInserted = false;
  for (const line of parsedLines) {
    if (line.kind === "data") {
      if (dataInserted) {
        continue;
      }
      for (const dataLine of nextDataLines) {
        rebuiltLines.push(`data: ${dataLine}`);
      }
      dataInserted = true;
      continue;
    }
    if (line.kind === "event") {
      rebuiltLines.push(`event: ${line.value}`);
      continue;
    }
    rebuiltLines.push(line.value);
  }

  return `${rebuiltLines.join("\n")}\n\n`;
}

export async function writeBufferedResponse(params: {
  upstream: Response;
  clientRes: ServerResponse;
  store: TokenStore;
}): Promise<void> {
  const rawText = await params.upstream.text();
  const restoredText = restoreSecrets(rawText, params.store);
  const restoredBody = Buffer.from(restoredText, "utf8");

  const headers = new Headers(params.upstream.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-length", String(restoredBody.byteLength));

  writeResponseHeaders(params.clientRes, headers);
  params.clientRes.statusCode = params.upstream.status;
  params.clientRes.end(restoredBody);
}

export async function writeSseResponse(params: {
  upstream: Response;
  clientRes: ServerResponse;
  store: TokenStore;
}): Promise<void> {
  const headers = new Headers(params.upstream.headers);
  // SSE 是边读边写的流式响应，最终长度在结束前不可知，因此不能保留旧 content-length。
  // 同时代理已经接管了传输边界，也不能继续透传原始 encoding / transfer-encoding 声明。
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  writeResponseHeaders(params.clientRes, headers);
  params.clientRes.statusCode = params.upstream.status;

  if (!params.upstream.body) {
    params.clientRes.end();
    return;
  }

  const reader = params.upstream.body.getReader();
  const decoder = new TextDecoder();
  const semanticState = createSseSemanticState();
  let pendingText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    pendingText += decoder.decode(value, { stream: true });
    const { blocks, remainder } = takeCompleteSseBlocks(pendingText);
    pendingText = remainder;
    for (const block of blocks) {
      const transformed = transformSseBlock({
        block,
        state: semanticState,
        store: params.store,
      });
      if (transformed) {
        await writeChunk(params.clientRes, transformed);
      }
    }
  }

  pendingText += decoder.decode();
  const { blocks, remainder } = takeCompleteSseBlocks(pendingText);
  for (const block of blocks) {
    const transformed = transformSseBlock({
      block,
      state: semanticState,
      store: params.store,
    });
    if (transformed) {
      await writeChunk(params.clientRes, transformed);
    }
  }
  if (remainder) {
    const transformed = transformSseBlock({
      block: `${remainder}\n\n`,
      state: semanticState,
      store: params.store,
    });
    if (transformed) {
      await writeChunk(params.clientRes, transformed);
    }
  }
  params.clientRes.end();
}

function respondWithError(res: ServerResponse, statusCode: number, message: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(message);
}

function resolveProviderIdFromUrl(url: string | undefined): string | null {
  const requestUrl = new URL(url ?? "/", "http://127.0.0.1");
  const providerId = requestUrl.pathname.split("/").filter(Boolean)[0] ?? "";
  return providerId || null;
}

export function createProxyServer(params: ProxyServerParams): http.Server {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return http.createServer(async (req, res) => {
    const providerId = resolveProviderIdFromUrl(req.url);
    if (!providerId) {
      respondWithError(res, 404, "Vault proxy route not found.");
      return;
    }

    const originalBaseUrl = params.originalBaseUrls[providerId];
    if (!originalBaseUrl) {
      params.logger.warn(`[vault] missing original baseUrl for provider ${providerId}`);
      respondWithError(res, 502, `Vault provider mapping not found: ${providerId}`);
      return;
    }

    const exchangeStore = new TokenStore();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const suffixPath = stripProviderPrefixFromPath({
        pathname: requestUrl.pathname,
        providerId,
      });
      const upstreamUrl = buildUpstreamUrl({
        originalBaseUrlRaw: originalBaseUrl,
        requestSuffixPath: suffixPath,
        search: requestUrl.search,
      });

      const rawBody = await readRequestBody(req);
      const rawText = rawBody.toString("utf8");
      const registeredValues = await params.registry.sortedValues();
      const maskedText = maskSecrets({
        text: rawText,
        registeredValues,
        store: exchangeStore,
      });
      const maskedBody = Buffer.from(maskedText, "utf8");

      const upstream = await fetch(upstreamUrl, {
        method: req.method ?? "GET",
        headers: buildForwardHeaders(req, maskedBody),
        body: maskedBody.byteLength > 0 ? maskedBody : undefined,
        signal: controller.signal,
      });

      if (isEventStreamResponse(upstream)) {
        await writeSseResponse({
          upstream,
          clientRes: res,
          store: exchangeStore,
        });
      } else {
        await writeBufferedResponse({
          upstream,
          clientRes: res,
          store: exchangeStore,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.logger.error(`[vault] proxy request failed for ${providerId}: ${message}`);
      if (!res.headersSent) {
        respondWithError(res, 502, `Vault proxy request failed: ${message}`);
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      clearTimeout(timeout);
      // token 映射只属于这一次 request-response 周期；一旦响应结束或失败，就必须清空，避免后续请求串用旧密文。
      exchangeStore.clear();
    }
  });
}

export async function resolveOriginalBaseUrls(params: {
  config: OpenClawConfig;
  backupStore: ProviderBackupStore;
}): Promise<Record<string, string>> {
  const configured = getConfiguredSecretBaseUrls(params.config);
  const backups = (await params.backupStore.load()).providers;
  return Object.fromEntries(
    [...new Set([...Object.keys(backups), ...Object.keys(configured)])]
      .sort((left, right) => left.localeCompare(right))
      .map((providerId) => [providerId, configured[providerId] ?? backups[providerId]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0),
  );
}
