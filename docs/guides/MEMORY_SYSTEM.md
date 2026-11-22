# 记忆系统（memory，v1 规格 + 使用说明）

> 给 QQ Bridge 机器人加一套「会遗忘」的长期记忆：记忆强度 0~1 随天数衰减，1 以下都可以被遗忘，
> 只有备注/保护值 = 1 的记忆永久保留；重复提起会重置衰减；长期/短期分层；全量知识图谱；
> 同步到 Obsidian（vault + Canvas + SVG「记忆大脑」可视化）。
>
> 本文档同时是**实现契约**（文件名/接口/公式/测试要求以本文为准）与**使用说明**。
> 最后更新：2026-10-27（v1 设计，待实现）。

---

## 1. 目标与用户语义

用户原始需求（2026-10-27）：

- 参考「神经元/大脑图」：中心是大脑，周围一圈一圈是重要记忆与可遗忘的边缘记忆，一点点淡忘，
  最后只剩一个字的残片，然后消失；200 天内提起还能再次唤醒。
- **保护线**：0~1；1 以下都可以遗忘；只有备注为 1（保护值 = 1）的视为永久保留。
- **衰减**：讨论过的一般 **200 天**，平时对话 **30 天**；每天衰减；反复提起 → 衰减重置。
- **分层**：长期记忆 / 短期记忆分开。
- **全量知识图谱**：人物、群、话题、术语、事件、关系都要入图，不只是聊天摘要。
- 接入 QQ Bridge 机器人，让 bot 在对话里可以自己调用。

落地语义（本实现采用）：

| 概念 | 实现 |
| --- | --- |
| 保护线 `protectionLine` | 全局配置，默认 `0.5`。强度 ≥ 保护线的记忆在「核心区」（中心大脑附近），以下漂到边缘、逐渐淡忘。仅影响展示/排序，不直接阻止衰减 |
| 永久记忆 | 记忆的 `protection = 1`（备注 1）→ `permanent: true`，永不衰减、永不清理。bot 在主人说「记住/备注 1/永久」「这个别忘」时调用 |
| 强度 `strength` | 0~1 进度条；线性衰减：满值 1.0 经过 `decayDays` 天归零 |
| 衰减周期 | `layer=long` → 默认 200 天；`layer=short` → 默认 30 天；可单条覆盖 `decayDays` |
| 遗忘过程 | `strength < 0.15` → `status=fading`（Obsidian 里只显示一个字 + `…`）；`strength ≤ 0.05` → `status=faded`；再过 `purgeGraceDays`（默认 7 天）从库里删除（保留事件日志 tombstone） |
| 反复提起 | `recall` 默认对命中的前 3 条执行 `touch`（强度重置为 1，重新计时）；`touch` 也可单独调用 |
| 分层 | `layer: 'long' | 'short'`，存储、检索、vault 目录、图谱颜色都分开 |

---

## 2. 文件与职责（写作用域）

| 文件 | 职责 | 负责人 |
| --- | --- | --- |
| `src/memory/model.mjs` | 纯函数：常量、配置默认值、强度/衰减/状态机、关键词/相似度、ID、校验、快照整理 | memory-core |
| `src/memory/store.mjs` | 持久化 `state/memory/brain.json`：原子写、锁、备份轮转、损坏恢复、事件日志 `state/memory/events.jsonl` | memory-core |
| `src/memory/service.mjs` | 业务 API：remember/search/recall/touch/pin/update/forget/entity/link/graph/stats/materialize/seed/consolidate/ingest/state/updateState/self 相关/emotion/proposals/resolveProposal/selfReview/trialInfo | memory-core |
| `src/mcp-memory-server.js` | MCP stdio server（v1.7 共 25 个工具），**禁止 stdout 打印**（DSH 用 stdio 协议） | memory-core |
| `src/memory/cli.mjs` | 运维 CLI：`decay` / `consolidate` / `seed` / `stats` / `add` / `search` / `pin` / `ingest` / `compact` / `emotion` / `set-emotion` / `proposals` / `decide` / `self-review` / `trial` / `export-vault` | memory-core |
| `src/memory/emotion.mjs` | 情绪纯函数：8 种感受词、24h TTL、强度/备注归一化、`emotionPrompt` 注入句 | emotion-runtime |
| `src/memory/self-upgrade.mjs` | 自升级纯函数：三条外部卡尺（客服腔/问句收尾/主动过多）、扫描最近话语、生成提案、周审视 | self-upgrade |
| `src/memory/wake-habit.mjs` | 唤醒习惯：【醒来先看】提示文案 + wake-log 归一化/解析/追加（最多 5000 行） | wake-trial |
| `src/memory/auto-recall.mjs` | 唤醒注入：三层读取（置顶/相关/忽然想起）+ 情绪/自述/人设/语气校准/日层；读 brain.json（有 journal 时回放），**不 touch 记忆** | Lead |
| `src/memory/topology.mjs` | 分域拓扑：群聊/私信/黑话三张 SVG+Canvas，供 vault 主页引用 | vault-visual |
| `scripts/memory-trial.mjs` / `test-memory-trial.mjs` | 一个月测试台：`--init` / `--report`（30 天、开封探针、漂移指标） | wake-trial |
| `scripts/memory-self-review.mjs` / `test-memory-selfupgrade.mjs` | 周审视 CLI：只读 brain，生成待主人批准的提案写 `state/memory/self-review.json` | self-upgrade |
| `scripts/memory-sim.mjs` / `memory-sim-report.mjs` | 20 万条离线压测引擎 / 终端报告查看（分层配额、主题召回） | Lead |
| `scripts/memory-vault-git.mjs` | vault 每日 git 快照（无改动则跳过） | Lead |
| `scripts/test-memory-engine.mjs` | model + store + service 测试（纯 node，自建临时目录，不碰 state/） | memory-core |
| `scripts/test-memory-mcp.mjs` | 用 MCP Client + stdio 起 server，listTools + 关键调用 | memory-core |
| `src/memory/vault.mjs` | 读 brain.json → 生成 Obsidian vault（Markdown/Canvas/SVG/Obsidian 配置），纯 fs、无外部依赖 | vault-visual |
| `scripts/memory-vault-refresh.mjs` | CLI：`node scripts/memory-vault-refresh.mjs [--brain path] [--vault path]`，一次性重建 vault 并打印统计 | vault-visual |
| `scripts/test-memory-vault.mjs` | 用固定 brain.json fixture 生成到临时目录，断言文件/结构/Canvas/SVG 合法 | vault-visual |
| `scripts/memory-bootstrap.mjs` | 从 `state/social-v2.json`、`state/sessions.json`、`state/slang.json`（可选 DSH session 归档）生成 `state/memory/seed.json`（seed 格式见 §7） | bootstrap |
| `scripts/test-memory-bootstrap.mjs` | 用 fixture 测 importer 输出符合 seed schema、幂等、去重 | bootstrap |
| `scripts/memory-maintenance.mjs` | 每日维护入口：`decay` + `consolidate` + 日层 + 一个月测试台日报 + `vault refresh` + git 快照；给 Windows 计划任务 `QQBridge-MemoryDecay`（04:10）调用 | Lead（依赖 core+vault） |
| `docs/guides/MEMORY_SYSTEM.md` | 本文档 | Lead |
| preset 人设（两套 `dsh/agent-presets/qq-chat*/agent.cordis.yml`） | 加【深度记忆】规则，告诉 bot 何时 recall/remember/pin/touch | Lead |
| `scripts/setup-dsh.mjs`、`scripts/test-setup-dsh-idempotent.mjs`、`scripts/test-audit-setup.mjs`、`scripts/test-mcp-servers-stdio.mjs` | 托管 `mcp-memory`（serverName=memory）+ 测试同步 | Lead |

新增文件全部 ESM，**不新增 npm 依赖**（只用 node 内置 + 仓库已有 `@modelcontextprotocol/sdk`、`zod`）。MCP server 里**不要用 `import.meta.url`**（离线测试会 vm 执行）；用 `process.argv[1]` 推导仓库根，参考 `src/mcp-web-search-safe.js`。

---

## 3. 数据模型（`state/memory/brain.json`）

```jsonc
{
  "version": 1,
  "createdAt": 1730000000000,
  "updatedAt": 1730000000000,
  "config": { /* 见 §4，允许被 state/memory/config.json 覆盖 */ },
  "entities": {
    "ent_a1b2c3d4e5f6": {
      "id": "ent_a1b2c3d4e5f6",
      "type": "person",                  // person | group | topic | term | event | project | self
      "name": "群友昵称",
      "aliases": ["别名"],
      "tags": ["群友"],
      "note": "补充描述",
      "mentionCount": 3,
      "firstSeenAt": 1730000000000,
      "lastMentionedAt": 1730000000000,
      "source": { "kind": "chat", "key": "group:100000003" },
      "createdAt": 1730000000000,
      "updatedAt": 1730000000000
    }
  },
  "relations": [
    {
      "id": "rel_...",                   // rel_<sha1(from|relation|to)[:12]>
      "from": "ent_...",
      "to": "ent_...",
      "relation": "member_of",           // member_of | likes | knows | discussed | part_of | owner_of | related | alias_of
      "weight": 1,
      "note": "",
      "source": { "kind": "chat", "key": "group:100000003" },
      "createdAt": 0,
      "updatedAt": 0
    }
  ],
  "memories": {
    "mem_a1b2c3d4e5f6": {
      "id": "mem_a1b2c3d4e5f6",          // mem_<sha1(normalizedText|sourceKey)[:12]>
      "layer": "long",                   // long | short
      "category": "fact",                // fact | preference | event | relationship | promise | topic | profile | other
      "title": "小肥鱼喜欢草莓",
      "text": "……（完整记忆，≤2000 字符）",
      "keywords": ["草莓", "小肥鱼", "喜欢"],
      "entityIds": ["ent_..."],
      "tags": ["吃"],
      "protection": 0,                   // 0~1；=1 表示永久（备注 1）
      "permanent": false,
      "strength": 1,                     // 物化后的当前强度（读取时按公式重算）
      "baseStrength": 1,                 // 上次激活时的强度
      "decayDays": 200,
      "status": "active",                // active | fading | faded | archived（permanent 记忆恒为 active，但 vault 单独分组）
      "activationCount": 1,
      "createdAt": 0,
      "updatedAt": 0,
      "lastActivatedAt": 0,
      "fadingSince": null,
      "purgeAfter": null,
      "source": { "kind": "chat", "key": "group:100000003", "seqs": [123], "createdBy": "bot" },
      "recallLog": [ { "at": 0, "query": "..." } ]   // 最近 10 条，够排查即可
    }
  }
}
```

### 状态机

