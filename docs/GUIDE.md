# OpenClaw Vault — Third-Party Skill Adaptation Guide

This document is for users who have installed the OpenClaw Vault plugin and third-party Skill developers.

- **Part 1 (Users)**: You are using a third-party Skill and want its sensitive content to be protected by Vault — no code changes needed, just adjust how you use it.
- **Part 2 (Developers)**: You are a Skill author and want your Skill to natively support Vault — a few small changes in the Skill source code.

> **Tip**: You can copy the relevant sections of this document directly to an AI assistant, then tell the AI which content you want to mask. The AI can automatically complete the adaptation following this guide.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [How Vault Works — Quick Overview](#how-vault-works--quick-overview)
- [Part 1: Users — Using Vault with Third-Party Skills](#part-1-users--using-vault-with-third-party-skills)
  - [Method 1: Inline Markers](#method-1-inline-markers)
  - [Method 2: Pre-registered Secrets](#method-2-pre-registered-secrets)
  - [Choosing a Method](#choosing-a-method)
  - [Real-World Scenarios](#real-world-scenarios)
  - [Caveats and Limitations](#caveats-and-limitations)
- [Part 2: Developers — Making Your Skill Vault-Compatible](#part-2-developers--making-your-skill-vault-compatible)
  - [Adaptation Principles](#adaptation-principles)
  - [Scenario 1: Sensitive Placeholders in Skill Prompt Templates](#scenario-1-sensitive-placeholders-in-skill-prompt-templates)
  - [Scenario 2: Sensitive Fields in User Configuration](#scenario-2-sensitive-fields-in-user-configuration)
  - [Scenario 3: Dynamically Assembled Text with Sensitive Content](#scenario-3-dynamically-assembled-text-with-sensitive-content)
  - [Scenario 4: Restoring Sensitive Content in Skill Output](#scenario-4-restoring-sensitive-content-in-skill-output)
  - [Testing Your Adaptation](#testing-your-adaptation)
- [AI Prompt Templates](#ai-prompt-templates)

---

## Prerequisites

1. OpenClaw Vault plugin is installed and enabled
2. `openclaw vault setup` or `/s check` has been run to take over Providers
3. The Provider's `baseUrl` has been rewritten to the Vault local proxy address (default `127.0.0.1:19100`)

To verify:

```text
/s check
```

If the output shows providers have been taken over, Vault is working and all requests through those providers will be automatically masked/restored.

---

## How Vault Works — Quick Overview

```text
Your input (may contain sensitive content)
  │
  ▼
Vault local proxy intercepts the request
  │
  ├─ Detects <<s:sensitive content>> markers → replaces with <<s.aB3xZ9>> temp token
  ├─ Detects pre-registered secret values → replaces with <<s.kM7pQ2>> temp token
  │
  ▼
Masked request sent to AI Provider (original sensitive text never appears)
  │
  ▼
AI response returns (may contain tokens)
  │
  ▼
Vault restores tokens back to original text and returns to you
```

**Key points**:

- Vault operates at the network layer, transparent to Skills and AI models
- As long as sensitive content **appears in full** in the final request body sent to the provider, Vault can detect and replace it
- Token mappings are isolated per request and discarded immediately after the response

---

## Part 1: Users — Using Vault with Third-Party Skills

### Method 1: Inline Markers

In any text that will be sent to the AI, wrap sensitive content with `<<s:...>>`:

```text
<<s:sensitive content>>
```

**Example**: Suppose you're using a database query Skill and need to provide connection details:

```text
Connect to the database, host is <<s:192.168.1.100>>, password is <<s:MyDBPass!2024>>
```

Vault will replace this before sending:

```text
Connect to the database, host is <<s.aB3xZ9>>, password is <<s.kM7pQ2>>
```

If the AI references these tokens in its response, Vault will automatically restore them.

**Characteristics**:

- Supports multi-line content: newlines, spaces, and indentation are preserved
- Empty value `<<s:>>` is not replaced (kept as-is)
- After restoration, the `<<s:...>>` wrapper is preserved

### Method 2: Pre-registered Secrets

Use the `/s add` command to pre-register sensitive values. Once registered, any occurrence of that value in the request body will be automatically replaced — **no manual marking needed**:

```text
/s add <name> <secret_value>
```

**Example**:

```text
/s add db_host 192.168.1.100
/s add db_pass MyDBPass!2024
```

After registration, whenever `192.168.1.100` or `MyDBPass!2024` appears in any Skill's request, Vault will automatically replace them with temporary tokens.

**Management commands**:

| Command | Description |
|---------|-------------|
| `/s add <name> <value>` | Add a secret |
| `/s update <name> <value>` | Update a secret |
| `/s remove <name>` | Remove a secret |
| `/s list` | View registered secrets (shows name, length, digest only — not plaintext) |

**Characteristics**:

- Matches by length in descending order to avoid short values accidentally cutting into longer ones
- After restoration, the value is returned as **plaintext** (no `<<s:...>>` wrapper)
- Secret values must be single-line text

### Choosing a Method

| Scenario | Recommended | Reason |
|----------|-------------|--------|
| Occasionally including sensitive content in a conversation | Inline `<<s:...>>` | Write as needed, no pre-configuration |
| Same sensitive value used across multiple Skills / conversations | `/s add` pre-register | Register once, auto-applied everywhere |
| Secret value is multi-line (e.g., SSH key, certificate) | Inline `<<s:...>>` | Pre-registration only supports single-line |
| Don't want to manually mark every time | `/s add` pre-register | Automatic matching, no change in input habits |

### Real-World Scenarios

#### Scenario A: Code Generation Skill + Database Password

You're using a code generation Skill and need the AI to generate code with a real database connection string.

**Method 1 (inline)**:
```text
Generate Python code to connect to PostgreSQL, connection string is <<s:postgresql://admin:secret123@10.0.0.5:5432/mydb>>
```

**Method 2 (pre-register)**:
```text
/s add pg_conn postgresql://admin:secret123@10.0.0.5:5432/mydb
```
Then input normally:
```text
Generate Python code to connect to PostgreSQL, connection string is postgresql://admin:secret123@10.0.0.5:5432/mydb
```
Vault will automatically detect and replace it.

#### Scenario B: Deployment Skill + API Key

You're using a deployment-related Skill and need to provide API keys.

```text
/s add aws_key AKIAIOSFODNN7EXAMPLE
/s add aws_secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

Any text sent to the AI containing these values will be automatically replaced.

#### Scenario C: Document Translation Skill + Internal Company Info

```text
Translate the following, where <<s:Acme Corp>> is the company name and <<s:Project Phoenix>> is the codename:

<<s:Acme Corp>> is developing <<s:Project Phoenix>>, expected to launch in Q3.
```

#### Scenario D: Code Review Skill + Config File with Secrets

```text
/s add api_token ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Then let the Skill review your config file directly — Vault will automatically replace the token value.

### Caveats and Limitations

1. **Vault only processes requests through the proxy**
   - Only requests from Providers taken over by `/s check` are masked
   - If a Skill uses an un-taken-over Provider or sends requests bypassing the proxy, Vault will not apply

2. **Restoration requires tokens to exist as-is**
   - If the AI rewrites, splits, or deletes `<<s.XXXXXX>>` tokens, Vault cannot restore them
   - Vault injects a system prompt instructing the model to preserve tokens, but compliance isn't guaranteed

3. **`<<s:...>>` markers must be complete**
   - If a Skill truncates your input before sending, breaking `<<s:` apart from `>>`, Vault cannot detect it
   - Be especially careful with large file scenarios

4. **`/s add` commands may leave traces**
   - The command `/s add db_pass MySecret` itself may appear in chat history
   - Use only for temporary test secrets or content whose exposure scope you accept

5. **Binary and non-text content is not protected**
   - Vault only processes UTF-8 text request/response bodies

---

## Part 2: Developers — Making Your Skill Vault-Compatible

If you're a third-party Skill developer, you can make your Skill natively support Vault, providing users with better privacy protection.

### Adaptation Principles

1. **Vault operates at the network layer** — your Skill does not need to depend on Vault's API or code
2. **Just ensure sensitive content appears in the correct format in the request body** — Vault handles the rest
3. **Two adaptation paths**:
   - **Zero-code adaptation**: Guide users in your documentation to use `<<s:...>>` markers or `/s add`
   - **Source-code adaptation**: Automatically wrap sensitive fields in your Skill's prompt templates or data processing pipeline

### Scenario 1: Sensitive Placeholders in Skill Prompt Templates

If your Skill uses prompt templates that may contain user-provided sensitive configuration (e.g., API keys, connection strings):

**Adaptation**: Wrap sensitive variables with `<<s:...>>` in the template.

**Before**:
```typescript
function buildPrompt(config: { apiKey: string; endpoint: string }) {
  return `Call the API, key is ${config.apiKey}, endpoint is ${config.endpoint}`;
}
```

**After**:
```typescript
function buildPrompt(config: { apiKey: string; endpoint: string }) {
  return `Call the API, key is <<s:${config.apiKey}>>, endpoint is <<s:${config.endpoint}>>`;
}
```

Vault will replace `<<s:...>>` with temporary tokens before the request is sent, and restore tokens in the AI response.

### Scenario 2: Sensitive Fields in User Configuration

If your Skill requires users to fill in sensitive information in a config file (e.g., database passwords, tokens), guide users to pre-register in your documentation.

**Add to your Skill documentation**:

```markdown
## Using Vault to Protect Sensitive Configuration

If you have [OpenClaw Vault](https://github.com/dayhi/openclaw-vault) installed,
you can pre-register sensitive config values. Vault will automatically mask them
when sent to the AI:

​```text
/s add my_skill_api_key <your API key>
/s add my_skill_db_pass <your database password>
​```

Once registered, these values will be automatically replaced with temporary tokens
whenever they appear in text sent to the AI.
```

### Scenario 3: Dynamically Assembled Text with Sensitive Content

If your Skill dynamically assembles text at runtime (e.g., reading file contents, query results) that may contain sensitive information, there are two adaptation approaches:

**Approach A: Let users pre-register** (recommended, zero code changes)

Inform users in your documentation: if the assembled content contains sensitive information, pre-register it with `/s add`.

**Approach B: Auto-wrap during assembly** (source code changes)

Provide a simple helper function:

```typescript
/**
 * Wraps a sensitive value with Vault inline markers.
 * If the user has Vault installed, the value will be automatically replaced with a temp token.
 * If Vault is not installed, the <<s:...>> marker is passed as plain text to the AI — no impact.
 */
function vaultWrap(value: string): string {
  if (!value) return value;
  return `<<s:${value}>>`;
}

// Usage
const prompt = `Database connection: ${vaultWrap(dbConnectionString)}`;
```

> **Note**: The `<<s:...>>` marker does not cause errors in environments without Vault — it simply passes as plain text to the AI. This means your adaptation code is backward-compatible.

### Scenario 4: Restoring Sensitive Content in Skill Output

Vault's restoration is automatic, happening at the proxy layer. Your Skill does not need any special handling.

**Restoration rules**:

| Source | Restored Format | Example |
|--------|----------------|---------|
| Inline `<<s:...>>` | `<<s:original>>` | `<<s:MyPass>>` |
| Pre-registered `/s add` | Plaintext value | `MyPass` |

If your Skill needs to parse or process the AI's response content, note:

- **Inline secrets** appear as `<<s:original>>` in the AI response (after Vault restoration)
- If your Skill needs to extract the value, use the regex `/<<s:([\s\S]+?)>>/g`

### Testing Your Adaptation

1. **Install Vault and take over Providers**:
   ```text
   /s check
   ```

2. **Test inline markers**: Use `<<s:test_secret>>` in your Skill's input and verify:
   - The AI receives a `<<s.XXXXXX>>` format token (check via Vault logs)
   - The final response has the token restored

3. **Test pre-registered secrets**:
   ```text
   /s add test_key test_value_12345
   ```
   Input text containing `test_value_12345` in your Skill and verify it gets replaced and restored.

4. **Test edge cases**:
   - Sensitive content inside JSON field values
   - Sensitive content inside code blocks
   - Multiple sensitive values in the same text
   - SSE streaming responses where tokens are split across chunks (Vault handles this automatically)

---

## AI Prompt Templates

The following templates can be copied directly to an AI assistant. Paste the relevant sections to the AI, then tell it what specific content you want to mask — the AI can complete the adaptation for you.

### Template 1: User — Protecting Sensitive Content in Third-Party Skills

```
I'm using a third-party OpenClaw Skill with the OpenClaw Vault plugin installed.
Vault automatically intercepts requests to AI Providers via a local proxy, replacing
sensitive content with temporary tokens and restoring them when the response returns.

Vault recognizes two types of sensitive markers:
1. Inline markers: <<s:sensitive content>> — replaced with <<s.random6chars>> tokens, restored with <<s:...>> wrapper
2. Pre-registered secrets: values registered via /s add <name> <value> — automatically replaced in requests, restored as plaintext

The Skill I'm using is: [Skill name and description]
It contains these sensitive fields: [list sensitive fields]

Please help me plan how to use Vault to protect this content:
- Which fields should use inline <<s:...>> markers
- Which should use /s add pre-registration
- What to watch out for
```

### Template 2: Developer — Adapting a Skill's Prompt Templates for Vault

```
I'm developing an OpenClaw Skill and want it to natively support the OpenClaw Vault
plugin's secret protection feature.

How Vault works:
- Intercepts requests to AI Providers at the network layer
- Replaces <<s:sensitive content>> markers with <<s.random6chars>> temporary tokens
- Replaces values registered via /s add with temporary tokens
- Automatically restores tokens when the response returns

Adaptation approach:
- In Skill prompt templates, wrap sensitive variables with <<s:${variable}>>
- Provide a vaultWrap(value) helper: wraps value as <<s:value>>
- <<s:...>> passes as plain text in environments without Vault — backward compatible

My Skill's purpose: [describe Skill functionality]
Here is the code involving sensitive content:
[paste relevant code]

Please help me modify the code so sensitive fields are automatically protected by Vault.
```

### Template 3: Developer — Retrofitting an Existing Skill for Vault

```
I have an existing OpenClaw Skill that needs to be adapted for OpenClaw Vault's
secret protection.

Adaptation principles:
1. No direct dependency on Vault API — just wrap sensitive values with <<s:...>> in text sent to AI
2. Backward compatible — <<s:...>> has no effect without Vault
3. Two protection paths:
   - Auto-wrap in code: use <<s:${value}>> for sensitive variables
   - Guide users in docs: tell users to pre-register with /s add

Restoration rules:
- Inline <<s:...>> restored format: <<s:original>>
- Pre-registered secret restored format: plaintext value

Here is the part of my Skill source code involving sensitive content:
[paste relevant code]

Please help me:
1. Identify which parts need adaptation
2. Complete the adaptation with minimal changes
3. Add Vault integration notes to the Skill documentation
```
