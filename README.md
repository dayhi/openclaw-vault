# openclaw-vault

Hide secrets (API keys, passwords, tokens) from AI conversations using `{{NAME}}` placeholders. The AI never sees real values — placeholders are automatically substituted in tool calls right before execution.

## Install

```bash
# 1. Confirm the plugin is discovered
openclaw plugins list

# 2. Enable
openclaw plugins enable openclaw-vault
```

The plugin directory is `~/.openclaw/extensions/openclaw-vault/`. No external dependencies required.

## Usage

### Register secrets

```
/secret add API_KEY sk-abcdef1234567890
/secret add DB_PASSWORD hunter2
/secret add SSH_HOST 192.168.1.100
```

Names are auto-uppercased. Values can contain spaces (everything after the name is the value).

### Manage secrets

```
/secret list              # Show registered placeholder names (never shows values)
/secret remove API_KEY    # Remove a single secret
/secret clear             # Remove all secrets
```

### Use in conversations

Once registered, just mention placeholders naturally:

```
User: Use {{API_KEY}} to call the OpenAI models endpoint
```

The AI sees `{{API_KEY}}` in your message and uses it as-is in tool calls:

```bash
# AI generates this command:
curl -H "Authorization: Bearer {{API_KEY}}" https://api.openai.com/v1/models

# before_tool_call hook substitutes the real value before execution:
curl -H "Authorization: Bearer sk-abcdef1234567890" https://api.openai.com/v1/models
```

The AI never receives the real value `sk-abcdef1234567890` — it only knows the placeholder name.

## How it works

| Component | Hook / API | Role |
|---|---|---|
| `/secret` command | `registerCommand` | CRUD for secrets, bypasses AI entirely |
| Prompt guard | `before_prompt_build` | Injects placeholder usage guide into system prompt |
| Tool call substitution | `before_tool_call` | Recursively replaces `{{NAME}}` with real values in tool params |
| `resolve_placeholder` tool | `registerTool` | AI can check if a placeholder exists (never reveals values) |

### Data flow

```
User message         →  AI sees {{API_KEY}} as literal text
AI tool call params  →  before_tool_call hook substitutes {{API_KEY}} → real value
Tool executes        →  uses real value
Tool output          →  returned to AI as-is (redaction of output is not yet implemented)
```

## Configuration

Optional — override the secrets file path in your openclaw config:

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

Default location: `~/.openclaw/secrets.json` (file permissions `0600`).

## File structure

```
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
    │   └── tool-call-sub.ts      # before_tool_call: {{NAME}} → real value
    └── tools/
        └── resolve-placeholder.ts  # AI tool: check if placeholder exists
```

## Notes

- Values shorter than 4 characters are skipped during redaction to avoid false matches
- Redaction sorts by value length (longest first) to prevent substring collisions
- `deepSubstitute` recursively processes all string values in nested objects/arrays
- The `resolve_placeholder` tool only returns `{ exists: boolean }` — never the real value
- Secrets persist in a JSON file across sessions
