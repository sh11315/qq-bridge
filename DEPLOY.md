# QQ Bridge 便携包 · 部署手册（给另一个 DSH 实例）

> 本包版本：`qq-bridge 0.2.1-r1`　生成日期：2026-11-23　平台：Windows 10/11 x64
> 读者有两类：
> - **人**：照着第 2～11 节做即可；每步都有命令、期望输出、失败怎么办。
> - **另一个 DSH agent**：把 `HANDOFF_PROMPT.md` 整段粘给它，让它按 `docs/DEPLOY_PLAYBOOK.md` 的
>   P0–P10 执行单干活；本文是它需要理解的背景与细节。
>
> 相关文档：`docs/DEPLOY_HANDOFF.md`（架构/配置全表/排错）、`docs/DEPLOY_PLAYBOOK.md`（P0–P10 执行单）、
> `PLUGIN_ADDRESSES.md`（插件与下载地址）、`THINKING_AND_MEMORY.md`（思考过程与记忆模式）、
> `README.md`（项目说明）、`RULES.md`（权限边界）。

---

## 0. 一分钟看懂

```
QQ 客户端 ⇄ SnowLuma（OneBot v11：WS 3001 / HTTP 3000）⇄ qq-bridge（本项目）⇄ DSH Web API（默认 3080）
                                                              │
                                                    统一控制台 7788（可选）
```

- 一条 QQ 消息 = DSH 会话里的一条 user message；agent 的回复/工具调用经桥接发回 QQ。
- 本包**已经带好** `node_modules`、`console/`、`plugins/`、`dsh/agent-presets/`、`scripts/`、桌面启动器与文档，
  解压后不需要联网装依赖（想重装也可以，见 3.1）。
- 本包**不包含**任何真实 `config.json`、`state/`、token、QQ 账号数据、NapCat 运行时、Edge 用户目录、个人语音与备份。
  这些必须在新机器上生成/填写。
- 首次部署约 **20–40 分钟**，其中大部分时间花在 SnowLuma 扫码登录 QQ。

**最短路径（四条命令）**：

```powershell
cd C:\qq-bridge
Copy-Item config.example.json config.json     # 然后改 ownerQQ / allow / dsh / snowluma
node scripts/setup-dsh.mjs web                # 注册 preset + MCP（需重启 DSH）
.\start.bat                                   # 起桥接（另开窗口）
.\start-console.bat                            # 起统一控制台（另开窗口）
```

---

## 1. 包内容与目录

| 路径 | 作用 |
| --- | --- |
| `src/` | 桥接主程序、DSH 客户端、MCP 工具、记忆/媒体/语音/搜索 |
| `console/` | 统一控制台（`server.mjs` + `ui.html`，默认 7788） |
| `public/console.html` | 控制台静态页（旧版兼容） |
| `plugins/qq-agent-presets` | DSH bundle：`qq-chat` / `qq-chat-v2` 两个 agent preset 的 patch |
| `plugins/qq-mode-console` | DSH 插件：`qq-mode` 设置命名空间 |
| `dsh/agent-presets/` | 两个 preset 的**权威源**（`agent.cordis.yml` / `preset.yml` / 工具守卫） |
| `scripts/` | 部署（`setup-dsh.mjs`、`deploy-check.mjs`）、运维（`qq-admin.mjs`）、测试、探针 |
| `desktop-app/` | `QQBridgeConsole.exe` 桌面启动器（Edge 应用窗口 + 看门狗）及其 `launcher.cs` 源码 |
| `roles/`、`assets/` | 角色卡示例与图片素材 |
| `node_modules/` | 已安装依赖（纯 JS，无原生二进制） |
| `docs/` | 部署交接单、Playbook、DSH 适配记录、控制台说明等 |
| `THINKING_AND_MEMORY.md` | 思考过程（reasoning）与记忆模式（memory）的开关、查看、验证、排错 |
| `config.example.json` | 配置模板（含少量示例 QQ 号，**必须改**） |
| `start.bat` / `start-console.bat` / `restart.bat` / `统一控制台.bat` | Windows 启动脚本 |

