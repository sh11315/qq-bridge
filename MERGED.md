# 合并说明：教程版 QQ 机器人 + 自定义版功能（统一系统）

本目录 `C:\Users\example\Documents\qq-bridge-merged` 是**副本**。原来正在运行的
`C:\qq-bridge` 一个字节都没动，3100 / 3080 上的进程也没碰。
确认没问题后，按本文第六节把线上切过来。

> 一句话：**教程版仍是主程序**（QQ 只由它接），把自定义版的
> 「直连 OpenAI 兼容 api 后端」和「7788 控制台」并了进来；白名单/管理员原样走 DSH Agent。

---

## 一、合并后的路由规则

| 会话类型 | 走哪条路 | 说明 |
| --- | --- | --- |
| ownerQQ（管理员） | **DSH Agent**（原行为） | 带工具/技能/表情包/黑话/二代仿真 |
| 命中 `allow.private` / `allow.groups` | **DSH Agent**（原行为） | 与合并前完全一致 |
| 其余会话 + `config.api.enabled=true` | **直连 OpenAI 兼容接口** | 轻量聊天，无工具，独立会话历史 |
| 其余会话 + `config.api.enabled=false` | 忽略（原行为） | 和教程版原来一样 |
| `closed-agent` 模式 | 只认管理员私聊 | 不给直连 api 开任何口子（安全） |

直连分支的群聊默认**只在被 @、被引用、或以唤醒词开头时**才回复（`api.groupTrigger=at`），
避免在别人的群里刷屏；`groupTrigger=all` 才会每条都回。

`config.api.enabled` 默认 `false`：不打开时，合并版的行为与教程版完全一致。

---

## 二、改了哪些文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/api-chat.js` | **新增** | 直连 OpenAI 兼容后端：请求、指数退避重试（429/5xx/网络/超时）、`reasoning_content` 思考过程写日志、每会话历史（可落盘 `state/api-sessions.json`）、群聊触发判定、路由纯函数 |
| `src/bridge.js` | 修改 | ① `loadConfig()` 增加 `api` 段；② 实例化直连后端；③ `handleIncoming` 入口按上文路由（管理员/白名单完全不经过新代码）；④ `/reset` 同时清直连历史；⑤ 新增控制台接口 `GET/POST /api/api-backend`、`POST /api/dsh/model` |
| `console/server.mjs` | **新增** | 统一控制台（7788）：三进程启停、状态探活、模型、白名单/owner、模式、人格、直连 api、日志 tail、余额、测试对话 |
| `console/ui.html` | **新增** | 控制台前端（零依赖，SSE 实时状态与日志） |
| `scripts/test-api-backend.mjs` | **新增** | 直连后端离线回归（60+ 断言，注入假 fetch，不联网） |
| `scripts/audit-bridge-harness.mjs` | 修改 | 把 `src/api-chat.js` 的导出注入 VM（bridge 的单测在 VM 里跑，import 会被剥掉） |
| `config.json` | 修改 | 增加 `api` 与 `unifiedConsole` 两段；`dsh.provider` 改为 `deepseek-account`（见第七节） |
| `package.json` | 修改 | 增加 `npm run console`、`npm run test:api-backend` |
| `统一控制台.bat` | **新增** | 双击启动 7788 控制台 |

