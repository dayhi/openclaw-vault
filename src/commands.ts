import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { ProviderBackupStore } from "./provider-backup.js";
import { runProviderReconcile } from "./provider-reconcile.js";
import { SecretRegistry } from "./secret-registry.js";

type VaultCommandDefinition = Parameters<OpenClawPluginApi["registerCommand"]>[0];
type VaultCommandContext = Parameters<VaultCommandDefinition["handler"]>[0];
type VaultCommandResult = Awaited<ReturnType<VaultCommandDefinition["handler"]>>;

type CommandDependencies = {
  api: OpenClawPluginApi;
  registry: SecretRegistry;
  backupStore: ProviderBackupStore;
  port: number;
};

function formatHelp(): string {
  return [
    "Vault 命令：",
    "",
    "/s add <name> <value>",
    "/s list",
    "/s remove <name>",
    "/s update <name> <value>",
    "/s check",
    "/s help",
  ].join("\n");
}

function toCommandErrorText(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (error.message.startsWith("secret already exists:")) {
    return `Vault 密文已存在：${error.message.slice("secret already exists:".length).trim()}`;
  }
  if (error.message.startsWith("secret not found:")) {
    return `Vault 密文不存在：${error.message.slice("secret not found:".length).trim()}`;
  }
  if (error.message === "secret name is required") {
    return "Vault 密文名称不能为空。";
  }
  if (error.message === "secret name cannot contain whitespace") {
    return "Vault 密文名称不能包含空白字符。";
  }
  if (error.message === "secret value is required") {
    return "Vault 密文内容不能为空。";
  }
  if (error.message === "secret value must be a single line") {
    return "Vault 密文内容必须为单行文本。";
  }
  return null;
}

function parseNameAndValue(args: string): { name: string; value: string } | null {
  const trimmed = args.trim();
  if (!trimmed) {
    return null;
  }
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return null;
  }
  const name = trimmed.slice(0, firstSpace).trim();
  const value = trimmed.slice(firstSpace).trimStart();
  if (!name || !value) {
    return null;
  }
  return { name, value };
}

export async function handleVaultCommand(
  params: CommandDependencies,
  ctx: VaultCommandContext,
): Promise<VaultCommandResult> {
  try {
    const args = ctx.args?.trim() ?? "";
    const [action = "help"] = args.split(/\s+/, 1);
    const normalizedAction = action.toLowerCase();

    if (normalizedAction === "help" || !args) {
      return { text: formatHelp() };
    }

    if (normalizedAction === "list") {
      const items = await params.registry.list();
      if (items.length === 0) {
        return { text: "Vault 密文列表为空。" };
      }
      return {
        text: [
          "Vault 密文列表：",
          ...items.map((item) => `- ${item.name} | len=${item.length} | sha256=${item.digest}`),
        ].join("\n"),
      };
    }

    if (normalizedAction === "add") {
      const parsed = parseNameAndValue(args.slice(action.length));
      if (!parsed) {
        return { text: "Usage: /s add <name> <value>" };
      }
      await params.registry.add(parsed.name, parsed.value);
      return {
        text:
          `Vault 密文已添加：${parsed.name}\n` +
          "注意：/s add 命令消息本身仍可能出现在宿主聊天、转录或日志里，请只使用临时测试密文。",
      };
    }

    if (normalizedAction === "update") {
      const parsed = parseNameAndValue(args.slice(action.length));
      if (!parsed) {
        return { text: "Usage: /s update <name> <value>" };
      }
      await params.registry.update(parsed.name, parsed.value);
      return { text: `Vault 密文已更新：${parsed.name}` };
    }

    if (normalizedAction === "remove") {
      const name = args.slice(action.length).trim();
      if (!name) {
        return { text: "Usage: /s remove <name>" };
      }
      const removed = await params.registry.remove(name);
      return { text: removed ? `Vault 密文已移除：${name}` : `Vault 密文不存在：${name}` };
    }

    if (normalizedAction === "check") {
      const result = await runProviderReconcile({
        runtime: params.api.runtime,
        backupStore: params.backupStore,
        port: params.port,
      });
      return { text: result.text };
    }

    return { text: formatHelp() };
  } catch (error) {
    return { text: toCommandErrorText(error) ?? "Vault 命令执行失败。" };
  }
}

export function createVaultCommandHandler(params: CommandDependencies) {
  return async (ctx: VaultCommandContext): Promise<VaultCommandResult> => {
    return await handleVaultCommand(params, ctx);
  };
}
