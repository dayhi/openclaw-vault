import { formatPlaceholder, type SecretStore } from "../secrets/secret-store.js";

export function contextRedactHandler(secretStore: SecretStore) {
  return async (event: { messages: Array<Record<string, unknown>> }) => {
    if (secretStore.size === 0) return;

    for (let i = 0; i < event.messages.length; i++) {
      const { result, changed } = secretStore.deepRedact(event.messages[i]);
      if (changed) {
        Object.assign(event.messages[i], result);
      }
    }

    const names = secretStore.listNames().map((name) => formatPlaceholder(name));
    return {
      prependSystemContext: `Available secret placeholders: ${names.join(", ")}. Use resolve_placeholder tool to check if a placeholder exists.`,
    };
  };
}