**没有带的东西（故意）**：`config.json`、`state/`（会话/记忆/黑话/日志）、`napcat/`、`backups/`、
`desktop-app/EdgeProfile/`、`integrations/`、`.env*`、`audio/`、`tools/ffmpeg/`、`config.json.bak-*`。
这些要么含凭据/个人数据，要么体积巨大且可在新机器重新生成。

---

## 2. 前置条件

### 2.1 系统

- Windows 10 1903+ / Windows 11，x64。
- 建议 4 GB 内存、2 GB 可用磁盘（不含 QQ 与 DSH 本体）。
- 安装路径**不要带空格和中文**（例如 `C:\qq-bridge`）；脚本大多能处理，但少一类坑。
- 端口占用检查（详见附录 A）：`3000`、`3001`、`3080`、`3100`、`7788`、`5099` 不冲突。

### 2.2 Node.js ≥ 22.13

```powershell
node -v
```

期望 `v22.13.0` 或更高。没有就装：

```powershell
winget install OpenJS.NodeJS.LTS
# 或从 https://nodejs.org/ 下载 LTS 安装包
```

装完**新开一个终端**再 `node -v`。

### 2.3 DeepSeek Harness（DSH）

- 桌面版从 <https://www.deepseek.com/harness/> 下载安装；
- 或按源码仓库 <https://github.com/deepseek-ai/deepseek-harness> 自行安装。

确认 CLI 可用：

```powershell
dsh --version
```

- 期望输出类似 `0.2.1-rc.2` / `0.2.2-rc.3`。
- 若提示找不到 `dsh`，找到 DSH 安装目录下的
  `resources\runtime\cli\bin\dsh.cmd`，把它所在目录加入 `PATH`，或后文用完整路径调用。
- 确认 profile 名称（本机默认 `web`，也可能有 `desktop` / `headless`）：

```powershell
Get-ChildItem $HOME\.dsh\profiles
```

后文 `setup-dsh.mjs` 的参数就是这个目录名。

> **版本说明**：本桥接的官方基线是 DSH `0.2.1-rc.2`（`0.2.0-rc.2` 亦兼容），
> 作者机器当前运行在 `0.2.2-rc.3` 上。新机器若装的是更新版本，**必须**跑
> `npm run verify:adaptation` 确认协议未漂移（第 9 节）；失败就按 README 切回基线版本。

### 2.4 SnowLuma（QQ 网关）

- 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest>
- 选 **win-x64 完整版**（自带 Node/运行时）；Lite 版需要本机 Node 24+。
- 运行后 WebUI 默认 <http://localhost:5099>。
- 需要一个能在这台机器登录的 QQ 号（机器人号），以及能扫码的手机。

---

## 3. 解压与安装

### 3.1 解压

```powershell
# 假设 zip 在 Downloads
Expand-Archive -Path "$HOME\Downloads\qq-bridge-0.2.1-r1-portable-20261123.zip" -DestinationPath C:\
cd C:\qq-bridge
Get-ChildItem
```

应看到 `package.json`、`src`、`console`、`config.example.json` 等。

> 校验：`Get-FileHash "$HOME\Downloads\qq-bridge-0.2.1-r1-portable-20261123.zip" -Algorithm SHA256`，
> 与发布目录里的 `SHA256SUMS.txt` 比对（在 zip 旁边；解压后的包内不再带）。

> `node_modules` 已随包提供。只有在你删了它、或换 Node 大版本想重装时才需要：
>
> ```powershell
> npm install
> ```
>
> `postinstall` 会给 `@snowluma/sdk` 打 ESM 补丁，看到补丁报错就停，别跳过。

### 3.2 验证依赖完整

```powershell
node -e "require.resolve('js-yaml'); console.log('deps ok')"
```

