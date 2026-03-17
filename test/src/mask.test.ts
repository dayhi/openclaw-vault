import { describe, expect, it } from "vitest";
import { maskSecrets } from "../../src/mask.js";
import { TokenStore } from "../../src/token-store.js";

describe("maskSecrets", () => {
  it("先处理 inline，再跳过已生成 token 片段做 registered 替换", () => {
    const tokens = ["AAA111", "BBB222", "CCC333"];
    const store = new TokenStore(() => tokens.shift() ?? "DDD444");

    const masked = maskSecrets({
      text: "before <<s:abc12345xyz>> middle abc12345xyz after token <<s.AAA111>>",
      registeredValues: ["abc12345xyz"],
      store,
    });

    expect(masked).toBe(
      "before <<s.AAA111>> middle <<s.BBB222>> after token <<s.AAA111>>",
    );
    expect(store.restore("AAA111")).toMatchObject({ source: "inline", value: "abc12345xyz" });
    expect(store.restore("BBB222")).toMatchObject({ source: "registered", value: "abc12345xyz" });
  });

  it("优先替换更长的 registered secret", () => {
    const tokens = ["AAA111", "BBB222"];
    const store = new TokenStore(() => tokens.shift() ?? "CCC333");

    const masked = maskSecrets({
      text: "abc12345xyz abc123",
      registeredValues: ["abc123", "abc12345xyz"],
      store,
    });

    expect(masked).toBe("<<s.AAA111>> <<s.BBB222>>");
  });
});
