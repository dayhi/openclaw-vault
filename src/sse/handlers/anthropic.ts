import {
  ANTHROPIC_BUFFER_PREFIX,
  buildAnthropicTextBufferKey,
  buildAnthropicToolInputBufferKey,
} from "../keys.js";
import { asRecord, restoreStructuredStrings, transformBufferedStringField } from "../helpers.js";
import { clearSseDeltaBuffer, clearSseDeltaBuffersByPrefix } from "../state.js";
import type { SsePayloadTransformParams, SsePayloadTransformResult } from "../types.js";

export function transformAnthropicSsePayload(
  params: SsePayloadTransformParams,
): SsePayloadTransformResult {
  const { payload, state, store } = params;

  if (payload.type === "content_block_delta") {
    const delta = asRecord(payload.delta);
    const deltaType = typeof delta?.type === "string" ? delta.type : "";

    if (deltaType === "text_delta") {
      const text = typeof delta?.text === "string" ? delta.text : "";
      if (!text) {
        return restoreStructuredStrings(payload, store) as Record<string, unknown>;
      }
      return transformBufferedStringField({
        state,
        store,
        key: buildAnthropicTextBufferKey(payload),
        value: text,
        rebuild: (value) => ({
          ...payload,
          delta: {
            ...delta,
            text: value,
          },
        }),
      });
    }

    if (deltaType === "input_json_delta") {
      const partialJson = typeof delta?.partial_json === "string" ? delta.partial_json : "";
      if (!partialJson) {
        return restoreStructuredStrings(payload, store) as Record<string, unknown>;
      }
      return transformBufferedStringField({
        state,
        store,
        key: buildAnthropicToolInputBufferKey(payload),
        value: partialJson,
        rebuild: (value) => ({
          ...payload,
          delta: {
            ...delta,
            partial_json: value,
          },
        }),
      });
    }

    return restoreStructuredStrings(payload, store) as Record<string, unknown>;
  }

  if (payload.type === "content_block_stop") {
    clearSseDeltaBuffer(state, buildAnthropicTextBufferKey(payload));
    clearSseDeltaBuffer(state, buildAnthropicToolInputBufferKey(payload));
    return restoreStructuredStrings(payload, store) as Record<string, unknown>;
  }

  if (payload.type === "message_stop") {
    clearSseDeltaBuffersByPrefix(state, ANTHROPIC_BUFFER_PREFIX);
    return restoreStructuredStrings(payload, store) as Record<string, unknown>;
  }

  return undefined;
}
