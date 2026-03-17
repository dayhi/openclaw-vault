import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test-utils/plugin-api.js";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import plugin from "../index.js";

type RegisteredCommand = Parameters<OpenClawPluginApi["registerCommand"]>[0];
type RegisteredCli = Parameters<OpenClawPluginApi["registerCli"]>[0];
type RegisteredCliOptions = Parameters<OpenClawPluginApi["registerCli"]>[1];
type RegisteredService = Parameters<OpenClawPluginApi["registerService"]>[0];

describe("openclaw-vault plugin", () => {
  it("同步注册 /s 命令、vault CLI 和 vault-proxy service", () => {
    let registeredCommand: RegisteredCommand | undefined;
    let registeredCli: RegisteredCli | undefined;
    let registeredCliOptions: RegisteredCliOptions | undefined;
    let registeredService: RegisteredService | undefined;

    const api = createTestPluginApi({
      id: "openclaw-vault",
      name: "OpenClaw Vault",
      source: "test",
      config: {},
      pluginConfig: {
        proxy_port: 19100,
      },
      runtime: createPluginRuntimeMock({
        state: {
          resolveStateDir: vi.fn(() => "/tmp/openclaw-test"),
        },
      }),
      registerCommand(command: RegisteredCommand) {
        registeredCommand = command;
      },
      registerCli(cli: RegisteredCli, options?: RegisteredCliOptions) {
        registeredCli = cli;
        registeredCliOptions = options;
      },
      registerService(service: RegisteredService) {
        registeredService = service;
      },
    }) as OpenClawPluginApi;

    const result = plugin.register(api);

    expect(result).toBeUndefined();
    expect(registeredCommand).toMatchObject({
      name: "s",
      acceptsArgs: true,
    });
    expect(typeof registeredCommand?.handler).toBe("function");
    expect(typeof registeredCli).toBe("function");
    expect(registeredCliOptions).toEqual({ commands: ["vault"] });
    expect(registeredService).toMatchObject({ id: "vault-proxy" });
    expect(typeof registeredService?.start).toBe("function");
    expect(typeof registeredService?.stop).toBe("function");
  });
});
