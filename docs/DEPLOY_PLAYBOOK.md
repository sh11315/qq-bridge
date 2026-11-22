# QQ ↔ DSH 桥接 · 部署 Playbook（给 DSH 实例执行）v1.0

> 这份不是说明书，是**执行单**：每个步骤都给出「前置 → 命令 → 期望输出 → 失败分支 → 幂等性 → 是否需 owner 确认」。
> 执行者：另一个 DSH 实例（管理员回合、可跑本地命令）。
> 配套：`scripts/deploy-check.mjs`（只读自检，退出码即结果）；人读版背景见 `docs/DEPLOY_HANDOFF.md`。

## 0. 执行契约（先读）

- 每一步按 `P<编号>` 顺序执行；**任何一步 FAIL 就停在该步**，不要跳步或自由发挥。
- 每步结束输出一行机读结果：`{"step":"P4","ok":true,"detail":"..."}`；失败时附 `hint`。
- 只有标了 **[需 owner 确认]** 的步骤可以停下来问人；其余步骤自动执行、失败即停。
- 所有命令都在仓库根目录执行（`package.json` 所在目录）。
- 幂等性：标「幂等」的步骤重复执行安全；标「一次」的步骤重复执行前要先检查状态。
- 禁止：手改 `config.json` 里的凭据字段、删除 `state/`、跳过 P0 直接起桥接。

## 1. 步骤

### P0 环境预检（幂等，只读）
- 前置：无
- 命令：`node scripts/deploy-check.mjs --json`
- 期望：退出码 0；`{"ok":true}`；`failed` 为空数组
- 失败分支：按 `checks[].hint` 逐项处理；`config.*` FAIL → 执行 P4；`dsh.*` FAIL → P3；`snowluma.*` FAIL → P2；`console.*` FAIL → P6
- 说明：首次部署时 P0 多数项会 FAIL，这是正常的——它同时充当「装到哪一步了」的进度探针。

### P1 安装依赖（幂等）
- 前置：P0 的 `node.version` 与 `repo.package` 通过
- 命令：`npm install`
- 期望：退出码 0；`node_modules/` 存在；postinstall 的 SDK 补丁无报错
- 失败分支：网络问题重试一次；`engines` 不符 → 升级 Node；补丁失败 → 看 `scripts/patch-snowluma-sdk.mjs` 日志并停下报告
- 幂等：可重复执行

### P2 启动 SnowLuma / NapCat 并登录 QQ（一次，**[需 owner 确认]**）
- 前置：P1 完成
- 动作：启动网关 → owner 扫码/密码登录 → 确认 OneBot HTTP(3000) / WS(3001) 已开
- 验证：`node scripts/deploy-check.mjs --json` 中 `snowluma.http.ok=true`
- 期望：`{"status":"ok","retcode":0}` 类健康响应；QQ 显示在线
- 失败分支：端口被占 → 改 `snowluma.httpUrl/wsUrl` 同步改网关；登录失败 → 停止，等 owner 处理（不要反复重试登录）
- 幂等：否（登录态过期需重新扫码）

### P3 启动 DeepSeek Harness（一次）
- 前置：本机已安装 DSH
- 动作：启动 DSH，确认 Web GUI 在 `dsh.baseUrl`（默认 `http://127.0.0.1:3080`）可访问
- 验证：`node scripts/deploy-check.mjs --json` 中 `dsh.reachable.ok=true`（401 也算可达，鉴权由桥接离线铸造 Cookie）
- 失败分支：端口不符 → 改 `config.json` 的 `dsh.baseUrl`；DSH 版本与桥接不匹配 → 按 README 对照表换 tag（0.2.1-rc.2 对应 0.2.1-r1）
- 幂等：是

### P4 写入最小配置（幂等，**[需 owner 确认]** 白名单与 ownerQQ）
- 前置：P0 的 `config.exists` 失败，或需要新增白名单
- 命令（首次）：
  1. `cp config.example.json config.json`（Windows：`Copy-Item config.example.json config.json`）
  2. 手改 `config.json` 的 `"ownerQQ": <真实QQ>`（`qq-admin` 刻意不开放权限字段；改完重启桥接）
  3. `node scripts/qq-admin.mjs whitelist add-private <QQ>` / `add-group <群号>`
  4. `node scripts/qq-admin.mjs config set dsh.model=deepseek-flash`
  5. 确认模板里的 `socialV2.memory` / `userMemory` / `photoMemory` 三块在（不需要的按
     `THINKING_AND_MEMORY.md` 关；`dsh.reasoningEffort` 新机建议先 `auto`）
- 期望：每条命令退出码 0；`node scripts/qq-admin.mjs config get allow` 返回含刚加的白名单
- 失败分支：`config set` 拒绝（路径不在白名单）→ 该字段只能手改并重启；JSON 解析失败 → 用 `config.json.bak-*` 恢复
- 幂等：是（重复 add 不报错或提示已存在）
- 说明：`ownerQQ` 与白名单属于权限边界，改前必须 owner 明确同意。

