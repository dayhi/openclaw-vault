# openclaw-vault

> **Hard-masking** secret management plugin — the AI **never** sees real secret values.

[中文文档](./README.md)

`openclaw-vault` is a security plugin for [OpenClaw](https://github.com/nicepkg/openclaw). It guarantees at the architecture level that the AI model only sees `{{NAME}}` placeholders. Real values are injected only when tools actually execute, tool results are automatically redacted before flowing back to the AI, and values are restored when displayed to the user.

## Core Features

- **Hard-masking architecture** — All messages have real values replaced with `{{NAME}}` before reaching the AI; the model physically cannot access plaintext secrets
- **Auto-restore at tool execution** — `before_tool_call` replaces `{{NAME}}` with real values; tools receive plaintext
- **Auto-redact tool results** — Tool output has real values replaced back to `{{NAME}}` before persistence
- **JSONL safety net** — `before_message_write` ensures session history files never contain real values
- **User display restoration** — `message_sending` replaces `{{NAME}}` with real values for user-facing output
- **Vault marker protocol** — External tools can register secrets via `<<VAULT:NAME=VALUE>>` markers with zero exposure
- **`/secret` command** — Interactive secret management: add, remove, list, clear
- **`resolve_placeholder` tool** — AI can check if a placeholder exists without exposing real values
- **Cross-session persistence** — Secrets stored in a local JSON file, auto-loaded on restart
- **Zero runtime dependencies** — Pure Node.js implementation

## Compatibility

| Requirement | Version |
|-------------|---------|
| OpenClaw | `>=v2026.3.8` (must support `before_prompt_build`, `before_tool_call`, `tool_result_persist`, `before_message_write`, `message_sending` hooks) |
| Node.js | `>=18` |

## Installation

```bash
# 1. Clone into the OpenClaw extensions directory
git clone https://github.com/nicepkg/openclaw-vault.git ~/.openclaw/extensions/openclaw-vault

# 2. Verify the plugin is discovered
openclaw plugins list

# 3. Enable the plugin
openclaw plugins enable openclaw-vault
```

Or manually place the project folder at `~/.openclaw/extensions/openclaw-vault/`.

## Quick Start

### 1. Register Secrets

```bash
/secret add API_KEY sk-abcdef1234567890
/secret add DB_PASSWORD hunter2
/secret add SSH_HOST 192.168.1.100
```

- Names are automatically normalized to uppercase
- Everything after the name is treated as the value (spaces supported)
- Placeholder format: `{{NAME}}`

### 2. Manage Secrets

```bash
/secret list              # Show placeholder names only, never real values
/secret remove API_KEY    # Remove a single secret
/secret clear             # Clear all secrets
```

### 3. Use in Conversations

After registration, use placeholders naturally in conversations:

```
User: Use {{API_KEY}} to call the OpenAI models endpoint
```

The AI only ever sees placeholders:

```
AI: Sure, I'll call the API.
    curl -H "Authorization: Bearer {{API_KEY}}" https://api.openai.com/v1/models
```

Real values are substituted only at actual tool execution:

```
Executed: curl -H "Authorization: Bearer sk-abcdef1234567890" https://api.openai.com/v1/models
```

Tool results are redacted before flowing back to the AI:

```
Tool returns: {"api_key": "sk-abcdef1234567890", ...}
AI sees:      {"api_key": "{{API_KEY}}", ...}
```

User-facing output restores real values:

```
AI internal: The api_key in the result is {{API_KEY}}
User sees:   The api_key in the result is sk-abcdef1234567890
```

### 4. Vault Markers (Tool-Initiated Secret Registration)

External tools can embed special markers in their return text to register new secrets:

```
Tool returns: Got token <<VAULT:ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9.xxx>>, ready to use
```

The plugin automatically:
1. Extracts the `<<VAULT:ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9.xxx>>` marker
2. Registers `ACCESS_TOKEN` in the secret store
3. Removes the marker from the text
4. Replaces all subsequent occurrences of the value with `{{ACCESS_TOKEN}}`

The AI ultimately sees:

```
Got token , ready to use
```

## How It Works

### Data Flow

```
User input
  ↓
before_message_write (sync) → redact real values → write to JSONL
  ↓
before_prompt_build → in-place redact messages[] (safety net) → inject placeholder list
  ↓
AI only sees {{NAME}} placeholders
  ↓
before_tool_call → {{NAME}} → real value
  ↓
Tool executes (uses real value)
  ↓
tool_result_persist (sync) → extract <<VAULT:...>> markers + redact result
  ↓
before_message_write (sync) → redact again (safety net)
  ↓
AI sees only {{NAME}} in results
  ↓
message_sending → {{NAME}} → real value displayed to user
```

### Hook Overview

| Hook | File | Sync/Async | Purpose |
|------|------|------------|---------|
| `before_prompt_build` | `context-redact.ts` | Async | Traverse all messages, in-place redact real values; inject available placeholder list |
| `before_tool_call` | `tool-call-sub.ts` | Async | Replace `{{NAME}}` in tool parameters with real values |
| `tool_result_persist` | `tool-result-redact.ts` | **Sync** | Extract vault markers → batch register → redact tool results |
| `before_message_write` | `message-write-redact.ts` | **Sync** | Safety net: ensure JSONL never contains real values |
| `message_sending` | `message-sending-sub.ts` | Async | Replace `{{NAME}}` with real values for user display |

### Two Ways to Register Secrets

**Method 1: `/secret` command (manual)**

```bash
/secret add MY_TOKEN abc123
```

Calls `SecretStore.set()` directly via closure. The value never passes through the AI. Zero exposure.

**Method 2: Vault markers (tool-initiated)**

External tools embed `<<VAULT:NAME=VALUE>>` markers in their return text. The `tool_result_persist` hook extracts and registers them. Markers are removed from the text; the value is never seen by the AI.

Marker format:
```
<<VAULT:SECRET_NAME=secret_value_here>>
```

Rules:
- Name must start with an uppercase letter or underscore, containing only uppercase letters, digits, and underscores
- Value supports any characters (including newlines), ending at the shortest `>>` match
- Multiple markers can appear in a single text

## Adapting Existing Skills

Depending on the relationship between your skill and this plugin, there are two adaptation methods:

### Method A: Direct Closure Registration (Plugin-Internal Tools)

If your skill is registered in this plugin's `index.ts` via `api.registerTool()`, the tool factory function can directly receive the `secretStore` instance and call `secretStore.set()` via closure. **Real values never pass through the AI. Zero exposure.**

This is exactly how the `/secret` command works — it calls `secretStore.set()` directly inside `execute`, and the AI never sees any plaintext.

**Example: Adding an OAuth Token Fetcher Tool to the Plugin**

`src/tools/fetch-oauth-token.ts`:

```typescript
import type { SecretStore } from "../secrets/secret-store.js";

export function createFetchOAuthTokenTool(secretStore: SecretStore) {
  return {
    name: "fetch_oauth_token",
    label: "Fetch OAuth Token",
    description: "Fetch an OAuth token and register it as {{OAUTH_TOKEN}}.",
    parameters: {
      type: "object" as const,
      properties: {
        clientId: { type: "string" as const, description: "OAuth client ID" },
        clientSecret: { type: "string" as const, description: "OAuth client secret (use {{NAME}} placeholder)" },
      },
      required: ["clientId", "clientSecret"] as const,
    },
    // {{NAME}} in params is auto-substituted by before_tool_call
    execute: async (_toolCallId: string, params: { clientId: string; clientSecret: string }) => {
      const token = await fetchTokenFromProvider(params.clientId, params.clientSecret);

      // Register directly via closure — AI never sees the token plaintext
      secretStore.set("OAUTH_TOKEN", token);

      return {
        content: "OAuth token acquired and registered as {{OAUTH_TOKEN}}. Use this placeholder going forward.",
      };
    },
  };
}
```

Register in `index.ts`:

```typescript
import { createFetchOAuthTokenTool } from "./src/tools/fetch-oauth-token.js";

// Inside register():
api.registerTool(createFetchOAuthTokenTool(secretStore));
```

> **Key point**: `secretStore.set()` is called directly inside the tool's `execute` function. The real value only exists in JS runtime variables and never appears in any text visible to the AI.

### Method B: Vault Markers (External Tools / Third-Party Skills)

If your skill is a separate plugin or external tool without direct access to the `secretStore` instance, embed `<<VAULT:NAME=VALUE>>` markers in return text. The `tool_result_persist` hook automatically extracts, registers, and removes markers.

**Adaptation Principles**

1. **Sensitive data in skill output** — Wrap with `<<VAULT:NAME=VALUE>>`
2. **Sensitive parameters received by skill** — Use `{{NAME}}` placeholders directly; the plugin auto-substitutes before execution
3. **Internal skill logic** — No changes needed; continue processing plaintext as usual

**Example**

Before (returns sensitive value directly):

```typescript
async function getOAuthToken() {
  const token = await fetchToken();
  return { content: `Got access token: ${token}` };
}
```

After (uses Vault marker):

```typescript
async function getOAuthToken() {
  const token = await fetchToken();
  return { content: `Got access token: <<VAULT:OAUTH_TOKEN=${token}>>, use {{OAUTH_TOKEN}} going forward` };
}
```

After adaptation, the plugin auto-registers the token as a secret. The AI can only see `{{OAUTH_TOKEN}}` from that point on.

### Comparison

| Aspect | Method A (Closure) | Method B (Vault Markers) |
|--------|-------------------|-------------------------|
| Use case | Tools registered within this plugin | External plugins / third-party skills |
| Security | Real value only in JS variables, completely invisible to AI | Markers extracted and removed at `tool_result_persist`, invisible to AI |
| Effort | Requires importing `SecretStore` type and receiving instance | Only requires modifying return text format |
| AI-visible output | Custom text (no real values) | Text with markers removed |

### AI-Assisted Adaptation Prompts

Use these prompts to have AI help adapt your skill code.

**For Method A (closure registration):**

```text
Please adapt the following tool code for the openclaw-vault hard-masking architecture (closure method).

Adaptation rules:
1. The tool factory function should accept a SecretStore instance as a parameter
2. Inside the execute function, after obtaining sensitive values, call secretStore.set("NAME", value) directly
3. Return text to the AI should only contain {{NAME}} placeholders, never real values
4. If the tool receives sensitive parameters, note in the description to use {{NAME}} placeholders (the plugin auto-substitutes at execution time)
5. Do not modify internal business logic

Example:
  Before:
    return { content: `Token: ${token}` }
  After:
    secretStore.set("ACCESS_TOKEN", token);
    return { content: "Token acquired and registered as {{ACCESS_TOKEN}}" }

Here is the code to adapt:

[paste your tool code]
```

**For Method B (Vault markers):**

```text
Please adapt the following skill code for the openclaw-vault hard-masking architecture (Vault marker method).

Adaptation rules:
1. Find all locations that return sensitive information (API keys, tokens, passwords, secrets, certificates, etc.)
2. Wrap sensitive values with <<VAULT:NAME=VALUE>> markers, where:
   - NAME is a descriptive uppercase name with underscores (e.g., OAUTH_TOKEN, API_KEY, DB_PASSWORD)
   - VALUE is the actual sensitive value
3. Guide subsequent usage with the {{NAME}} placeholder format in the return text
4. If the skill receives sensitive parameters, change to accept {{NAME}} placeholders (the plugin auto-substitutes real values at execution time)
5. Do not modify internal processing logic
6. Do not change how non-sensitive information is returned

Example:
  Before: return { content: `Token: ${token}` }
  After:  return { content: `Token: <<VAULT:ACCESS_TOKEN=${token}>>, use {{ACCESS_TOKEN}} going forward` }

Here is the code to adapt:

[paste your skill code]
```

## Configuration

Customize plugin behavior in the OpenClaw configuration file:

```json
{
  "plugins": {
    "openclaw-vault": {
      "secrets": {
        "file": "~/my-secrets.json",
        "enableContextRedaction": true,
        "enableOutputSubstitution": true
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `secrets.file` | `string` | `~/.openclaw/secrets.json` | Path to the secrets storage file (resolved via `resolvePath`) |
| `secrets.enableContextRedaction` | `boolean` | `true` | Whether to redact real values in all messages during `before_prompt_build` |
| `secrets.enableOutputSubstitution` | `boolean` | `true` | Whether to restore `{{NAME}}` to real values during `message_sending` for user display |

Default secrets file location: `~/.openclaw/secrets.json`, with file permissions `0600`.

## Project Structure

```
openclaw-vault/
├── openclaw.plugin.json              # Plugin manifest
├── package.json                      # Zero runtime dependencies
├── index.ts                          # Entry: registers hooks/commands/tools
└── src/
    ├── secrets/
    │   └── secret-store.ts           # Secret store: CRUD + redact/substitute + vault marker parsing
    ├── commands/
    │   └── secret-command.ts         # /secret add|remove|list|clear
    ├── hooks/
    │   ├── context-redact.ts         # before_prompt_build: in-place redact + inject placeholder list
    │   ├── tool-call-sub.ts          # before_tool_call: {{NAME}} → real value
    │   ├── tool-result-redact.ts     # tool_result_persist: extract markers + redact results
    │   ├── message-write-redact.ts   # before_message_write: JSONL safety net
    │   └── message-sending-sub.ts    # message_sending: {{NAME}} → real value (user display)
    └── tools/
        └── resolve-placeholder.ts    # AI tool: check if placeholder exists
```

## Security Notes

### What Can the AI See?

Under the hard-masking architecture, the AI only ever sees:
- `{{API_KEY}}`
- `{{DB_PASSWORD}}`
- `{{SSH_HOST}}`

The real values `sk-abcdef1234567890`, `hunter2`, `192.168.1.100` are completely invisible to the AI.

### Compared to the Old "Soft Constraint" Approach

| Aspect | Old (Soft Constraint) | New (Hard Masking) |
|--------|----------------------|-------------------|
| Method | Prompt instructs AI "don't expose" | Data-level replacement; AI physically cannot see values |
| Reliability | AI may ignore instructions and leak | 100% impossible to leak (values are replaced) |
| Coverage | Relies on AI compliance | All messages, tool results, persisted files |
| JSONL Safety | Real values may be written to history | `before_message_write` ensures they are never written |

### Known Limitations

- `redact()` does not replace secret values shorter than 4 characters by default, to avoid false positives on common short strings
- Redaction replaces values from longest to shortest, reducing false matches from substring overlap
- If a real value happens to be a substring of another placeholder, unexpected replacement may occur (extremely rare)

## Verification Checklist

1. `/secret add API_KEY sk-test123` — Register a secret
2. Send a message containing `sk-test123` → Confirm AI response only shows `{{API_KEY}}`
3. Have AI call a tool (parameter contains `{{API_KEY}}`) → Confirm tool receives `sk-test123`
4. Tool returns result containing `sk-test123` → Confirm AI only sees `{{API_KEY}}`
5. Tool returns `<<VAULT:TOKEN=new-secret>>` marker → Confirm `TOKEN` is registered and AI only sees `{{TOKEN}}`
6. Check JSONL file → Confirm persisted content contains no real secret values

## License

MIT
