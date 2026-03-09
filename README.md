# openclaw-vault

A lightweight OpenClaw plugin that hides secrets from AI conversations by using `{{NAME}}` placeholders and substituting real values only at tool execution time.

## 中文简介

`openclaw-vault` 是一个用于 **OpenClaw** 的轻量插件，用来在与 AI 对话时隐藏敏感信息（如 API Key、密码、Token、主机地址等）。

你只需要在对话中使用 `{{API_KEY}}` 这样的占位符，AI 看到的始终只是占位符本身；真正的值会在工具调用执行前自动替换，因此 **AI 不会直接看到你的真实密钥**。

### 适用场景

- 在 AI 对话中安全地使用 API Key
- 避免将数据库密码、Token、SSH 地址直接暴露给模型
- 在保留可用性的同时，降低敏感信息泄露风险

## Features

- Hide secrets from the AI using `{{NAME}}` placeholders
- Substitute real values only in `before_tool_call`
- Manage secrets with `/secret add|list|remove|clear`
- Let the AI check placeholder existence without exposing values
- Persist secrets locally in a JSON file across sessions
- No external runtime dependencies

## 安装

```bash
# 1. 确认插件已被发现
openclaw plugins list

# 2. 启用插件
openclaw plugins enable openclaw-vault
```

插件目录：`~/.openclaw/extensions/openclaw-vault/`

## 快速开始

### 1. 注册密钥

```bash
/secret add API_KEY sk-abcdef1234567890
/secret add DB_PASSWORD hunter2
/secret add SSH_HOST 192.168.1.100
```

说明：

- 名称会自动转为大写
- 名称后的所有内容都会被当作 value，因此支持空格

### 2. 管理密钥

```bash
/secret list              # 仅显示占位符名称，不显示真实值
/secret remove API_KEY    # 删除单个密钥
/secret clear             # 清空全部密钥
```

### 3. 在对话中使用占位符

注册完成后，可以直接在对话里自然使用：

```text
User: Use {{API_KEY}} to call the OpenAI models endpoint
```

AI 看到的内容仍然是占位符：

```bash
curl -H "Authorization: Bearer {{API_KEY}}" https://api.openai.com/v1/models
```

在真正执行工具调用前，插件会自动替换为真实值：

```bash
curl -H "Authorization: Bearer sk-abcdef1234567890" https://api.openai.com/v1/models
```

## How It Works

| Component | Hook / API | Role |
|---|---|---|
| `/secret` command | `registerCommand` | CRUD for secrets without involving the AI |
| Prompt guard | `before_prompt_build` | Injects placeholder usage guidance into the prompt |
| Tool call substitution | `before_tool_call` | Replaces `{{NAME}}` with real values in tool parameters |
| `resolve_placeholder` tool | `registerTool` | Lets the AI check whether a placeholder exists |

### Data Flow

```text
User message         -> AI sees {{API_KEY}} as plain text
AI tool call params  -> before_tool_call replaces {{API_KEY}} with the real value
Tool executes        -> Uses the real secret
Tool output          -> Returned as-is
```

## 安全说明

### AI 能看到什么？

AI 只能看到：

- `{{API_KEY}}`
- `{{DB_PASSWORD}}`
- `{{SSH_HOST}}`

AI **不能直接看到** 这些占位符对应的真实值。

### 当前限制

- 工具输出返回后，目前 **还没有实现输出结果脱敏**
- 如果外部工具或接口把密钥原样返回到输出中，理论上仍可能暴露给 AI

因此，这个插件主要解决的是：

- **输入给 AI 的敏感信息隐藏**
- **执行工具调用时的自动替换**

而不是完整的端到端输出脱敏系统。

## Configuration

You can optionally override the secrets file path in your OpenClaw config:

```json
{
  "plugins": {
    "openclaw-vault": {
      "secrets": {
        "file": "~/my-secrets.json"
      }
    }
  }
}
```

Default location:

```text
~/.openclaw/secrets.json
```

The file is intended to use `0600` permissions.

## File Structure

```text
~/.openclaw/extensions/openclaw-vault/
├── openclaw.plugin.json          # Plugin manifest
├── package.json                  # No runtime dependencies
├── index.ts                      # Entry: registers command/hooks/tool
└── src/
    ├── secrets/
    │   └── secret-store.ts       # CRUD + redact() + substitute() + deepSubstitute()
    ├── commands/
    │   └── secret-command.ts     # /secret add|remove|list|clear
    ├── hooks/
    │   ├── prompt-guard.ts       # before_prompt_build: inject placeholder guide
    │   └── tool-call-sub.ts      # before_tool_call: {{NAME}} -> real value
    └── tools/
        └── resolve-placeholder.ts  # AI tool: check if placeholder exists
```

## Notes

- Values shorter than 4 characters are skipped during redaction to reduce false matches
- Redaction sorts by value length first to avoid substring collisions
- `deepSubstitute` recursively processes nested objects and arrays
- `resolve_placeholder` only returns `{ exists: boolean }`
- Secrets are stored locally and persist across sessions

## English

`openclaw-vault` helps you use secrets safely in AI conversations by replacing real values with placeholders such as `{{API_KEY}}`. The model only sees placeholder names, while the real values are injected right before tool execution.

This is useful for API keys, passwords, tokens, database credentials, and internal host addresses that should not appear directly in prompts.

## License

Currently not specified.
