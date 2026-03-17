import { describe, expect, it } from "vitest";
import { TokenStore } from "../../src/token-store.js";

describe("TokenStore", () => {
  it("为相同 value 的不同 source 分配不同 token", () => {
    const tokens = ["AAA111", "BBB222"];
    const store = new TokenStore(() => tokens.shift() ?? "CCC333");

    const inlineToken = store.getOrCreate("abc12345xyz", "inline");
    const registeredToken = store.getOrCreate("abc12345xyz", "registered");

    expect(inlineToken).toBe("AAA111");
    expect(registeredToken).toBe("BBB222");
    expect(store.restore(inlineToken)).toMatchObject({ source: "inline", value: "abc12345xyz" });
    expect(store.restore(registeredToken)).toMatchObject({ source: "registered", value: "abc12345xyz" });
  });

  it("对相同 source + value 复用 token", () => {
    const store = new TokenStore(() => "AAA111");

    expect(store.getOrCreate("same", "registered")).toBe("AAA111");
    expect(store.getOrCreate("same", "registered")).toBe("AAA111");
    expect(store.entries()).toHaveLength(1);
  });
});
