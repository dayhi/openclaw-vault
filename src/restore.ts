import { TokenStore, VAULT_TOKEN_CAPTURE_PATTERN } from "./token-store.js";

const TOKEN_PATTERN = new RegExp(VAULT_TOKEN_CAPTURE_PATTERN, "g");

export function restoreSecrets(text: string, store: TokenStore): string {
  return text.replace(TOKEN_PATTERN, (fullMatch, token: string) => {
    const entry = store.restore(token);
    if (!entry) {
      return fullMatch;
    }
    return entry.source === "inline" ? `<<s:${entry.value}>>` : entry.value;
  });
}
