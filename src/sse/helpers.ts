import { restoreSecrets } from "../restore.js";
import type { TokenStore } from "../token-store.js";
import { getOrCreateSseDeltaBuffer } from "./state.js";
import type { SseSemanticState } from "./types.js";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function restoreStructuredStrings(value: unknown, store: TokenStore): unknown {
  if (typeof value === "string") {
    return restoreSecrets(value, store);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => restoreStructuredStrings(entry, store));
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, restoreStructuredStrings(entry, store)]),
  );
}

export function transformBufferedStringField(params: {
  state: SseSemanticState;
  store: TokenStore;
  key: string | null;
  value: string;
  rebuild: (value: string) => Record<string, unknown>;
}): Record<string, unknown> | null {
  const { state, store, key, value, rebuild } = params;
  if (!key) {
    return rebuild(restoreSecrets(value, store));
  }

  const bufferedValue = getOrCreateSseDeltaBuffer(state, key).push(value);
  if (!bufferedValue) {
    return null;
  }

  return rebuild(restoreSecrets(bufferedValue, store));
}
