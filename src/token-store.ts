import { randomInt } from "node:crypto";

export type TokenSource = "inline" | "registered";

export type TokenEntry = {
  token: string;
  value: string;
  source: TokenSource;
};

export const VAULT_TOKEN_LENGTH = 6;
export const VAULT_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const VAULT_TOKEN_PATTERN = `[A-Za-z0-9]{${VAULT_TOKEN_LENGTH}}`;
export const VAULT_TOKEN_SEGMENT_PATTERN = `<<s\\.${VAULT_TOKEN_PATTERN}>>`;
export const VAULT_TOKEN_CAPTURE_PATTERN = `<<s\\.(${VAULT_TOKEN_PATTERN})>>`;
export const COMPLETE_VAULT_TOKEN_LENGTH = `<<s.${"A".repeat(VAULT_TOKEN_LENGTH)}>>`.length;

const VAULT_TOKEN_REGEX = new RegExp(`^${VAULT_TOKEN_PATTERN}$`);
const VAULT_TOKEN_SEGMENT_REGEX = new RegExp(`^${VAULT_TOKEN_SEGMENT_PATTERN}$`);

export function formatVaultToken(token: string): string {
  return `<<s.${token}>>`;
}

export function isVaultToken(value: string): boolean {
  return VAULT_TOKEN_REGEX.test(value);
}

export function isVaultTokenSegment(value: string): boolean {
  return VAULT_TOKEN_SEGMENT_REGEX.test(value);
}

function createRandomToken(): string {
  let token = "";
  for (let index = 0; index < VAULT_TOKEN_LENGTH; index += 1) {
    token += VAULT_TOKEN_ALPHABET[randomInt(0, VAULT_TOKEN_ALPHABET.length)] ?? "A";
  }
  return token;
}

// TokenStore 只服务于单次代理 exchange：请求脱敏时登记映射，响应还原完成后立即丢弃，不承担持久化职责。
export class TokenStore {
  private readonly tokenToEntry = new Map<string, TokenEntry>();
  private readonly sourceValueToToken = new Map<string, string>();

  constructor(private readonly tokenFactory: () => string = createRandomToken) {}

  // 相同明文在 inline / registered 两条链路上的还原方式不同，所以键必须同时包含 source 与 value。
  private keyOf(source: TokenSource, value: string): string {
    return `${source}\u0000${value}`;
  }

  getOrCreate(value: string, source: TokenSource): string {
    const existing = this.sourceValueToToken.get(this.keyOf(source, value));
    if (existing) {
      return existing;
    }

    // token 既要满足格式校验，也要在当前 exchange 内唯一；尝试上限用于防止自定义 tokenFactory 异常时陷入死循环。
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const nextToken = this.tokenFactory();
      if (!isVaultToken(nextToken)) {
        continue;
      }
      if (this.tokenToEntry.has(nextToken)) {
        continue;
      }

      this.sourceValueToToken.set(this.keyOf(source, value), nextToken);
      this.tokenToEntry.set(nextToken, { token: nextToken, value, source });
      return nextToken;
    }

    throw new Error("failed to allocate a unique vault token");
  }

  restore(token: string): TokenEntry | undefined {
    return this.tokenToEntry.get(token);
  }

  entries(): TokenEntry[] {
    return [...this.tokenToEntry.values()].map((entry) => ({ ...entry }));
  }

  // 单次请求-响应结束后立即清空，避免旧 token 泄漏到下一次代理交换。
  clear(): void {
    this.tokenToEntry.clear();
    this.sourceValueToToken.clear();
  }
}
