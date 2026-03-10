# openclaw-vault

> **硬遮蔽**秘密管理插件 — AI **永远无法看到**真实秘密值。

[English](./README_EN.md)

`openclaw-vault` 是 [OpenClaw](https://github.com/nicepkg/openclaw) 的安全插件。它在架构层面保证 AI 模型只能看到 `{{NAME}}` 占位符，真实值仅在工具实际执行时注入，执行结果在回流给 AI 前自动脱敏，发送给用户时自动还原。

## 核心特性

- **硬遮蔽架构** — 所有消息在送入 AI 前自动替换真实值为 `{{NAME}}`，AI 物理上无法接触明文
- **工具执行时自动还原** — `before_tool_call` 阶段将 `{{NAME}}` 替换为真实值，工具收到的是明文
- **工具结果自动脱敏** — 工具返回的内容在持久化前自动将真实值替换回 `{{NAME}}`
- **JSONL 安全网** — `before_message_write` 确保写入会话历史文件的内容绝不含真实值
- **用户展示自动还原** — `message_sending` 阶段将 `{{NAME}}` 替换为真实值，用户看到的是明文
- **Vault 标记协议** — 外部工具可通过 `<<VAULT:NAME=VALUE>>` 标记注册秘密，零暴露
- **`/secret` 命令** — 交互式管理秘密：增删查清
- **`resolve_placeholder` 工具** — AI 可查询占位符是否存在，不暴露真实值
- **跨会话持久化** — 秘密存储在本地 JSON 文件，重启后自动加载
- **零运行时依赖** — 纯 Node.js 实现，无需安装额外包

## 兼容性

| 要求 | 版本 |
|------|------|
| OpenClaw | `>=v2026.3.8`（需支持 `before_prompt_build`、`before_tool_call`、`tool_result_persist`、`before_message_write`、`message_sending` 钩子） |
| Node.js | `>=18` |

## 安装

```bash
# 1. 克隆到 OpenClaw 扩展目录
git clone https://github.com/nicepkg/openclaw-vault.git ~/.openclaw/extensions/openclaw-vault

# 2. 确认插件已被发现
openclaw plugins list

# 3. 启用插件
openclaw plugins enable openclaw-vault
```

或手动将项目文件夹放到 `~/.openclaw/extensions/openclaw-vault/` 下即可。

## 快速开始

### 1. 注册秘密

```bash
/secret add API_KEY sk-abcdef1234567890
/secret add DB_PASSWORD hunter2
/secret add SSH_HOST 192.168.1.100
```

- 名称自动规范化为大写
- 名称后的所有内容都作为 value（支持包含空格的值）
- 占位符统一格式：`{{NAME}}`

### 2. 管理秘密

```bash
/secret list              # 仅显示占位符名称，不显示真实值
/secret remove API_KEY    # 删除单个秘密
/secret clear             # 清空全部秘密
```

### 3. 在对话中使用

注册后直接在对话中使用即可：

```
User: 用 {{API_KEY}} 调用 OpenAI 的 models 接口
```

AI 全程只看到占位符：

```
AI: 好的，我来调用 API。
    curl -H "Authorization: Bearer {{API_KEY}}" https://api.openai.com/v1/models
```

工具实际执行时自动替换为真实值：

```
实际执行: curl -H "Authorization: Bearer sk-abcdef1234567890" https://api.openai.com/v1/models
```

工具返回结果在回流给 AI 前自动脱敏：

```
工具返回: {"api_key": "sk-abcdef1234567890", ...}
AI 看到:  {"api_key": "{{API_KEY}}", ...}
```

发送给用户时自动还原：

```
AI 内部: 调用结果中 api_key 为 {{API_KEY}}
用户看到: 调用结果中 api_key 为 sk-abcdef1234567890
```

### 4. Vault 标记（外部工具注册秘密）

外部工具可以在返回文本中嵌入特殊标记来注册新秘密：

```
工具返回: 已获取 token <<VAULT:ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9.xxx>>，可以使用了
```

插件会自动：
1. 提取 `<<VAULT:ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9.xxx>>` 标记
2. 注册 `ACCESS_TOKEN` 到秘密存储
3. 将标记从文本中移除
4. 后续所有出现该值的地方自动替换为 `{{ACCESS_TOKEN}}`

AI 最终看到的只是：

```
已获取 token ，可以使用了
```

## 工作原理

### 数据流

```
用户输入
  ↓
before_message_write（同步）→ 遮蔽真实值 → 写入 JSONL
  ↓
before_prompt_build → 原地遮蔽 messages[]（兜底）→ 注入可用占位符列表
  ↓
AI 只看到 {{NAME}} 占位符
  ↓
before_tool_call → {{NAME}} → 真实值
  ↓
工具执行（使用真实值）
  ↓
tool_result_persist（同步）→ 提取 <<VAULT:...>> 标记 + 遮蔽结果
  ↓
before_message_write（同步）→ 再次遮蔽（安全网）
  ↓
AI 在结果中只看到 {{NAME}}
  ↓
message_sending → {{NAME}} → 真实值展示给用户
```

### 钩子一览

| 钩子 | 文件 | 同步/异步 | 作用 |
|------|------|-----------|------|
| `before_prompt_build` | `context-redact.ts` | 异步 | 遍历所有消息，原地遮蔽真实值；注入可用占位符列表 |
| `before_tool_call` | `tool-call-sub.ts` | 异步 | 将工具参数中的 `{{NAME}}` 替换为真实值 |
| `tool_result_persist` | `tool-result-redact.ts` | **同步** | 提取 Vault 标记 → 批量注册 → 遮蔽工具结果 |
| `before_message_write` | `message-write-redact.ts` | **同步** | 安全网：确保 JSONL 不含真实值 |
| `message_sending` | `message-sending-sub.ts` | 异步 | 将 `{{NAME}}` 还原为真实值展示给用户 |

### 两种秘密注册方式

**方式 1：`/secret` 命令（手动注册）**

```bash
/secret add MY_TOKEN abc123
```

通过闭包直接调用 `SecretStore.set()`，值不经过 AI，零暴露。

**方式 2：Vault 标记（工具自动注册）**

外部工具在返回文本中嵌入 `<<VAULT:NAME=VALUE>>` 标记，由 `tool_result_persist` 钩子提取并注册。标记会从文本中移除，值不会被 AI 看到。

标记格式：
```
<<VAULT:SECRET_NAME=secret_value_here>>
```

规则：
- 名称必须以大写字母或下划线开头，只能包含大写字母、数字和下划线
- 值支持任意字符（包括换行），以最短匹配 `>>` 结束
- 单条文本中可包含多个标记

## 现有 Skill 适配指南

根据 skill 与本插件的关系，有两种适配方式可选：

### 方式 A：闭包直接注册（插件内部工具）

如果你的 skill 是在本插件的 `index.ts` 中通过 `api.registerTool()` 注册的，那么工具工厂函数可以直接接收 `secretStore` 实例，通过闭包调用 `secretStore.set()` 注册秘密。**真实值完全不经过 AI，零暴露。**

这就是 `/secret` 命令的工作方式——它在 `execute` 内部直接调用 `secretStore.set()`，AI 从头到尾看不到任何明文。

**示例：在插件内新增一个获取 OAuth Token 的工具**

`src/tools/fetch-oauth-token.ts`：

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
    // params 中的 {{NAME}} 会被 before_tool_call 自动替换为真实值
    execute: async (_toolCallId: string, params: { clientId: string; clientSecret: string }) => {
      const token = await fetchTokenFromProvider(params.clientId, params.clientSecret);

      // 通过闭包直接注册，AI 永远看不到 token 明文
      secretStore.set("OAUTH_TOKEN", token);

      return {
        content: "OAuth token 已获取并注册为 {{OAUTH_TOKEN}}，后续可直接使用该占位符。",
      };
    },
  };
}
```

在 `index.ts` 中注册：

```typescript
import { createFetchOAuthTokenTool } from "./src/tools/fetch-oauth-token.js";

