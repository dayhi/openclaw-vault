import { formatPlaceholder, normalizeSecretName, type SecretStore } from "../secrets/secret-store.js";

export function secretCommandHandler(secretStore: SecretStore) {
  return async (ctx: { args?: string }) => {
    const args = ctx.args?.trim() ?? "";
    const tokens = args.split(/\s+/).filter(Boolean);
    const action = (tokens[0] ?? "help").toLowerCase();

    if (action === "add" || action === "set") {
      const name = tokens[1];
      // Value is everything after the name (preserves spaces in values)
      const valueStart = args.indexOf(tokens[1] ?? "") + (tokens[1]?.length ?? 0);
      const value = args.slice(valueStart).trim();
      if (!name || !value) {
        return { text: "Usage: /secret add <NAME> <value>" };
      }
      const normalizedName = normalizeSecretName(name);
      secretStore.set(normalizedName, value);
      return { text: `Registered secret ${formatPlaceholder(normalizedName)}` };
    }

    if (action === "remove" || action === "delete" || action === "rm") {
      const name = tokens[1];
      if (!name) {
        return { text: "Usage: /secret remove <NAME>" };
      }
      const normalizedName = normalizeSecretName(name);
      const deleted = secretStore.delete(normalizedName);
      return {
        text: deleted
          ? `Removed secret ${formatPlaceholder(normalizedName)}`
          : `Secret "${normalizedName}" not found`,
      };
    }

    if (action === "list" || action === "ls") {
      const names = secretStore.listNames();
      if (names.length === 0) {
        return { text: "No secrets registered." };
      }
      const formatted = names.map((name) => formatPlaceholder(name)).join(", ");
      return { text: `Registered placeholders (${names.length}): ${formatted}` };
    }

    if (action === "clear") {
      secretStore.clear();
      return { text: "All secrets cleared." };
    }

    return {
      text: [
        "Secret placeholder commands:",
        "",
        "/secret add <NAME> <value>  — Register a secret",
        "/secret remove <NAME>       — Remove a secret",
        "/secret list                — List placeholder names",
        "/secret clear               — Remove all secrets",
      ].join("\n"),
    };
  };
}
