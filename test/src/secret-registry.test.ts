import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretRegistry } from "../../src/secret-registry.js";

describe("SecretRegistry", () => {
  let tempDir = "";
  let registryPath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vault-registry-"));
    registryPath = path.join(tempDir, "vault-secrets.json");
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("list 不回显 secret 明文", async () => {
    const registry = new SecretRegistry(registryPath);
    await registry.add("demo", "abc12345xyz");

    const items = await registry.list();

    expect(items).toEqual([
      {
        name: "demo",
        length: 11,
        digest: expect.any(String),
      },
    ]);
    expect(JSON.stringify(items)).not.toContain("abc12345xyz");
  });

  it("sortedValues 按长度倒序返回去重结果", async () => {
    const registry = new SecretRegistry(registryPath);
    await registry.add("short", "abc");
    await registry.add("long", "abc12345xyz");
    await registry.add("same-value", "abc12345xyz2");

    expect(await registry.sortedValues()).toEqual(["abc12345xyz2", "abc12345xyz", "abc"]);
  });
});
