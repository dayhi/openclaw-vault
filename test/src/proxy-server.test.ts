import http, { type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SecretRegistry } from "../../src/secret-registry.js";
import { createProxyServer, writeBufferedResponse, writeSseResponse } from "../../src/proxy-server.js";
import { TokenStore } from "../../src/token-store.js";

type TestResponse = ServerResponse & {
  body?: Buffer;
  chunks: Buffer[];
  ended: boolean;
};

function createResponseCapture(): TestResponse {
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    chunks,
    ended: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    writeHead(statusCode: number, nextHeaders?: Record<string, string>) {
      res.statusCode = statusCode;
      res.headersSent = true;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) {
        headers.set(name.toLowerCase(), value);
      }
      return res;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      res.ended = true;
      res.body = Buffer.concat(chunks);
      res.headersSent = true;
      return res;
    },
    destroy() {
      res.ended = true;
    },
  } as unknown as TestResponse;
  return res;
}

function createRegistry(values: string[]): SecretRegistry {
  return {
    sortedValues: async () => values,
  } as unknown as SecretRegistry;
}

async function startServer(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve test server address");
  }
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function parseSseJsonEvents(bodyText: string): Array<string | Record<string, unknown>> {
  return bodyText
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return data === "[DONE]" ? data : (JSON.parse(data) as Record<string, unknown>);
    });
}