期望打印 `deps ok`。

---

## 4. 写配置（本步最关键）

```powershell
Copy-Item config.example.json config.json
notepad config.json
```

`config.json` 是一棵大 JSON 树（约 340 行），**不要整个替换**，只改下面这些键：

### 4.1 必改项

| 键 | 填什么 | 说明 |
| --- | --- | --- |
| `ownerQQ` | 你的 QQ 号（数字） | 管理员；只有它的私聊回合有本地工具权限。**必填**。5–12 位数字 |
| `allow.private` | `[你的QQ号]` | 私聊白名单；不填且 `allowAllWhenEmpty=false` 时谁都不理（fail-closed） |
| `allow.groups` | `[群号, ...]` | 允许的群；群聊只有被 @/命中唤醒条件才回 |
| `dsh.baseUrl` | `http://127.0.0.1:3080` | DSH Web API 地址；以你机器实际端口为准 |
| `dsh.provider` | 如 `deepseek-official` / `deepseek-account` | 必须是你 DSH 里真实存在的 provider |
| `dsh.model` | 如 `deepseek-flash` | 必须真实存在；不确定就先在 DSH GUI 里发一句话看用的哪个 |
| `dsh.reasoningEffort` | `auto` / `low` / `high` / `max` | 新机器建议先 `auto` |
| `snowluma.wsUrl` | `ws://127.0.0.1:3001` | SnowLuma 的 OneBot v11 **正向 WS 服务器** |
| `snowluma.httpUrl` | `http://127.0.0.1:3000` | SnowLuma 的 OneBot v11 HTTP 服务器（**不能和 wsUrl 同端口**） |
| `snowluma.accessToken` | SnowLuma 里设的 token；没设就留 `""` | 两边必须一致 |
| `unifiedConsole.napcatQQ` | 机器人 QQ 号 | 控制台显示/快速登录用；可留空，但建议填 |
| `unifiedConsole.napcatDir` | SnowLuma 的 NapCat 目录（可选） | 仅控制台的 NapCat 启停按钮需要；纯桥接可不填 |
| `unifiedConsole.dshExe` | `...\DeepSeek Harness.exe` 的完整路径 | 仅控制台的「重启 DSH」按钮需要 |

最小可用片段（合并进现有 JSON，不要整份覆盖）：

```json
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:3080",
    "provider": "deepseek-official",
    "model": "deepseek-flash",
    "reasoningEffort": "auto"
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": ""
  },
  "ownerQQ": 123456789,
  "allow": { "private": [123456789], "groups": [] },
  "unifiedConsole": {
    "port": 7788,
    "napcatQQ": "100000002",
    "dshExe": "C:\\Users\\<你>\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe"
  }
}
```

> 模板里的 `100000002`、`100000001`、`100000003` 是作者机器的示例号，**全部换成你自己的**。
> `qq-admin` 刻意不允许改 `ownerQQ`（权限字段），必须在这里手改或用控制台。

### 4.2 校验 JSON

```powershell
node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('config json ok')"
```

期望 `config json ok`。JSON 坏了桥接会拒绝启动，并保留上一份可用配置。

### 4.3 可选但建议

- `ackMessage`：收到消息先回一句回执（默认空，不回）。
- `adminTurnTools.enabled` / `allowLocal`：管理员回合是否允许本地命令（默认开）。
- `socialV2.wake.preSleepWaitMs`：沉睡前观察 5 分钟（默认 300000）。
- `mentionOnly.aliases`：群里除了 @ 还认哪些称呼。
- `webSearch` / `api`：需要联网搜索或直连模型再配，默认关闭/自动。
- `socialV2.memory` / `userMemory` / `photoMemory`：记忆模式开关（自动召回、用户画像、照片记忆），
  模板已带默认值；怎么调、怎么初始化/迁移/每日维护，见 `THINKING_AND_MEMORY.md`。

---

## 5. 注册 DSH 插件与 preset

