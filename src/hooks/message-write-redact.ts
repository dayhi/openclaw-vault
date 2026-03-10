import type { SecretStore } from "../secrets/secret-store.js";

export function messageWriteRedactHandler(secretStore: SecretStore) {
  return (event: { message: Record<string, unknown> }) => {
    if (secretStore.size === 0) return;
    const { result, changed } = secretStore.deepRedact(event.message);
    if (changed) {
      return { message: result as Record<string, unknown> };
    }
  };
}