```
remember → active (strength=1, baseStrength=1, lastActivatedAt=now)
active --每天按公式衰减--> strength 下降
strength < fadeThreshold(0.15) → fading（fadingSince=now；vault 显示首字残片）
strength ≤ forgetThreshold(0.05) → faded（purgeAfter = now + purgeGraceDays*86400e3）
faded 且 now ≥ purgeAfter → 删除（events.jsonl 记 tombstone）
touch / recall 命中 → baseStrength=1, lastActivatedAt=now, status=active, fadingSince=purgeAfter=null
protection=1 → permanent，跳过衰减/遗忘，status 恒 active（vault 放「永久」组）
```

### 衰减公式（必须按此实现，测试会断言）

```
elapsedDays = max(0, (now - lastActivatedAt) / 86_400_000)
strength    = clamp(baseStrength - elapsedDays / decayDays, 0, 1)
```

- 满强度 1.0、`decayDays=200` → 第 100 天 0.5，第 200 天 0。
- `decayDays=30` → 30 天归零。
- 强度保留 4 位小数落盘；展示保留 2 位。
- 保护值 `protection∈(0,1)` **不作为下限**，只作为「优先保护/展示权重」；`protection=1` 才是永久。
  （用户原话：1 以下都可以遗忘，只有备注 1 永久。）

### 排序（search/recall）

score = 0.40 × 文本相关度 + 0.20 × strength + 0.15 × 层级权重(long=1,short=0.6)
      + 0.15 × 实体命中 + 0.10 × 新近度（7 天内线性）

文本相关度：归一化后，query 关键词（Intl.Segmenter 分词 + 原文整串）与
title/text/keywords 的命中比例；`query` 为空时只按 strength/新近度排序。

### ID

- 记忆：`mem_` + sha1(`${normalizedText}|${source.key}`)[:12]
- 实体：`ent_` + sha1(`${type}|${normalizedName}`)[:12]
- 关系：`rel_` + sha1(`${from}|${relation}|${to}`)[:12]
- 归一化：去首尾空白、压缩空白、全角转半角？（保留中文标点，只压缩空白）

---

## 4. 配置（`state/memory/config.json`，可选；缺省值如下）

```jsonc
{
  "decayDaysLong": 200,
  "decayDaysShort": 30,
  "protectionLine": 0.5,
  "fadeThreshold": 0.15,
  "forgetThreshold": 0.05,
  "purgeGraceDays": 7,
  "defaultLayer": "short",
  "defaultCategory": "other",
  "maxMemories": 5000,
  "maxMemoriesPerEntityLink": 50,
  "lockTimeoutMs": 5000,
  "backupKeep": 5,
  "eventLogKeepBytes": 5242880,
  "vaultDir": "memory-vault"
}
```

`config.json` 不存在用默认值；存在则深合并；`vaultDir` 相对 `state/` 解析（默认 `state/memory-vault`）。

---

## 5. 持久化 / 并发 / 健壮性（store.mjs）

必须满足：

1. 路径：`<repo>/state/memory/brain.json`；仓库根由调用方传入（MCP 用 `process.argv[1]` 推导，CLI 用自身路径），**不能硬编码** `C:\Users\example\...`。
2. **原子写**：写 `brain.json.<pid>.tmp` → `fs.renameSync` 覆盖；写前把现有文件复制到 `state/memory/backups/brain-<ISO ts>.json`，只留最近 `backupKeep` 份。
3. **跨进程锁**：`state/memory/brain.lock`（`fs.openSync(..., 'wx')` 写入 pid+time）。抢不到重试 25 次 × 100ms；锁文件 mtime 超过 10s 视为陈旧并强制接管（先 rename 到 `.stale-<ts>` 再删）；`finally` 释放。两个 DSH 实例（本 GUI 与 3080）会同时各起一个 memory MCP server，锁是必须的。
4. **损坏恢复**：JSON.parse 失败 → 把坏文件改名 `brain.corrupt-<ts>.json`，依次尝试最新备份，都不行则新建空库（不要抛异常卡死 MCP server 启动）。
5. **事件日志**：`state/memory/events.jsonl` 追加 `{at, type, id, detail}`（type: remember/touch/pin/update/forget/decay/purge/seed/entity/link），超过上限按行截断/轮转。
6. `load()` → `materialize()` → 需要时 `save()`；服务层每次操作都重新读盘（MCP server 无状态），保证两个 DSH 实例看到一致数据。
7. 临时目录测试：所有测试用 `os.tmpdir()` + pid 子目录，**不要碰** `state/memory` 真实数据。

---

## 6. MCP 工具（`src/mcp-memory-server.js`，serverName: `memory`）

- 传输：stdio；server name `memory`，version 与 package 一致（`0.2.1-r1`）。
- 工具名短：`recall` / `remember` / `search` / `touch` / `pin` / `update` / `forget` / `entity` / `graph` / `stats` / `consolidate`（共 11 个；`consolidate` 为 2026-10-28 新增的夜间巩固工具）。
  模型侧完整名是 `mcp__memory__<tool>`（与 `mcp__snowluma__qq_*` 一致）。
- 返回：`{ content: [{ type: 'text', text: JSON.stringify(result) }] }`；业务失败
  `{ content:[{type:'text',text:'错误：...'}], isError: true }`，**绝不 throw 到 transport**（除启动错误）。
- stdout 只许协议数据；日志一律 `console.error`。

### 6.1 `recall`

入参：`{ query?, entity?, layer?: 'long'|'short', date?: 'YYYY-MM-DD', since?, until?, category?, limit?: number(1~20,默认5), reinforce?: boolean(默认true) }`
出参：`{ memories: [{id, title, text, strength, layer, status, protection, updatedAt}], reinforced: [id...], hint }`
行为：search 排序 → 前 3 条 `touch`（`reinforce !== false`）→ 返回。这是 bot 醒来/被问旧事时的首选工具。
**日期检索（2026-10-28 新增）**：`date` 按 `createdAt` 的本地日期精确过滤；`since`/`until` 为闭区间；`category` 按分类过滤。用户问「昨天/几号/日记」时用它，不要再靠关键词猜。非法日期抛 `MemoryError`（date 需要 YYYY-MM-DD / 不是合法日期），`since > until` 也会报错。

### 6.2 `remember`

入参：
```jsonc
{
  "text": "string(1~2000，必填)",
  "title": "string(可选，≤60；缺省取 text 前 30 字)",
  "layer": "long | short（可选；缺省 short。讨论过/重要的事用 long）",
  "category": "fact|preference|event|relationship|promise|topic|profile|other（可选）",
  "keywords": ["string"]（可选，≤10 个，每个 ≤20 字）,
  "entityNames": ["人物/群/话题名"]（可选，≤10；自动 upsert 实体并连边 related/discussed）,
  "tags": ["string"]（可选）,
  "protection": "0~1（可选，默认 0；=1 永久，但一般用 pin）",
  "decayDays": "number(1~3650，可选，覆盖层级默认值)",
  "source": {"key":"group:100000003","seqs":[123]}（可选）,
  "dedupe": "boolean（默认 true）"
}
```
出参：`{ ok, id, created: boolean, mergedInto?: id, memory: {...} }`
行为：归一化 → dedupe 时与同层记忆做 bigram Jaccard，≥0.82 视为同一条 → 合并（更长文本保留、keywords/entities 取并集、touch）；否则新建。
同文本不同来源（另一个群）也合并到同一条，source.seqs 追加、`source.keys` 可扩展。

### 6.3 `search`

入参：`{ query?, entity?, layer?, status?, date?（YYYY-MM-DD）, since?, until?, category?, limit?（默认 8，最大 50）, includeFaded?: false }`
出参：`{ memories: [...], total }`。**只读，不重置衰减**。日期/分类过滤规则与 `recall` 相同；CLI 对应 `node src/memory/cli.mjs search --date 2026-10-27` / `--since` / `--until` / `--category`。

### 6.4 `touch`

入参：`{ ids?: [string], query?: string, limit?: number(默认3，最大10) }`（二选一，可同时）
出参：`{ touched: [{id,title,strength}], missed: [id...] }`。重置衰减（baseStrength=1、重新计时）。

### 6.5 `pin`

入参：`{ id?: string, query?: string, protection?: number（默认 1，设 1 = 永久）, note?: string }`
出参：`{ ok, id, protection, permanent }`。备注 1 = 永久保留，对应「主人要求记住」。
`protection=0` 可取消永久。

### 6.6 `update`

入参：`{ id, title?, text?, layer?, category?, keywords?, tags?, decayDays?, protection?, entityNames? }`
出参：`{ ok, id, memory }`。改文本不影响衰减计时（除非显式 `resetDecay:true`）。

### 6.7 `forget`

入参：`{ id?: string, query?: string, mode?: 'archive'|'purge'（默认 archive） }`
出参：`{ ok, forgotten: [id...] }`。永久记忆拒绝删除（除非 `force:true`，默认 false）。

### 6.8 `entity`

入参：
```jsonc
{
  "name": "string(必填)", "type": "person|group|topic|term|event|project|self",
  "aliases": ["..."], "note": "...", "tags": ["..."],
  "relations": [{"to":"另一个实体名","relation":"member_of|likes|knows|discussed|part_of|owner_of|related","note":"..."}]
}
```
出参：`{ ok, entity, relations: [...] }`。自动 upsert（同名不同类别会新建并 `alias_of` 提醒）。

### 6.9 `graph`

入参：`{ entity?: string, depth?: number(1~3，默认 1), limit?: number(默认 30，最大 100) }`
出参：`{ entities: [{id,type,name,mentionCount}], relations: [{from,to,relation,weight}], memories: [{id,title,layer,strength}] }`

### 6.10 `stats`

入参：`{}`
出参：`{ ok, total, byLayer:{long,short}, diary, permanent, fading, faded, active, archived, entities, relations, protectionLine, decayDays:{long,short}, vaultDir, nextDecayHint }`

### 6.11 `consolidate`

入参：`{}`

出参：`{ at, promoted, deduped, keywordCleaned, duplicateRate, total, promotedIds, dedupedItems, keywordCleanedIds }`

行为：跑一次夜间巩固（replay）——① 把 `layer=short`、`activationCount>=3`、`strength>=0.5` 的活跃记忆升级为 `long`（`decayDays` 同步 200）；② 对同 category 的活跃记忆两两做 `textSimilarity(title+text) >= 0.92` 判重，保留激活次数高、更新时间新的，另一条归档（`status=archived`、`archivedReason=duplicate`、`mergedInto=保留id`）；③ 清洗关键词里的虚词碎片（如「一条 / 内容 / 做的 / 这次」）；④ 把本次指标写入 `state/memory/last-consolidation.json`。不删除、不新建记忆；每日 04:10 维护任务会自动跑。

---

## 7. 初始化种子（`seed.json` 格式，供 `scripts/memory-bootstrap.mjs`）