// 在 register() 中：
api.registerTool(createFetchOAuthTokenTool(secretStore));
```

> **关键点**：`secretStore.set()` 在工具的 `execute` 函数内直接调用，真实值只存在于 JS 运行时的变量中，永远不会出现在 AI 可见的任何文本里。

### 方式 B：Vault 标记（外部工具/第三方 Skill）

如果你的 skill 是独立插件或外部工具，无法直接访问 `secretStore` 实例，可以在返回文本中嵌入 `<<VAULT:NAME=VALUE>>` 标记。`tool_result_persist` 钩子会自动提取标记、注册秘密并从文本中移除标记。

**适配原则**

1. **skill 返回的敏感信息** — 用 `<<VAULT:NAME=VALUE>>` 包裹
2. **skill 接收的敏感参数** — 直接使用 `{{NAME}}` 占位符，插件会在执行前自动替换
3. **skill 内部逻辑** — 无需改动，照常处理明文

**示例**

改造前（直接返回敏感值）：

```typescript
async function getOAuthToken() {
  const token = await fetchToken();
  return { content: `获取到访问令牌: ${token}` };
}
```

改造后（使用 Vault 标记）：

```typescript
async function getOAuthToken() {
  const token = await fetchToken();
  return { content: `获取到访问令牌: <<VAULT:OAUTH_TOKEN=${token}>>，后续请使用 {{OAUTH_TOKEN}}` };
}
```

改造后，插件会自动将 token 注册为秘密，AI 后续只能看到 `{{OAUTH_TOKEN}}`。

### 两种方式对比

| 对比项 | 方式 A（闭包直接注册） | 方式 B（Vault 标记） |
|--------|----------------------|---------------------|
| 适用场景 | 本插件内注册的工具 | 外部插件 / 第三方 Skill |
| 安全性 | 真实值只在 JS 变量中，AI 完全不可见 | 标记在 `tool_result_persist` 阶段提取并移除，AI 不可见 |
| 改造成本 | 需要导入 `SecretStore` 类型，接收实例 | 只需修改返回文本格式 |
| 返回给 AI 的内容 | 自定义文本（不含真实值） | 标记被移除后的文本 |

### AI 辅助改造提示词

如果你的 skill 代码较多，可以用以下提示词让 AI 帮你改造。

**针对方式 A（闭包直接注册）的提示词：**

```text
请帮我改造以下工具代码，使其适配 openclaw-vault 插件的硬遮蔽架构（闭包方式）。

