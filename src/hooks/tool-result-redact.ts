import type { SecretStore } from "../secrets/secret-store.js";

type Logger = { info?: (...args: unknown[]) => void };

export function toolResultRedactHandler(secretStore: SecretStore, logger: Logger) {
  return (event: { message: Record<string, unknown> }) => {
    // Step 1: Extract <<VAULT:NAME=VALUE>> markers from message text content
    if (typeof event.message.content === "string") {
      const { cleaned, entries } = secretStore.extractVaultMarkers(event.message.content);
      if (entries.length > 0) {
        event.message.content = cleaned;
        // Step 2: Batch register extracted secrets
        secretStore.batchSet(entries);
        logger.info?.(`secret-placeholder: extracted ${entries.length} vault marker(s) from tool result`);
      }
    } else if (Array.isArray(event.message.content)) {
      let totalEntries: Array<{ name: string; value: string }> = [];
      for (let i = 0; i < event.message.content.length; i++) {
        const part = event.message.content[i];
        if (typeof part === "string") {
          const { cleaned, entries } = secretStore.extractVaultMarkers(part);
          if (entries.length > 0) {
            event.message.content[i] = cleaned;
            totalEntries = totalEntries.concat(entries);
          }
        } else if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
          const obj = part as Record<string, unknown>;
          const { cleaned, entries } = secretStore.extractVaultMarkers(obj.text as string);
          if (entries.length > 0) {
            obj.text = cleaned;
            totalEntries = totalEntries.concat(entries);
          }
        }
      }
      if (totalEntries.length > 0) {
        secretStore.batchSet(totalEntries);
        logger.info?.(`secret-placeholder: extracted ${totalEntries.length} vault marker(s) from tool result`);
      }
    }

    // Step 3: Redact all known secret values in the message
    if (secretStore.size === 0) return;
    const { result, changed } = secretStore.deepRedact(event.message);
    if (changed) {
      logger.info?.("secret-placeholder: redacted secret values in tool result");
      return { message: result as Record<string, unknown> };
    }
  };
}