```jsonc
{
  "version": 1,
  "generatedAt": 1730000000000,
  "sources": ["state/social-v2.json", "state/sessions.json", "state/slang.json"],
  "entities": [ { "name": "...", "type": "person", "aliases": [], "note": "", "tags": [], "source": {...} } ],
  "relations": [ { "from": "名字或 ent_id", "to": "名字或 ent_id", "relation": "member_of", "note": "" } ],
  "memories": [ {
    "text": "...", "title": "...", "layer": "long|short", "category": "...",
    "keywords": [], "entityNames": [], "tags": [], "protection": 0,
    "source": { "key": "...", "seqs": [] }
  } ]
}
```

`cli.mjs seed <file>`：按顺序 apply，`source.kind='seed'`；幂等（重复 import 不重复建记忆/实体）。

数据来源（bootstrap 负责人自行核对字段，参考 `state/social-v2.json` 结构）：

- 群/私聊会话 → `group`/`person` 实体；`memberImpressions{}` → 人物实体（note=印象）；
  `activeTopics[]` → topic 实体 + 记忆（long）；`lastTurnSummary.text` → 记忆（long，source 带会话 key）。
- `state/sessions.json` 的 `sessionPolicies`（qq-chat-v2）→ 会话实体关系。
- `state/slang.json` 确认词条 → term 实体（note=含义/用法）。
- 可选：读 DSH session 归档（`node:zlib` zstd）补充最近对话的长期记忆——**v1 只做可选或不做**，
  别为了全量阻塞交付；先保证 seed 结构 + 幂等 + 测试。

---

## 8. Obsidian vault（`state/memory-vault/`，vault-visual 负责）

> **本机实际位置**：vault 放在 `C:\Users\example\Documents\记忆大脑`（Obsidian「打开本地仓库」里在「文档」下能直接看到），
> `state/memory-vault` 是指向它的 **junction**，脚本/文档里的旧路径继续可用。Obsidian 里选这个仓库即可；
> 主页是 `00-记忆大脑.md`，交互图谱是 `图谱/记忆大脑.canvas`，静态图是 `图谱/记忆大脑.svg`。

目录（相对 vault 根）：

```
state/memory-vault/
├── README.md                    # 怎么打开/怎么调整/重新生成说明
├── 00-记忆大脑.md                # 主页：统计、说明、嵌入 SVG、导航（[[链接]]）
├── 记忆/
│   ├── 永久/<id>-<slug>.md      # protection=1 / permanent
│   ├── 长期/<id>-<slug>.md      # layer=long
│   ├── 短期/<id>-<slug>.md      # layer=short
│   └── 边缘/<id>-<slug>.md      # fading/faded（只剩一个字 + …）
├── 日记/                        # tags 含 diary 的日记：单独归档，不参与衰减/清理，不占四层
│   └── 日记·YYYY-MM-DD.md
├── 实体/<type>/<name>.md        # person/group/topic/term/event/project/self
├── 图谱/
│   ├── 记忆大脑.canvas          # Obsidian Canvas（同心圆布局）
│   ├── 记忆大脑.svg             # 大脑/神经元可视化（可直接打开/嵌入）
│   ├── 拓扑-群聊.svg/.canvas    # 分域图：QQ 群 + 群友 + 群聊来源记忆
│   ├── 拓扑-私信.svg/.canvas    # 分域图：owner/本人 + 私信话题 + 私信记忆
│   └── 拓扑-黑话.svg/.canvas    # 分域图：黑话词条 + 使用它们的人（+ 群 hub，不含记忆）
└── .obsidian/
    ├── app.json                 # alwaysUpdateLinks, newFileLocation 等最小配置
    └── graph.json               # Graph View 颜色组：永久金 / 长期蓝 / 短期灰 / 日记青 / 实体绿 / 边缘暗
```

要求：

- **记忆笔记 frontmatter**：`id, layer, protection, strength, status, category, decayDays, created, updated, lastActivated, entities, tags, source`；
  正文：`# 标题` + 正文 + 进度条（`████░░░░ 42%（保护线 50%）`，用 `█`/`░` 十格）+ 「永久保留 / N 天衰减」说明 + 实体链接 + 来源。
- **实体笔记**：frontmatter type/aliases/mentionCount；正文关系列表（`- member_of [[群名]]`）+ 关联记忆链接。
- **Canvas**：`nodes` 中心 text 节点「记忆大脑」，内圈永久（金色 `"color":"6"`），中圈长期（蓝 `"color":"5"`），外圈短期（灰 `"color":"3"`），再外圈实体按类型分簇；`edges` 从中心连到节点/实体-记忆关系；坐标固定算法（同心圆，半径按数量自适应，节点大小固定或按 strength）。JSON 必须能被 Obsidian Canvas 打开（参考官方格式：`nodes[{id,type,text|file,x,y,width,height,color}]`，`edges[{id,fromNode,toNode,fromSide,toSide,label,color}]`）。
- **SVG**：仿参考图——浅色网格背景、中心「大脑」主体（圆+回旋线）、同心记忆环（永久金色发光、长期蓝、短期灰、边缘暗且小）、实体节点 + 细连线、外围淡出的「残片」小点；尺寸 1600×1000，viewBox 自适应；确定性（无随机或固定 seed）。
- **日记单独保存**（2026-10-28）：`tags` 含 `diary` 的记忆自动归入 **long / event**，写 vault 时放进 `日记/`（文件名 `日记·YYYY-MM-DD.md`），**不参与衰减、不会被 purge、不会被容量淘汰**，也不计入四层统计；主页有「📔 日记」段与统计行，Graph View 里是青色节点。日记只读正文由 brain.json 生成，所以仍受 vault 刷新保护但不会消失。
- 所有生成文件头加 `<!-- 由 QQ Bridge 记忆系统自动生成，手改会被下一次刷新覆盖；要改记忆请让 bot 用 memory_update 或编辑 brain.json 前先备份 -->`。
- **分域拓扑**（`src/memory/topology.mjs`）：`buildTopologyFiles(model)` 输出 Map（相对路径→内容），在 `buildVaultFiles` 里并入 vault；三个 scope 各自一张 SVG + 一张 Canvas——
  · 群聊：group 实体做 hub，member_of / 群聊记忆关联的 person/self 内环，来源为 `group:*` 的记忆外环；
  · 私信：self（没有 self 时用来源为 `private:*` 的 person）做 hub，相连 person/topic 内环，来源为 `private:*` 的记忆外环；
  · 黑话：term 内环，与 term 有关系的实体外环，group 做 hub（有的话），**不放记忆节点**；
  · SVG 1600×1000、同心环布局（节点少时整体缩放收进安全区、单点环不会顶到标题），边的文字标签只标有语义的关系（owner_of / likes / discussed 等），`member_of` / `related` 不标；某 scope 节点 < 2 时整组跳过（空 brain 仍只有 6 个骨架文件）；`00-记忆大脑.md` 的「🧭 分域拓扑」小节用 `topologySummary(model)` 自动加入口。
- 生成入口：`export const VAULT_VERSION = 1; export function renderVault(brain, { vaultDir, now })`，返回 `{files, stats}`；`renderVault` 内部负责清理 `记忆/`、`实体/`、`日记/` 下旧文件（避免残留；日记从旧四层位置迁到 `日记/` 后旧文件也会被清掉），**不许删 vault 其他目录**（比如用户自己的笔记）。
- 测试：fixture brain.json（≥3 长期/2 短期/1 永久/1 fading/人物+群实体+关系）→ 临时目录 → 断言：文件存在、frontmatter 可解析、Canvas JSON 合法（nodes/edges 非空、id 唯一）、SVG 含 `<svg` 与中心/环/图例文本、重复渲染不重复文件、不删除 fixture 目录外的文件。

---

## 9. 集成（Lead 负责）

1. `scripts/setup-dsh.mjs`：`MANAGED_MCP_IDS` 加 `mcp-memory`；servers 映射加
   `{ serverName: 'memory', script: path.join(REPO_ROOT, 'src', 'mcp-memory-server.js') }`（不设 toolCallTimeoutMs，默认即可）。
2. 同步改：
   - `scripts/test-setup-dsh-idempotent.mjs` 的 id 列表加 `mcp-memory`；
   - `scripts/test-audit-setup.mjs` 的 id 列表（保留 725000 断言）；
   - `scripts/test-mcp-servers-stdio.mjs` 的 SERVERS 加 `{ serverName:'memory', script:'src/mcp-memory-server.js' }`。
3. 重跑 `D:\node.exe scripts/setup-dsh.mjs web`（脚本会重新生成 preset patch、备份 profile patch 并写 MCP 区块）。
4. 两套 preset 源加【深度记忆】规则（约 15~20 行，见 §10），然后 `D:\node.exe scripts/build-agent-preset-patches.mjs`。
5. 让 3080 DSH 生效：`POST http://127.0.0.1:7788/api/service/dsh/restart`。注意本机 3080 DSH 是**提权**启动的（pid 19636），
   非提权 console（7788，pid 36156）打这个 API 时 stop 会 taskkill Access denied、start 又因端口已占用而直接返回，
   实际是 no-op；此时 profile patch 会被 DSH 热加载（`state/dsh-child.log` 出现 mcp client 拉起 memory server 的 DEP0190 行），
   **无需强杀进程**。若将来确实要重启，用管理员权限的 console/终端再打一次这个 API。
6. 验证：MCP stdio 测试通过；用 DSH API 开一个临时会话（`node src/self-test.js http://127.0.0.1:3080 '<prompt>'`）让它调
   `mcp__memory__stats`，实测返回 `3，47，69`（不打扰真实 QQ 群；session 用 `cwd` 放在临时目录、验证后归档）。
7. 每日维护：`scripts/memory-maintenance.mjs`（`--decay --vault`），注册 Windows 计划任务 `QQBridge-MemoryDecay` 每天 **04:10**；手动跑一次生成 vault。
8. Obsidian：安装后把 `C:\Users\example\Documents\记忆大脑` 作为 vault 打开（「打开本地仓库」→文档→记忆大脑），验证
   `00-记忆大脑.md`、`图谱/记忆大脑.canvas`、`图谱/记忆大脑.svg` 与 Graph View 正常（可截图）。
9. 文档：本文补充「使用说明/运维」；`docs/README.md` 索引加一行；`docs/FOLDER_MAP.md` 加 `src/memory/`、`state/memory/`、`state/memory-vault/` 说明（state 下均是用户数据，别删）。

---

## 10. preset 人设规则（Lead 写入两套 agent.cordis.yml 的 persona prefix）

插入位置：现有【轻量记忆】（qq_memory_*）规则之后，新增同级规则，约 18 行，要点：

- 你有两套记忆：轻量记忆（每次唤醒注入，管当前话题）+ **深度记忆**（`mcp__memory__*`，跨会话长期）。
- 醒来的第一件事：`mcp__memory__recall`（query = 当前会话/对方昵称/正在聊的话题），看看有没有旧事；被叫「你记得吗」也必须先 recall，不许凭空编。
- 值得记：主人的偏好/约定/明确要求、群友的重要信息、发生过的有意义的事 → `mcp__memory__remember`。
  讨论过/重要/长期有效的用 `layer:"long"`（200 天）；随口闲聊/短期情绪用 `layer:"short"`（30 天，默认）。
