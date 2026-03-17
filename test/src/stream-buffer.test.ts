import { describe, expect, it } from "vitest";
import { StreamBuffer } from "../../src/stream-buffer.js";

describe("StreamBuffer", () => {
  it("保留跨 chunk 被截断的 token", () => {
    const buffer = new StreamBuffer();

    expect(buffer.push("data: <<s.AAA")).toBe("data: ");
    expect(buffer.getPending()).toBe("<<s.AAA");
    expect(buffer.push("111>>\n\nmore")).toBe("<<s.AAA111>>\n\nmore");
    expect(buffer.getPending()).toBe("");
  });
});
