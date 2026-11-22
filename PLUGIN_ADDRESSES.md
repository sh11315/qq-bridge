# 插件与下载地址清单（PLUGIN ADDRESSES）

> 包版本：`qq-bridge 0.2.1-r1`　更新：2026-11-23
> 本文件回答两个问题：**这个包里的插件从哪来**、**要装/更新时该访问哪些地址**。
> 结论先说：**本包以自带的本地插件为准**（`plugins/`、`dsh/agent-presets/`），
> npm 上的同名包是更新的另一条分支，版本号与内容都不同，**不要混装**。

---

## 1. 本包内置的 DSH 插件（权威来源）

| 插件 | 包名 / 版本 | 包内路径 | DSH 入口 | 说明 |
| --- | --- | --- | --- | --- |
| Agent preset bundle | `qq-agent-presets` `0.2.1-r1` | `plugins/qq-agent-presets/` | `dsh.bundle.patch` = `presets/qq-chat.patch.yml` + `presets/qq-chat-v2.patch.yml` | 把 `qq-chat` / `qq-chat-v2` 两个 preset 插入 DSH；带共用工具守卫 |
| 模式设置页 | `qq-mode-console` `0.2.1-r1` | `plugins/qq-mode-console/` | `main` = `lib/index.js`，`dsh.bundle.patch` = `cordis.patch.yml` | DSH 设置里的 `qq-mode` 命名空间（模式/唤醒/仿真参数） |
| preset 权威源 | —（不是独立包） | `dsh/agent-presets/qq-chat/`、`dsh/agent-presets/qq-chat-v2/` | `setup-dsh.mjs` 读取并生成 bundle patch | `agent.cordis.yml`、`preset.yml`、`qq-tool-restrict.mjs` |

`qq-agent-presets` 的 `package.json`（原文要点）：

```json
{
  "name": "qq-agent-presets",
  "version": "0.2.1-r1",
  "type": "module",
  "dsh": { "bundle": { "patch": ["./presets/qq-chat.patch.yml", "./presets/qq-chat-v2.patch.yml"] } }
}
```

`qq-mode-console` 的 `package.json`（原文要点）：

```json
{
  "name": "qq-mode-console",
  "version": "0.2.1-r1",
  "main": "./lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.1" }
}
```

### 1.1 安装方式（不要手 copy）

```powershell
cd C:\qq-bridge
node scripts/setup-dsh.mjs web
```

它会把包内两个插件链接进：

```
~/.dsh/plugins/qq-agent-presets        -> C:\qq-bridge\plugins\qq-agent-presets
~/.dsh/plugins/qq-mode-console         -> C:\qq-bridge\plugins\qq-mode-console
~/.dsh/profiles/<profile>/node_modules/qq-agent-presets   -> 上述链接
~/.dsh/profiles/<profile>/node_modules/qq-mode-console    -> 上述链接
```

并写入 profile 的 `package.json`（`link:` 依赖 + `dsh.profile.bundles`），
最后执行 `dsh plugin --profile <profile> install`。**装完必须重启 DSH。**

### 1.2 四个 MCP server（由 `setup-dsh.mjs` 写进 `cordis.patch.yml`）

| MCP id | 入口脚本 | 用途 / 备注 |
| --- | --- | --- |
| `mcp-snowluma` | `src/mcp-snowluma-safe.js` | QQ 工具面（发消息、等消息、看图、表情、语音…）；`toolCallTimeoutMs: 725000`，因为 `qq_wait_for_messages` 可等 10 分钟 |
| `mcp-snowluma-host` | `src/mcp-host-server.js` | host 侧辅助工具（本地能力桥） |
| `mcp-web-search-safe` | `src/mcp-web-search-safe.js` | 联网搜索（安全封装） |
| `mcp-memory` | `src/mcp-memory-server.js` | 深度记忆（短/长期、实体关系、日记、情绪）；数据在 `state/memory/brain.json`，开关/迁移见 `THINKING_AND_MEMORY.md` |

> MCP 的 `command` 用 `process.execPath`（即运行 setup 的那个 Node），
> 所以装完不要把 Node 卸了/换路径，否则 MCP 起不来。

> 记忆是「有状态」的：`mcp-memory` 不依赖 npm 包，但依赖包根下的 `state/memory/` 可写；
> 迁移时连同 `state/` 一起搬。只想关注入、不想删库：`socialV2.memory.autoRecall=false`。

---

## 2. npm 上的同名包（另一条分支，谨慎）

本机实测（2026-11-23，`npm pack --dry-run`）：

| 包 | 最新版本 | 打包/解包 | tarball | shasum |
| --- | --- | --- | --- | --- |
| `qq-agent-presets` | `1.1.2` | 36,249 B / 96,118 B | <https://registry.npmmirror.com/qq-agent-presets/-/qq-agent-presets-1.1.2.tgz> | `8e5d81d182fb6beb629ac6a658f14fdab08bf50f` |
| `qq-mode-console` | `1.1.2` | 11,630 B / 22,517 B | <https://registry.npmmirror.com/qq-mode-console/-/qq-mode-console-1.1.2.tgz> | `03acc92e37b5a4b5d65c4c734070b141a831883e` |

