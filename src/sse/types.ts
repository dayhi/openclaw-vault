import type { StreamBuffer } from "../stream-buffer.js";
import type { TokenStore } from "../token-store.js";

export type SseSemanticState = {
  deltaBuffers: Map<string, StreamBuffer>;
};

export type SsePayloadTransformParams = {
  payload: Record<string, unknown>;
  state: SseSemanticState;
  store: TokenStore;
};

export type SsePayloadTransformResult = Record<string, unknown> | null | undefined;
