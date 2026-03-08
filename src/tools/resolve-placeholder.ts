import type { SecretStore } from "../secrets/secret-store.js";

export function createResolvePlaceholderTool(secretStore: SecretStore) {
  return {
    name: "resolve_placeholder",
    label: "Resolve Placeholder",
    description:
      "Check if a secret placeholder name is registered. Returns whether it exists and lists available placeholders. Does NOT reveal actual secret values.",
    parameters: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "Placeholder name to check (without {{ }} brackets)",
        },
      },
      required: ["name"] as const,
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: { name: string }) => {
      const normalized = params.name.toUpperCase().replace(/^\{\{|\}\}$/g, "");
      const exists = secretStore.get(normalized) !== undefined;
      const available = secretStore.listNames().map((n) => `{{${n}}}`);
      return {
        content: JSON.stringify({
          exists,
          name: normalized,
          hint: exists
            ? `Use {{${normalized}}} in tool parameters — the system will substitute the real value automatically.`
            : `Placeholder {{${normalized}}} is not registered. Available: ${available.join(", ") || "(none)"}`,
        }),
      };
    },
  };
}