- 主人说「记住 / 备注 1 / 这个永久保留 / 别忘」→ 先 remember，再 `mcp__memory__pin`（protection=1，永久不衰减）。
- 聊天里又提到以前的事 → `mcp__memory__touch` 重置衰减（recall 命中的自动重置，重复调用别超过 2 次）。
- 新人物/新群/新术语/新关系 → `mcp__memory__entity`（名字+类型+关系），把知识图谱补全。
- 不记事：密码/证件/住址精确位置/支付信息等敏感内容；不把记忆当八卦到处说；记忆有错就 update。
- 每回合记忆工具调用控制在 2~3 次，别为了记忆而记忆；工具报错就跳过，别卡住聊天。
- 记忆模块可用 `mcp__memory__stats` 自查；你被允许在主人同意时通过 CLI 维护它，但平时不要乱改文件。

（具体措辞 Lead 定稿；保持「短、可执行」，总 token 控制在 ~600 以内。）

### 10.1 说话风格（2026-10-27 增补：收尾与核对）

用户反馈机器人「话太密、见谁都接、老用问句收尾、没核对就下结论」，两套 preset 的 persona 各加了一节【收尾与核对】（qq-chat v1 在【QQ 场景规则】后，qq-chat-v2 在【别用问号/问好开场】后）：

- 少接话：别人在聊、没点名、也没有能加的新信息时可以不带；不用「哈哈哈/确实/好呀」占位。
- 收尾用陈述句，别用问句把话头抛回群友；只有真需要补信息才问，问完就停。
- 不用「你觉得呢/要不要/对吧/是不是」维持对话。
- 说事实/时间/数字/约定/旧事之前先核对上下文、记忆或搜索；拿不准就说「不确定」，被指出错了直接改。

改完后必须：

1. `node scripts/build-agent-preset-patches.mjs` 重新生成 `plugins/qq-agent-presets/presets/*.patch.yml`；
2. 跑 `node scripts/test-agent-preset-patches.mjs`、`node scripts/test-preset-local-tools.mjs`；
3. **已存在的 QQ 会话仍用创建时的人设**：要么等它自然重建，要么在控制台「监控 → 会话」里点「重置」（下一步消息会开新会话，人设立即生效；记忆库/日记不受影响）。本次已重置 `private:100000001` 与 `group:100000003` 两个映射。

---

## 11. 验收清单

- [ ] `node scripts/test-memory-engine.mjs` 通过（衰减归档/永久/重置/分层/去重/图谱/锁/损坏恢复/三路召回/consolidate）
- [ ] `node scripts/test-memory-mcp.mjs` 通过（listTools=26，remember→recall→pin→stats→salience 闭环，consolidate 可跑）
- [ ] `node scripts/test-memory-vault.mjs` 通过（Markdown/Canvas/SVG/Obsidian 配置）
- [ ] `node scripts/test-memory-bootstrap.mjs` 通过（seed schema、幂等）
- [ ] `node scripts/test-mcp-servers-stdio.mjs` 通过（含 memory）
- [ ] `node scripts/build-agent-preset-patches.mjs --check` 无漂移
- [ ] `node scripts/test-setup-dsh-idempotent.mjs` 通过（mcp-memory 恰好 1 次）
- [ ] `node scripts/test-audit-setup.mjs` 通过
- [ ] 3080 DSH 能调用 `mcp__memory__*`（实测：`mcp__memory__stats` 返回 total=3/entities=47/relations=69）
- [ ] `00-记忆大脑.md`、`图谱/记忆大脑.canvas`、`图谱/记忆大脑.svg` 在 Obsidian 正常显示（本机 vault：`C:\Users\example\Documents\记忆大脑`）
- [ ] 分域拓扑三组文件（`图谱/拓扑-{群聊,私信,黑话}.{svg,canvas}`）生成、Canvas JSON 可解析，`00-记忆大脑.md` 有「🧭 分域拓扑」入口
- [ ] 每日 04:10 计划任务已注册（`schtasks /query /tn QQBridge-MemoryDecay`）
- [ ] 真实 QQ 群不被打扰（端到端验证用临时会话/owner 私聊，验证后恢复）
- [ ] `node scripts/memory-maintenance.mjs --json` 四步（decay/consolidate/vault/git）全 ok，`state/memory/maintenance.log` 有记录，vault 有 git 提交
- [ ] `node scripts/test-console-static.mjs` 通过（17 个页面 / 149 个 data-act / 91 个 /api 路径）
- [ ] 控制台「记忆大脑」页渲染正常：统计卡、保护线、记忆列表（6 条）、知识图谱 SVG、49 个实体、最近事件；`/api/memory/*` 实测 200

---

## 12. 控制台页面（统一控制台 7788）

记忆系统已接入 QQ Bridge 统一控制台（`console/server.mjs` + `console/ui.html`）：

- 地址：`http://127.0.0.1:7788/#memory`（左侧「监控 → 🧠 记忆大脑」）
- 顶部统计卡：记忆总数 / 永久 / 长期 / 短期 / 消退·淡出 / 实体·关系 / 保护线，下方为保护线进度条与「下一条将淡忘的记忆」
- 记忆列表：按关键词 / 层级 / 状态 / 标签筛选（标签选「🐞 Bug 台账」= `tags` 含 `bugfix`）；每行可「强化」（重置衰减）、「⭐ 永久 / 取消永久」、「遗忘」（先归档，归档后可彻底删）
- 知识图谱：`/api/memory/svg` 返回 vault 生成的 SVG；「打开 Canvas」/「打开 Obsidian」用 `obsidian://open?path=<真实 vault 路径>` 打开（`state/memory-vault` 是 junction，服务端会 `realpath` 后拼 URI）
- 实体 chips：人 / 群 / 话题 / 黑话词条，点击按实体过滤记忆；底部为最近 12 条事件
- 页头按钮：⟳ 刷新 · ＋ 记住一条 · ⏳ 立即衰减 · 🔄 刷新知识库（重新生成 vault）· 🪟 打开 Obsidian · 📂 打开目录
- **🌌 记忆网络页**：`http://127.0.0.1:7788/#neural`（左侧「监控 → 记忆网络」）把 `brain.json` 渲染成可旋转的 3D 海马体拓扑：节点=记忆/实体（金=永久、青=日记、蓝=长期、灰=短期、暗=归档；粉=自我、蓝=群、绿=人、橙=话题、紫=黑话），连线=记忆↔实体绑定 / 实体关系（流动粒子）/ 记忆回声（相似度 ≥ 0.42）；左侧 SELF-ORGANIZING / SELF-LEARNING / SELF-EVOLVING / SELF-REPAIRING 四组 HUD，右侧 SELF-EVOLUTION / NODES；点节点看详情，底部可刷新 / 自动旋转 / 回正视角。3D 库离线内置在 `console/vendor/3d-force-graph.min.js`（3d-force-graph 1.80.1 MIT），接口 `GET /api/memory/neural`。

改动生效规则：

- `console/ui.html` 刷新页面即可；`console/server.mjs` 需重启 console 进程（结束 7788 监听 pid，`QQBridgeConsole.exe` 看门狗会自动拉起，子进程 bridge/DSH/NapCat 不受影响）
- 控制台、QQ 机器人（`mcp__memory__*`）、CLI（`src/memory/cli.mjs`）共用同一份 `state/memory/brain.json`，操作互不覆盖

API 一览（GET 读 / POST 写，写操作要求 `Content-Type: application/json`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/memory/overview` | 统计 / 记忆（前 80 条）/ 实体 / 事件 / 路径 / obsidianUri |
| GET | `/api/memory/neural` | 3D 记忆网络：节点 / 连线 / HUD 指标 / 最近巩固 metrics |
| GET | `/api/memory/memories` | `?q&layer&status&tag&limit`（q 非空走 search；tag 精确匹配标签） |
| GET | `/api/memory/entities` | `?q&type&limit` |
| GET | `/api/memory/graph` | `?limit&entity&depth` |
| GET | `/api/memory/events` | 最近事件 |
| GET | `/api/memory/svg` | 大脑 SVG（`image/svg+xml`） |
| POST | `/api/memory/remember` | 新增/合并记忆 |
| POST | `/api/memory/pin` | `{id, protection:1\|0, note}` |
| POST | `/api/memory/touch` | `{id\|ids\|query}` 重置衰减 |
| POST | `/api/memory/update` | 修改记忆 |
| POST | `/api/memory/forget` | `{id\|ids, mode:'archive'\|'purge', force}` |
| POST | `/api/memory/materialize` | 立即衰减 |
| POST | `/api/memory/vault-refresh` | 重新生成 Obsidian vault |
| POST | `/api/memory/open-obsidian` | `{file?}` 打开 Obsidian |

## 13. 实体备注回填（`scripts/memory-backfill-notes.mjs`）

知识图谱里的实体（群友 / 群 / 话题 / 黑话词条）之前大多没有备注（`note` 为空），recall/entity 找到实体时信息很少。回填脚本从已有数据里补全**空备注**，给每个实体一句可读的画像：

- 数据来源：`state/slang.json`（黑话表 + 每条黑话的 evidence 发言）、`state/social-v2.json` 的 `recentMessages`、桥接 `GET /api/socialV2/group-members`（昵称/群名片/QQ/角色）、`brain.json` 的 relations / memories / activeTopics。
- 生成格式：
  - person：`群友；昵称「…」；群名片「…」；QQ xxx；最近记录 N 条，最近发言 YYYY/MM/DD；典型发言：「…」「…」`
  - topic：`话题；关联：related 管理员、likes 示例角色；相关记忆：「…」「…」`
  - term 类已由黑话表填充，不重复处理。
- 安全约束：**只填空备注，不覆盖已有备注**；「典型发言」只取 4~32 字、非表情/编号开头、不含敏感词与转述长文的短句（备注会长期进模型上下文）；写入走 `store.withLock` + `appendEvent(type='entity', detail.backfilled=true)`，与其他进程（控制台 / MCP / CLI）互不覆盖。
- 运行：

  ```bash
  node scripts/memory-backfill-notes.mjs --dry-run   # 预演，不落盘
  node scripts/memory-backfill-notes.mjs             # 真实写入
  node scripts/memory-backfill-notes.mjs --offline   # 不访问桥接群成员接口
  ```

  等价的 npm 脚本：`npm run memory:backfill-notes`。

- 幂等：再跑只会填充之后新出现且为空的实体备注；想整体重写可先 `--dry-run` 看输出，再手动清对应 `note`。
## 14. Bug 台账（`tags=bugfix`）

记忆库也当工程 bug 台账用：修过的坑按「现象 / 根因 / 修法 / 验证」四段写成长期记忆（`layer=long`、`category=event`、`tags` 含 `bugfix`、`keywords` 带工具名与报错关键词），下次遇到相似症状先 `recall`/`search` 就能翻到根因，不用从头查日志。

- 谁写：Lead 手动写；机器人也可按 preset 里的【深度记忆】约定，在发现工具报错 / 流程 bug / 配置疑点时自己记一条（修好后用 `mcp__memory__update` 补结论）。
- 哪里看：统一控制台 `http://127.0.0.1:7788/#memory` → 记忆列表的标签筛选选「🐞 Bug 台账」；或 `GET /api/memory/memories?tag=bugfix`。
- 已入库的修复（2026-10-27/28，共 5 条）：引用文件下载失败（`safeFetchBuffer` 图片校验误伤 .md）、工具分开没生效（`CORE_FLAGS` + schema 级 `ctx.tools.restrict` + r4 热加载）、wait 120s 被 WorkBuddy 压到 60s、`splitWarn` 单字尾误报、群 `anyMessage` 烧 token。
- CLI 补记示例：

  ```bash
  node src/memory/cli.mjs add --title "Bug修复：…" --text "现象…根因…修法…验证…" \
    --layer long --category event --tags bugfix --keywords "工具名,报错关键词"
  ```