改造规则：
1. 工具的工厂函数需要接收 SecretStore 实例作为参数
2. 在 execute 函数内部，获取到敏感值后直接调用 secretStore.set("NAME", value) 注册
3. 返回给 AI 的文本中只包含 {{NAME}} 占位符，绝不包含真实值
4. 如果工具接收敏感参数，参数描述中说明使用 {{NAME}} 占位符（插件会在执行时自动替换）
5. 工具内部的业务逻辑不需要改动

示例：
  改造前:
    return { content: `Token: ${token}` }
  改造后:
    secretStore.set("ACCESS_TOKEN", token);
    return { content: "Token 已注册为 {{ACCESS_TOKEN}}" }

以下是需要改造的代码：

[粘贴你的工具代码]
```

**针对方式 B（Vault 标记）的提示词：**

```text
请帮我改造以下 skill 代码，使其适配 openclaw-vault 插件的硬遮蔽架构（Vault 标记方式）。

改造规则：
1. 找出所有返回敏感信息（API key、token、密码、密钥、证书等）的位置
2. 将敏感值用 <<VAULT:NAME=VALUE>> 标记包裹，其中：
   - NAME 是大写字母加下划线的描述性名称（如 OAUTH_TOKEN、API_KEY、DB_PASSWORD）
   - VALUE 是实际的敏感值
3. 在返回文本中引导后续使用占位符格式 {{NAME}}
4. 如果 skill 接收敏感参数，改为接收 {{NAME}} 占位符（插件会在执行时自动替换为真实值）
5. skill 内部处理逻辑不需要改动
6. 不要改动非敏感信息的返回方式

