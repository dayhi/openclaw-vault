import { restoreSecrets } from "../../restore.js";
import {
  buildOpenAiFunctionArgumentsBufferKey,
  buildOpenAiFunctionArgumentsItemBufferKey,
  buildOpenAiTextBufferKey,
  OPENAI_BUFFER_PREFIX,
} from "../keys.js";
import { asRecord, restoreStructuredStrings, transformBufferedStringField } from "../helpers.js";
import { clearSseDeltaBuffer, clearSseDeltaBuffersByPrefix } from "../state.js";
import type { SsePayloadTransformParams, SsePayloadTransformResult } from "../types.js";

export function transformOpenAiSsePayload(params: SsePayloadTransformParams): SsePayloadTransformResult {
  const { payload, state, store } = params;

  if (payload.type === "response.output_text.delta") {
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (!delta) {
      return payload;
    }
    return transformBufferedStringField({
      state,
      store,
      key: buildOpenAiTextBufferKey(payload),
      value: delta,
      rebuild: (value) => ({ ...payload, delta: value }),
    });
  }

  if (payload.type === "response.output_text.done") {
    clearSseDeltaBuffer(state, buildOpenAiTextBufferKey(payload));
    const text = typeof payload.text === "string" ? payload.text : "";
    return text ? { ...payload, text: restoreSecrets(text, store) } : payload;
  }

  if (payload.type === "response.content_part.done") {
    clearSseDeltaBuffer(state, buildOpenAiTextBufferKey(payload));
    return restoreStructuredStrings(payload, store) as Record<string, unknown>;
  }

  if (payload.type === "response.function_call_arguments.delta") {
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (!delta) {
      return payload;
    }
    return transformBufferedStringField({
      state,
      store,
      key: buildOpenAiFunctionArgumentsBufferKey(payload),
      value: delta,
      rebuild: (value) => ({ ...payload, delta: value }),
    });
  }

  if (payload.type === "response.function_call_arguments.done") {
    clearSseDeltaBuffer(state, buildOpenAiFunctionArgumentsBufferKey(payload));
    const args = typeof payload.arguments === "string" ? payload.arguments : "";
    return args ? { ...payload, arguments: restoreSecrets(args, store) } : payload;
  }

  if (payload.type === "response.output_item.done") {
    const item = asRecord(payload.item);
    if (item?.type === "function_call") {
      clearSseDeltaBuffer(state, buildOpenAiFunctionArgumentsItemBufferKey(payload));
    }
    return restoreStructuredStrings(payload, store) as Record<string, unknown>;
  }

  if (payload.type === "response.completed") {
    clearSseDeltaBuffersByPrefix(state, OPENAI_BUFFER_PREFIX);
    return restoreStructuredStrings(payload, store) as Record<string, unknown>;
  }

  return undefined;
}
