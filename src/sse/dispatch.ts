import { transformAnthropicSsePayload } from "./handlers/anthropic.js";
import { transformOpenAiSsePayload } from "./handlers/openai.js";
import { restoreStructuredStrings } from "./helpers.js";
import type { SsePayloadTransformParams } from "./types.js";

export function transformProtocolSsePayload(
  params: SsePayloadTransformParams,
): Record<string, unknown> | null {
  const openAiResult = transformOpenAiSsePayload(params);
  if (openAiResult !== undefined) {
    return openAiResult ?? null;
  }

  const anthropicResult = transformAnthropicSsePayload(params);
  if (anthropicResult !== undefined) {
    return anthropicResult ?? null;
  }

  return restoreStructuredStrings(params.payload, params.store) as Record<string, unknown>;
}