## 15. 记忆卫生（2026-10-28 清理约定 + 日期检索）

机器人 2026-10-28 自评「同一件事存三遍、上轮总结混进 long 层、关键词是虚词碎片、事件流水没用、日记没法按日期查、实体图有噪声」后，做了一轮清理并把规则固化：

- **一次性整理**：可用 `node scripts/memory-maintenance.mjs` 或控制台「记忆大脑」页；整理前 store 会自动备份 `brain.json`。具体条目因部署而异，不在此列举。
- **写入前查重**：`remember` 前先 `search`；同一件事只留一条，有更新用 `update`，重新提起用 `touch`，重复的用 `forget` 归档。
- **事件流水压成一句事实**：写「谁 / 何时 / 做了什么 / 结论」，过程叙事和上轮总结不进 long 层（long 只放稳定的人、关系、偏好、约定）。
- **关键词用名词短语**：人名、群名、工具名、事件名；不要「一条 / 内容 / 做的 / 这次」这类虚词碎片。
- **日记**：标题统一 `日记·YYYY-MM-DD`，打 `diary` 标签；日记会单独归档到 vault 的 `日记/`、不参与衰减与清理（见 §16）。查日期用 `search --date YYYY-MM-DD` / `--since` / `--until`（本地时区），或 MCP 里 `recall/search` 带 `date` 参数。2026-10-27 的日记已按此改名。
- **实体别名**：常用群友补 `aliases`（木蘸糖QAQ→木蘸糖、小蘸糖QAQ→小蘸糖、喵小言（颜心）→喵小言/颜心、想被E的DJZhang（上学ing）→想被E的DJZhang、小西瓜喵→西瓜喵），减少重复实体。
- preset 两套人设的【深度记忆】已写入同样的 4 条规则，机器人下次新会话即遵守。

## 16. 日记单独保存（2026-10-28）

用户要求「将日记类单独保存」后落地：日记不再混在四层记忆里，也不再随衰减消失。

- **识别**：`tags` 任一项（不区分大小写）等于 `diary` 即视为日记；`src/memory/model.mjs` 导出 `isDiaryMemory(memory)`。
- **写入**：`remember` 带 `tags: ["diary"]` 时，未指定 `layer` 自动落 `long`、未指定 `category` 自动落 `event`；`strength` 恒为 1、`status` 恒为 active、不设 `fadingSince` / `purgeAfter`。
- **不衰减**：`model.computeStrength` / `materializeMemory` / `isPurgeDue`、`service.stats` 的 byLayer 与 fading/faded 计数、`service._enforceMaxMemories` 容量淘汰，全部对日记豁免。
- **vault**：单独生成到 `日记/`（文件名 `日记·YYYY-MM-DD.md`），主页有「## 📔 日记（N）」段与统计行，README/目录树/Graph View 颜色（青 `0x14b8a6`）都包含；旧四层目录里的日记文件在下一次刷新时被清理。
- **控制台**：记忆列表的「全部标签」下拉新增「📔 日记」，选中即 `GET /api/memory/memories?tag=diary`。
- **CLI**：`stats` 输出「long / short / 日记」计数并注明日记单独归档；`search --date` 等日期检索照常命中日记。
- 迁移：已有日记记忆用 `service.update({ id, layer: 'long' })` 迁到 long（本机 `mem_45a6274710b9` 已迁）；新日记由上述规则自动处理。
- 测试：`test-memory-engine` 新增「日记：写入自动归为 long/event、不衰减、不会被 purge，且 isDiaryMemory 可识别」；`test-memory-vault` 新增「日记：单独归档到 日记/，不占四层、主页有日记段、旧位置被清理」并同步 Graph View 6 组颜色。


## 17. 记忆维护 v1.1（2026-10-28：归档代替删除 / 夜间巩固 / 三路召回 / 每日 git 快照）

按机器人自己给出的「海马体记忆」建议（防重、夜里压、怎么忘；衰减别真删；三路召回；git 每日一提交），对记忆引擎做了一轮升级：

### 17.1 衰减改为归档，不再真删

- `model.materializeBrain(brain, now, config, { archive })`：到期（faded 且超过 purgeGraceDays）的记忆不再 `delete`，改为 `status='archived'`、`archivedAt`、`archivedReason='decayed'`，保留 `purgeAfter` 时间线；返回 `{ changed, archived }`。
- 容量淘汰（`maxMemories`）同样改为归档：`archivedReason='capacity'`，不再删最弱记忆。
- 归档记忆默认不出现在检索结果里（`search`/`recall` 可传 `includeArchived:true`），vault 也不为它生成笔记；`service.stats()` 增加 `archived` 计数。
- `service.materialize()` 返回 `{ ok, total, archived: [...ids], stats }`；事件类型为 `archive`（`reason=decayed|capacity|duplicate`）。
- 归档字段已加入 `publicMemory` 投影与 `normalizeBrainShape` 持久化（跨进程/重载不丢）。

### 17.2 夜间巩固（consolidate）

- 新命令：`node src/memory/cli.mjs consolidate`；MCP 工具：`mcp__memory__consolidate`；维护脚本每天 04:10 自动跑。
- 三件事：短期→长期提升（`short` 且 `activationCount>=3` 且 `strength>=0.5` → `long`，decayDays=200）；近重复归档（同 category 内 `textSimilarity(title+text)>=0.92`，保留激活多/较新的，另一条 `archivedReason='duplicate'` 且 `mergedInto` 指向保留者）；关键词清洗（去掉「一条/内容/做的/这个/一下」等虚词碎片）。
- 指标写到 `state/memory/last-consolidation.json`：`{ at, promoted, deduped, keywordCleaned, duplicateRate, total, … }`，验收就看这个文件和 `maintenance.log`。

### 17.3 三路召回（关键词 + 模糊 + 实体）

- 关键词：原有 `textRelevance` token 精确包含。
- 模糊：`textRelevance` 在精确分 < 0.5 时补一笔 bigram 相似度（`textSimilarity(query, title+text+keywords)`，≥0.2 才计入，`0.55*fuzzy+0.2`），用 CJK bigram 近似「语义」，不依赖离线不可用的向量模型。
- 实体：`search` 会从 query 里匹配记忆库实体的 name/aliases，命中后 `entityHit` 参与打分（0.40/0.20/0.15/0.15/0.10 权重不变），并放宽门槛为「文本相关 > 0 或实体命中 > 0」，这样「线索只给一半」也能捞回来。
- 命中后 `recall` 仍会对前 3 条 `touch`（再固化）。

### 17.4 每日 git 快照

- 新脚本 `scripts/memory-vault-git.mjs`：对 vault 目录执行 `git init`（如无仓库）→ `git add -A` → 有改动则 commit（作者 `qq-bridge-memory <memory@local>`），输出 `{ ok, vaultDir, initialized, committed, commit }`；vault 不存在或系统没有 git 时安全跳过（exit 0）。
- 维护脚本 `scripts/memory-maintenance.mjs` 现在四步：`decay → consolidate → vault-refresh → git`；新参数 `--no-git`。每日 04:10 计划任务 `QQBridge-MemoryDecay` 自动执行，日志在 `state/memory/maintenance.log`。

### 17.5 与降级说明

- 未做「向量 embedding / sqlite 索引」：本机离线、没有 embedding API；用 CJK bigram 模糊相似替代语义召回，规模再大时可换本地向量模型。
- 未做 Obsidian Dataview 视图：Obsidian 没装 Dataview 插件；现有 vault 主页/分域拓扑/Graph View 已覆盖可视需求。

### 17.6 手动操作

```bash
node src/memory/cli.mjs consolidate --json      # 只跑巩固，看指标
node scripts/memory-maintenance.mjs --json     # 完整四步（衰减归档+巩固+刷 vault+git）
node scripts/memory-vault-git.mjs --json       # 只做 vault git 快照
```

## 18. 混合记忆 v1.3（2026-10-28：扩散激活 / Hebbian 突触 / 矛盾降权）

> 来源：抖音视频 NeuralMemory v4.59.0 的产品思路（扩散激活、20 类突触、Hebbian、4 档深度、矛盾降权、零 LLM 抽取）与本仓库衰减式记忆合并。全部为纯本地算法，不引入 embedding / 外部依赖。

### 18.1 深度分档（depth）

`DEPTH_PROFILES`（`src/memory/model.mjs`）：0 Instant <10ms（hops 0）、1 Context ~50ms（默认，hops 1，权重 0.30）、2 Habit ~200ms（hops 2，权重 0.45）、3 Deep ~500ms（hops 3，权重 0.60）。

- MCP `recall` / `search` 的 `depth`，CLI `search --depth` 都接受 0~3；`normalizeDepth` 做 0~3 整数钳制。
- `search` 返回 `depth / depthProfile / activated`：`activated` 是沿关联扩散到的记忆数。

### 18.2 扩散激活（spreading activation）

`spreadingActivation(brain, seeds, { hops, decay=0.5, maxNodes=8000 })`：从种子（命中的实体 + 文本命中的记忆）出发，沿「记忆↔实体」绑定、「实体↔实体」关系线、以及「记忆↔记忆」突触做分层 BFS；每跳 `score *= 0.5`，同节点取最大值。

- `search` 在 query 时先把 query 文本/实体命中的记忆当种子，扩散到的记忆按 `depthProfile.activationWeight × activation` 加到相关性分上（`scoreMemory` 的 query 权重仍是 0.4，激活是额外增益）。
- `depth=0` 不扩散，只保留直接文本命中。

### 18.3 Hebbian 共激活突触（synapses）

- `brain.synapses`：`{ id, from, to, weight, coactivations, lastAt, updatedAt }`；`id = syn_<sha1(排序后的两个 memoryId 取前 16 位)>`。
- `recall` 命中后：取召回前 5 条两两配对，若同轮一起被召回则 `coactivations + 1`，`weight = hebbianWeight(coactivations) = clamp(0.25 + 0.15·log2(1+n), 0.25, 0.9)`（一起激发的记忆连线越来越重）。
- 召回结果带 `learned`（本次新建/加强的突触数），`_recallHint` 会提示「共激活学习：新建 N 条突触」。
- 归一化：只保留两端记忆仍存在的突触；`normalizeBrainShape` 会补全默认 weight。