示例：
  改造前: return { content: `Token: ${token}` }
  改造后: return { content: `Token: <<VAULT:ACCESS_TOKEN=${token}>>，后续请使用 {{ACCESS_TOKEN}}` }

以下是需要改造的代码：

[粘贴你的 skill 代码]
```

## 配置

在 OpenClaw 配置文件中可以自定义插件行为：

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

### 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `secrets.file` | `string` | `~/.openclaw/secrets.json` | 秘密存储文件路径（通过 `resolvePath` 解析） |
| `secrets.enableContextRedaction` | `boolean` | `true` | 是否在 `before_prompt_build` 阶段遮蔽所有消息中的真实值 |
| `secrets.enableOutputSubstitution` | `boolean` | `true` | 是否在 `message_sending` 阶段将 `{{NAME}}` 还原为真实值展示给用户 |

秘密文件默认位置：`~/.openclaw/secrets.json`，文件权限为 `0600`。

## 项目结构

```
openclaw-vault/
├── openclaw.plugin.json              # 插件清单
├── package.json                      # 无运行时依赖
├── index.ts                          # 入口：注册钩子/命令/工具
└── src/
    ├── secrets/
    │   └── secret-store.ts           # 秘密存储：CRUD + redact/substitute + vault 标记解析
    ├── commands/
    │   └── secret-command.ts         # /secret add|remove|list|clear
    ├── hooks/
    │   ├── context-redact.ts         # before_prompt_build: 原地遮蔽 + 注入占位符列表
    │   ├── tool-call-sub.ts          # before_tool_call: {{NAME}} → 真实值
    │   ├── tool-result-redact.ts     # tool_result_persist: 提取标记 + 遮蔽结果
    │   ├── message-write-redact.ts   # before_message_write: JSONL 安全网
    │   └── message-sending-sub.ts    # message_sending: {{NAME}} → 真实值（用户展示）
    └── tools/
        └── resolve-placeholder.ts    # AI 工具：查询占位符是否存在
```

## 安全说明

### AI 能看到什么？

在硬遮蔽架构下，AI 全程只能看到：
- `{{API_KEY}}`
- `{{DB_PASSWORD}}`
- `{{SSH_HOST}}`

真实值 `sk-abcdef1234567890`、`hunter2`、`192.168.1.100` 对 AI 完全不可见。

### 与旧版"软约束"的区别

| 对比项 | 旧版（软约束） | 新版（硬遮蔽） |
|--------|---------------|---------------|
| 方式 | 通过 prompt 告诉 AI "不要暴露" | 在数据层面替换，AI 物理上看不到 |
| 可靠性 | AI 可能忽略指令泄露真实值 | 100% 不可能泄露（值已被替换） |
| 覆盖范围 | 仅靠 AI 自觉 | 所有消息、工具结果、持久化文件 |
| JSONL 安全 | 真实值可能写入历史 | `before_message_write` 确保不写入 |

### 已知限制

- `redact()` 默认不替换长度小于 4 的秘密值，以避免误伤常见短字符串
- 脱敏按值长度从长到短替换，降低子串重叠导致的错误匹配
- 如果某个真实值恰好是另一个占位符的子串，可能产生非预期替换（极少见）

## 验证清单

1. `/secret add API_KEY sk-test123` — 注册秘密
2. 发送包含 `sk-test123` 的消息 → 确认 AI 回复中只出现 `{{API_KEY}}`
3. 让 AI 调用工具（参数含 `{{API_KEY}}`）→ 确认工具收到 `sk-test123`
4. 工具返回包含 `sk-test123` 的结果 → 确认 AI 只看到 `{{API_KEY}}`
5. 工具返回 `<<VAULT:TOKEN=new-secret>>` 标记 → 确认 `TOKEN` 被注册且 AI 只看到 `{{TOKEN}}`
6. 检查 JSONL 文件 → 确认持久化内容不含任何真实值

## License

MIT
