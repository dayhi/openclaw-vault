function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toKeyPart(value: unknown): string | null {
  return typeof value === "number"
    ? String(value)
    : typeof value === "string"
      ? value
      : null;
}

export const OPENAI_BUFFER_PREFIX = "openai:";
export const ANTHROPIC_BUFFER_PREFIX = "anthropic:";

export function buildOpenAiTextBufferKey(payload: Record<string, unknown>): string | null {
  const itemId = toKeyPart(payload.item_id);
  const outputIndex = toKeyPart(payload.output_index);
  const contentIndex = toKeyPart(payload.content_index);
  if (!itemId || outputIndex == null || contentIndex == null) {
    return null;
  }
  return `${OPENAI_BUFFER_PREFIX}text:${itemId}:${outputIndex}:${contentIndex}`;
}

export function buildOpenAiFunctionArgumentsBufferKey(payload: Record<string, unknown>): string | null {
  const itemId = toKeyPart(payload.item_id);
  const outputIndex = toKeyPart(payload.output_index);
  const callId = toKeyPart(payload.call_id);
  if (!itemId || outputIndex == null || !callId) {
    return null;
  }
  return `${OPENAI_BUFFER_PREFIX}function-args:${itemId}:${outputIndex}:${callId}`;
}

export function buildOpenAiFunctionArgumentsItemBufferKey(payload: Record<string, unknown>): string | null {
  const item = asRecord(payload.item);
  const itemId = toKeyPart(item?.id);
  const outputIndex = toKeyPart(payload.output_index);
  const callId = toKeyPart(item?.call_id);
  if (!itemId || outputIndex == null || !callId) {
    return null;
  }
  return `${OPENAI_BUFFER_PREFIX}function-args:${itemId}:${outputIndex}:${callId}`;
}

export function buildAnthropicTextBufferKey(payload: Record<string, unknown>): string | null {
  const index = toKeyPart(payload.index);
  if (index == null) {
    return null;
  }
  return `${ANTHROPIC_BUFFER_PREFIX}text:${index}`;
}

export function buildAnthropicToolInputBufferKey(payload: Record<string, unknown>): string | null {
  const index = toKeyPart(payload.index);
  if (index == null) {
    return null;
  }
  return `${ANTHROPIC_BUFFER_PREFIX}tool-input:${index}`;
}
