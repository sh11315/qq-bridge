# QQ ↔ DSH 桥接 · 设计与部署交接单 v0.3

> 用途：交给另一个 DSH 实例 / 另一台机器，照着就能把这个「QQ 群友」跑起来。
> 权威细节仍以 `README.md`（安装与协议）、`docs/FOLDER_MAP.md`（目录约定）、
> `RULES.md`（权限边界）为准；本文是「一页看懂 + 全表 + 排错」。
> 版本基线：`qq-bridge 0.2.1-r1`，适配 DSH `0.2.1-rc.2`（0.2.0-rc.2 亦兼容）。
> 给 DSH 执行用：见 **`docs/DEPLOY_PLAYBOOK.md`**（前置/命令/期望输出/失败分支/幂等）与
> **`scripts/deploy-check.mjs`**（只读自检，退出码即结果）。

## 1. 这是什么

一条把 QQ 消息接进 DeepSeek Harness agent 的桥：

```
QQ 客户端 ─► SnowLuma（OneBot v11 WS 3001 / HTTP 3000）─► qq-bridge 进程 ─► DSH Web API（127.0.0.1:3080）
                                                              ▲                      │
                                                              └─ agent 回复/工具调用/审批 ┘
```

- 一条 QQ 消息 = 一个 DSH 会话里的一条 user message；agent 的发言经桥接发回 QQ。
- 群聊/私聊、@ 唤醒、引用、图片/表情/语音/视频、合并转发、联网搜索、看图、记忆、黑话、拍一拍。
- 鉴权：用 `~/.dsh` 里持久化的浏览器会话签名密钥**离线铸造 Cookie**（DSH 0.1.7 起启动 token 只在内存）。
- 传输代次：Cookie 鉴权 + 斜杠 RPC + `/api/remote.mux` 事件流（DSH 0.1.2-alpha.1 起）。

## 2. 进程与目录

| 部件 | 位置 | 作用 |
| --- | --- | --- |
| 主桥接 | `src/bridge.js`（约 1MB） | 收 QQ 事件、拼提示词、唤醒判定、调 DSH、回消息；单进程常驻 |
| DSH 客户端 | `src/dsh-client.js` | Cookie 鉴权、斜杠 RPC、`/api/remote.mux` 事件流、会话创建/退役 |
| 网关连接 | `src/snowluma-conn.js` | 按账号发现 OneBot HTTP/WS token，换 QQ 号不用改配置 |
| 会话路由 | `src/core/session-router.mjs` | 纯函数：给定会话 key → mode / preset / model / effort（fail-closed） |
| 功能会话 | `src/core/feature-sessions.mjs` | chat / vision / sticker / voice / web 分 lane、各自工具面 |
| 提示词 | `src/preset-prompt.js`、`src/role-card.js`、`src/qq-model-view.js` | preset 装配、角色卡注入、QQ 侧视图 |
| MCP 工具 | `src/mcp-snowluma-safe.js`、`mcp-memory-server.js`、`mcp-web-search-safe.js`、`mcp-host-server.js` | 给 agent 暴露 QQ 工具 / 记忆 / 搜索 |
| 其它能力 | `src/image-gen.mjs`、`voice-core.js`、`web-search.js`、`sticker-lib.js`、`media-normalize.js`、`doc-extract.js` | 出图、语音、搜索、表情、媒体归一化、文档提取 |
| 控制台 | `console/server.mjs` + `public/` | 127.0.0.1 统一控制台：配置、白名单、模型、日志、侧栏 |
| 状态 | `state/` | 会话快照、唤醒配置、黑话库、记忆 vault、日志（`state/agents` 为 agent 工作目录） |
| 配置 | `config.json`（28KB 实跑 / `config.example.json` 模板） | 白名单、模型、社交参数、工具开关；改前自动备份 |
| 脚本 | `scripts/` | 测试、探针、管理 CLI（`qq-admin.mjs`、`backlog-open.mjs`、`memory-maintenance.mjs`） |

## 3. 消息流水线（调用栈视角）