新增的桥接 HTTP 接口（都在 3100，沿用原控制台 token）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/api-backend` | 读直连配置（Key 只回掩码）与运行计数 |
| POST | `/api/api-backend` | 改开关/模型/BaseURL/Key/人格/重试等，**热生效**并写回 config.json |
| POST | `/api/dsh/model` | 改 DSH 的 provider/model/reasoningEffort，热生效（下一条消息 selectModel） |

原有接口一个都没改签名；`/api/whitelist`、`/api/dsh/effort`、`/api/mode`、`/api/test-send` 等继续可用。

---

## 三、启动统一控制台（7788）

```powershell
cd C:\Users\example\Documents\qq-bridge-merged
D:\node.exe console\server.mjs
# 或者双击「统一控制台.bat」；也可以 npm run console
```

打开 <http://127.0.0.1:7788>。控制台只监听 `127.0.0.1`，不对外暴露。

界面/接口能力：

* **总览**：NapCat(3001) / 桥接(3100) / DSH(3080) / 模型 / 余额 五个状态点；全部启动、全部重启、全部停止；每个服务单独启停。
* **模型**：从 DSH `session/modelCatalog` 拉真实 provider/模型/思考档位，写入 `config.json` 的 `dsh.*`，并可选同时写 DSH 的 `agent-default-model`。
* **允许的人**：`ownerQQ`、`allow.private/groups`、`deny.private/groups`、模式（chat/reserved/reserved2/closed-agent）。
* **人格**：列出 `roles/*.md`、启用/清除角色、编辑并保存角色内容、静默/活跃。
* **直连 API**：开关、BaseURL、模型、Key、群聊触发、唤醒词、temperature、超时、重试、历史条数、人格提示词、图片开关。
* **实时日志**：tail `state/bridge.log` + NapCat/DSH 子进程输出，SSE 实时推送，可按服务过滤、清空显示。
* **测试对话**：走 `config.api` 的直连测试（显示回复/思考过程/耗时）；也可通过桥接发一条 QQ 测试消息。

常用接口（都是 JSON）：

```
GET  /api/status           # 三个服务 + 模型 + 直连状态
GET  /api/config           # 全部配置（Key 只有掩码）
GET  /api/model            # config.dsh + DSH 模型目录 + DSH 当前 agent-default-model
POST /api/model            # {provider, model, reasoningEffort, syncDshDefault}
POST /api/allow            # {ownerQQ, allowPrivate[], allowGroups[], denyPrivate[], denyGroups[]}
POST /api/mode             # {mode}
POST /api/api-backend      # 直连 api 配置（enabled 等）
GET  /api/roles            # 角色列表 + 当前角色
POST /api/roles/current    # {role, mode}
POST /api/roles/content    # {name, content}
GET  /api/balance          # 余额（直连 Key 或桌面端凭据）
GET  /api/logs?since=N     # 历史日志
POST /api/start|stop|restart
POST /api/service/{napcat|bridge|dsh}/{start|stop|restart}
POST /api/test             # {backend:"api"|"qq", message, target}
```

> 写接口要求 `Content-Type: application/json`（防任意网页跨站触发启停/改配置）。

---

## 四、怎么切换回答后端

### 方式 A：7788 控制台（推荐）

1. 打开 <http://127.0.0.1:7788> → 「直连 API」页。
2. 填 BaseURL（如 `https://api.deepseek.com/v1`）、模型、API Key。
3. 勾选「启用直连后端」→ 保存。

保存后：config.json 立即更新，且如果桥接在运行，会调 3100 的 `/api/api-backend` **热生效**
（不需要重启桥接）。页面会显示「桥接已热更新 / 桥接未运行，下次启动生效」。

关掉开关即回到「只走 DSH Agent」的原行为。

### 方式 B：直接改 config.json

```jsonc
"api": {
  "enabled": true,
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",          // 只存在本机 config.json，日志里永远只显示前 4 位
  "model": "deepseek-chat",
  "groupTrigger": "at",        // at=群里只在被叫到时回；all=每条都回
  "wakeWords": ["小鲸鱼", "在吗"],
  "systemPrompt": "",          // 留空=内置纯文本人格
  "maxRetries": 2,
  "timeoutMs": 60000,
  "maxHistory": 12,
  "maxReplyChars": 1000,
  "useRoleHint": true          // 叠加教程版的角色扮演人格
}
```

改完重启桥接生效（或在 3100/7788 控制台热切换）。

### 方式 C：桥接内置控制台（3100）

`POST http://127.0.0.1:3100/api/api-backend`，带 `x-console-token: <state/console-token>`，
body 同上（`enabled` 等）。返回 `{ok, enabled, model, hasKey, message}`。

> 注意：**直连 api 只影响「不在白名单里的人」**。管理员和 `allow.*` 里的会话永远走 DSH Agent，
> 这样带工具的能力不会被降级，也不会把工具权限开给直连用户。

---

## 五、验证结果（在副本上实测）

1. **离线单测**
   * `npm run test:api-backend`：全部通过（配置归一、路由矩阵、群聊触发、请求体、重试/4xx 不重试、
     思考过程写日志、Key 掩码、历史裁剪/落盘、门面私聊必回/群里不乱回/`/reset`/截断/缺 Key 跳过）。
   * `npm run test:hardening`：通过。
   * `npm run test:audit`：**33/35** 脚本通过。两个失败是**既有环境问题**、与本次合并无关：
     * `test-voice-system.mjs`：`docs/guides/VOICE.md` 在这个 checkout 里不存在（docs 只有 README/FOLDER_MAP）。
     * `test-preset-local-tools.mjs`：需要定位 DSH 安装目录下的 `node_modules`，本机定位不到。
     （这两个脚本在改动前同样会失败，失败原因分别是 ENOENT 与「无法定位 DSH 安装目录」。）
2. **桥接隔离启动实测**（把副本的 NapCat 端点指到死端口 + `followDiscoveredEndpoint:false`，
   控制台端口改 3101 启动，全程没连真实 QQ）：
   * 启动成功，日志首行：`直连 api 后端未启用（config.api.enabled=false）：所有会话仍只走 DSH Agent`。
   * `GET http://127.0.0.1:3101/api/status` 正常返回（DSH 就绪、模式 reserved2）。
   * `POST /api/api-backend` 热切换启用成功：返回 `{ok:true, enabled:true, model:"mock-model"...}`，
     日志出现 `[api] 配置已更新：enabled=true ... key=sk-t********`（掩码），`GET` 回读一致。
   * 全程 3999 端口保持关闭，没有向真实 QQ 发消息。
3. **7788 控制台实测**（在副本目录、只用副本的 config/state）：
   * `GET /api/status`：正确识别 NapCat(3001)/桥接(3100)/DSH(3080) 三个在跑的服务与 PID。
   * `GET /api/config`、`GET /api/roles`、`GET /api/logs`、`GET /api/model`（拉到 DSH 模型目录与
     `agent-default-model`）、`GET /api/balance`、`GET /api/stream`(SSE) 全部正常。
   * 用 7789 实例 + 不存在的桥接端口验证离线分支：`POST /api/allow`、`POST /api/mode`、
     `POST /api/api-backend`、`POST /api/roles/current`、`POST /api/roles/content` 均返回预期
     （保存成功并提示「桥接未运行，下次启动生效」；无 Key 启用直连正确返回 400）。
   * 首页 `GET /` 返回完整控制台页面（34 KB，脚本通过语法检查）。

### 已知的 DSH 侧问题（不是本次合并引入）

`POST /api/model` 里「写 DSH 的 agent-default-model」这一步在本机 DSH 0.2.x 上会失败：

```
settings.update failed: settings/rejected: Unexpected scalar at node end at line 1, column 4:
- id: llm-pi-ai
```

这是 DSH 自身设置持久化的老毛病：**教程版原控制台切模式时也会报同一句**
（见 `state/bridge.log` 里 22:39:11「控制台：模式写穿 DSH 设置失败 …」）。
控制台会把它作为一个失败步骤如实显示（`DSH agent-default-model ✗`），**config.json 仍然会写入**，
桥接下一条消息 selectModel 时还会按既有逻辑写全局默认。不影响 QQ 侧使用。

---

## 六、把线上切到合并版（建议停机窗口 2~3 分钟）

> 全程不需要改 NapCat 配置。切换期间 QQ 会短暂掉线一次。

1. **备份**（出问题 30 秒能回滚）

   ```powershell
   Copy-Item C:\qq-bridge\config.json C:\qq-bridge\config.json.bak
   Copy-Item C:\qq-bridge\state C:\qq-bridge-state.bak -Recurse
   ```

2. **停旧系统**（按顺序：桥接 → NapCat；DSH 可留着不重启）

   ```powershell
   # 桥接（3100）——PID 用 netstat 查，别杀错 node
   $p = (Get-NetTCPConnection -State Listen -LocalPort 3100).OwningProcess; Stop-Process -Id $p -Force
   # NapCat（网关）：父进程 + worker 一起清
   Get-Process -Name node | Where-Object { $_.Path -like '*napcat*' } | Stop-Process -Force
   ```

   注意：不要用 `restart.bat` 去「重启」，那样会再拉起旧目录的桥接。

3. **用副本替换原目录**（保留旧目录做回滚）

   ```powershell
   Move-Item C:\qq-bridge C:\qq-bridge.old
   Copy-Item C:\Users\example\Documents\qq-bridge-merged C:\qq-bridge -Recurse
   ```

   > 如果只想让合并版留在 `qq-bridge-merged` 目录运行也可以：把 `统一控制台.bat` / 启动脚本里的
   > 路径换成合并目录即可，但**不要两个目录同时对同一个 QQ 账号运行**。

4. **把线上 state 带过来**（会话映射、表情库、黑话、社交状态都在这）

   ```powershell
   # 旧目录已停，直接覆盖副本里那份「拷贝时快照」
   Remove-Item C:\qq-bridge\state -Recurse -Force
   Copy-Item C:\qq-bridge.old\state C:\qq-bridge\state -Recurse
   # 清掉旧锁文件，避免新进程以为还有实例
   Remove-Item C:\qq-bridge\state\bridge.lock -ErrorAction SilentlyContinue
   ```

5. **启动**（顺序：DSH → NapCat → 桥接；用 7788 一键启动最省事）

   ```powershell
   cd C:\qq-bridge
   D:\node.exe console\server.mjs        # 打开 http://127.0.0.1:7788 → 点「全部启动」
   ```

   DSH（3080）如果本来就在跑，控制台会识别为「已在运行」，不会重复拉起。

6. **验收**
   * 7788 上五个状态点：NapCat / 桥接 / DSH 绿，模型绿。
   * `http://127.0.0.1:3100/api/status`（带 token）返回 `dshReady:true`。
   * 群里 @ 一下机器人，确认正常回复（走 DSH Agent）。
   * 需要直连后端时，在 7788「直连 API」里填 Key → 启用 → 用「测试对话」验证一条。
   * 日志页应能看到桥接的实时日志；直连消息会出现 `[api] ... 思考过程：...`。

7. **回滚**（1 分钟内）

   ```powershell
   # 停掉新系统
   $p = (Get-NetTCPConnection -State Listen -LocalPort 3100).OwningProcess; Stop-Process -Id $p -Force
   Get-Process -Name node | Where-Object { $_.Path -like '*napcat*' } | Stop-Process -Force
   # 目录还原
   Move-Item C:\qq-bridge C:\qq-bridge.broken
   Move-Item C:\qq-bridge.old C:\qq-bridge
   Copy-Item C:\qq-bridge-state.bak C:\qq-bridge\state -Recurse -Force
   # 按原来的方式启动（start.bat / 原来的控制台）
   ```

---

## 七、注意事项

* **没动 NapCat 配置**：只新增了「启动/停止 NapCat 进程」的控制能力，路径写在
  `config.json → unifiedConsole.napcatDir`（默认指向上面的 NapCat，换机器要改）。
  账号在 `unifiedConsole.napcatQQ`（100000002）。
* **端口**：桥接仍是 3100、DSH 仍是 3080、NapCat 仍是 3000/3001；新增的只有 7788。
  端口或路径可通过 `unifiedConsole` 或环境变量 `QQB_CONSOLE_PORT` / `QQB_BRIDGE_PORT` 覆盖
  （后两个主要用于自测）。
* **`dsh.provider` 改成了 `deepseek-account`**：原值 `deepseek-official` 不在当前 DSH 的
  `session/modelCatalog` 里，线上日志一直在报
  `session/model-unavailable: Select an available model before sending a message`，
  也就是会话模型其实没设上、一直在用 DSH 默认。改成目录里真实存在的 provider 后，
  selectModel 才会真正生效。如果以后 DSH 换 provider id，在 7788「模型」页重新选一次即可。
* **Key 的存放**：直连 Key 明文存在本机 `config.json`，和教程版原来的 `dsh.authToken` 一样；
  控制台只回掩码、日志只打前 4 位。不要把 config.json 提交/外发。
* **直连后端没有工具**：它只是聊天接口，不能读文件/跑命令/发表情/潜水。需要这些能力的人
  必须留在白名单里走 DSH Agent。
* **两套历史**：DSH 会话历史在 DSH 侧；直连历史在 `state/api-sessions.json`（只存最近 N 轮，
  按 TTL 清理，`/reset` 会同时清两边）。
* 合并版 `package.json` 没加新依赖，`node_modules` 直接沿用教程版即可。
