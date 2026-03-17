import { StreamBuffer } from "../stream-buffer.js";
import type { SseSemanticState } from "./types.js";

export function createSseSemanticState(): SseSemanticState {
  return {
    deltaBuffers: new Map(),
  };
}

export function getOrCreateSseDeltaBuffer(state: SseSemanticState, key: string): StreamBuffer {
  const existing = state.deltaBuffers.get(key);
  if (existing) {
    return existing;
  }
  const created = new StreamBuffer();
  state.deltaBuffers.set(key, created);
  return created;
}

export function clearSseDeltaBuffer(state: SseSemanticState, key: string | null): void {
  if (!key) {
    return;
  }
  state.deltaBuffers.delete(key);
}

export function clearSseDeltaBuffersByPrefix(state: SseSemanticState, prefix: string): void {
  for (const key of state.deltaBuffers.keys()) {
    if (key.startsWith(prefix)) {
      state.deltaBuffers.delete(key);
    }
  }
}