```
OneBot WS 事件（message/meta/poke/notice）
  └─ bridge.js 主事件循环
       ├─ allowed(kind,id,cfg)         白名单/黑名单过滤
       ├─ 媒体归一化 media-normalize / 提取 segmentsToText
       ├─ 会话 key 规范化「group:<群号> | private:<QQ>」
       ├─ session-router.modeFor(key)  取 mode/preset/model/effort
       ├─ feature-sessions             选 lane（chat/vision/…），收窄工具面
       ├─ 唤醒判定（wake 配置 + 批次窗口 + 频率上限）
       │    └─ 未命中 → 只入快照，不建回合
       ├─ 提示词装配：角色卡 + 记忆 + 状态 + 时间感 + 消息快照 + 唤醒原因
       ├─ dsh-client：保活/新建 DSH 会话 → 发送 user message（斜杠 RPC）
       └─ remote.mux 事件回流
            ├─ assistant 文本 → 分条 → qq_send_message（走发送节奏与频率限制）
            ├─ 工具调用 → MCP 工具（QQ/记忆/搜索），结果回灌同一轮
            ├─ 提问/审批 → 转成 QQ 消息交给 owner
            └─ 回合结束 → turn-summary / 经验写入 state
```

要点：
- **一个 QQ 会话一个 DSH 会话**；DSH 会话上下文按 `socialV2.context` 阈值轮换/退役。
- **lane 不是新会话**：各功能会话共享同一份最近消息快照、记忆、黑话库，但工具清单各自收窄。
- 工具隔离是「profile 级 schema 收窄 + 执行期守卫」双保险；新增的 DSH 全局工具要补进 `CORE_FLAGS` 才能隐藏。
- 发送侧统一走出站队列：分条、随机间隔、频率上限、引用/@ 规则都在这里。

## 4. 设计要点

1. **模式分层**：`chat` / `reserved` / `reserved2`（= `simulation`）/ `closed-agent`。
   仿真模式无本地工具、白名单门禁；`closed-agent` 只允许 owner 私聊，默认永不提权。
2. **唤醒墙**：`mode=diving|active`、`infinite|有限时间`、triggers（@/名字/关键词/提问/拍一拍/概率/指定人）
   + 批次窗口 + 每分钟/每小时上限 + `noActionLimit`（连续无动作自动收敛）。
3. **计划可观测**：`qq_plan_wake` 自排唤醒；失败重排（最多 2 次），彻底失败下一轮主动告知，
   避免「排了没叫」让 agent 以为说过话。
4. **沉睡前观察**：默认 5 分钟（`socialV2.wake.preSleepWaitMs`），防止刚走就有人接话。
5. **记忆三层**：轻量记忆（activeTopic/印象）→ 深度记忆（`mcp-memory-server`：短/长期、实体关系、日记、情绪）
   → 长期 Markdown 记忆（memory 工具）；关键记忆持续注入。
6. **安全边界**：只有 owner 在管理员回合有本地工具权限；其余人要求执行命令/读写文件一律拒绝（见 `RULES.md`）。

## 5. config.json 配置项全表

> 模板见 `config.example.json`（以下键均出自该文件；敏感项以 `***` 表示，不要写实值）。
> 改配置推荐用控制台或 `node scripts/qq-admin.mjs config set 路径=JSON值`（自动备份）。

### 5.1 顶层
| 键 | 说明 |
| --- | --- |
| `ownerQQ` | 管理员 QQ 号；只有它的私聊回合给本地工具权限。**必填** |
| `sessionCwd` | agent 会话工作目录（留空用默认） |
| `agentPreset` | 默认 agent preset 名（如 `qq-chat`） |
| `workspaceTitle` | DSH 侧工作区标题 |
| `allow.private` / `allow.groups` | 白名单（不填且 `allowAllWhenEmpty=false` 则谁都不理） |
| `deny.private` / `deny.groups` | 黑名单，优先级高于白名单 |
| `allowAllWhenEmpty` | 白名单为空时是否放行所有人（默认 false） |
| `ackMessage` | 收到消息时可选的回执文案（空=不回执） |
| `sendDelayMs` | 发送前基础延迟（毫秒） |
| `questionTimeoutMs` | agent 提问等待回答的超时 |
| `consolePort` / `consoleToken` | 控制台端口与访问令牌（别名 consoleToken 敏感） |
| `security.interceptNotify` | 拦截「通知类」危险指令 |
| `role.maxInjectChars` | 角色卡注入上限（默认 6000 字符） |