### P5 启动桥接（一次）
- 前置：P1–P4 完成
- 命令：`npm start`（Windows 也可 `start.bat`）
- 期望：日志出现「已连接 SnowLuma / 桥接就绪」；进程常驻不退出
- 验证：`node scripts/qq-admin.mjs status --json` 或 P7 的 verify
- 失败分支：端口占用 → 找占用进程；`config.json` 解析失败 → 回 P4；DSH 连接失败 → 回 P3
- 幂等：否（已有实例在跑时不要起第二个，先查进程）
- 说明：这是长驻进程，用后台任务/计划任务跑，不要占住当前终端。

### P6 启动统一控制台（一次）
- 前置：P5 已起（控制台会读桥接状态）
- 命令：`start-console.bat`（或 `npm run console`）
- 期望：`http://127.0.0.1:<unifiedConsole.port>` 返回 200；`state/console-token` 已生成
- 验证：`node scripts/deploy-check.mjs --json` 中 `console.health.ok=true`
- 失败分支：端口冲突 → 改 `unifiedConsole.port` 并重启控制台；401 → 带 `state/console-token` 的 token 访问
- 幂等：否（先查是否已有控制台在跑）

### P7 自动化验（幂等，只读）
- 命令（任一项失败即停）：
  1. `node scripts/deploy-check.mjs --json`
  2. `node scripts/qq-admin.mjs verify --json`
  3. `npm run test:audit`
  4. `npm run verify:adaptation`
  5. `node src/memory/cli.mjs stats`（新库 0 条也算通过；报错则回 P4/P5）
- 期望：全部退出码 0；`verify` 四项（控制台/桥接/DSH/QQ）均 ok；audit 全绿；adaptation 输出兼容；
  `stats` 能打印条数/层级，不报锁或路径错误
- 失败分支：按失败项回对应步骤；`verify:adaptation` 失败说明 DSH 版本不匹配 → 换 tag 或调 preset
- 幂等：是

### P8 端到端验收（一次，**[需 owner 确认]** 发测试消息）
- 动作：owner 私聊机器人发一句 → 期望 60s 内收到回复；群里 @ 一次 → 期望被唤醒并回复；
  再说「记住：我周五晚上一般有空」→ 回「好」后 `node src/memory/cli.mjs stats` 总数 +1 →
  追问「我周五晚上一般干嘛？」期望能召回
- 期望：私聊/群聊都回；日志有对应回合记录；无「永久繁忙」；记忆统计 +1 且能召回
- 失败分支：私聊不回 → 查白名单与 owner 私聊 key；群不回 → 查 mentionOnly/唤醒配置；有回复但发不出 → 查发送频率上限与网关连接
- 幂等：可重复（低频）

### P9 备份与守护（幂等）
- 命令：
  1. 备份：控制台 `POST /api/backup`（带 console token），或手动打包 `config.json` + `state/`
  2. 守护：开启 `unifiedConsole.autoHeal`；Windows 计划任务开机拉起 `start.bat`
- 期望：`/api/backups` 列表出现新备份；杀掉桥接进程后能自动拉起
- 失败分支：autoHeal 不生效 → 查控制台日志与 `unifiedConsole` 配置；备份失败 → 查磁盘空间与 `state` 权限
- 幂等：是

### P10 回滚（一次）
- 触发：P7/P8 失败且无法在当前版本修复
- 命令：
  1. `git checkout <上一个可用 tag>` + `npm install`
  2. 恢复配置：控制台 `/api/backup/restore` 或 `Copy-Item config.json.bak-* config.json`
  3. 重启桥接与控制台，重跑 P7
- 期望：P7 恢复全绿
- 失败分支：回滚后退不回去 → 用 `state/` 快照与 git tag 双保险，仍有问题即停并报告
- 幂等：否（先确认目标 tag）

## 2. 停止条件（任何一条命中就停）

- P0 的 `repo.package` / `node.version` 失败且无法升级
- 出现需要凭据输入的步骤（QQ 登录、API Key）而没有 owner 在场
- P7 连续两次同一项失败
- 任何步骤要求删除 `state/` 或改写凭据字段

## 3. 机读结果模板

```json
{"step":"P7","ok":true,"detail":"deploy-check ALL PASS; qq-admin verify 4/4; audit green","hint":""}
```

失败时：
```json
{"step":"P3","ok":false,"detail":"dsh.reachable 连接失败 ECONNREFUSED 127.0.0.1:3080","hint":"先启动 DeepSeek Harness，或修正 dsh.baseUrl"}
```

## 4. 与文档的分工

- 本文：**执行顺序与判定**（机器照做）。
- `docs/DEPLOY_HANDOFF.md`：背景、架构、配置全表、故障排查表（人看）。
- `scripts/deploy-check.mjs`：唯一「环境是否就绪」的机器判据；优先跑它，不要靠肉眼判断。
