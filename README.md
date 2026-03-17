# OpenClaw Vault

OpenClaw Vault 是 OpenClaw 的插件，为 AI Provider 流量提供**本地透明代理**。

核心目标：在请求发往 AI Provider 前，把敏感内容替换成随机临时 token；在 Provider 响应返回后，再把 token 还原回原文。整个过程对用户和 AI 模型透明，**敏感原文不会出现在上游请求中**。

---

## 功能效果

### 请求侧脱敏

- **inline 密文**：输入中的 `<<s:原文>>` 会被替换为 `<<s.随机6位字母数字>>` 格式的临时 token
- **已登记密文**：通过 `/s add` 注册的密文值，只要出现在请求体中就会被自动替换（按长度倒序匹配，避免短值误切长值）

### 响应侧还原

- **普通 HTTP 响应**：整包读取后统一还原，自动重算 `content-length`
- **SSE 流式响应**：按完整 SSE block 逐块还原，支持 OpenAI Responses 和 Anthropic Messages 等常见 SSE delta 协议；内置跨 chunk token 拼接，不会吐出半截 token

### 会话隔离

- 每次请求创建独立的 token 映射表
- 响应结束后（无论成功或失败）立即清空，不跨请求复用

### Provider 自动接管

- `/s check` 自动把目标 provider 的 `baseUrl` 改写为本地代理地址（默认 `127.0.0.1:19100`）
- 同时将真实上游 URL 备份到配置和状态文件，后续代理据此转发

### 密文注册表

- 支持 `add` / `update` / `remove` / `list` 管理已登记密文
- 列表只展示名称、长度和 SHA-256 摘要前 12 位，不显示明文

---

## 工作原理

```text
OpenClaw ──请求──▶ Vault 本地代理（127.0.0.1:19100）
                       │
                  ① 读取请求体，替换 <<s:原文>> 和已登记密文为临时 token
                       │
                  ② 将脱敏后的请求转发到真实 AI Provider
                       │
                  ③ 收到响应，按本次 token 映射表还原所有 token
                       │
                  ④ 还原后的响应返回给 OpenClaw
                       │
                  ⑤ 立即丢弃本次请求的所有映射关系
```

**示例**

| 阶段 | 内容 |
|------|------|
| 用户输入 | `<<s:我的密码123>>` |
| AI 上游看到 | `<<s.aB3xZ9>>` |
| 用户最终看到 | `<<s:我的密码123>>` |

---

## 安装方式

### GitHub 一键安装

> 前提：你已经安装并初始化过 `openclaw` CLI，且本机可执行 `node` 与 `openclaw`。

#### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/dayhi/openclaw-vault/main/scripts/install.sh | sh
```

#### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/dayhi/openclaw-vault/main/scripts/install.ps1 | iex
```

安装器会自动完成：

1. 默认解析 `dayhi/openclaw-vault` 的 latest release
2. 下载该 release tag 对应的源码归档
3. 提取仓库根目录中的插件
4. 执行 `openclaw plugins install`
5. 自动启用 `openclaw-vault`
6. 执行 `openclaw vault setup`
7. 重启 OpenClaw Gateway

> 如果仓库尚未发布任何 release，默认一键安装会直接报错，不会回退到 `main`。此时请先发布首个 release，或临时显式执行 `node scripts/install.mjs --ref main` 安装未发布代码。
>
> 如果你想只安装但暂不重启，可给 Node 安装器追加 `--no-restart`。

### 仓库内手动安装

如果你已经把整个仓库 clone 到本地，可以直接安装当前工作树里的插件目录：

```bash
openclaw plugins install .
```

或在 Windows PowerShell 中：

```powershell
openclaw plugins install .
```

安装完成后，执行：

```bash
openclaw vault setup
openclaw gateway restart
```

如果 `openclaw vault setup` 写回了 provider 配置，建议再重启一次 Gateway，确保新的 `baseUrl` 生效。

### 更新到最新版本

如果你是通过 GitHub 一键安装的，直接重新执行同一条安装命令即可；安装器会先卸载已有安装，再安装最新 release。

如果你想安装尚未发布的仓库代码，请显式执行 `node scripts/install.mjs --ref main`。

如果你是从本地仓库目录安装的，也可以在更新仓库后重新执行：

```bash
openclaw plugins uninstall openclaw-vault --force
openclaw plugins install .
openclaw vault setup
openclaw gateway restart
```

### 配置插件

插件配置位于 `~/.openclaw/openclaw.json` 的 `plugins.entries.openclaw-vault.config` 下。通常无需手动编辑，安装器和 `openclaw vault setup` 会自动补齐必要配置。

如果你需要手动设置，可参考：

```json5
{
  plugins: {
    entries: {
      "openclaw-vault": {
        enabled: true,
        config: {
          proxy_port: 19100,        // 可选，默认 19100
          secrets_baseurls: {}      // 由 vault setup 或 /s check 自动填充
        }
      }
    }
  }
}
```

如果你的配置启用了 `plugins.allow` 白名单，也要确保其中包含 `openclaw-vault`；CLI 安装流程会自动处理这一点。

### `openclaw vault setup` 会做什么

`openclaw vault setup` 与聊天中的 `/s check` 复用同一套 Provider 接管逻辑，会自动完成以下操作：

