import type { SecretStore } from "../secrets/secret-store.js";

const PLACEHOLDER_GUIDE = `IMPORTANT: The user has registered secret placeholders in the format {{SECRET_NAME}}.
When you need to use a secret value in tool calls (e.g., bash commands, API requests),
use the {{SECRET_NAME}} syntax as-is in tool parameters. The system will automatically
substitute the real value before execution. Never ask the user to reveal actual secret values.
Use the resolve_placeholder tool to check if a placeholder name is valid.`;

export function promptGuardHandler(secretStore: SecretStore) {
  return async () => {
    if (secretStore.size === 0) return;
    const names = secretStore.listNames().map((n) => `{{${n}}}`);
    const guide = `${PLACEHOLDER_GUIDE}\n\nAvailable placeholders: ${names.join(", ")}`;
    return { prependSystemContext: guide };
  };
}
