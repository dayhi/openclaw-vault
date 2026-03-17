import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { buildProxyUrl, isProxyUrlForProvider } from "./url-forward.js";
import { ProviderBackupStore } from "./provider-backup.js";

const PLUGIN_ID = "openclaw-vault";

export type VaultPluginConfig = {
  proxy_port?: number;
  secrets_baseurls?: Record<string, string>;
};

export type ReconcileSummary = {
  adopted: string[];
  repaired: string[];
  updated: string[];
  removed: string[];
  unresolved: string[];
  changed: boolean;
  configChanged: boolean;
  backupChanged: boolean;
  nextConfig: OpenClawConfig;
  nextBackups: Record<string, string>;
};

type MutableProviderConfig = {
  baseUrl: string;
  models?: unknown[];
  [key: string]: unknown;
};

type MutableConfig = OpenClawConfig & {
  plugins?: NonNullable<OpenClawConfig["plugins"]>;
  models?: NonNullable<OpenClawConfig["models"]>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeBaseUrlMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(([providerId, baseUrl]) => providerId.trim() && typeof baseUrl === "string" && baseUrl.trim())
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function ensureVaultPluginConfig(config: MutableConfig): Record<string, unknown> {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  const entries = config.plugins.entries as Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
  const existingEntry = entries[PLUGIN_ID] ?? {};
  if (!existingEntry.config || typeof existingEntry.config !== "object" || Array.isArray(existingEntry.config)) {
    existingEntry.config = {};
  }
  entries[PLUGIN_ID] = existingEntry;
  return existingEntry.config as Record<string, unknown>;
}

function getVaultPluginConfig(config: OpenClawConfig): VaultPluginConfig {
  const entry = config.plugins?.entries?.[PLUGIN_ID] as
    | { enabled?: boolean; config?: Record<string, unknown> }
    | undefined;
  return {
    proxy_port: typeof entry?.config?.proxy_port === "number" ? entry.config.proxy_port : undefined,
    secrets_baseurls: normalizeBaseUrlMap(entry?.config?.secrets_baseurls),
  };
}

function getMutableProviders(config: MutableConfig): Record<string, MutableProviderConfig> {
  const providers = config.models?.providers;
  return typeof providers === "object" && providers !== null
    ? (providers as Record<string, MutableProviderConfig>)
    : {};
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

export function formatReconcileSummary(summary: ReconcileSummary): string {
  const lines = [
    "Vault 检查完成：",
    `- 新接管: ${formatList(summary.adopted)}`,
    `- 修复回代理: ${formatList(summary.repaired)}`,
    `- 更新原始 URL: ${formatList(summary.updated)}`,
    `- 清理陈旧记录: ${formatList(summary.removed)}`,
    `- 无法自动修复: ${formatList(summary.unresolved)}`,
  ];

  if (summary.unresolved.length > 0) {
    lines.push(
      "",
      "无法自动修复的 Provider 当前已指向 Vault 代理，但缺少原始 URL 记录。",
      "请先把对应 provider.baseUrl 手动改回真实上游 URL，再重新执行 /s check。",
    );
  }

  if (summary.configChanged) {
    lines.push("", "本次已写回配置，请重启 OpenClaw Gateway 生效。");
  } else if (summary.backupChanged) {
    lines.push("", "已同步 Vault 备份记录，无需重启。");
  }

  return lines.join("\n");
}

// /s check 的目标不是只做展示，而是尽量把 provider 拉回 Vault 可接管的稳定状态：
// 接管真实上游 URL、修复代理映射，并同步 secrets_baseurls 与 backup 记录。
export async function reconcileVaultProviders(params: {
  config: OpenClawConfig;
  backupStore: ProviderBackupStore;
  port: number;
}): Promise<ReconcileSummary> {
  const nextConfig = structuredClone(params.config) as MutableConfig;
  const backupFile = await params.backupStore.load();
  const currentPluginConfig = getVaultPluginConfig(nextConfig);
  const mutablePluginConfig = ensureVaultPluginConfig(nextConfig);
  const providers = getMutableProviders(nextConfig);
  const secretsBaseUrls = { ...currentPluginConfig.secrets_baseurls };
  const backups = { ...backupFile.providers };

  const adopted: string[] = [];
  const repaired: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const unresolved: string[] = [];
  let configChanged = false;
  let backupChanged = false;

  for (const [providerId, provider] of Object.entries(providers)) {
    const currentBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
    if (!currentBaseUrl.trim()) {
      continue;
    }

    const desiredProxyUrl = buildProxyUrl(params.port, providerId);
    // configOriginal 来自主配置里的 secrets_baseurls，backupOriginal 来自独立备份文件；
    // recordedOriginal 按“配置优先、备份兜底”合并，避免两边不一致时继续扩散旧值。
    const configOriginal = secretsBaseUrls[providerId];
    const backupOriginal = backups[providerId];
    const recordedOriginal = configOriginal ?? backupOriginal;
    const currentIsProxy = isProxyUrlForProvider(currentBaseUrl, params.port, providerId);

    if (!currentIsProxy) {
      // 当前 provider 还指向真实上游：要么是第一次接管，要么是用户/外部流程把代理改掉了，这里统一修回 Vault。
      if (!recordedOriginal) {
        secretsBaseUrls[providerId] = currentBaseUrl;
        backups[providerId] = currentBaseUrl;
        provider.baseUrl = desiredProxyUrl;
        adopted.push(providerId);
        configChanged = true;
        backupChanged = true;
        continue;
      }

      if (recordedOriginal === currentBaseUrl) {
        if (provider.baseUrl !== desiredProxyUrl) {
          provider.baseUrl = desiredProxyUrl;
          repaired.push(providerId);
          configChanged = true;
        }
        if (!backups[providerId]) {
          backups[providerId] = recordedOriginal;
          backupChanged = true;
        }
        continue;
      }

      secretsBaseUrls[providerId] = currentBaseUrl;
      backups[providerId] = currentBaseUrl;
      provider.baseUrl = desiredProxyUrl;
      updated.push(providerId);
      configChanged = true;
      backupChanged = true;
      continue;
    }

    // 当前 provider 已经在走代理，此时只补齐或对齐原始 URL 记录；如果两份记录都丢了，就不能安全猜测真实上游。
    if (configOriginal && backupOriginal) {
      if (configOriginal !== backupOriginal) {
        backups[providerId] = configOriginal;
        backupChanged = true;
      }
      continue;
    }

    if (configOriginal && !backupOriginal) {
      backups[providerId] = configOriginal;
      backupChanged = true;
      continue;
    }

    if (!configOriginal && backupOriginal) {
      secretsBaseUrls[providerId] = backupOriginal;
      repaired.push(providerId);
      configChanged = true;
      continue;
    }

    unresolved.push(providerId);
  }

  // 已经不存在的 provider 历史记录要及时清理，否则 /s check 会一直带着陈旧映射，后续排障时容易误判。
  const activeProviderIds = new Set(Object.keys(providers));
  for (const providerId of new Set([...Object.keys(secretsBaseUrls), ...Object.keys(backups)])) {
    if (activeProviderIds.has(providerId)) {
      continue;
    }
    let removedAnything = false;
    if (providerId in secretsBaseUrls) {
      delete secretsBaseUrls[providerId];
      configChanged = true;
      removedAnything = true;
    }
    if (providerId in backups) {
      delete backups[providerId];
      backupChanged = true;
      removedAnything = true;
    }
    if (removedAnything) {
      removed.push(providerId);
    }
  }

  mutablePluginConfig.secrets_baseurls = Object.fromEntries(
    Object.entries(secretsBaseUrls).sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    adopted,
    repaired,
    updated,
    removed,
    unresolved,
    changed: configChanged || backupChanged,
    configChanged,
    backupChanged,
    nextConfig,
    nextBackups: Object.fromEntries(
      Object.entries(backups).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

// reconcileVaultProviders 只负责计算“下一份配置应该长什么样”，真正写回 runtime config 和 backup 的副作用统一放在这里。
export async function runProviderReconcile(params: {
  runtime: PluginRuntime;
  backupStore: ProviderBackupStore;
  port: number;
}): Promise<ReconcileSummary & { text: string }> {
  const config = params.runtime.config.loadConfig();
  const summary = await reconcileVaultProviders({
    config,
    backupStore: params.backupStore,
    port: params.port,
  });

  if (summary.backupChanged) {
    await params.backupStore.replaceAll(summary.nextBackups);
  }
  if (summary.configChanged) {
    await params.runtime.config.writeConfigFile(summary.nextConfig);
  }

  return {
    ...summary,
    text: formatReconcileSummary(summary),
  };
}

export function getConfiguredProxyPort(config: OpenClawConfig): number | undefined {
  return getVaultPluginConfig(config).proxy_port;
}

export function getConfiguredSecretBaseUrls(config: OpenClawConfig): Record<string, string> {
  return { ...getVaultPluginConfig(config).secrets_baseurls };
}
