import type { Command } from "commander";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { ProviderBackupStore } from "./provider-backup.js";
import { runProviderReconcile } from "./provider-reconcile.js";

export function registerVaultCli(params: {
  program: Command;
  runtime: PluginRuntime;
  backupStore: ProviderBackupStore;
  port: number;
}) {
  const root = params.program.command("vault").description("OpenClaw Vault utilities");

  root
    .command("setup")
    .description("同步 Vault provider 代理配置")
    .option("--json", "Print JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await runProviderReconcile({
        runtime: params.runtime,
        backupStore: params.backupStore,
        port: params.port,
      });

      const payload = {
        adopted: result.adopted,
        repaired: result.repaired,
        updated: result.updated,
        removed: result.removed,
        unresolved: result.unresolved,
        changed: result.changed,
        configChanged: result.configChanged,
        backupChanged: result.backupChanged,
        text: result.text,
      };

      // eslint-disable-next-line no-console
      console.log(options.json ? JSON.stringify(payload, null, 2) : result.text);
    });
}
