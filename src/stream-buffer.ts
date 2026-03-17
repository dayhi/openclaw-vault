import { COMPLETE_VAULT_TOKEN_LENGTH, VAULT_TOKEN_LENGTH } from "./token-store.js";

const POSSIBLE_TOKEN_PREFIX_REGEX = new RegExp(`^<<s\\.[A-Za-z0-9]{0,${VAULT_TOKEN_LENGTH}}$`);
const POSSIBLE_TOKEN_ALMOST_COMPLETE_REGEX = new RegExp(`^<<s\\.[A-Za-z0-9]{${VAULT_TOKEN_LENGTH}}>$`);

function isPossibleTokenPrefix(value: string): boolean {
  return (
    value === "<" ||
    value === "<<" ||
    value === "<<s" ||
    POSSIBLE_TOKEN_PREFIX_REGEX.test(value) ||
    POSSIBLE_TOKEN_ALMOST_COMPLETE_REGEX.test(value)
  );
}

// 完整 token 的最大长度固定，因此只需要回看尾部这段窗口；前面的内容已经不可能再和未来 chunk 拼成未完成 token。
export function findIncompleteTokenStart(text: string): number {
  const scanStart = Math.max(0, text.length - (COMPLETE_VAULT_TOKEN_LENGTH - 1));
  for (let index = scanStart; index < text.length; index += 1) {
    if (isPossibleTokenPrefix(text.slice(index))) {
      return index;
    }
  }
  return -1;
}

// StreamBuffer 用于流式场景：把“看起来像 token 前缀但还没收全”的尾部留在 pending，避免过早输出给客户端。
export class StreamBuffer {
  private pending = "";

  // push 返回当前可安全输出的文本；若尾部仍可能是未完成 token，就先继续保留到下一次 chunk。
  push(chunk: string): string {
    this.pending += chunk;
    const incompleteStart = findIncompleteTokenStart(this.pending);
    if (incompleteStart === -1) {
      const completeText = this.pending;
      this.pending = "";
      return completeText;
    }

    const safeText = this.pending.slice(0, incompleteStart);
    this.pending = this.pending.slice(incompleteStart);
    return safeText;
  }

  // flush 只在流结束、确认后面不会再有补全片段时调用，用来吐出最后残留的 pending。
  flush(): string {
    const remaining = this.pending;
    this.pending = "";
    return remaining;
  }

  getPending(): string {
    return this.pending;
  }
}