```powershell
cd C:\qq-bridge
node scripts/setup-dsh.mjs web
```

最后参数是 **DSH profile 名**（第 2.3 节看到的目录名）。自定义 DSH_HOME 时：

```powershell
$env:DSH_HOME = "D:\dsh-home"
node scripts/setup-dsh.mjs web
```

`setup-dsh.mjs` 会做五件事（幂等，可重复跑）：

1. 在 `~/.dsh/plugins/` 建 `qq-agent-presets`、`qq-mode-console` 两个链接，指向本包；
2. 在 `~/.dsh/profiles/<profile>/node_modules/` 建同名链接；
3. 把这两个包写进 profile 的 `package.json`（`link:` 依赖 + `dsh.profile.bundles`）；
4. 在 profile 的 `cordis.patch.yml` 里注册四个 MCP server：
   `mcp-snowluma`、`mcp-snowluma-host`、`mcp-web-search-safe`、`mcp-memory`；
5. 调用 `dsh plugin --profile <profile> install` 重建 profile，并生成 `state/mode.json`（默认 `reserved2`）。

**期望**：退出码 0，最后提示 profile 已安装/已是最新。

**如果 `dsh` 不在 PATH**：

```powershell
$env:QQ_BRIDGE_SKIP_DSH_INSTALL = "1"
node scripts/setup-dsh.mjs web

# 然后用 DSH 自带的 CLI 手动装（路径按你的安装位置）
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile web install
```

看到 `cannot resolve profile bundle` 或启动时报缺 bundle，就是第 5 步没成功——重跑上面的 `plugin install`。

---

## 6. 重启 DSH（必须）

`setup-dsh` 改的是 profile 的 bundle 清单，**DSH 进程必须重启才会加载**。

- 桌面版：托盘图标 → 退出，再重新打开；或任务管理器结束 `DeepSeek Harness.exe` 后重开。
- 有控制台时：`node scripts/qq-admin.mjs restart dsh`（需要 `unifiedConsole.dshExe` 配好）。
- 重启后确认 DSH Web 可访问：浏览器打开 `http://127.0.0.1:3080`（以你的 `dsh.baseUrl` 为准）。

确认 preset 已加载（任选一种）：

```powershell
Select-String -Path "$HOME\.dsh\profiles\web\cordis.patch.yml" -Pattern "mcp-snowluma|qq-agent-presets"
```

或在 DSH 新建会话的 preset 列表里应能看到 `qq-chat` / `qq-chat-v2`。

---

## 7. 启动 SnowLuma 并登录 QQ

1. 解压/运行 SnowLuma（完整版自带运行时），打开 <http://localhost:5099>。
2. 用**机器人 QQ** 扫码登录；登录成功显示在线。
3. 进入 OneBot v11 配置，开启：
   - **HTTP 服务器**：`127.0.0.1:3000`
   - **WebSocket 服务器（正向）**：`127.0.0.1:3001`
   - 如设置了 access token，记下来填进 `config.json` 的 `snowluma.accessToken`。
