# Context

- 现有显式密文语法只有 `<<s:...>>`，依赖完整边界；当宿主或工具只读取文件的一部分时，若截断发生在密文内部，当前请求侧无法识别并遮掩这段内容。
- 请求侧主链路会在 [src/proxy-server.ts](src/proxy-server.ts) 中把整个请求体读成 UTF-8 文本后调用 `maskSecrets`；响应侧普通 JSON 与 SSE 最终都会走 `restoreSecrets`。
- 插件已在 [index.ts](index.ts) 中通过 `before_prompt_build` 注入 `VAULT_PROMPT_GUIDANCE`，可用于补充模型对新标签的理解规则。
- 本次已确认：`s#数量:密文` 中的 `数量` 按字符数计算；响应还原后保留为 `s#N:片段`；标签边界严格定义为“冒号后连续取 N 个字符，不够就取当前最大范围”。
- 目标是新增 `s#数量:密文片段` 语法：即使只截取到密文的一部分，也能按标签声明的数量对当前可见片段做遮掩，并在响应还原后保留“不完整但合法”的语义，便于模型提示用户延长截取范围。

# Recommended approach

1. 在 [src/mask.ts](src/mask.ts) 中新增对 `s#<数量>:` 的显式解析，不依赖单一正则直接完成整段匹配，而是先识别前缀再手动截取后续字符，按 `min(声明数量, 冒号后实际可见字符数)` 取出敏感片段并替换为现有标准 token `<<s.ABC123>>`。
2. 保持现有“先显式语法、后 registered”的顺序：继续先处理 `<<s:...>>`，再处理 `s#<数量>:`，最后执行 registered secrets 替换，避免后两步误进入已生成 token 片段内部。相关复用点在 [src/mask.ts](src/mask.ts) 的 `maskSecrets` 与 `replaceRegisteredOutsideTokens`。
3. 在 [src/token-store.ts](src/token-store.ts) 扩展 token 元数据：新增一种来源类型（如 `sized-inline`），并为该来源记录声明长度 `requestedLength`。同时扩展去重 key，确保相同片段但不同声明长度不会错误复用同一个 token。
4. 在 [src/restore.ts](src/restore.ts) 中为新来源增加恢复分支，统一恢复成 `s#<requestedLength>:<capturedFragment>`。这样即使当次只截到部分内容，也能保留“目标长度是多少、当前只拿到多少”的信息。
5. 维持 [src/proxy-server.ts](src/proxy-server.ts)、[src/stream-buffer.ts](src/stream-buffer.ts) 及各 SSE handlers 不变；新语法在请求侧仍落成现有标准 vault token，因此可直接复用当前跨 chunk / 跨 delta 的恢复能力。
6. 在 [index.ts](index.ts) 的 `VAULT_PROMPT_GUIDANCE` 追加规则：`s#<count>:<fragment>` 是合法保护数据；`count` 表示冒号后目标总字符数；若当前可见片段短于该数量，不要猜测、修复或要求用户替换，只需要求下次延长截取/扩大窗口，直到冒号后总长度达到声明数量。提示词里使用不会被实际匹配的新语法占位写法，如 `s#<count>:<fragment>`，避免 guidance 自身被请求侧脱敏。

# Critical files

- [src/mask.ts](src/mask.ts)：新增 `s#N:` 解析与请求侧脱敏主逻辑。
- [src/token-store.ts](src/token-store.ts)：扩展 source / entry 元数据 / key 规则。
- [src/restore.ts](src/restore.ts)：新增新来源的恢复输出。
- [index.ts](index.ts)：补充模型提示规则。
- [test/src/mask.test.ts](test/src/mask.test.ts)：新增语法解析与顺序回归。
- [test/src/restore.test.ts](test/src/restore.test.ts)：新增 `s#N:片段` 恢复断言。
- [test/src/token-store.test.ts](test/src/token-store.test.ts)：验证 `requestedLength` 参与 key。
- [test/src/proxy-server.test.ts](test/src/proxy-server.test.ts)：端到端验证普通响应与 SSE 回归。

# Verification

1. 单元测试：
   - `mask`：覆盖 `s#8:abcdefgh`、`s#10:abcd`、非法数量、空内容、与 `<<s:...>>` / registered 共存、不同声明长度不复用 token。
   - `restore`：覆盖新来源恢复成 `s#N:片段`，并验证旧 `inline` / `registered` 不回归。
   - `token-store`：覆盖 `source + value + requestedLength` 的 key 行为。
2. 代理端到端测试：
   - 普通 JSON 请求转发时，上游看不到 `s#N:` 后的明文片段，只看到 vault token；客户端响应恢复成 `s#N:片段`。
   - SSE 文本 delta / JSON delta 中的新来源 token 仍能通过现有 `StreamBuffer` + handlers 正确跨 chunk 恢复。
3. 手工验证：构造一个只含部分片段的输入，例如 `s#12:abcd`，确认请求侧会遮掩 `abcd`，响应侧保留 `s#12:abcd`，并且 guidance 已明确告诉模型“应延长截取直到冒号后达到 12 个字符”。
