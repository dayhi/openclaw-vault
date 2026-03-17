import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerVaultCli } from "./src/cli.js";
import { createVaultCommandHandler } from "./src/commands.js";
import { PLUGIN_ID, DEFAULT_PROXY_PORT } from "./src/constants.js";
import { ProviderBackupStore } from "./src/provider-backup.js";
import { createProxyServer, resolveOriginalBaseUrls } from "./src/proxy-server.js";
import { SecretRegistry } from "./src/secret-registry.js";
const VAULT_PROMPT_GUIDANCE = [
  "Some user or tool content may include structured placeholders or protected opaque strings such as `<<s.ABC123>>`.",
  "These values are valid Vault-generated placeholders that temporarily stand in for protected secret content and may be restored outside the model later.",
  "Treat them as intentional exact data, not malformed text, invalid input, or natural language.",
  "Do not translate, summarize, normalize, repair, infer, explain away, split, or partially rewrite them.",
  "If you need to repeat them, pass them into a tool, write them to a file, or include them in output, preserve every character exactly as received.",
  "If such a value looks incomplete or unusual, leave it unchanged rather than guessing or asking the user to replace it just because it looks unfamiliar.",
].join("\n");

function resolveProxyPort(pluginConfig: Record<string, unknown> | undefined): number {
  const configured = pluginConfig?.proxy_port;
  return typeof configured === "number" && Number.isInteger(configured) ? configured : DEFAULT_PROXY_PORT;
}

function resolveRegistry(stateDir: string): SecretRegistry {
  return new SecretRegistry(path.join(stateDir, "vault-secrets.json"));
}

function resolveBackupStore(stateDir: string): ProviderBackupStore {
  return new ProviderBackupStore(path.join(stateDir, "vault-providers.json"));
}

// 插件注册阶段只做三件事：准备状态目录下的密文/备份存储，注册 /s 命令，以及注册本地代理 service。
const plugin = {
  id: PLUGIN_ID,
  name: "OpenClaw Vault",
  description: "Mask and restore secrets for provider HTTP and SSE traffic.",
  register(api: OpenClawPluginApi) {
    const stateDir = api.runtime.state.resolveStateDir();
    const registry = resolveRegistry(stateDir);
    const backupStore = resolveBackupStore(stateDir);
    const port = resolveProxyPort(api.pluginConfig);

    api.on("before_prompt_build", async () => ({
      prependSystemContext: VAULT_PROMPT_GUIDANCE,
    }));

    api.registerCommand({
      name: "s",
      description: "管理 Vault 密文与 Provider 检查",
      acceptsArgs: true,
      handler: createVaultCommandHandler({
        api,
        registry,
        backupStore,
        port,
      }),
    });

    api.registerCli(
      ({ program }) => {
        registerVaultCli({
          program,
          runtime: api.runtime,
          backupStore,
          port,
        });
      },
      { commands: ["vault"] },
    );

    let server: ReturnType<typeof createProxyServer> | null = null;

    api.registerService({
      id: "vault-proxy",
      // start/stop 跟随宿主 service 生命周期，负责占用与释放本地代理端口，避免插件重复启动时残留旧实例。
      async start(ctx) {
        if (server) {
          return;
        }

        // 这里必须先解析 provider 的真实上游地址。/s check 运行后 provider.baseUrl 可能已经被改成 Vault 代理，
        // 如果等收到请求时再直接读当前 provider 配置，就会把流量再次转回代理自己，形成自循环。
        const originalBaseUrls = await resolveOriginalBaseUrls({
          config: ctx.config,
          backupStore,
        });

        server = createProxyServer({
          registry,
          originalBaseUrls,
          logger: ctx.logger,
        });

        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server?.off("error", onError);
            reject(error);
          };
          server?.once("error", onError);
          server?.listen(port, "127.0.0.1", () => {
            server?.off("error", onError);
            resolve();
          });
        });
        ctx.logger.info(`[vault] proxy listening on 127.0.0.1:${port}`);
      },
      async stop(ctx) {
        if (!server) {
          return;
        }
        const current = server;
        server = null;
        await new Promise<void>((resolve, reject) => {
          current.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        ctx.logger.info("[vault] proxy stopped");
      },
    });
  },
};

export default plugin;