4. 验证 HTTP：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/get_status
```

期望返回 `status=ok` / `retcode=0`（不同 SnowLuma 版本字段略有差异），且 `online=true`。

> 常见错误：`wsUrl` 和 `httpUrl` 填成同一个端口 → 桥接收到 `HTTP 426 Upgrade Required`。
> 端口被占：改 SnowLuma 端口，同时改 `config.json` 两处。

---

## 8. 启动桥接

**方式 A（推荐，带守护）**：

```powershell
cd C:\qq-bridge
.\start.bat
```

会新开一个窗口，桥接崩溃后 5 秒自动重拉；检测到 3100 已有实例会直接退出，避免双开。

**方式 B（前台调试）**：

```powershell
npm start
```

**期望日志**（大意）：

```
[snowluma] connected ws://127.0.0.1:3001
[bridge] ready ...
```

首次启动会创建 `state/`、`state/bridge.lock`、`state/mode.json`（默认 `reserved2`）。

**确认在跑**：

```powershell
node scripts/qq-admin.mjs status
```

> 单实例：同一目录只能有一个桥接。要重启用 `restart.bat`，不要直接再开一个。
> 端口 `3100` 是桥接内置 HTTP/单实例哨兵，别被其他程序占用。

---

## 9. 启动统一控制台

```powershell
cd C:\qq-bridge
.\start-console.bat
```

- 自动打开 `http://127.0.0.1:7788/?token=<state\console-token>`；
- 也可以双击 `desktop-app\QQBridgeConsole.exe`，用 Edge 应用窗口打开同一个控制台（启动器会读 `state\console-token` 并把 token 带进 URL）；
- 端口改 `config.json` 的 `unifiedConsole.port`（改完重启控制台）。
- **令牌门禁**：除 `/api/health`、`/api/version`、`/vendor/*` 外，页面和 `/api/*` 都要令牌。首次带 `?token=` 打开后服务端种 `qqb_console_token` HttpOnly cookie，之后浏览器里的 fetch/SSE 自动带；裸开 `http://127.0.0.1:7788/` 会看到 401 表单。`/go/bridge` 只 302，不再把 token 放进 `Location`。
- **只接受本机回环**：Host 必须是 `127.0.0.1` / `localhost` / `[::1]` 加实际端口；反向代理/端口转发会被 403。要远程访问请用 SSH 隧道。

确认健康（`/api/health` 是公开探活，不需要 token）：

```powershell
Invoke-RestMethod http://127.0.0.1:7788/api/health
```

期望 `ok=true`。

---

## 10. 自检（四项）

按顺序跑，**任何一项失败先修再往下**：

```powershell
cd C:\qq-bridge

node scripts/deploy-check.mjs
node scripts/qq-admin.mjs verify
npm run test:audit
npm run verify:adaptation
```

| 命令 | 期望 | 说明 |
| --- | --- | --- |
| `deploy-check.mjs` | 退出码 0，`ALL PASS` | 只读环境探针；首次部署前几项 FAIL 很正常 |
| `qq-admin verify` | 控制台/桥接/DSH/QQ 四项 ok | 需要控制台与桥接都在跑 |
| `test:audit` | 全绿 | 代码/协议回归，不需要网络 |
| `verify:adaptation` | 全绿 | 连**运行中的 DSH** 做协议探测；会建临时会话并归档 |

> `verify:adaptation` 失败通常意味着 DSH 版本漂移：按 README 的对照表切回 `0.2.1-rc.2`，
> 或更新桥接的 `feat/dsh-0.2.2-adaptation` 分支。

`deploy-check` 的检查项与失败含义见附录 B。

### 10.1 思考与记忆（建议加验）

```powershell
# 记忆库能读（新库显示 0 条是正常的）
node src/memory/cli.mjs stats

# 思考强度/记忆开关配置
node -e "const c=JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('effort=',c.dsh.reasoningEffort,'autoRecall=',c.socialV2.memory.autoRecall,'autoEmotion=',c.socialV2.memory.autoEmotion)"
```

- 期望：`stats` 输出「记忆库：… 条」，不报锁/路径错误；配置行能打印。
- 首次 `deploy-check` 的 `memory.vault` FAIL 常见于 vault 还没生成：先让 bot 记一条（生成
  `brain.json`），再跑 `node scripts/memory-maintenance.mjs --vault-only`；空库时这项 FAIL 属预期。
- 思考过程在哪看、五套记忆怎么开关/迁移/每日维护，见 `THINKING_AND_MEMORY.md`。

---

## 11. 端到端验收

