import { describe, expect, it } from "vitest";
import { restoreSecrets } from "../../src/restore.js";
import { TokenStore } from "../../src/token-store.js";

describe("restoreSecrets", () => {
  it("按 source 还原 inline 和 registered token", () => {
    const tokens = ["AAA111", "BBB222"];
    const store = new TokenStore(() => tokens.shift() ?? "CCC333");
    store.getOrCreate("abc12345xyz", "inline");
    store.getOrCreate("abc12345xyz", "registered");

    expect(restoreSecrets("<<s.AAA111>> :: <<s.BBB222>>", store)).toBe(
      "<<s:abc12345xyz>> :: abc12345xyz",
    );
  });

  it("保留未知 token 原样", () => {
    const store = new TokenStore(() => "AAA111");
    expect(restoreSecrets("before <<s.ZZZ999>> after", store)).toBe("before <<s.ZZZ999>> after");
  });
});
