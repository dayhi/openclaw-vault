import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/openclaw-vault";
import { SecretStore } from "./src/secrets/secret-store.js";
import { secretCommandHandler } from "./src/commands/secret-command.js";
import { contextRedactHandler } from "./src/hooks/context-redact.js";
import { toolCallSubHandler } from "./src/hooks/tool-call-sub.js";
import { toolResultRedactHandler } from "./src/hooks/tool-result-redact.js";
import { messageWriteRedactHandler } from "./src/hooks/message-write-redact.js";
import { messageSendingSubHandler } from "./src/hooks/message-sending-sub.js";
import { createResolvePlaceholderTool } from "./src/tools/resolve-placeholder.js";

type PluginConfig = {
  secrets?: {
    file?: string;
    enableContextRedaction?: boolean;
    enableOutputSubstitution?: boolean;
  };
};

const plugin = {
  id: "openclaw-vault",
  name: "Secret Placeholder",
  description:
    "Hard-masking secret management: AI never sees real values. Secrets are auto-redacted before reaching the model and restored at tool execution and user display.",

  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as PluginConfig;
    const secretsCfg = pluginCfg.secrets ?? {};
    const enableContextRedaction = secretsCfg.enableContextRedaction ?? true;
    const enableOutputSubstitution = secretsCfg.enableOutputSubstitution ?? true;

    const secretsFile = secretsCfg.file
      ? api.resolvePath(secretsCfg.file)
      : path.join(api.resolvePath("~/.openclaw"), "secrets.json");

    const secretStore = new SecretStore(secretsFile, api.logger);

    // 1. before_prompt_build — redact all messages before AI sees them
    if (enableContextRedaction) {
      api.on("before_prompt_build", contextRedactHandler(secretStore), { priority: 100 });
    }

    // 2. before_tool_call — substitute placeholders with real values for tool execution
    api.on("before_tool_call", toolCallSubHandler(secretStore, api.logger));

    // 3. tool_result_persist (sync) — extract vault markers + redact tool results
    api.on("tool_result_persist", toolResultRedactHandler(secretStore, api.logger));

    // 4. before_message_write (sync) — safety net: redact before writing to JSONL
    api.on("before_message_write", messageWriteRedactHandler(secretStore));

    // 5. message_sending — substitute placeholders back to real values for user display
    if (enableOutputSubstitution) {
      api.on("message_sending", messageSendingSubHandler(secretStore, api.logger));
    }

    // 6. /secret slash command
    api.registerCommand({
      name: "secret",
      description: "Manage secret placeholders: add, remove, list, clear",
      acceptsArgs: true,
      handler: secretCommandHandler(secretStore),
    });

    // 7. resolve_placeholder tool
    api.registerTool(createResolvePlaceholderTool(secretStore));

    api.logger.info?.(`secret-placeholder: plugin registered (secrets file: ${secretsFile})`);
  },
};

export default plugin;
