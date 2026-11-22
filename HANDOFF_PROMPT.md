# 给另一个 DSH 实例的交接指令（可直接整段粘贴）

> 用法：在新机器上打开 DSH，把下面 **「=== 提示词开始 ===」到「=== 提示词结束 ===」** 之间的内容整段发给它。
> 里面的 `C:\qq-bridge` 是解压后的包根目录；如果你放在别处，先改这一处路径。
> 执行前请确认：QQ 机器人号的登录需要你本人在场扫码；白名单/owner 需要你确认。

---

=== 提示词开始 ===

你是部署执行者。目标：在一台 Windows 机器上把 `C:\qq-bridge` 这个 QQ ↔ DSH 桥接跑起来，并通过验收。

## 先读（按顺序）

1. `C:\qq-bridge\DEPLOY.md` —— 部署手册（人读版，含配置表、端口、排错）。
2. `C:\qq-bridge\docs\DEPLOY_PLAYBOOK.md` —— P0–P10 执行单（你就是按这个干活）。
3. `C:\qq-bridge\PLUGIN_ADDRESSES.md` —— 插件来源与地址。
4. `C:\qq-bridge\THINKING_AND_MEMORY.md` —— 思考过程（reasoning）与记忆模式（memory）的开关/验证。
5. `C:\qq-bridge\RULES.md` —— 权限边界；不要越界。

## 执行规则

- 严格按 P0 → P10 顺序；**任何一步 FAIL 就停在当前步**，不要跳步、不要"顺手"改别的。
- 每步结束输出一行机读结果：
  `{"step":"P4","ok":true,"detail":"...","hint":""}`
  失败时 `ok:false` 并附可执行的 `hint`。
- 所有命令在 `C:\qq-bridge` 下执行（`package.json` 所在目录）。
- 不要打印、回显、复制任何 token / cookie / 密码 / API key；不要读取 `state/console-token` 的内容，
  只把它当文件传给需要它的命令。
- **不要删除 `state/`**；不要手改凭据字段；不要起第二个桥接实例。
- 需要「人」的步骤只有两类：QQ 扫码登录、确认 ownerQQ/白名单。其余自动执行。
- 停止条件（命中即停并报告，不要硬试）：
  1. `repo.package` / `node.version` 失败且无法修复；
  2. 需要凭据而 owner 不在；
  3. 同一项连续两次失败；
  4. 任何步骤要求删 `state/` 或改写凭据。
- 命令用 PowerShell（`pwsh`）；路径含空格要加引号；长驻进程（桥接/控制台）用后台方式启动，
  不要占住当前会话。

## 步骤摘要（细节以 DEPLOY_PLAYBOOK.md 为准）

- **P0 预检**：`node scripts/deploy-check.mjs --json`。首次多数 FAIL 正常，按 `hint` 记录进度。
- **P1 依赖**：包内已带 `node_modules`。只有缺失/broken 时才 `npm install`（postinstall 会打 SDK 补丁）。
- **P2 SnowLuma**：启动网关 → 请 owner 扫码登录 → 开 OneBot v11 WS 3001 / HTTP 3000 → 
  `Invoke-RestMethod http://127.0.0.1:3000/get_status` 应为 ok。
- **P3 DSH**：确认 DSH 已启动、`dsh --version` 可用、`http://127.0.0.1:3080` 可访问；
  确认 profile 名（`Get-ChildItem $HOME\.dsh\profiles`）。
- **P4 配置**：`Copy-Item config.example.json config.json`；填 `ownerQQ`、`allow.private/groups`、
  `dsh.baseUrl/provider/model`、`snowluma.wsUrl/httpUrl/accessToken`；
  **`ownerQQ` 必须手改**（`qq-admin` 不开放权限字段）；JSON 用 `node -e` 校验。
- **P5 桥接**：`.\start.bat`（后台）；看日志连上 SnowLuma；确认只有一个实例。
- **P6 控制台**：`.\start-console.bat`；`/api/health` 返回 200；token 在 `state\console-token`。
- **P7 自动化验**：`deploy-check` → `qq-admin verify` → `npm run test:audit` → `npm run verify:adaptation`，
  再跑 `node src/memory/cli.mjs stats`（新库 0 条也算通过）；全绿才继续。
- **P8 端到端**：owner 私聊发「在吗」60s 内回；群里 @ 一次被唤醒并回；
  再走一遍「记住：我周五晚上一般有空」→ `stats` +1 → 追问能召回（验证 `mcp-memory` 已挂上）。
- **P9 守护/备份**：开 `unifiedConsole.autoHeal`；计划任务开机拉起 `start.bat`；备份 `config.json`+`state/`。
- **P10 回滚**：保留上一版目录/zip；失败时停进程 → 换回旧包 → 恢复 `config.json`+`state/` → 重跑 P7。

## 你必须向 owner 确认的两件事

1. 机器人 QQ 号与扫码登录（P2）。
2. `ownerQQ` 与允许的私聊/群白名单（P4）。

## 最终报告格式

```json
{
  "ok": true,
  "package": "C:\\qq-bridge",
  "steps": [
    {"step":"P0","ok":true,"detail":"deploy-check: 6 expected FAIL (fresh install)"},
    {"step":"P10","ok":true,"detail":"rollback plan documented; backups verified"}
  ],
  "verify": {"deployCheck": true, "qqAdmin": "4/4", "audit": true, "adaptation": true, "memoryStats": true},
  "e2e": {"private": true, "group": true, "memoryRecall": true},
  "blocked": "",
  "next": "可选：配置 webSearch/api/voice"
}
```

失败时 `ok:false`，`blocked` 写清停在哪一步、原始错误文本、已尝试的修复、需要 owner 做什么。

=== 提示词结束 ===

---

## 附：如果对方 DSH 的 profile 不叫 `web`

把 P3/P4 里的 `web` 换成实际 profile 名，例如：

```powershell
node scripts/setup-dsh.mjs desktop
```

## 附：如果 `dsh` 命令不在 PATH

```powershell
$env:QQ_BRIDGE_SKIP_DSH_INSTALL = "1"
node scripts/setup-dsh.mjs web
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile web install
```

装完**必须重启 DSH**，否则 preset/MCP 不生效。