1. 用 **owner QQ** 私聊机器人发一句「在吗」→ 60 秒内应收到回复。
2. 在允许的群里 **@机器人** 问一句 → 应被唤醒并回复。
3. 打开控制台「日志/会话」页，能看到对应回合；没有「永久繁忙」。
4. 记忆回路：owner 私聊「记住：我周五晚上一般有空」→ 回「好」后 `node src/memory/cli.mjs stats`
   总数 +1 → 再问「我周五晚上一般干嘛？」应能召回；控制台 `#memory` 能看到这条。
   （不验记忆也能上线，但验过才知道 `mcp-memory` 真的挂上了。）

失败排查顺序：

- 完全没反应 → 白名单是否空（fail-closed）、桥接日志、`qq-admin verify`；
- 有「正在输入」但不回 → DSH 会话/preset 未加载、模型不存在、`verify:adaptation`；
- 回复发不出 → SnowLuma 掉线、发送频率上限、token 不匹配；
- 群里不醒 → `mentionOnly` / `socialV2.wake` 配置、是否 @ 到机器人。

---

## 12. 守护、备份、升级、回滚

### 12.1 开机自启

任务计划程序 → 创建任务 → 触发器「登录时」→ 操作「启动程序」：

```
C:\qq-bridge\start.bat
```

或让控制台接管：`unifiedConsole.autoHeal=true`（默认开），掉线自动重拉 NapCat/桥接。

### 12.2 备份

定期打包：

```powershell
$stamp = Get-Date -Format yyyyMMdd-HHmm
Compress-Archive -Path C:\qq-bridge\config.json, C:\qq-bridge\state -DestinationPath "D:\backup\qq-bridge-$stamp.zip"
```

控制台也有 `POST /api/backup`（带 console token）。`state/` 里含记忆 vault 与会话快照，**不要外发**。

### 12.3 升级

本便携包**不是 git 仓库**，升级用「换目录 + 保留配置/状态」：

1. 停桥接与控制台；
2. 备份 `config.json` + `state/`；
3. 解压新包到新目录，把旧 `config.json`、`state/` 复制过去；
4. `node scripts/setup-dsh.mjs web`，重启 DSH，起桥接；
5. 重跑第 10 节四项。

### 12.4 回滚

保留上一个版本的 zip/目录；回滚 = 停进程 → 换回旧目录 → 恢复 `config.json` + `state/` → 重启。
配置改坏了：`config.json.bak-*` 或控制台备份恢复。

---

## 13. 故障排查表

| 症状 | 先查 | 处理 |
| --- | --- | --- |
| `deploy-check` 报 `repo.package` FAIL | 当前目录 | `cd C:\qq-bridge`，确认 `package.json` 在 |
| `node.version` FAIL | `node -v` | 升到 ≥22.13 |
| `config.exists` FAIL | 文件 | `Copy-Item config.example.json config.json` |
| `config.ownerQQ` FAIL | `ownerQQ` | 填 5–12 位数字（手改，qq-admin 不开放） |
| `config.allow` FAIL | 白名单 | 加至少一个私聊/群，否则 fail-closed |
| `dsh.reachable` FAIL | DSH 是否启动、端口 | 启动 DSH；改 `dsh.baseUrl`（401 也算可达） |
| `snowluma.http` FAIL | SnowLuma HTTP | 开 OneBot HTTP 3000；token 对齐 |
| `console.health` FAIL | 控制台 | `start-console.bat`；查 `unifiedConsole.port` |
| `state.writable` FAIL | 权限/杀软 | 对 `C:\qq-bridge\state` 给当前用户写权限；`npm run harden-acl` |
| 启动报 `cannot resolve profile bundle` | 第 5 步 | 重跑 `setup-dsh` 与 `dsh plugin --profile web install`，重启 DSH |
| 桥接拒绝建会话 | preset 未加载 | 第 6 节重启 DSH；确认 preset 列表有 `qq-chat` |
| `HTTP 426` | wsUrl/httpUrl | 两者不能同端口 |
| 401 / token 不匹配 | SnowLuma token | 两边改成一致，重启桥接 |
| 谁都不理 | 白名单空 | 加 `allow.private` / `allow.groups` |
| 群里每条都醒 | 唤醒概率/anyMessage | 控制台把概率调到 0.05，关 anyMessage |
| 会话永久「繁忙」 | DSH 队列 | 控制台退役会话；桥接会先清 inbox |
| 回复很慢/超时 | 模型、DSH 队列 | 换 `dsh.model`、降 `reasoningEffort`、看 DSH 日志 |