### 5.2 dsh
| 键 | 说明 |
| --- | --- |
| `baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `provider` / `model` / `reasoningEffort` | 默认供应商、模型、推理强度 |
| `authToken` / `authHeader` / `authPrefix` | 鉴权覆盖项（一般留空，走离线 Cookie） |
| `allowRemote` | 是否允许远程 DSH 地址 |
| `features.enabled` | 是否启用功能会话 |
| `features.explicitCommands` | 是否支持 `/sticker` `/vision` `/voice` `/web` 显式指令 |
| `features.proactiveFeature` | 主动对话用哪个 lane（默认 `web`） |
| `features.models.*` | 各 lane 的档位/模型覆盖（chat 分 group/private，sticker/vision/voice/web） |

### 5.3 snowluma
| 键 | 说明 |
| --- | --- |
| `wsUrl` / `httpUrl` | OneBot 网关地址，默认 3001（WS）/ 3000（HTTP） |
| `accessToken` | 网关 token（留空则自动按账号发现） |
| `followDiscoveredEndpoint` | 是否跟随自动发现的端点 |
| `silenceWarnMs` | 多久没消息记为静默告警 |
| `launcherPath` / `homeDir` | 网关安装路径 / 主目录（用于扫 per-account token） |

### 5.4 adminTurnTools
| 键 | 说明 |
| --- | --- |
| `enabled` | 管理员回合是否解锁本地工具 |
| `allowLocal` | 是否允许本地 shell/文件工具 |

### 5.5 slang（黑话学习）
`enabled` 开关、`extractMinMessages` 触发门槛、`extractCooldownMs` 冷却、
`inferenceThresholds` 出现次数档位 `[2,4,8]`、`injectMax` 注入上限、
`learnerPreset` 学习用 preset、`workspaceTitle`、`autoResearch` 自动检索释义。

### 5.6 social（旧版社交，保留）
`enabled`、`maxReplyChars`、`mustReplyKeywords`、`contextWindow`、`triggerProbability`、
`activeCheckMinMs/MaxMs`、`idleWindowMs`、`idleRetryProbability`、`proactive*`、
`activeReplyDelayMinMs/MaxMs`、`skipProbability`、`burstEnabled`、`burstIntervalMinMs/MaxMs` 等。

### 5.7 socialV2（二代仿真主配置）
| 组 | 键（摘要） |
| --- | --- |
| 总 | `enabled`、`agentPreset`（如 `qq-chat-v2`）、`autoReplyCheckMs`、`provideRecommendations`、`initialPromptMaxChars` |
| `tools` | 逐工具开关：getPrompt/getUnread/getRecent/sendMessage/sendBurst/reply/waitMessages/markRead/setWakeConfig/memory/slang*/getImages/getForwardMsg/sendPoke/sticker 系/voice 系 等 |
| `wake` | `defaultMode`、`preSleepWaitEnabled`、`preSleepWaitMs`、`staleChatMinutes`、`staleSilentMinutes`、`batchWindowMs`、`maxWakePerMinute/Hour`、`noActionLimit`、推荐值字段 |
| `send` | `burstEnabled`、`burstMaxMessages`、间隔上下限、`maxSendPerMinute/Hour`、`maxMessageChars`、按字数算间隔参数 |
| `wait` | `defaultMs`、`minMs`、`maxMs`（上限 600000）、`defaultQuietMs`、`minQuietAfterNewMs` |
| `sticker` | `enabled`、`syncTtlMs`、`maxListCount`、`includeInPrompt`、`promptMaxStickers`、`collect.*` |
| `voice` | `enabled`、`dir`、`maxSeconds`、`maxBytes`、`maxPerMinute/Hour`、`ffmpegPath` 等 |
| `proactive` | `enabled`、检查间隔、`idleThresholdMs`、`probability` |
| `context` | `recentLimit`、`unreadLimit`、`contextWindow`、`inlineWakeMessages`、`wakeMessageLimit`、`wakeMaxChars`、`emptyTurnsBeforeRotate`、`maxPromptTokens`、`rotateCooldownMs` |
| `memory` | `autoRecall`（总开关）、`limit`（注入条数，默认 6）、`serendipity`（忽然想起，0.18）、`autoEmotion` |
| `userMemory` | `enabled`、`maxUsers`（跨群用户画像，落 `state/user-memory.json`） |
| `photoMemory` | `enabled`、`maxPhotos`、`recallLimit`、`maxChars`、`keepDays`、`storeOriginals`、`maxOriginalBytes` |
| `media` | `maxBytes`、`maxFetchBytes`、`maxPixels`、`maxCount`、`maxFileBytes`、`normalize`、`maxModelBytes`、`maxLongEdge`、`gifFrames`、`gifTile`、`normalizeTimeoutMs`、`pythonPath` |

### 5.8 其它
| 组 | 说明 |
| --- | --- |
| `webSearch` | `provider`（auto）、`apiKey`（***）、`apiKeyEnv`、`model`、`maxUses`、`maxResults`、`timeoutMs` |
| `api` | 可选直连模型模式：`enabled`、`baseUrl`、`apiKey`（***）、`model`、`groupTrigger`、`wakeWords`、`maxReplyChars` 等 |
| `unifiedConsole` | 统一控制台：`port`（默认 7788）、`autoHeal`、`napcatDir`、`napcatQQ`、`dshExe`、`dshCli` |
| `pricing` | 计量单价：`models.<模型>.off.{cacheHit,cacheMiss,output}` |

## 6. 部署顺序（新机器）

1. Node.js ≥ 22.13；`npm install`（postinstall 会打 snowluma SDK 补丁）。
2. 装并启动 **SnowLuma**（OneBot v11），QQ 号登录；确认 WS 3001 / HTTP 3000 可连。
3. 装 **DeepSeek Harness**，确认 Web GUI 在 127.0.0.1:3080 可访问。
4. `config.example.json` → `config.json`，至少填：`ownerQQ`、`allow.*`、`dsh.baseUrl`、`dsh.model`、`snowluma.*`。
5. 启动桥接 `npm start`（Windows：`start.bat`；控制台 `start-console.bat`）。
6. 自检：`node scripts/qq-admin.mjs verify`（控制台/桥接/DSH/QQ 四项）；
   `npm run test:audit`、`npm run verify:adaptation` 与 README 一致即通过。
7. owner 私聊发一条消息确认能回；群里 @ 一次确认唤醒与回复。
8. 备份：`config.json` + `state/`（含 `memory-vault`）定期打包；建议 `npm run harden-acl`。

## 7. 故障排查清单

| 症状 | 先查 | 常见根因 / 处理 |
| --- | --- | --- |
| 发消息完全没反应 | 桥接日志、`verify` | DSH 升级删了提示词变量（如 `{{cwd}}`）导致每回合在装配阶段 error；跑 `verify:adaptation` |
| 换 QQ 号后工具 401 | `snowluma.homeDir`、per-account token | 账号 token 变了；靠 `snowluma-conn.js` 自动发现，确认 homeDir 对 |
| 群里每条消息都醒 | `wake.anyMessage`、概率 | 关掉 anyMessage，概率降到 0.05 |
| 排了计划没叫 | 活动日志 `[wake-plan]` | 看失败重排与主动告知是否触发；必要时 `qq_plan_wake` 重排 |
| 「有话说」其实没发 | 回合日志 / 发送失败 | 发送被频率或白名单拦；看 `maxSendPerMinute/Hour` |
| 会话永久「繁忙」 | DSH 队列 | 退役会话前要清 DSH inbox；`session/projections` 读队列 |
| 工具隔离失效 | `CORE_FLAGS` | 新增全局工具未加入隐藏名单 |
| 引用里的文件读不了 | 媒体归一化日志 | 文件被当图片；走 `doc-extract.js` 路径 |
| 消息拆条很怪 | `splitWarn` 日志 | 同句被误判拆开发；按标点/语义边界调 |
| 表情发不出 | CDN / `emoji_id` | 走 CDN 优先、`emoji_id` 兜底、DNS 多地址切换 |

## 8. 交接给下一个 DSH 时的检查单

- [ ] `node scripts/qq-admin.mjs verify` 全绿
- [ ] `npm run test:audit`、`npm run verify:adaptation` 通过
- [ ] owner 私聊 + 群 @ 各验一次
- [ ] `config.json` 不含明文密钥（`privacy-scan`）
- [ ] `state/` 已备份、ACL 已加固
- [ ] 知道怎么重置：停桥接 → 改 config → 重启；会话退役走控制台

## 9. 运维手册（长期运行）

### 9.1 进程守护
- 桥接是单进程，崩了必须拉起：Windows 计划任务/服务启动 `start.bat`，或统一控制台的
  `unifiedConsole.autoHeal`（发现 NapCat/桥接掉线就重拉）。
- `restart.bat` 一键重启桥接与控制台；`start-console.bat` 单独起控制台。
- 建议：开机自启 + 失败重试（3 次、间隔 30s）+ 日志只留最近 7 天。

### 9.2 健康指标
| 指标 | 来源 | 建议阈值 |
| --- | --- | --- |
| 四项自检 | `node scripts/qq-admin.mjs verify`、控制台 `/api/health` | 连续 3 次失败即告警 |
| 综合诊断 | 控制台 `/api/diagnostics` | 任一子系统红即查 |
| 心跳 | 网关 meta_event / 桥接日志 | 5 分钟无心跳告警 |
| 发送失败率 | 日志统计 | > 5% 告警 |
| 回合延迟 | 回合日志（收消息 → 首条回复） | > 60s 告警 |
| token 用量 | 控制台用量页 / `state` 计量文件 | 按日预算，超 80% 提醒 |

### 9.3 升级与回滚
- 顺序：停桥接 → 备份 `config.json` + `state/` → `npm install` → 起桥接 →
  `verify` + `test:audit` + `verify:adaptation`。
- DSH 版本不兼容时按 README 的对照表切 tag（0.1.1-rc.2 / 0.1.5 / 0.1.7 / 当前 0.2.1-rc.2）。
- 回滚：`git checkout <tag>` + `npm install`；配置用控制台 `/api/backup/restore` 或
  `config.json.bak-*` 恢复。

### 9.4 密钥轮换
- OneBot token：SnowLuma 每个账号有 HTTP/WS 两套，换号后由 `src/snowluma-conn.js` 自动发现；
  轮换后重启桥接并 verify。
- `dsh.authToken`、`webSearch.apiKey`、`api.apiKey`、`consoleToken`：改完重启对应进程，绝不进 git。
- 定期跑 `npm run privacy-scan`，再用 `npm run harden-acl` 收紧 `state/` 权限。

### 9.5 会话退役演练
1. 低峰期、先在测试群做。
2. 控制台会话页退役/重置目标 key。
3. 桥接会先清 DSH inbox（走 `session/projections`），日志里不该再出现
   `invalid session/control baseline`。
4. 验证：退役后发一条消息能正常新建会话，旧会话不再烧 token。
5. 失败回退：保留 `state/` 快照，重启桥接后恢复。

### 9.6 配置 schema 校验
- 只走三种入口改配置：控制台 `/api/config`、`node scripts/qq-admin.mjs config set`、手改后校验 JSON。
- 写入是原子写 + 自动备份；解析失败保留旧文件。
- 建议 CI 常跑 `verify:persona`、`test:preset-prompt`、`test:setup-idempotent`，防配置漂移。
- 改到启动期才读的项（端口/模型/语音开关）必须重启桥接；改 preset/插件要重启 DSH。

## 10. 交接验收（可勾）
- [ ] health / diagnostics 正常，verify 四项绿
- [ ] 升级演练一次（含回滚）
- [ ] 密钥轮换演练一次
- [ ] 会话退役演练一次
- [ ] 配置改错能被备份回滚
- [ ] 守护/自愈开启，异常能自动拉起
