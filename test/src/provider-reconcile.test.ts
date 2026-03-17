import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test-utils/plugin-runtime-mock.js";
import { ProviderBackupStore } from "../../src/provider-backup.js";
import { reconcileVaultProviders, runProviderReconcile } from "../../src/provider-reconcile.js";

describe("provider-reconcile", () => {
  let tempDir = "";
  let backupPath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vault-provider-"));
    backupPath = path.join(tempDir, "vault-providers.json");
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("/s check 写回 provider baseUrl 和 secrets_baseurls", async () => {
    const backupStore = new ProviderBackupStore(backupPath);
    const config: OpenClawConfig = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com/v1",
            api: "anthropic-messages",
            models: [],
          },
          openai: {
            baseUrl: "http://127.0.0.1:19100/openai",
            api: "openai-responses",
            models: [],
          },
        },
      },
      plugins: {
        entries: {
          "openclaw-vault": {
            enabled: true,
            config: {
              proxy_port: 19100,
              secrets_baseurls: {
                openai: "https://api.openai.com/v1",
              },
            },
          },
        },
      },
    };

    const summary = await reconcileVaultProviders({
      config,
      backupStore,
      port: 19100,
    });

    expect(summary.adopted).toEqual(["anthropic"]);
    expect(summary.nextConfig.models?.providers?.anthropic?.baseUrl).toBe("http://127.0.0.1:19100/anthropic");
    expect(summary.nextConfig.plugins?.entries?.["openclaw-vault"]?.config?.secrets_baseurls).toEqual({
      anthropic: "https://api.anthropic.com/v1",
      openai: "https://api.openai.com/v1",
    });
    expect(summary.nextBackups).toEqual({
      anthropic: "https://api.anthropic.com/v1",
      openai: "https://api.openai.com/v1",
    });
  });

  it("用 backup 恢复缺失的 secrets_baseurls 记录", async () => {
    const backupStore = new ProviderBackupStore(backupPath);
    await backupStore.replaceAll({ openai: "https://api.openai.com/v1" });

    const summary = await reconcileVaultProviders({
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:19100/openai",
              api: "openai-responses",
              models: [],
            },
          },
        },
        plugins: {
          entries: {
            "openclaw-vault": {
              enabled: true,
              config: { proxy_port: 19100 },
            },
          },
        },
      },
      backupStore,
      port: 19100,
    });

    expect(summary.repaired).toEqual(["openai"]);
    expect(summary.nextConfig.plugins?.entries?.["openclaw-vault"]?.config?.secrets_baseurls).toEqual({
      openai: "https://api.openai.com/v1",
    });
  });

  it("runProviderReconcile 在有变更时写配置和 backup", async () => {
    const backupStore = new ProviderBackupStore(backupPath);
    const writeConfigFile = vi.fn();
    const runtime = createPluginRuntimeMock({
      config: {
        loadConfig: vi.fn(() => ({
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.com/v1",
                api: "anthropic-messages",
                models: [],
              },
            },
          },
          plugins: {
            entries: {
              "openclaw-vault": {
                enabled: true,
                config: {
                  proxy_port: 19100,
                  secrets_baseurls: {},
                },
              },
            },
          },
        })),
        writeConfigFile,
      },
    });

    const result = await runProviderReconcile({
      runtime,
      backupStore,
      port: 19100,
    });

    expect(result.configChanged).toBe(true);
    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    expect((await backupStore.load()).providers).toEqual({
      anthropic: "https://api.anthropic.com/v1",
    });
  });
});
