# OpenClaw Vault — 第三方 Skill 适配指引

本文档面向已经安装了 OpenClaw Vault 插件的用户和第三方 Skill 开发者。

- **Part 1（用户篇）**：你正在使用某个第三方 Skill，希望让其中的敏感内容也受 Vault 保护 — 不需要修改任何代码，只需调整使用方式。
- **Part 2（开发者篇）**：你是 Skill 的作者，希望你的 Skill 原生适配 Vault — 需要在 Skill 源码中做少量改动。

> **提示**：你可以将本文档的相关章节直接复制给 AI 助手，然后告诉 AI 你希望遮掩哪些内容，AI 就能按照指引自动完成适配。

---

## 目录

- [前提条件](#前提条件)
- [Vault 工作原理速览](#vault-工作原理速览)
- [Part 1：用户篇 — 在第三方 Skill 中使用 Vault](#part-1用户篇--在第三方-skill-中使用-vault)
  - [方式一：inline 标记](#方式一inline-标记)
  - [方式二：预注册密文](#方式二预注册密文)
  - [如何选择方式](#如何选择方式)
  - [实际场景示例](#实际场景示例)
  - [注意事项与限制](#注意事项与限制)
- [Part 2：开发者篇 — 让你的 Skill 原生适配 Vault](#part-2开发者篇--让你的-skill-原生适配-vault)
  - [适配原则](#适配原则)
  - [场景一：Skill prompt 模板中的敏感占位符](#场景一skill-prompt-模板中的敏感占位符)
  - [场景二：Skill 读取用户配置中的敏感字段](#场景二skill-读取用户配置中的敏感字段)
  - [场景三：Skill 动态拼接包含敏感内容的文本](#场景三skill-动态拼接包含敏感内容的文本)
  - [场景四：Skill 输出中需要还原敏感内容](#场景四skill-输出中需要还原敏感内容)
  - [测试你的适配](#测试你的适配)
- [给 AI 的提示词模板](#给-ai-的提示词模板)

---

## 前提条件

1. 已安装并启用 OpenClaw Vault 插件
2. 已运行 `openclaw vault setup` 或 `/s check` 完成 Provider 接管
3. Provider 的 `baseUrl` 已被改写为 Vault 本地代理地址（默认 `127.0.0.1:19100`）

确认方法：

```text
/s check
```

如果输出显示 provider 已被接管，说明 Vault 正在工作，所有经过该 provider 的请求都会被自动脱敏/还原。

---

## Vault 工作原理速览

```text
你的输入（可能包含敏感内容）
  │
  ▼
Vault 本地代理拦截请求
  │
  ├─ 识别 <<s:敏感内容>> 标记 → 替换为 <<s.aB3xZ9>> 临时 token
  ├─ 识别已注册的密文值 → 替换为 <<s.kM7pQ2>> 临时 token
  │
  ▼
脱敏后的请求发往 AI Provider（敏感原文不会出现）
  │
  ▼
AI 响应返回（可能包含 token）
  │
  ▼
Vault 将 token 还原为原文，返回给你
```

**关键点**：

- Vault 在网络层工作，对上层的 Skill 和 AI 模型透明
- 只要敏感内容**完整出现**在最终发送给 provider 的请求体中，Vault 就能识别和替换
- 每次请求的 token 映射独立，响应结束后立即丢弃

---

## Part 1：用户篇 — 在第三方 Skill 中使用 Vault

### 方式一：inline 标记

在任何会发给 AI 的文本中，用 `<<s:...>>` 包裹敏感内容：

```text
<<s:敏感内容>>
```

**示例**：假设你使用一个数据库查询 Skill，需要提供连接信息：

```text
请帮我连接数据库，主机是 <<s:192.168.1.100>>，密码是 <<s:MyDBPass!2024>>
```

Vault 会在请求发出前将其替换为：

```text
请帮我连接数据库，主机是 <<s.aB3xZ9>>，密码是 <<s.kM7pQ2>>
```

AI 响应中如果引用了这些 token，Vault 会自动还原回原文。

**特性**：

- 支持多行内容：换行、空格、缩进都会被原样保留
- 空值 `<<s:>>` 不会被替换（保留原样）
- 还原后保留 `<<s:...>>` 包裹格式

### 方式二：预注册密文

通过 `/s add` 命令预先注册敏感值，之后只要请求体中出现该值就会被自动替换，**无需手动标记**：

```text
/s add <名称> <密文值>
```

**示例**：

```text
/s add db_host 192.168.1.100
/s add db_pass MyDBPass!2024
```

注册后，无论你在哪个 Skill 中输入 `192.168.1.100` 或 `MyDBPass!2024`，Vault 都会在请求发出前自动替换为临时 token。

**管理命令**：

| 命令 | 说明 |
|------|------|
| `/s add <name> <value>` | 添加密文 |
| `/s update <name> <value>` | 更新密文 |
| `/s remove <name>` | 移除密文 |
| `/s list` | 查看已注册密文（只显示名称、长度、摘要，不显示明文） |

**特性**：

- 按长度倒序匹配，避免短值误切长值的一部分
- 还原后是**明文值**（不带 `<<s:...>>` 包裹）
- 密文值必须是单行文本

### 如何选择方式

| 场景 | 推荐方式 | 理由 |
|------|----------|------|
| 偶尔在某次对话中包含敏感内容 | inline `<<s:...>>` | 即用即写，无需预先配置 |
| 同一敏感值在多个 Skill / 多次对话中反复出现 | `/s add` 预注册 | 一次注册，到处自动生效 |
| 密文值是多行文本（如 SSH key、证书） | inline `<<s:...>>` | 预注册只支持单行 |
| 不想每次手动标记 | `/s add` 预注册 | 自动匹配，无需改变输入习惯 |

### 实际场景示例

#### 场景 A：代码生成 Skill + 数据库密码

你使用一个代码生成 Skill，需要让 AI 生成包含真实数据库连接串的代码。

**方式一（inline）**：
```text
请生成 Python 代码连接 PostgreSQL，连接串是 <<s:postgresql://admin:secret123@10.0.0.5:5432/mydb>>
```

**方式二（预注册）**：
```text
/s add pg_conn postgresql://admin:secret123@10.0.0.5:5432/mydb
```
然后正常输入：
```text
请生成 Python 代码连接 PostgreSQL，连接串是 postgresql://admin:secret123@10.0.0.5:5432/mydb
```
Vault 会自动识别并替换。

#### 场景 B：部署 Skill + API Key

你使用部署相关 Skill，需要提供 API Key。

```text
/s add aws_key AKIAIOSFODNN7EXAMPLE
/s add aws_secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

之后任何发送给 AI 的文本中出现这两个值，都会被自动替换。

#### 场景 C：文档翻译 Skill + 公司内部信息

```text
请翻译以下内容，其中 <<s:Acme Corp>> 是公司名，<<s:Project Phoenix>> 是项目代号：

<<s:Acme Corp>> 正在开发 <<s:Project Phoenix>>，预计 Q3 发布。
```

#### 场景 D：代码审查 Skill + 包含密钥的配置文件

```text
/s add api_token ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

然后直接让 Skill 审查你的配置文件，Vault 会自动替换其中出现的 token 值。

### 注意事项与限制

1. **Vault 只处理经过代理的请求**
   - 只有被 `/s check` 接管的 Provider 的请求才会被脱敏
   - 如果 Skill 使用了未接管的 Provider，或绕过代理直接发请求，Vault 不会生效

2. **还原依赖 token 原样存在**
   - 如果 AI 改写、拆分或删除了 `<<s.XXXXXX>>` 形式的 token，Vault 无法还原
   - Vault 已在系统提示词中告知模型保留 token，但不能保证所有模型都遵守

3. **`<<s:...>>` 标记必须完整**
   - 如果 Skill 在发送前截断了你的输入，导致 `<<s:` 和 `>>` 被拆开，Vault 无法识别
   - 对于大文件场景尤其需要注意

4. **`/s add` 命令本身可能留痕**
   - `/s add db_pass MySecret` 这条命令可能出现在聊天记录中
   - 建议只用于临时测试密文，或你已接受其暴露范围的内容

5. **二进制和非文本内容不受保护**
   - Vault 只处理 UTF-8 文本格式的请求/响应

---

## Part 2：开发者篇 — 让你的 Skill 原生适配 Vault

如果你是第三方 Skill 的开发者，可以让你的 Skill 原生支持 Vault，为用户提供更好的隐私保护体验。

### 适配原则

1. **Vault 在网络层工作** — 你的 Skill 不需要直接依赖 Vault 的 API 或代码
2. **只需确保敏感内容以正确格式出现在请求体中** — Vault 会自动完成替换
3. **两种适配路径**：
   - **零代码适配**：在文档中引导用户使用 `<<s:...>>` 标记或 `/s add` 注册
   - **源码适配**：在 Skill 的 prompt 模板或数据处理流程中自动包裹敏感字段

### 场景一：Skill prompt 模板中的敏感占位符

如果你的 Skill 使用 prompt 模板，模板中可能包含用户提供的敏感配置（如 API Key、连接串）。

**适配方法**：在模板中将敏感变量用 `<<s:...>>` 包裹。

**改造前**：
```typescript
function buildPrompt(config: { apiKey: string; endpoint: string }) {
  return `请调用 API，Key 是 ${config.apiKey}，地址是 ${config.endpoint}`;
}
```

**改造后**：
```typescript
function buildPrompt(config: { apiKey: string; endpoint: string }) {
  return `请调用 API，Key 是 <<s:${config.apiKey}>>，地址是 <<s:${config.endpoint}>>`;
}
```

Vault 会在请求发出前将 `<<s:...>>` 替换为临时 token，AI 响应中的 token 会被还原。

### 场景二：Skill 读取用户配置中的敏感字段

如果你的 Skill 需要用户在配置文件中填写敏感信息（如数据库密码、Token），可以在文档中引导用户预注册。

**在 Skill 文档中添加**：

```markdown
## 配合 Vault 保护敏感配置

如果你安装了 [OpenClaw Vault](https://github.com/dayhi/openclaw-vault) 插件，
可以预先注册敏感配置值，Vault 会在发送给 AI 时自动遮掩：

​```text
/s add my_skill_api_key <你的 API Key>
/s add my_skill_db_pass <你的数据库密码>
​```

注册后，这些值出现在任何发给 AI 的文本中时都会被自动替换为临时 token。
```

### 场景三：Skill 动态拼接包含敏感内容的文本

如果你的 Skill 在运行时动态拼接文本（如读取文件内容、查询结果），且其中可能包含敏感信息，有两种适配方式：

**方式 A：让用户自己预注册**（推荐，零代码改动）

在文档中告知用户：如果拼接的内容中包含敏感信息，请提前用 `/s add` 注册。

**方式 B：在拼接时自动包裹**（源码改动）

提供一个简单的 helper 函数：

```typescript
/**
 * 用 Vault inline 标记包裹敏感值。
 * 如果用户安装了 Vault，该值会被自动替换为临时 token；
 * 如果没有安装 Vault，<<s:...>> 标记会原样传递给 AI，不影响功能。
 */
function vaultWrap(value: string): string {
  if (!value) return value;
  return `<<s:${value}>>`;
}

// 使用示例
const prompt = `数据库连接信息：${vaultWrap(dbConnectionString)}`;
```

> **注意**：`<<s:...>>` 标记即使在没有安装 Vault 的环境中也不会造成错误 — 它只会作为普通文本传递给 AI。这意味着你的适配代码是向后兼容的。

### 场景四：Skill 输出中需要还原敏感内容

Vault 的还原是自动的，发生在代理层。你的 Skill 不需要做任何特殊处理。

**还原规则**：

| 来源 | 还原后格式 | 示例 |
|------|-----------|------|
| inline `<<s:...>>` | `<<s:原文>>` | `<<s:MyPass>>` |
| 预注册 `/s add` | 明文值 | `MyPass` |

如果你的 Skill 需要在输出中解析或处理 AI 的响应内容，需要注意：

- **inline 密文**在 AI 响应中会以 `<<s:原文>>` 格式出现（Vault 还原后）
- 如果你的 Skill 需要提取其中的值，可以用正则 `/<<s:([\s\S]+?)>>/g` 匹配

### 测试你的适配

1. **安装 Vault 并接管 Provider**：
   ```text
   /s check
   ```

2. **测试 inline 标记**：在 Skill 的输入中使用 `<<s:test_secret>>`，确认：
   - AI 收到的是 `<<s.XXXXXX>>` 格式的 token（可通过 Vault 日志确认）
   - 最终返回的响应中 token 已被还原

3. **测试预注册密文**：
   ```text
   /s add test_key test_value_12345
   ```
   在 Skill 中输入包含 `test_value_12345` 的文本，确认被自动替换和还原。

4. **测试边界情况**：
   - 敏感内容出现在 JSON 字段值中
   - 敏感内容出现在代码块中
   - 多个敏感值出现在同一段文本中
   - SSE 流式响应中 token 跨 chunk 被拆分（Vault 会自动处理）

---

## 给 AI 的提示词模板

以下模板可以直接复制给 AI 使用。把相关章节粘贴给 AI，再告诉它你具体想遮掩哪些地方，AI 就能帮你自动完成适配。

### 模板一：用户 — 让第三方 Skill 的敏感内容受 Vault 保护

```
我正在使用 OpenClaw 的第三方 Skill，同时安装了 OpenClaw Vault 插件。
Vault 通过本地代理自动拦截发往 AI Provider 的请求，将敏感内容替换为临时 token，响应返回时再还原。

Vault 识别两种敏感标记：
1. inline 标记：<<s:敏感内容>> — 会被替换为 <<s.随机6位>> 格式的 token，还原后保留 <<s:...>> 包裹
2. 预注册密文：通过 /s add <name> <value> 注册的值 — 出现在请求中会被自动替换，还原后是明文

我正在使用的 Skill 是：[Skill 名称和功能描述]
其中包含以下敏感内容：[列出敏感字段]

请帮我规划如何使用 Vault 保护这些内容：
- 哪些适合用 inline <<s:...>> 标记
- 哪些适合用 /s add 预注册
- 使用时需要注意什么
```

### 模板二：开发者 — 让 Skill 的 prompt 模板适配 Vault

```
我正在开发一个 OpenClaw Skill，希望让它原生适配 OpenClaw Vault 插件的密文保护功能。

Vault 的工作方式：
- 在网络层拦截发往 AI Provider 的请求
- 将 <<s:敏感内容>> 标记替换为 <<s.随机6位>> 临时 token
- 将通过 /s add 注册的密文值自动替换为临时 token
- 响应返回时自动还原

适配方法：
- 在 Skill 的 prompt 模板中，用 <<s:${variable}>> 包裹敏感变量
- 提供 vaultWrap(value) helper 函数：将值包裹为 <<s:value>>
- <<s:...>> 在没有 Vault 的环境中会作为普通文本传递，向后兼容

我的 Skill 的功能是：[描述 Skill 功能]
以下是我的 Skill 中涉及敏感内容的代码：
[粘贴相关代码]

请帮我改造代码，让敏感字段自动被 Vault 保护。
```

### 模板三：开发者 — 改造现有 Skill 适配 Vault

```
我有一个已有的 OpenClaw Skill，需要改造它以适配 OpenClaw Vault 的密文保护。

改造原则：
1. 不直接依赖 Vault API — 只需在发给 AI 的文本中用 <<s:...>> 包裹敏感值
2. 向后兼容 — <<s:...>> 在没有 Vault 时不影响功能
3. 两种保护路径：
   - 代码中自动包裹：用 <<s:${value}>> 包裹敏感变量
   - 文档引导用户：告知用户用 /s add 预注册敏感值

还原规则：
- inline <<s:...>> 还原后格式：<<s:原文>>
- 预注册密文还原后格式：明文值

以下是我的 Skill 源码中涉及敏感内容的部分：
[粘贴相关代码]

请帮我：
1. 识别哪些地方需要适配
2. 用最小改动完成适配
3. 在 Skill 文档中添加 Vault 配合使用说明
```