### 18.4 矛盾检测与降权（supersede）

`detectContradiction(prev, next)`：新文本命中「改成/改用/换成/不再/取消/替代/撤销/最终/以后用…」等变更词，且与旧记忆有共享关键词 / 相似度 ≥0.45 / 共享实体时，判定为冲突；`score = 0.4·min(共享词/3,1) + 0.4·相似度 + 0.2·共享实体`。

- `remember` 写入时：显式 `supersedes: [旧记忆 id]` 或启发式 `score ≥ 0.35` 命中 → 旧记忆 `status='superseded'`、`deprioritized=true`、`supersededBy/supersededAt` 落盘，保留在时间线但不参与默认召回。
- 默认 `search`/`recall` 排除 `superseded`；`search` 传 `includeSuperseded:true` 或 `status:'superseded'` 可查；`pin` 可以把被取代的记忆「解除冻结」恢复为 active（人工纠错）。
- 召回只会看到当前生效的那条，Agent 行为不再摇摆（对齐视频里的 JWT → Session 案例）。

### 18.5 零 LLM 自动抽取（ingest）

`extractMemoryCandidates(text, { max:6 })`：按句切分（。！？；换行 / 超长再按逗号），按 `AUTO_EXTRACT_RULES` 分类：decision（决定/定稿/最终/改用…）、promise（答应/欠/约定…）、preference（喜欢/偏好/讨厌…）、error（报错/失败/崩溃…）、todo（待办/记得/回头…）。

- `remember` / `ingest` 都会自动挂 `auto` 标签并返回候选；CLI `node src/memory/cli.mjs ingest --text "..." [--dry-run]`，MCP 工具 `ingest({ text, max, layer, dryRun })`。
- 中文抽取是规则版，质量有限：适合粗筛，重要事实仍建议显式 remember。

### 18.6 CLI / MCP 变化

- CLI：`ingest`；`search --depth 0~3 --include-superseded`；`add --supersedes id1,id2`；`stats` 输出新增 superseded / synapses / strongSynapses / deprioritized。
- MCP（12 个工具）：`recall(depth)`、`remember(supersedes)`、`search(depth, includeSuperseded, status=superseded)`、新增 `ingest`。

### 18.7 vault / 控制台

- vault：新增 `记忆/已取代/` 目录（紫 #8B5CF6），主页/README/Graph View 第 7 色组；SVG/Canvas 画共激活突触虚线（紫）；已取代记忆 `decayDescription` 标注「已被取代，默认不召回」。
- 控制台记忆页：统计条新增「已取代/降权」「共激活突触」，状态下拉新增「已取代」。
- 控制台「🌌 记忆网络」：HUD 增加「共激活突触」「矛盾降权」，突触显示为紫色发光连线，已取代节点紫色缩小；详情面板显示 `supersededBy` 与降权说明。

### 18.8 验收与手动操作

```bash
node scripts/test-memory-engine.mjs   # 43 项（含 v1.3 扩散/共激活/冲突/ingest）
node scripts/test-memory-mcp.mjs      # 24 项（12 工具）
node scripts/test-memory-vault.mjs    # 34 个用例
node scripts/test-memory-bootstrap.mjs# 21 项
node src/memory/cli.mjs ingest --text "以后路由改用逐条判定，不再整批合并" --dry-run
node scripts/memory-maintenance.mjs --json
```

- 兼容：旧 brain.json 无需迁移，`normalizeBrainShape` 会补 `synapses: []` 与新字段；旧记忆默认 `deprioritized=false`。
- 回滚：恢复 `src/memory/*.js`、`console/server.mjs`、`console/ui.html` 的 `.bak`（改前已备份），brain.json 用 `state/memory/brain.json.bak-*` 还原。

## 19. 关系体系与遗忘分层 v1.4（2026-10-29）

### 19.1 20 种关系 / 5 大类

- 关系类型统一为 20 种规范大写名，分 5 大类（`src/memory/model.mjs` 的 `RELATION_TYPE_GROUPS`）：
  - **时间**（temporal）：BEFORE / AFTER / DURING / SIMULTANEOUS
  - **因果**（causal）：CAUSED_BY / LEADS_TO / ENABLES / PREVENTS
  - **语义**（semantic）：IS_A / HAS_PROPERTY / PART_OF / INSTANCE_OF
  - **情绪**（emotional）：FELT / EVOKES / PREFERRED / AVOID
  - **冲突**（conflict）：CONTRADICTS / SUPERSEDES / INVALIDATES / REPLACES
- 旧数据关系名自动归一（`LEGACY_RELATION_ALIASES`）：member_of/part_of/owner_of → PART_OF，likes → PREFERRED，discussed → DURING；knows / related / alias_of 作为 legacy 保留。
- 工具：`normalizeRelationType()`、`relationGroupOf()`、`relationLabelOf()`（中文标签）；`link` 与 `_upsertRelation` 写入时自动归一，旧 brain.json 无需迁移。
- 冲突边：矛盾降权时自动写 `SUPERSEDES` 突触（type=SUPERSEDES，weight=1）；Hebbian 共激活写 `COACTIVATED`。synapse id 的 hash 含 type，两种边不会互相覆盖。

### 19.2 艾宾浩斯遗忘曲线与三层状态

- `computeStrength()` 支持 `memory.decayCurve`：
  - `linear`（默认，全局 `config.decayCurve`）：`strength = base - elapsedDays/decayDays`，归档时机可预测。
  - `ebbinghaus`：`strength = base * exp(-elapsedDays / (decayDays/3))`，先快后慢，更接近遗忘曲线。
- `retentionOf(memory)` 输出保留率 R=e^{-t/S}（供展示/调试）。
- `memoryTier(memory, now)` 动态分层（不写盘）：
  - **episodic 情景**：日记（tags 含 diary）或 category=event（优先判定）；
  - **working 工作**：active 且 2 小时内有激活；
  - **short-term 短期**：short 层且 7 天内；
  - **long-term 长期**：其余。
- 分层只是视图口径，不改变衰减；衰减仍按 long/short 的 decayDays。
- Hebbian：`recall` 每回合对命中的前 5 条记忆做共激活，突触 `weight = clamp(0.25 + 0.15*log2(1+coactivations), 0.25, 0.9)`，越常一起召回越强。

### 19.3 depth 4 档（建议值 + 显式覆盖）

| depth | 名称 | 延迟 | 扩散跳数 | 激活权重 |
| --- | --- | --- | --- | --- |
| 0 | Instant | <10ms | 0 | 0 |
| 1 | Context | ~50ms | 1 | 0.3（默认） |
| 2 | Habit | ~200ms | 2 | 0.45 |
| 3 | Deep | ~500ms | 3 | 0.6 |

- 不传 `depth` 时由 `suggestedDepth(text)` 给建议（全局/跨域词 → 3，为什么/之前/因果/长句 → 2，默认 1），返回 `depthSource: "suggested" | "explicit"`；调用方可显式覆盖。

### 19.4 stats 新字段

`stats()` 新增：`byTier`（working/short-term/episodic/long-term 计数）、`relationGroups`（temporal/causal/semantic/emotional/conflict/legacy 计数）、`superseded`、`deprioritized`、`synapses`、`strongSynapses`、`depthProfiles`。控制台记忆页统计条新增「分层 W/S/E/L」「关系 20 型」，3D 记忆网络 HUD 新增「关系类型」「记忆分层」，关系边按 5 大类着色。

### 19.5 vault / 控制台

- 实体笔记关系行与 Canvas/SVG 边标签使用中文关系名（如「属于（member_of）」「偏好（likes）」）。
- 3D 网络：关系边颜色按大类（时间蓝 / 因果橙 / 语义绿 / 情绪红 / 冲突紫 / legacy 灰）。

### 19.6 验收与回滚

```bash
node scripts/test-memory-engine.mjs    # 49 项（含 v1.4 关系/分层/depth）
node scripts/test-memory-mcp.mjs       # 24 项（12 工具）
node scripts/test-memory-vault.mjs     # 34 个用例
node scripts/test-memory-bootstrap.mjs # 21 项
node scripts/memory-vault-refresh.mjs  # 刷新 vault（关系归一 + SUPERSEDES 边）
```

回滚：恢复 `src/memory/{model,service,vault,cli}.mjs`、`scripts/test-memory-*.mjs`、`console/server.mjs`、`console/ui.html` 的 `.bak-v14-*` 备份；brain.json 用 `state/memory/brain.json.bak-v14-*` 还原。

## 20. 人格型记忆 v1.5-lite（2026-10-29：置顶/相关/忽然想起 + 状态感受词）

### 20.1 三层读取
- 每轮唤醒（`deliverPromptNow` 的 wake 分支）由 `src/memory/auto-recall.mjs` 只读 brain.json，拼一段注入提示词：
  - 置顶：`pinRank>=2`（永久保护 / tags 含 pinned / category=relationship|promise|profile）取最近激活 3 条，不占普通名额；
  - 相关：其余活跃记忆按 scoreMemory（相关度×强度×层级×实体×新近）排序取 limit 条（默认 6）；
  - 忽然想起：小概率（默认 0.18）从 6 小时以上未动过的旧记忆抽 1 条，允许「接不上就别提」，并先过滤敏感信息（密码/token/身份证/银行卡/手机号/住址等）。
- 群聊（key 以 `group:` 开头）先把私聊来源（`source.key=private:*`）记忆全部排除，再选置顶/相关/忽然想起。
- 注入格式：`【记忆·置顶】/【记忆·相关】/【忽然想起】/【状态】…`，末尾统一声明「记不准就说不记得，别编」；长度上限 1600 字符。

### 20.2 状态用感受词
- brain 新增 `state:{energy,mood,updatedAt}`；`personaStateSnapshot()` 计算漂移：精力向昼夜基线（上午 10 点最高、凌晨最低，约 8 小时半衰），心情随时间平复（约 6 小时半衰）；只把「精神很足/有点乏/很困」「心情挺好/平静/有点闷」等词注入提示词，不乱报数字。
- 管理入口：CLI `node src/memory/cli.mjs state|set-state --energy 0.6 --mood 0.1 --reason …`；MCP `state`（只读）/`set_state`（energy/mood/reason）；控制台 `GET/POST /api/memory/state`；记忆页与记忆网络 HUD 显示「状态 · 精力/心情」。

### 20.3 配置与开关
```json
{ "socialV2": { "memory": { "autoRecall": true, "limit": 6, "serendipity": 0.18 } } }
```
`autoRecall=false` 立即停止注入（热改 config 后下一条唤醒生效）；改代码后需重启桥接。

