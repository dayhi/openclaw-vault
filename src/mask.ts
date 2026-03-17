import {
  formatVaultToken,
  TokenStore,
  VAULT_TOKEN_SEGMENT_PATTERN,
  isVaultTokenSegment,
} from "./token-store.js";

export const INLINE_SECRET_PATTERN = /<<s:([\s\S]+?)>>/g;
const TOKEN_SEGMENT_SPLIT_REGEX = new RegExp(`(${VAULT_TOKEN_SEGMENT_PATTERN})`, "g");

// registered secret 需要先按长度倒序处理，避免较短的值先替换掉较长值的一部分。
function sortRegisteredValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((left, right) => {
    if (left.length !== right.length) {
      return right.length - left.length;
    }
    return left.localeCompare(right);
  });
}

// inline 标记自带明确边界，先处理它可以保留“这是显式机密”这一还原语义，避免后面的 registered 替换误改 <<s:...>> 内部内容。
export function maskInlineSecrets(text: string, store: TokenStore): string {
  return text.replace(INLINE_SECRET_PATTERN, (fullMatch, secretContent: string) => {
    if (secretContent.length === 0) {
      return fullMatch;
    }
    return formatVaultToken(store.getOrCreate(secretContent, "inline"));
  });
}

export function replaceRegisteredOutsideTokens(
  text: string,
  registeredValues: string[],
  store: TokenStore,
): string {
  const sortedValues = registeredValues;
  if (sortedValues.length === 0) {
    return text;
  }

  return text
    .split(TOKEN_SEGMENT_SPLIT_REGEX)
    .map((part) => {
      // 已经是 vault token 的片段必须跳过，否则 registered 替换会把刚生成的 token 再次命中，破坏映射稳定性。
      if (isVaultTokenSegment(part)) {
        return part;
      }

      let next = part;
      for (const secretValue of sortedValues) {
        if (!next.includes(secretValue)) {
          continue;
        }
        next = next.split(secretValue).join(formatVaultToken(store.getOrCreate(secretValue, "registered")));
      }
      return next;
    })
    .join("");
}

// 总顺序固定为“先 inline，后 registered”：先处理显式标记，再扫描剩余普通文本，能让还原时保留最准确的来源语义。
export function maskSecrets(params: {
  text: string;
  registeredValues: string[];
  store: TokenStore;
}): string {
  const maskedInline = maskInlineSecrets(params.text, params.store);
  return replaceRegisteredOutsideTokens(maskedInline, sortRegisteredValues(params.registeredValues), params.store);
}
