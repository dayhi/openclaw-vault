import type { SecretStore } from "../secrets/secret-store.js";

type Logger = { info?: (...args: unknown[]) => void };

export function toolCallSubHandler(secretStore: SecretStore, logger: Logger) {
  return async (event: { toolName: string; params: Record<string, unknown> }) => {
    if (secretStore.size === 0) return;
    const { result, changed } = secretStore.deepSubstitute(event.params);
    if (changed) {
      logger.info?.(`secret-placeholder: substituted placeholders in ${event.toolName} params`);
      return { params: result as Record<string, unknown> };
    }
  };
}