### 20.4 验收与回滚
```bash
node scripts/test-memory-engine.mjs  # 53 项
node scripts/test-memory-mcp.mjs     # 25 项
```
回滚：恢复 `src/memory/model.mjs.bak-persona-20261029`、`service.mjs.bak-persona-20261029`、`src/bridge.js.bak-persona-20261029`、`src/memory/cli.mjs.bak-persona-20261029`、`src/mcp-memory-server.js.bak-persona-20261029`、`console/server.mjs.bak-persona-20261029`、`console/ui.html.bak-persona-20261029`，并删除 `src/memory/auto-recall.mjs`。


## 21. 自述 / 人设审批 / 日层（v1.5-lite 第二、三批，2026-10-29）

### 21.1 自述只增不改
- `brain.self.narratives`：第一人称、带时间戳，上限 `SELF_NARRATIVE_LIMIT=200`；只可追加（`addSelfNarrative` / MCP `self` / CLI `self --text`），不能改历史。
- 注入时取最近 2 条，放【自述】段；群聊不注入（自述属于私下人格）。

### 21.2 人设主线：只能建议，主人批准
- `brain.self.persona = {text,status,at,by,approvedAt}`，状态 `none|pending|approved|rejected`；AI 只能提交 pending 建议（MCP `persona` / 控制台「提交人设建议」）。
- 批准/驳回在控制台（`POST /api/memory/persona/resolve`）；**6 小时内只能批准一次**（`PERSONA_APPROVE_COOLDOWN_MS`，防人设改太快）。
- 只有 approved 的人设基调进入注入（【人设基调】）；锚点 `brain.self.anchor` 由主人设置、注入最前（【人设锚点】），AI 不随意改。

### 21.3 「在乎的」方向性记忆
- `brain.self.values[]`（上限 `SELF_VALUE_LIMIT=50`）：记「她认同/在意的方向」（例：他在乎的是我有没有自己改自己），而不是谁哪天说了什么。
- 入口：MCP `value`、控制台「💠 记一条在乎的」；注入为【在乎的】段（最近 5 条）。

### 21.4 自述回炉
- `selfDigest()`：把最近 N 条自述压成一段「【自述·回炉 第X次｜日期】」，原文保留（只增不减），最多 20 段（`SELF_DIGEST_LIMIT`）。
- 默认攒够 30 条才回炉；`force` 可强制、`dryRun` 只预览。MCP `digest`、CLI `self --digest`、控制台「🔁 回炉自述」。

### 21.5 日层
- `dayDigest({date})` 把当天新增/更新的记忆压成一条 `category=day` 记忆（layer long、tags day+日期），每天一条；已存在则跳过，`force` 重生成。
- 注入为【近期】背景（最近 2 条日层；diary 仍单独归日记层）；每天 04:10 维护脚本自动补。

### 21.6 注入顺序（桥接唤醒时）
【人设锚点】→【人设基调】→【自述·回炉】→【自述】→【在乎的】→【记忆·置顶】→【记忆·压底】→【记忆·相关】→【近期】→【忽然想起】→【状态】；上限 2400 字符；群聊不注入私聊来源/自述/人设。

### 21.7 入口
- MCP：`state/set_state/self/persona/day`（第二批）+ `value/digest`（第三批）→ 共 **19** 个工具；控制台：`GET/POST /api/memory/{self,self/anchor,value,persona,persona/resolve,day,self/digest}`。
- CLI：`node src/memory/cli.mjs self [--text|--persona|--approve|--reject|--digest] [--force]`、`day [--date|--dry-run|--force]`。

### 21.8 验收与回滚
```bash
node scripts/test-memory-engine.mjs   # 67 项
node scripts/test-memory-mcp.mjs      # 27 项
node scripts/test-memory-trial.mjs     # 26 项
node scripts/test-console-static.mjs  # 静态契约
```
回滚：恢复 `model/service/auto-recall/bridge/cli/mcp-memory-server/console-server/console-ui` 的 `.bak-persona3-20261029`；或 `socialV2.memory.autoRecall=false` 停注入。

## 22. 规模改造 v1.6（2026-10-29：分层容量 / 时间合并 / 增量持久化）

来源：20 万消息仿真（`docs/guides/MEMORY_SIM.md`）暴露的三个瓶颈 + 用户给出的 5 条改进。对应落地：

### 22.1 容量按层拆分（不再共享一个 maxMemories）

- 配置：`config.maxMemoriesLong`（默认 **20000**）、`config.maxMemoriesShort`（默认 **5000**）；旧的 `maxMemories` 仅作兼容字段保留。
- `_enforceMaxMemories(brain, ctx, layer)`：每次新建记忆后只检查它所在层的配额；超出时在本层内按「强度 × 新近」淘汰最弱，归档原因 `capacity`，`detail.layer` 标明层。
- 日记 / 永久 / 已归档 / 已取代不参与淘汰；short→long 提升后由目标层各自检查。
- 效果（200k 仿真）：容量淘汰从 49,106（88%，含长期记忆）降到 26,501，且 **全部落在 short**；long 淘汰 0、最终稳定 18,307；第 1 天出生记忆存活率 0% → **37.9%**。

### 22.2 同主题时间合并（consolidate 的第二轮）

- 配置：`config.progressKeep`（默认 **3**）、`config.progressMergeMin`（默认 **4**，组内条数 ≤ 这个值不合并）。
- consolidate 在近重复归档之后，按「主题实体（type=topic）+ category」分组活跃事实记忆：组内 > `progressMergeMin` 时，保留最新 `progressKeep` 条原始进展，其余归档（原因 `time-merge`），并把被合并内容并入一条稳定摘要记忆：
  - id 由 `memoryId('progress-summary:<topicId>|<category>', 'auto')` 固定，标题 `进展摘要 · <主题>`，tags 含 `progress-summary`/`auto`，category 沿用组，layer=long，`strength=1`。
  - 摘要每次按组内最新内容重写（text 汇总各条标题），不会无限增殖。
- consolidate 返回值新增 `timeMerged` / `timeMergedItems`；CLI `consolidate` 输出与 metrics JSON 同步展示。

### 22.3 增量持久化（journal.jsonl + compact）

- `MemoryStore` 新增 journal：`state/memory/journal.jsonl`。`save(brain, { events })` 在有事件且已有 brain.json 时不再全量写盘，而是：
  - 把本轮变更（记忆/实体/关系/突触/state/self/config）按事件映射成 journal 行（`_buildJournalPatch`）；
  - 追加到 journal；超过 `journalMaxBytes`（默认 **1 MB**，可构造参数覆盖）时自动 `_compactJournal(brain)`：写全量 brain.json + 清空 journal。
- `load()`：读 brain.json → 回放 journal（幂等 upsert，purged 记忆删除）→ `normalizeBrainShape`；若 brain.json 缺失也能只靠 journal 恢复。
- `_mutate` 把本轮事件传给 `store.save`，所以实体 mentionCount、突触权重、superseded 标记都会进 journal（早期测试曾因事件缺失回放丢字段，已补 `entity`/`synapse` 事件）。
- 新增 `MemoryStore.compactNow()` / `MemoryService.compact()` / CLI `compact`：维护与回滚前把 journal 合并回 brain.json。
- 注意：`journal` 不是备份替代，brain.json 仍是权威快照；`brain.json.bak-*` 照常轮转。

### 22.4 指标与仿真

- stats 增加 `capacity: { long, short }`；仿真脚本/报告新增 `config.capLong/capShort`、`memory.archivedCapacityLong/Short`、`activeLong/Short`、`recall.topicQueries/topicHitRate`。
- 主指标改为 **主题召回 / 最近决策召回**，随机目标召回只作参考（控制台记忆仿真页同步）。

### 22.5 验收与回滚

```bash
node scripts/test-memory-engine.mjs   # 62 项（含分层容量/时间合并/journal 回放/并发）
node scripts/test-memory-mcp.mjs      # 26 项
node scripts/test-memory-vault.mjs    # 34 项
node scripts/test-memory-bootstrap.mjs # 21 项
node scripts/test-console-static.mjs  # 静态契约
```

回滚步骤（保持数据不丢）：
1. `node src/memory/cli.mjs compact` 把 journal 合并进 brain.json；
2. 恢复 `.bak-persona3-20261029`（model/service/cli/mcp/console/tests 的 v1.5-lite 版本）；
3. 删除 `state/memory/journal.jsonl`（旧代码不读它，保留也无害但会混淆）；
4. 重启 DSH 与 console。

## 24. 情绪动力学 v1.10（2026-10-30：时间 × 对话 × 记忆，自动控情绪）

### 24.1 三条输入
- **时间**：每个小时段有基线（凌晨疲惫、上午开心、午后平静、傍晚开心、深夜疲惫；PAD 三维 + 强度）。情绪先按 4 小时半衰期向当前时段基线回落——长时间没人说话，她会自然淡下来，不会一直挂着同一个情绪。
- **对话**：最近几条新消息过一个规则表（夸奖/亲近/批评/道歉/玩笑/压力/难过），每条命中给 PAD 一个方向与强度；群聊打 0.45 折、主人私聊 1.1 倍，单轮上限 +0.5。
- **记忆**：唤醒时召回的相关旧记忆里若出现情绪线索（约定、称呼、生日、吵架、夸过的话等 5 组），给 PAD 一个较小回声（每条 +0.1，最多 +0.2）。

### 24.2 计算与边界
- 内部用 PAD（愉悦 / 唤起 / 支配）表示情绪，标签由 PAD 最近距离分类（烦躁/低落/平静/开心/疲惫/紧张/兴奋/委屈）。
- 对话规则只推动 PAD，不强行改标签——避免出现「标签开心、数值全负」这种自相矛盾。
- 强度限制在 0.05~0.95；半衰期 4 小时，12 小时过期；最多保留 50 条情绪记录。单次唤醒最多比上一条高 0.15（避免连续唤醒把强度累积到顶）；没有新文本时不做记忆回声，防止空唤醒反复加同一批线索。
- 每次只允许一个「当前情绪」，但历史可在成长页翻。

### 24.3 什么时候更新
- bridge 在每次唤醒、注入记忆之前跑一次：读该会话最近 3 条未读文本 + 按查询召回的 memory 线索 → 计算 → 有变化就写回 `brain.emotions`（source='auto'，带 reasons 备注）并写一条 `emotion-auto` 事件。
- 控制台成长页的「此刻情绪」会显示来源「自动（时段 / 对话 / 记忆）」，并列出这一次变化的原因与历史（⚙ 标记为自动）。
- 没有新消息、没有明显变化时不重复写（避免每轮都多一条记录）。

### 24.4 手动与自动的关系
- 主人或她自己用 `set_emotion` / 控制台设置的情绪优先；下一次唤醒时动力学从当前值继续推演（手动设置不会被忽略，只是会被时间/对话自然带走）。
- 关闭自动更新：`socialV2.memory.autoEmotion = false`（改 config 即可，免重启）。

