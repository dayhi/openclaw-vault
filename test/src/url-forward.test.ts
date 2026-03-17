import { describe, expect, it } from "vitest";
import { buildUpstreamUrl, countPathOverlap } from "../../src/url-forward.js";

describe("url-forward", () => {
  it("避免 /v1/v1 路径重复", () => {
    const url = buildUpstreamUrl({
      originalBaseUrlRaw: "https://api.anthropic.com/v1",
      requestSuffixPath: "v1/messages",
      search: "?beta=true",
    });

    expect(url.toString()).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  it("支持更长路径前缀重叠", () => {
    const url = buildUpstreamUrl({
      originalBaseUrlRaw: "https://api.z.ai/api/paas/v4",
      requestSuffixPath: "api/paas/v4/chat/completions",
    });

    expect(url.toString()).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  });

  it("计算最长重叠路径长度", () => {
    expect(countPathOverlap(["api", "paas", "v4"], ["api", "paas", "v4", "chat"]))
      .toBe(3);
  });
});