更多架构级排错见 `docs/DEPLOY_HANDOFF.md` 第 7 节。

---

## 14. 安全与隐私

- 本包**不含** `config.json`、`state/`、任何 token/API key、QQ 登录数据、个人语音与备份。
- `config.json`、`state/`、`state/console-token` 属于敏感文件：不要提交、不要发群、不要放进公开网盘。
- 白名单默认 **fail-closed**：空名单 = 谁都不理，这是安全设计，不是 bug。
- 只有 `ownerQQ` 的私聊管理员回合才有本地命令/文件权限；其他人要求执行命令应拒绝（见 `RULES.md`）。
- 定期轮换：SnowLuma OneBot token、`dsh.authToken`（如有）、`webSearch.apiKey`、`api.apiKey`、`consoleToken`。
- 包内源码/测试夹具含作者机器的示例 QQ 号（`100000001`、`100000002`、`100000003`），
  仅作占位；部署时全部换成自己的，对外分发前建议全局替换。
- `npm run privacy-scan` 可扫本机真实 QQ/路径；`npm run harden-acl` 收紧 `state/` ACL。

---

## 附录 A：端口表

| 端口 | 谁 | 说明 |
| --- | --- | --- |
| 3000 | SnowLuma | OneBot v11 HTTP（发消息/查状态） |
| 3001 | SnowLuma | OneBot v11 正向 WebSocket（收事件） |
| 3080 | DSH | Web API（`dsh.baseUrl`） |
| 3100 | qq-bridge | 内置 HTTP / 单实例哨兵（`consolePort`） |
| 7788 | qq-bridge 控制台 | 统一控制台（`unifiedConsole.port`） |
| 5099 | SnowLuma | 网关 WebUI |

> 3080 是默认值；你的 DSH 可能改了端口，以实际为准。DSH 桌面版还可能有另一个 GUI 端口（如 60954），
> 桥接用的是 API 端口，不要填错。

## 附录 B：`deploy-check` 检查项

| id | 通过条件 | 失败先做什么 |
| --- | --- | --- |
| `node.version` | ≥22.13 | 升级 Node |
| `repo.package` | 当前目录有 `package.json` 且 name=qq-bridge | `cd` 到包根 |
| `config.exists` | `config.json` 存在 | 复制模板 |
| `config.ownerQQ` | 5–12 位数字 | 手改 |
| `config.allow` | 白名单非空 | 加私聊/群 |
| `dsh.reachable` | HTTP <500 | 启 DSH / 改 baseUrl |
| `snowluma.http` | HTTP 可达 | 启 SnowLuma HTTP |
| `console.health` | /api/health 200 | 启控制台 |
| `state.writable` | 可写 | 修 ACL/权限 |
| `memory.vault` | 记忆 vault 可读/可建 | 检查 `state/memory` |

## 附录 C：命令速查

```powershell
cd C:\qq-bridge
Copy-Item config.example.json config.json
node scripts/setup-dsh.mjs web
.\start.bat
.\start-console.bat
node scripts/deploy-check.mjs --json
node src/memory/cli.mjs stats
node scripts/memory-maintenance.mjs --json
node scripts/qq-admin.mjs verify --json
node scripts/qq-admin.mjs config get allow
node scripts/qq-admin.mjs whitelist add-private <QQ>
node scripts/qq-admin.mjs whitelist add-group <群号>
npm run test:audit
npm run verify:adaptation
.\restart.bat
```

> `qq-admin` 只能改白名单/模型/社交参数等非敏感子树；`ownerQQ`、token、`consolePort` 等必须手改配置。