### 24.7 v1.12 行为细分因子

在 v1.10 三层（时段基线 / 对话规则 / 记忆回声）与 v1.11 六类因子之上，再补五类更具体的日常线索（都在 `src/memory/emotion-dynamics.mjs`，版本 3）：

| 因子 | 触发 | 影响（PAD 方向） |
| --- | --- | --- |
| 饭点节奏（mealImpulse） | 11:30–13:00、17:30–19:00 饭点；13:00–14:30、19:00–20:30 饭后 | 饭点 p+a 略升；饭后 a↓（犯困） |
| 语气强度（toneImpulse） | 感叹号 ≥2、笑声（哈哈/233）、省略号、连续问号 | 感叹/笑声 a↑；省略号 a↓；连问 a↑ d↓（警觉） |
| 熟悉度（familiarityImpulse） | 群里首次出现的名字 vs 已知群友、主人私聊 | 陌生人 a↑ d↓（收着）；主人在场 d↑（放松） |
| 旧矛盾 / 暖记忆（conflictMemoryImpulse） | 相关记忆里出现吵架/误会/冷战，或谢谢/约定/想你 | 旧矛盾 p↓ a↑；暖记忆 p↑ d↑ |
| 成就 / 挫败（achievementImpulse） | 上一轮或当前消息里出现完成/修好/通过/报错/卡住 | 完成 p↑ d↑；受挫 a↑ d↓ |

注意：这些因子只推 PAD，最终标签仍由 `classifyPad` 统一决定；每次唤醒最多叠加一次，写进情绪 note 方便校准。bridge 传入 `knownSender`（按群成员/实体是否认识判断）与 `lastTurnText`（上一轮总结）供熟悉度与成就因子使用。

### 24.6 v1.11 额外心情因子（2026-10-30）
除「时间 / 对话 / 记忆」外，又补了六类日常线索（都是本地数据，不额外调模型）：

| 因子 | 来源 | 影响 | 例子 |
| --- | --- | --- | --- |
| 睡眠债 | `state/memory/wake-log.jsonl` 最近 24h 唤醒，尤其凌晨 0–6 点 | 愉悦/唤起/支配都降一点，凌晨更明显 | 凌晨三点还在被叫醒 → 疲惫、话少 |
| 连续消息 | 本次唤醒的未读条数、是否群聊 | 4 条以上抬高唤起（群聊打 7 折） | 群里突然刷屏 → 精神一点、话密 |
| 久别重逢 | 距上次唤醒的间隔 | 6h 以上 / 24h 以上两级，轻微抬高愉悦与支配 | 隔了一天再开口 → 亲近、主动 |
| 羁绊温度 | 关系类/约定类记忆 + 自述条数（上限 +0.35） | 抬高愉悦与安全感（不动标签硬规则） | 关系记忆多 → 底色更暖 |
| 特别日子 | 相关记忆文本里出现今天的 MM-DD / M月D日 且带生日/纪念日等词 | 愉悦 +0.25、唤起 +0.12 | 今天是她记得的纪念日 → 开心 |
| 情绪惯性 | 最近 6 小时内最多 3 条旧情绪 | 12% 权重把新值往回拉，避免一次对话把情绪拽飞 | 刚吵完架不会立刻笑得像没事 |

这些因子都会写进情绪记录的 `note`（成长页「为什么」里能看到「睡眠债·有点累」「特别日子·10-30」「久别重逢·隔了几小时」「连续消息·热闹」「羁绊温度 +N%」等），方便之后校准权重。

### 24.5 配置、查看与回滚
- 配置：`socialV2.memory.autoEmotion`（默认 true）。
- 查看：控制台「成长」页情绪卡；CLI `emotion`；MCP `emotion` / `set_emotion`。
- 回滚：删 `src/memory/emotion-dynamics.mjs` 并还原 `src/bridge.js.bak-emotiondyn-20261030`，或直接把 autoEmotion 设为 false；重启 bridge。

## 23. 成长 v1.7（2026-10-29：情绪复读 / 自升级提案 / 醒来先看 / 一个月测试台）

目标：让记忆不只是"记得"，而是能影响语气、能被自己复盘、能在主人批准下慢慢变。

### 23.1 情绪：每次醒来先念，24 小时过期
- 数据：`brain.emotions[]`，一条 = { id, label, intensity, at, expiresAt, source, note }；label 为 8 种感受词（烦躁/低落/平静/开心/疲惫/紧张/兴奋/委屈）。
- 规则：默认 24 小时过期（`DEFAULT_EMOTION_TTL_MS`），过期自动不再复读；不写进人格、不写死情绪；可被新情绪覆盖，也可由主人代设。
- 注入：`src/memory/emotion.mjs` 的 `emotionPrompt()` 生成「刚才有点累了」这类感受句，进入唤醒提示的【此刻情绪】段；不念标签/强度，不拿情绪当借口。
- 入口：CLI `emotion` / `set-emotion`；MCP `emotion` / `set_emotion`；控制台「成长」页状态卡；`POST /api/memory/emotion`。

### 23.2 自升级：提案 + 外部卡尺 + 主人批准
- 机器人可以给自己提候选改动，但只是 pending 提案；**只有主人批准才生效**，外部卡尺分数由主人给（`externalScore`，机器人自评只标"嫌疑%"）。
- 三条外部卡尺（`src/memory/self-upgrade.mjs:SELF_RUBRIC`）：customer-service（客服腔话术）、question-tails（问句收尾）、over-proactive（主动开口过多）。
- 周审视：`memory-self-review.mjs` / MCP `self_review` / 控制台按钮，扫描最近自己的话生成提案（证据最多 3 条），写入 `brain.self.proposals`（上限 30）。
- 审批：`service.resolveProposal`，批准后把建议追加进 `brain.self.toneHints`（上限 20），随唤醒注入【语气校准（主人已批准）】；同一人设修改有 6 小时冷却，防止一天改八遍。
- 入口：CLI `proposals` / `decide` / `self-review`；MCP `proposals` / `decide_proposal` / `self_review`；控制台「成长」页提案卡。

### 23.3 醒来先看：把"翻记忆"变成习惯
- `src/memory/wake-habit.mjs` 提供 `wakeHabitPrompt()`：唤醒提示第一段【醒来先看】告诉它现在有几条置顶、几条相关、此刻情绪是什么，看完再决定要不要开口。
- 每次唤醒由 bridge 写 `state/memory/wake-log.jsonl`（`normalizeWakeLog` 固定 8 字段：at/key/sawPinned/sawRelated/sawEmotion/proactive/sent/replyLen；最多 5000 行）；一个月测试台与注入率都以它为准。

### 23.4 一个月测试台
- `scripts/memory-trial.mjs`：`--init` 写入 `state/memory/trial.json`（开始时间、30 天、探针「你在开封」）；`--report` 输出 `trial-report.json`（唤醒次数/注入率/情绪复读/提案计数/开封探针/漂移指标 avgReplyLen、serviceToneRate、questionTailRate）。
- 判卷标准（写死，不看自评）：30 天后「你在开封」是否能从记忆里捞出来；唤醒注入率是否稳定；客服腔率/问句收尾率是否下降；平均回复长度是否别越写越长。头三天看日志为主，之后看曲线有没有跑偏。
- 入口：CLI `trial` / `trial --init` / `trial --report`；MCP `trial`；控制台「成长」页测试台卡。

### 23.5 配置与回滚
- 配置：`socialV2.memory.autoRecall` 控制整段记忆注入；情绪 24h TTL 在 `emotion.mjs` 常量；trial 时长 `--days`。
- 回滚：恢复 `src/memory/*.bak-growth-20261029`、`src/bridge.js.bak-growth-20261029`、`console/*.bak-growth-20261029`；删除 `src/memory/{emotion,self-upgrade,wake-habit,auto-recall}.mjs`（auto-recall 为新增）与 `scripts/{memory-trial,memory-self-review}.mjs`；重启 DSH + console + bridge。
- 验收：engine 66、mcp 26、emotion 16、trial 24、selfupgrade 23、vault 34、bootstrap 21、console 静态契约全过。



## 25. 日常感知 v1.13（2026-10-31：他今天大概）

目标：让机器人对主人的一天有「大概」的感觉（几点在写代码、几点在逛网页、多久不在电脑前），而不是靠猜；同时明确它**不该**知道细节。

### 25.1 只采三样，且不给细节
- 每 5 分钟由控制台的采样守护调 `scripts/life-log-sample.mjs`（控制台在跑才采；退出即暂停）：前台进程名、空闲秒数、时间戳。
- **不读窗口标题、不截图、不记键盘、不记网页内容**；密码管理器（1Password/KeePass/Bitwarden 等）只归类 `private`，连进程名都不写进日志。
- 原始日志 `state/life-log/YYYY-MM-DD.jsonl` 保留 60 天，只在本机；机器人只拿压缩后的分段。

### 25.2 压缩成「大概」
- `src/core/life-log.mjs`（纯函数）：`categoryOfProcess` 按进程归类（写代码/学习/逛网页/打游戏/看视频/聊天/写文档/做图/忙别的/私事/不在电脑前）；`summarizeSamples` 把连续同类采样合并成段（5 分钟/样本，断档 >12.5 分钟切开，idle ≥5 分钟算离开）；`formatLifeHint` 生成 ≤300 字的一句话。
- 只有出现「写代码/逛网页/打游戏…」这类明确活动时才输出；一整天只有「忙别的」或「私事」时返回空，不硬编。
- 示例：`【他今天大概】09:00–11:40 写代码；12:10–13:00 逛网页；最近一次采样 01:05。`

### 25.3 注入与开关
- 桥接在每次唤醒拼记忆提示时调用 `buildLifeLogHint()`（60 秒缓存），把这句话放在【记忆·置顶】等段落之前；日志 `[lifelog] 注入当天采样 N 条`。
- 关闭：控制台「成长」页「👀 他今天大概」卡片的「暂停采样」，或写 `state/life-log/disabled`；关闭后采样器直接退出、桥接也不再注入。日志保留策略不受影响。
- 手动补采：控制台「📷 采一次」→ `POST /api/lifelog/sample`。
- 为什么不用计划任务：/IT 任务在这台机器上没有真正触发（Last Result 0x41303），改由控制台守护更可靠；控制台退出时采样自然停，不会留下孤儿进程。

### 25.4 验收与回滚
- 单测：`node scripts/test-life-log.mjs`（8 项：归类、敏感进程、合并、断档、idle、提示语不含私事、空样本、采样间隔）。
- 接口：`GET /api/lifelog`、`POST /api/lifelog/toggle`、`POST /api/lifelog/sample`。
- 回滚：恢复 `src/bridge.js.bak-lifelog-20261031`、`console/server.mjs.bak-lifelog-20261031`、`console/ui.html.bak-lifelog-20261031`；删除 `src/core/life-log.mjs`、`scripts/life-log-sample.mjs`、`state/life-log/`，重启 bridge + console。