function buildSseText(
  events: Array<{ event?: string; data: string | Record<string, unknown> }>,
): string {
  return events
    .flatMap(({ event, data }) => [
      ...(event ? [`event: ${event}`] : []),
      `data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
      "",
    ])
    .join("\n");
}

describe("proxy-server response helpers", () => {
  it("非流式响应重算 content-length", async () => {
    const store = new TokenStore(() => "AAA111");
    store.getOrCreate("abc12345xyz", "registered");
    const res = createResponseCapture();

    await writeBufferedResponse({
      upstream: new Response("reply <<s.AAA111>>", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "999",
          "content-encoding": "gzip",
        },
      }),
      clientRes: res,
      store,
    });

    expect(String(res.body)).toBe("reply abc12345xyz");
    expect(res.getHeader("content-length")).toBe(String(Buffer.byteLength("reply abc12345xyz", "utf8")));
    expect(res.getHeader("content-encoding")).toBeUndefined();
  });

  it("SSE 响应不设置 content-length 且能跨 chunk 还原 token", async () => {
    const store = new TokenStore(() => "AAA111");
    store.getOrCreate("abc12345xyz", "registered");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: <<s.AAA"));
        controller.enqueue(encoder.encode("111>>\n\n"));
        controller.close();
      },
    });
    const res = createResponseCapture();

    await writeSseResponse({
      upstream: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "content-length": "123",
          "content-encoding": "gzip",
        },
      }),
      clientRes: res,
      store,
    });

    const bodyText = String(res.body);
    expect(bodyText).not.toContain("<<s.AAA111>>");
    expect(bodyText.split(/\n\n+/).filter(Boolean)).toEqual(["data: abc12345xyz"]);
    expect(res.getHeader("content-length")).toBeUndefined();
    expect(res.getHeader("content-encoding")).toBeUndefined();
  });

  it("OpenResponses SSE 语义 delta 分片也能还原 registered token", async () => {
    const store = new TokenStore(() => "AAA111");
    store.getOrCreate("abc12345xyz", "registered");
    const encoder = new TextEncoder();
    const sseText = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"<<"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"s"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":".AAA"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"111"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":">>"}',
      "",
      "event: response.output_text.done",
      'data: {"type":"response.output_text.done","item_id":"msg_1","output_index":0,"content_index":0,"text":"<<s.AAA111>>"}',
      "",
      "event: response.content_part.done",
      'data: {"type":"response.content_part.done","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"<<s.AAA111>>"}}',
      "",
      "event: response.output_item.done",
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"<<s.AAA111>>"}]}}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"<<s.AAA111>>"}]}]}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });
    const res = createResponseCapture();

    await writeSseResponse({
      upstream: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      }),
      clientRes: res,
      store,
    });

    const bodyText = String(res.body);
    expect(bodyText).toContain('"delta":"abc12345xyz"');
    expect(bodyText).toContain('"text":"abc12345xyz"');
    expect(bodyText).not.toContain("<<s.AAA111>>");
    expect(bodyText).toContain("data: [DONE]");
  });

  it("OpenResponses SSE 语义 delta 分片也能还原 inline token", async () => {
    const store = new TokenStore(() => "AAA111");
    store.getOrCreate("abc12345xyz", "inline");
    const encoder = new TextEncoder();
    const sseText = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_2","output_index":0,"content_index":0,"delta":"<<"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_2","output_index":0,"content_index":0,"delta":"s.A"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_2","output_index":0,"content_index":0,"delta":"AA111"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_2","output_index":0,"content_index":0,"delta":">>"}',
      "",
      "event: response.output_text.done",
      'data: {"type":"response.output_text.done","item_id":"msg_2","output_index":0,"content_index":0,"text":"<<s.AAA111>>"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });
    const res = createResponseCapture();

    await writeSseResponse({
      upstream: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      }),
      clientRes: res,
      store,
    });

    const bodyText = String(res.body);
    expect(bodyText).toContain('"delta":"<<s:abc12345xyz>>"');
    expect(bodyText).toContain('"text":"<<s:abc12345xyz>>"');
    expect(bodyText).not.toContain("<<s.AAA111>>");
  });

  it("Anthropic Messages SSE content_block_delta 分片也能还原 inline token", async () => {
    const store = new TokenStore(() => "AAA111");
    store.getOrCreate("abc12345xyz", "inline");
    const encoder = new TextEncoder();
    const sseText = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<<"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"s.A"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"AA111"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":">>"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });
    const res = createResponseCapture();

    await writeSseResponse({
      upstream: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      }),
      clientRes: res,
      store,
    });

    const bodyText = String(res.body);
    expect(bodyText).toContain('"text":"<<s:abc12345xyz>>"');
    expect(bodyText).not.toContain("<<s.AAA111>>");
  });

  it("OpenResponses function_call_arguments.delta 分片能还原 registered token", async () => {
    const store = new TokenStore(() => "AAA111");
    store.getOrCreate("abc12345xyz", "registered");
    const encoder = new TextEncoder();
    const sseText = buildSseText([
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write", arguments: "" },
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          delta: '{"content":"<<',
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          delta: "s.AAA",
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          delta: "111",
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          delta: '>>"}',
        },
      },
      {
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          arguments: '{"content":"<<s.AAA111>>"}',
        },
      },
      {
        event: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "write",
            arguments: '{"content":"<<s.AAA111>>"}',
          },
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            output: [
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "write",
                arguments: '{"content":"<<s.AAA111>>"}',
              },
            ],
          },
        },
      },
      { data: "[DONE]" },
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });
    const res = createResponseCapture();

    await writeSseResponse({
      upstream: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      }),
      clientRes: res,
      store,
    });

    const bodyText = String(res.body);
    expect(bodyText).not.toContain("<<s.AAA111>>");
    expect(bodyText).toContain('"arguments":"{\\"content\\":\\"abc12345xyz\\"}"');

    const events = parseSseJsonEvents(bodyText);
    const doneEvent = events.find(
      (event) => typeof event === "object" && event.type === "response.function_call_arguments.done",
    ) as Record<string, unknown> | undefined;
    expect(doneEvent?.arguments).toBe('{"content":"abc12345xyz"}');

    const completedEvent = events.find(
      (event) => typeof event === "object" && event.type === "response.completed",
    ) as Record<string, unknown> | undefined;
    const completedResponse = completedEvent?.response as Record<string, unknown> | undefined;
    const completedOutput = completedResponse?.output as Array<Record<string, unknown>> | undefined;
    expect(completedOutput?.[0]?.arguments).toBe('{"content":"abc12345xyz"}');
  });

  it("OpenResponses 并行 function_call_arguments 不会串 buffer", async () => {
    const tokenQueue = ["AAA111", "BBB222"];
    const store = new TokenStore(() => tokenQueue.shift() ?? "ZZZ999");
    store.getOrCreate("abc12345xyz", "registered");
    store.getOrCreate("xyz98765abc", "registered");
    const encoder = new TextEncoder();
    const sseText = buildSseText([
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          delta: '{"content":"<<',
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_2",
          output_index: 0,
          call_id: "call_2",
          delta: '{"content":"<<',
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          delta: "s.AAA",
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_2",
          output_index: 0,
          call_id: "call_2",
          delta: "s.BBB",
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          delta: "111",
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_2",
          output_index: 0,
          call_id: "call_2",
          delta: "222",
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          delta: '>>"}',
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_2",
          output_index: 0,
          call_id: "call_2",
          delta: '>>"}',
        },
      },
      {
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          output_index: 0,
          call_id: "call_1",
          arguments: '{"content":"<<s.AAA111>>"}',
        },
      },
      {
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          item_id: "fc_2",
          output_index: 0,
          call_id: "call_2",
          arguments: '{"content":"<<s.BBB222>>"}',
        },
      },
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });
    const res = createResponseCapture();

    await writeSseResponse({
      upstream: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      }),
      clientRes: res,
      store,
    });

    const bodyText = String(res.body);
    expect(bodyText).toContain('"arguments":"{\\"content\\":\\"abc12345xyz\\"}"');
    expect(bodyText).toContain('"arguments":"{\\"content\\":\\"xyz98765abc\\"}"');
    expect(bodyText).not.toContain("<<s.AAA111>>");
    expect(bodyText).not.toContain("<<s.BBB222>>");
  });

  it("Anthropic input_json_delta 分片能还原 inline token", async () => {
    const store = new TokenStore(() => "AAA111");
    store.getOrCreate("abc12345xyz", "inline");
    const encoder = new TextEncoder();
    const sseText = buildSseText([
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "write", input: {} },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"content":"<<' },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "s.AAA" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "111" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '>>"}' },
        },
      },
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index: 1 },
      },
      {
        event: "message_stop",
        data: { type: "message_stop" },
      },
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });
    const res = createResponseCapture();

    await writeSseResponse({
      upstream: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      }),
      clientRes: res,
      store,
    });

    const bodyText = String(res.body);
    expect(bodyText).not.toContain("<<s.AAA111>>");

    const events = parseSseJsonEvents(bodyText);
    const partialJson = events
      .filter((event) => typeof event === "object" && event.type === "content_block_delta")
      .map((event) => (event.delta as Record<string, unknown> | undefined)?.partial_json)
      .filter((value): value is string => typeof value === "string")
      .join("");
    expect(partialJson).toBe('{"content":"<<s:abc12345xyz>>"}');
  });
});

describe("createProxyServer", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("转发时不会把 registered secret 明文发送到上游", async () => {
    let upstreamBody = "";
    let upstreamUrl = "";
    const upstreamServer = http.createServer(async (req, res) => {
      upstreamUrl = req.url ?? "";
      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      upstreamBody = Buffer.concat(bodyChunks).toString("utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ echoed: upstreamBody }));
    });
    const upstream = await startServer(upstreamServer);
    cleanups.push(upstream.close);

    const proxyServer = createProxyServer({
      registry: createRegistry(["abc12345xyz"]),
      originalBaseUrls: {
        anthropic: `http://127.0.0.1:${upstream.port}/v1`,
      },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });
    const proxy = await startServer(proxyServer);
    cleanups.push(proxy.close);

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: proxy.port,
          path: "/anthropic/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify({ message: "please repeat abc12345xyz" }));
      req.end();
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamUrl).toBe("/v1/messages");
    expect(upstreamBody).not.toContain("abc12345xyz");
    expect(upstreamBody).toContain("<<s.");
    expect(response.body).toContain("abc12345xyz");
  });
});