**差异（重要）**：

- npm `qq-agent-presets@1.1.2` 里是 `presets/qq-agent-full.patch.yml`、
  `presets/qq-agent-readonly.patch.yml`（以及 `compat/dsh-021-team.patch.yml`），
  对应 README 里提到的 **readonly / workspace / full（L1~L3）** 三代 preset；
- 本包 `0.2.1-r1` 里是 **`qq-chat` / `qq-chat-v2`** 两代，文件名、结构、工具面都不同；
- `qq-mode-console` 的 npm 1.1.2 是 7,238 B 的 `lib/index.js`，本包是 7,816 B 的版本；
- 两者**不能互换**：`setup-dsh.mjs`、桥接的 `session-router`、preset 契约都按本地 0.2.1-r1 校验。
  混装会出现 preset 找不到、工具守卫失效、`verify:adaptation` 红。

> 如果确实要升级到 npm 的 1.1.2：先看该版本的 README/CHANGELOG，
> 在测试机跑 `node scripts/test-qq-preset-contract.mjs`、`npm run verify:adaptation`，
> 再改 `scripts/setup-dsh.mjs` 里的 preset 列表；不要只 `npm i -g` 了事。

---

## 3. 源码与上游

| 项目 | 地址 | 说明 |
| --- | --- | --- |
| qq-bridge 源码（本版） | <https://github.com/sh11315/qq-bridge> | 本定制版；默认分支 `main` 就是 0.2.1-r1，部署请 clone 这个 |
| qq-bridge 上游 | <https://github.com/Derpyu520/qq-bridge> | 原项目；本包基于其 `master` 的定制快照 |
| 上游分支 | `main`、`dev`、`docs/full-review`、`feat/dsh-0.2.2-adaptation` | `main` HEAD 实测 `12e66d2…`；0.2.2 适配在 feature 分支 |
| DeepSeek Harness 官网 | <https://www.deepseek.com/harness/> | 下载/文档入口 |
| DSH 源码 | <https://github.com/deepseek-ai/deepseek-harness> | 版本与 CLI 说明 |
| DSH CLI（临时） | `npx @deepseek-ai/dsh web` | 不想装桌面版时可用 |
| SnowLuma | <https://github.com/SnowLuma/SnowLuma> | QQ 网关（OneBot v11） |
| SnowLuma Releases | <https://github.com/SnowLuma/SnowLuma/releases/latest> | 选 **win-x64 完整版**（自带运行时）；Lite 需 Node 24+ |

部署用（推荐）：

```powershell
git clone https://github.com/sh11315/qq-bridge.git
cd qq-bridge
```

只在你需要 diff / 升级时，再拉上游：

```powershell
git clone https://github.com/Derpyu520/qq-bridge.git qq-bridge-upstream
cd qq-bridge-upstream
git log --oneline -5
```

> 本包不是 git 仓库，没有 `.git`；升级请用「新包 + 保留 config/state」的方式（见 `DEPLOY.md` 12.3）。

---

## 4. 版本矩阵

| 组件 | 本包版本 | 兼容/备注 |
| --- | --- | --- |
| qq-bridge | `0.2.1-r1` | `package.json` 的 `engines.node >= 22.13` |
| qq-agent-presets | `0.2.1-r1` | 只含 `qq-chat` / `qq-chat-v2` |
| qq-mode-console | `0.2.1-r1` | 依赖 `@deepseek-ai/schemastery ^3.18.1` |
| DSH | 基线 `0.2.1-rc.2` | `0.2.0-rc.2` 兼容；作者机器 `0.2.2-rc.3` 可跑，升级后必须 `verify:adaptation` |
| Node.js | ≥ `22.13.0` | 低于此版本桥接与 MCP 都可能起不来 |
| SnowLuma | 最新稳定版（v2.4.x） | win-x64 完整版；OneBot v11 WS 3001 / HTTP 3000 |

---

## 5. 装完怎么确认

```powershell
# 1) 链接在不在
Get-Item "$HOME\.dsh\plugins\qq-agent-presets", "$HOME\.dsh\plugins\qq-mode-console" | Select-Object FullName, LinkType, Target

# 2) profile 依赖里有没有
Select-String -Path "$HOME\.dsh\profiles\web\package.json" -Pattern "qq-agent-presets|qq-mode-console"

# 3) MCP 注册有没有
Select-String -Path "$HOME\.dsh\profiles\web\cordis.patch.yml" -Pattern "mcp-snowluma|mcp-memory"

# 4) DSH 里的 preset（重启后）
#    新建会话 → preset 列表应出现 qq-chat / qq-chat-v2

# 5) 运行期
node scripts/deploy-check.mjs
node scripts/qq-admin.mjs verify
npm run verify:adaptation
```

---

## 6. 一句话总结

- **要装本包**：用 `node scripts/setup-dsh.mjs <profile>`，插件从 `plugins/` + `dsh/agent-presets/` 来，
  地址就是本机路径，不依赖 npm。
- **要查上游/升级**：GitHub `Derpyu520/qq-bridge`；npm 的 `1.1.2` 是另一条分支，别直接替换。
- **要装 DSH/SnowLuma**：官网与 Releases 链接见第 3 节。
