import type { SecretStore } from "../secrets/secret-store.js";

type Logger = { info?: (...args: unknown[]) => void };

export function messageSendingSubHandler(secretStore: SecretStore, logger: Logger) {
  return async (event: { to: string; content: string; metadata: unknown }) => {
    if (secretStore.size === 0) return;
    const substituted = secretStore.substitute(event.content);
    if (substituted !== event.content) {
      logger.info?.("secret-placeholder: substituted placeholders in outbound message");
      return { content: substituted };
    }
  };
}