1. 将 `models.providers.<providerId>.baseUrl` 改写为本地 Vault 代理地址
2. 将真实上游 URL 备份到 `plugins.entries.openclaw-vault.config.secrets_baseurls`
3. 将备份同步写入插件状态文件 `vault-providers.json`

如果你更习惯在聊天里操作，也可以继续使用：

```text
/s check
```

---

## 使用方法

### 方式一：inline 密文（即用即写）

在任何会发往模型的文本中使用 `<<s:...>>` 包裹敏感内容：

```text
我的数据库密码是 <<s:mySecret123>>，请帮我写连接代码
```

- 请求发往上游前，`<<s:mySecret123>>` 被替换为类似 `<<s.xK9mP2>>` 的临时 token
- 响应返回时，token 被还原为 `<<s:mySecret123>>`
- **支持多行内容**：换行、空格、前导空白都会原样保留和还原

```text
<<s:第一行
第二行
  缩进行>>
```

### 方式二：已登记密文（预注册自动匹配）

通过 `/s` 命令预先注册密文，之后请求体中出现该值时会被自动替换：

| 命令 | 说明 |
|------|------|
| `/s add <name> <value>` | 添加密文 |
| `/s update <name> <value>` | 更新已有密文的值 |
| `/s remove <name>` | 移除密文 |
| `/s list` | 查看已登记密文列表（只显示名称、长度、SHA-256 摘要） |
| `/s check` | 检查并接管 Provider，同步代理配置 |
| `/s help` | 显示帮助信息 |

**示例**

```text
/s add db_pass mySecret123
```

之后，只要请求体中出现 `mySecret123`，Vault 就会在转发上游前把它替换为临时 token，响应中的 token 会被还原为明文 `mySecret123`（注意：已登记密文还原后是明文，不会带 `<<s:...>>` 包裹）。

### 查看密文列表

```text
/s list
```

输出示例：

```text
Vault 密文列表：
- db_pass | len=11 | sha256=a1b2c3d4e5f6
```

---

## 插件配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `proxy_port` | integer | `19100` | 本地代理监听端口（1–65535） |
| `secrets_baseurls` | object | `{}` | Provider 真实上游 URL 映射（由 `/s check` 自动管理） |

配置位于 `plugins.entries.openclaw-vault.config` 下。

## 插件状态文件

插件在自身状态目录下维护两个 JSON 文件：

| 文件 | 用途 |
|------|------|
| `vault-secrets.json` | 已登记密文的名称和值 |
| `vault-providers.json` | Provider 原始 baseUrl 备份 |

---

## 能力边界

### 这是什么

- 本地 HTTP 代理 + 临时随机 token 替换 + 响应还原
- 目标是**让敏感原文不出现在发往 AI Provider 的请求中**

### 生效条件

- 只有经过 Vault 代理的 provider 请求才会被脱敏/还原
- 未被 `/s check` 接管的 provider，或绕过代理的直接请求，不受保护
- 代理默认监听 `127.0.0.1`，仅本机可访问

### 还原限制

- **还原依赖 token 在响应中原样存在**：如果 AI 模型改写、拆分、删除了 token，则无法还原
- 这是 token 替换方案的固有限制，对单行和多行内容均适用

### 大文件 / 部分读取边界

- Vault **只处理实际到达代理的请求体内容**，不会参与宿主或工具在代理之前进行的文件部分读取、裁剪、摘要或截断
- 如果 `read` 等工具因为文件过大只发送部分内容，而截断恰好发生在敏感片段内部，可能会破坏 `<<s:...>>` 的完整边界，或把已登记密文拆成不连续片段
- 当前请求侧替换不会跨“宿主已经截断/分段后的边界”重新拼接匹配；只有在最终请求体中**完整出现**的 inline 密文或已登记密文才会被替换
- 因此，大文件场景下如果敏感内容依赖完整结构才能识别，宿主先读一部分再发给模型时，残留的原文片段可能不会被转换

### 内容格式

- 请求体和响应体均按 **UTF-8 文本** 处理
- 已覆盖：普通 HTTP JSON 响应、SSE 流式响应（含 OpenAI Responses 和 Anthropic Messages 协议）
- 未覆盖：二进制 payload、非文本编码的请求/响应

### inline 密文 vs 已登记密文

| | inline `<<s:...>>` | 已登记密文（`/s add`） |
|---|---|---|
| 多行支持 | 支持 | 不支持（必须单行） |
| 空值处理 | `<<s:>>` 保留原样，不替换 | 空值会被拒绝 |
| 还原后格式 | `<<s:原文>>` | 明文值 |
| 名称要求 | 无 | 名称不能为空、不能含空白字符 |

### `/s add` 命令的留痕风险

- `/s add db_pass mySecret123` 这条命令本身可能出现在宿主聊天记录、转录或日志中
- 建议只用于登记临时测试密文，或你已接受其暴露范围的内容

### 请求超时

- 代理转发上游请求默认超时 30 秒；超时后请求会被中止并返回 502 错误

---

## 适用场景

**适合**

- 希望在发往模型前，把 prompt 中的敏感片段替换成临时 token
- 希望尽量避免真实敏感值直接出现在上游 AI Provider 请求中
- 使用 OpenClaw 的 provider HTTP / SSE 链路，且接受本地代理方式

**不适合**

- 需要端到端加密或密钥托管能力
- 需要宿主侧聊天记录、命令记录、日志完全不出现敏感内容
- 核心数据是二进制 payload 而非文本 / JSON / SSE
