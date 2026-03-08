import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/openclaw-vault";
import { SecretStore } from "./src/secrets/secret-store.js";
import { secretCommandHandler } from "./src/commands/secret-command.js";
import { promptGuardHandler } from "./src/hooks/prompt-guard.js";
import { toolCallSubHandler } from "./src/hooks/tool-call-sub.js";
import { createResolvePlaceholderTool } from "./src/tools/resolve-placeholder.js";

const plugin = {
  id: "openclaw-vault",
  name: "Secret Placeholder",
  description: "Hide secrets from AI with placeholder substitution in tool calls",

  register(api: OpenClawPluginApi) {
    // Resolve secrets file path from plugin config or default to state dir
    const pluginCfg = (api.pluginConfig ?? {}) as {
      secrets?: { file?: string; autoRedact?: boolean };
    };
    const secretsFile = pluginCfg.secrets?.file
      ? api.resolvePath(pluginCfg.secrets.file)
      : path.join(api.resolvePath("~/.openclaw"), "secrets.json");

    const secretStore = new SecretStore(secretsFile, api.logger);

    // /secret command — fully bypasses AI
    api.registerCommand({
      name: "secret",
      description: "Manage secret placeholders: add, remove, list, clear",
      acceptsArgs: true,
      handler: secretCommandHandler(secretStore),
    });

    // Inject placeholder usage guide into system prompt
    api.on("before_prompt_build", promptGuardHandler(secretStore));

    // Substitute {{NAME}} → real values in tool call params
    api.on("before_tool_call", toolCallSubHandler(secretStore, api.logger));

    // AI tool to check if a placeholder exists (never reveals values)
    api.registerTool(createResolvePlaceholderTool(secretStore));

    api.logger.info?.(`secret-placeholder: plugin registered (secrets file: ${secretsFile})`);
  },
};

export default plugin;
