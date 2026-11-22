# 思考过程与记忆模式（部署 / 开关 / 验证）

> 适用：qq-bridge 0.2.1-r1，DSH 0.2.0-rc.2 / 0.2.1-rc.2（0.2.2-rc.x 亦可）。
> 这是 `DEPLOY.md` 的补充章：**思考过程**管「怎么想」，**记忆模式**管「记得什么」。
> 两者代码都在包里；默认值偏保守，按下面按需打开即可。

---

## 0. 一页速查

| 能力 | 开关（config.json） | 随包默认 | 在哪里看 |
| --- | --- | --- | --- |
| 基础回合思考强度 | `dsh.reasoningEffort` | `max`（示例值，建议新机 `auto`） | DSH GUI 会话、控制台模型页 |
| 进阶回合思考强度 | `dsh.advanced.reasoningEffort` | 未写=沿用基础 | 控制台模型页「进阶」 |
| 内部会话思考强度 | `dsh.internal.reasoningEffort` | 未写=`high`（仅内部任务） | 一般不暴露 |
| 「正在思考」回执 | `ackMessage` | `""`（不发；代码兜底文案是 `🤔 收到，正在思考…`） | QQ 聊天窗口 |
| 直连 API 思考 | `api.reasoningEffort` / `api.thinkingType` / `api.thinkingBudget` | 全空/0=不发 | 控制台「API 测试」、日志页 `[api] 思考过程：` |
| 深度记忆（会遗忘） | `socialV2.memory.autoRecall` | 缺省=开 | 控制台「记忆大脑 / 记忆网络 / 记忆银河」 |
| 记忆注入条数 | `socialV2.memory.limit` | 6 | 同上 |
| 「忽然想起」比例 | `socialV2.memory.serendipity` | 0.18 | 同上 |
| 自动情绪 | `socialV2.memory.autoEmotion` | 开 | 控制台「成长」 |
| 跨群用户记忆 | `socialV2.userMemory.enabled` | 开（`maxUsers=5000`） | 控制台「记忆大脑 / 用户」 |
| 照片记忆 | `socialV2.photoMemory.enabled` | 开（300 张 / 365 天） | 控制台「照片记忆」 |
| 跨会话 Markdown 记忆 | `dsh-memory-evolve` 插件 | 取决于目标 DSH profile | DSH 记忆页 / `~/.dsh/memories` |

> 说明：`config.example.json` 已包含 `socialV2.memory / userMemory / photoMemory` 三块。
> 从旧包升级时，把这三块合并进你现有的 `config.json` 即可，不要整份覆盖。

---

## 1. 思考过程（reasoning）

### 1.1 QQ 里到底能看到什么

| 场景 | 会不会出现在 QQ | 说明 |
| --- | --- | --- |
| 回执 `ackMessage` | 会（如果你填了） | 收到消息后先发一条「正在思考」，**不是**模型推理原文 |
| 最终回复 | 会 | 模型通过 `qq_send_message` / `qq_reply` 发出的正文 |
| DSH 会话的原始 reasoning | **不会** | 留在 DSH 会话/GUI 里；reserved2 的提示词明确「文本输出只是思考，不会自动发送」 |
| 直连 API 的 `reasoning_content` | **不会** | 只写桥接日志 `[api] 思考过程：…`；控制台 API 测试页会显示 |
| 工具调用过程 | 不会 | 工具结果只作为模型下一轮的素材 |

**为什么不直接把 reasoning 转发到 QQ？**

- 原始思维链可能包含系统提示词、隐私上下文、工具参数，群聊里直接发等于泄露；
- 推理 token 通常比正文贵，转发还会多占一条消息；
- 真要让群友看到「思路」，更安全的做法是让模型在 `qq_send_message` 里发一句**简短结论式思路**（例如「我先确认一下你上次说的是周五」），而不是透传 `reasoning_content`。

### 1.2 基础回合：`dsh.reasoningEffort`

`config.json`：

```json
{
  "dsh": {
    "reasoningEffort": "auto"
  }
}
```

| 值 | 行为 | 建议 |
| --- | --- | --- |
| `auto` | **不发送** `reasoningEffort`，由 DSH/provider 决定 | 新机器首选；兼容性最好 |
| `low` | 低思考预算 | 闲聊、快问快答 |
| `high` | 高思考预算 | 需要推理的问答 |
| `max` | 最高档（代码默认） | 难题、长任务；更慢更贵 |

- 控制台「模型」页也能热切换（`/api/dsh/effort`），对已有会话**下一条消息**生效。
- 控制台刻意不提供 `off`：QQ 聊天助手依赖思考。
- 手工写成非法值（如 `medium`）时，桥接会打印警告并回退 `max`，不会崩。
- 某些模型（如 WorkBuddy）不支持 `reasoningEffort`：桥接会去掉参数重试一次，日志里会写「不支持思考强度…改为不发送」。

### 1.3 进阶 / 内部回合（可选）

进阶回合用于看图、视频等会切模型的场景；内部会话用于控制台/维护类调用。

```json
{
  "dsh": {
    "advanced": {
      "enabled": true,
      "provider": "deepseek-official",
      "model": "deepseek-flash",
      "reasoningEffort": "high"
    },
    "internal": {
      "enabled": true,
      "reasoningEffort": "high"
    }
  }
}
```

- `advanced` 不写时沿用基础回合；`internal` 不写时默认 `high`，只影响黑话学习等内部任务。
- 改动后重启桥接；`advanced.holdMs` 控制进阶模型保持时长（默认 180000ms）。

### 1.4 直连 API 后端（`api`）

只有「非管理员且不在白名单」的会话才会走这条直连链路；管理员/白名单仍走 DSH。要测思考过程，可以用控制台「API 测试」页。

```json
{
  "api": {
    "enabled": true,
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-...",
    "model": "deepseek-chat",
    "reasoningEffort": "high",
    "thinkingType": "enabled",
    "thinkingBudget": 4096
  }
}
```

| 键 | 取值 | 说明 |
| --- | --- | --- |
| `reasoningEffort` | 空 / 服务商支持的值（`low`/`high`/`max` 等） | 空=请求体不带该字段 |
| `thinkingType` | `""` / `adaptive` / `enabled` / `disabled` | 非空才发 `thinking: { type }` |
| `thinkingBudget` | 0–32000 | 只有 `thinkingType=enabled` 且 >0 才发 `budget_tokens` |

响应解析顺序：`message.reasoning_content` → `message.reasoning` → `reasoning_details`（部分中转格式）；读到就写日志并回调控制台测试页。

### 1.5 验证思考链路

```powershell
cd C:\qq-bridge

# 1) 看配置
node -e "const c=JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('effort=',c.dsh.reasoningEffort,'api=',c.api.reasoningEffort,c.api.thinkingType,c.api.thinkingBudget)"

# 2) 控制台起没起
Invoke-RestMethod http://127.0.0.1:7788/api/health | ConvertTo-Json -Depth 3
```

- 控制台 → **模型**：能看到当前 `provider/model/reasoningEffort`，可热切。
- 控制台 → **日志**：直连 API 回合会出现 `[api] 思考过程：…`；DSH 回合不会打印 reasoning。
- 控制台 → **API 测试**（需先配 `api.apiKey`）：回复下方会显示【思考过程】。
- DSH GUI：打开对应 QQ 会话，能看到 DSH 自己的思考/工具过程。

### 1.6 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 日志没有 `[api] 思考过程` | 模型不返回 reasoning / 没走 API 链路 | 换推理模型；确认是「非白名单」会话或 API 测试 |
| 设了 `thinkingBudget` 没效果 | `thinkingType` 没设 `enabled` | 两个一起设 |
| 回复变慢变贵 | `high/max` + 长上下文 | 改 `auto`/`low`；看用量页 reasoning token |
| 控制台提示思考强度非法 | 手工写了 `medium`/`off` | 改 `auto/low/high/max` |
| 日志「不支持思考强度，改为不发送」 | 模型/provider 不支持 | 正常降级；想稳就设 `auto` |

---

## 2. 记忆模式（memory）

「记忆模式」不是单一开关，而是**五套记忆 + 一组开关**。它们共用同一个 `state/`，但职责不同：

| 层 | 数据位置 | 谁在用 | 开关 |
| --- | --- | --- | --- |
| ① 深度记忆（会遗忘） | `state/memory/brain.json` + `journal` | `mcp__memory` 工具、唤醒注入、控制台 | `socialV2.memory.autoRecall`（注入）；`tools.memory` 只管 `qq_memory_*`，不管 `mcp__memory` |
| ② 跨会话 Markdown 记忆 | `<DSH_HOME>/memories`（如 `C:\Users\<你>\.dsh\memories`） | `dsh-memory-evolve` 插件 + `memory` 工具 | 由目标 DSH 是否装该插件决定 |
| ③ 跨群用户记忆 | `state/user-memory.json` | 每回合注入「这个人以前聊过什么」 | `socialV2.userMemory.enabled` |
| ④ 照片记忆 | `state/photo-memory.json` + `state/media/photo-memory/` | 看图后回查「之前那张照片」 | `socialV2.photoMemory.enabled` |
| ⑤ 会话轻记忆（小黑板） | `state/social-v2.json` 等 | `qq_memory_append/query/remove` | `socialV2.tools.memory` |

### 2.1 深度记忆：长/短两层 + 遗忘

- **short**：约 30 天不提起就淡忘（默认 `decayDaysShort=30`）。
- **long**：约 200 天（默认 `decayDaysLong=200`）。
- **永久**：`protection=1`（控制台「备注 1」）永不衰减。
- **日记**：`tags:["diary"]` 单独归档，不衰减、不清理。
- **归档而非删除**：强度低于阈值只归档，保留时间线；`purgeGraceDays=7` 后才可能清。
- **知识图谱**：实体/关系/共激活突触/矛盾降权；控制台有 3D 网络与银河页。
- **注入**：每次唤醒取「置顶 + 相关 + 忽然想起」三层，外加情绪/状态提示。

可选的 `state/memory/config.json`（不存在就用默认值，存在则深合并）：

```json
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

`vaultDir` 相对 `state/` 解析，默认 `state/memory-vault`。

### 2.2 开关与默认值

`config.example.json` 里已经带好：

```json
{
  "socialV2": {
    "memory": {
      "autoRecall": true,
      "limit": 6,
      "serendipity": 0.18,
      "autoEmotion": true
    },
    "userMemory": {
      "enabled": true,
      "maxUsers": 5000
    },
    "photoMemory": {
      "enabled": true,
      "maxPhotos": 300,
      "recallLimit": 3,
      "maxChars": 900,
      "keepDays": 365,
      "storeOriginals": true,
      "maxOriginalBytes": 8388608
    }
  }
}
```

| 想关掉 | 怎么改 | 影响 |
| --- | --- | --- |
| 完全不注入深度记忆 | `socialV2.memory.autoRecall=false` | 唤醒不再带记忆块；数据还在 |
| 不自动更新情绪 | `socialV2.memory.autoEmotion=false` | 情绪仍可手动设 |
| 不给模型 `qq_memory_*` 轻记忆工具 | `socialV2.tools.memory=false` | 模型不能用 append/query/remove/clear；深度记忆 `mcp__memory` 仍可用（另由 setup-dsh 挂载） |
| 不记用户画像 | `socialV2.userMemory.enabled=false` | 不再按 QQ 号注入历史 |
| 不看图记照片 | `socialV2.photoMemory.enabled=false` | 已存照片保留，不再新增 |
| 不发「正在思考」 | `ackMessage=""`（示例默认） | 收到消息不再回执 |

> 热改 `autoRecall` / `autoEmotion` 下一条唤醒生效；改 `tools.*` 或插件级能力后建议重启桥接与 DSH。

### 2.3 新机器怎么初始化

**空库直接可用**（推荐给全新部署）：

1. 不需要手动建 `state/memory/`；第一次写入（bot 调 `remember` 或跑一次维护）才会建 `brain.json`；空库唤醒不报错。
2. 控制台「记忆大脑」显示 0 条是正常的；聊几句后让 bot「记住……」再刷新。
3. `deploy-check` 的 `memory.vault` 项第一次可能 FAIL：vault 要等 `brain.json` 有了内容才生成；先让 bot 记一条，再跑 `node scripts/memory-maintenance.mjs --vault-only`。空库时这项 FAIL 属预期。

**从旧机器迁移**（想保留记忆）：

```powershell
cd C:\qq-bridge

# 旧机器：只读旧 state，生成 seed（不会改旧数据）
node scripts/memory-bootstrap.mjs --state "D:\old-qq-bridge\state" --out "state\memory\seed.json" --json

# 新机器：幂等导入
node src/memory/cli.mjs seed "state\memory\seed.json"
```

- `memory-bootstrap` 需要旧 `state` 里有 `social-v2.json` / `sessions.json` / `slang.json` / `current-role.json` 等；没有就跳过，空库也能用。
- 更彻底的做法：停桥接后直接复制 `state/memory/`（`brain.json` + `journal`）、`state/user-memory.json`、`state/photo-memory.json`、`state/media/photo-memory/`、`state/memory-vault/`。
- **不要**在桥接运行时覆盖 `brain.json`；store 有锁与 journal，运行中替换可能丢增量。

**Obsidian vault（可选）**：

默认 `state/memory-vault`。想直接在 Obsidian 里看，可以把它做成 junction（**junction 路径必须尚不存在**；若 `state\memory-vault` 已是目录/junction，先停桥接并把它改名移走，再执行）：

```powershell
# 示例：把 vault 指到你的 Obsidian 库
New-Item -ItemType Junction -Path "C:\qq-bridge\state\memory-vault" -Target "C:\Users\<你>\Documents\记忆大脑"
```

### 2.4 每天维护（强烈建议）

```powershell
cd C:\qq-bridge
node scripts/memory-maintenance.mjs
```

它做：衰减/归档 → 夜间巩固（short→long、近重复归档、关键词清洗）→ 日层 → vault 刷新 → vault git 快照。

只跑一部分：

```powershell
node scripts/memory-maintenance.mjs --decay-only   # 只衰减/巩固
node scripts/memory-maintenance.mjs --vault-only   # 只刷 vault
node scripts/memory-maintenance.mjs --no-git       # 不提交 git
node scripts/memory-maintenance.mjs --json         # 机读结果
```

Windows 计划任务（每天 04:10，路径按实际改）：

```powershell
schtasks /Create /TN "QQBridge-Memory" /SC DAILY /ST 04:10 /F `
  /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\qq-bridge\scripts\memory-maintenance.mjs\""
```

### 2.5 查看与验证

```powershell
cd C:\qq-bridge

# 记忆库统计（条数/层级/实体/关系/保护线/衰减参数）
node src/memory/cli.mjs stats

# 只读检索
node src/memory/cli.mjs search --query "关键词" --layer long

# 控制台健康
Invoke-RestMethod http://127.0.0.1:7788/api/health | ConvertTo-Json -Depth 3
```

控制台页面（`http://127.0.0.1:7788/`）：

| 页面 | 路由 | 看什么 |
| --- | --- | --- |
| 记忆大脑 | `#memory` | 保护线、衰减、知识图谱、照片记忆入口 |
| 记忆网络 | `#neural` | 3D 海马体拓扑、自组织/自学习 |
| 记忆银河 | `#galaxy` | 星系底图上的记忆点 |
| 记忆仿真 | `#sim` | 20 万条压测、存活/召回对照 |
| 成长 | `#growth` | 情绪、自升级提案、一个月测试台 |
| 照片记忆 | `#memory` 内区块 | 看图后记下的画面与原图 |

端到端验证（P8 加一项）：

1. owner 私聊 bot：「记住：我周五晚上一般有空」。
2. 回一句「好，记住了」后，`node src/memory/cli.mjs stats` 总数 +1。
3. 再问「我周五晚上一般干嘛？」，应能召回；控制台日志出现 `[memory] ... 注入记忆`。
4. 控制台「记忆大脑」能看到这条；「记忆网络」有节点。

### 2.6 备份、迁移、隐私

- **备份**：停桥接 → 复制 `config.json` + `state/`（至少 `state/memory/`、`state/user-memory.json`、`state/photo-memory.json`、`state/media/photo-memory/`、`state/memory-vault/`）。
- **迁移**：同备份；新机解压同版本包 → 放回 `state/` → 起桥接。不要跨大版本直接搬 `brain.json` 而不看 schema 版本。
- **隐私**：`state/` 含聊天记录、用户画像、照片原图、记忆原文，**不要打进分发包、不要发群**。本包已故意排除 `state/`。
- **清理**：删单条用控制台或 `memory_forget`；清空整库请先备份，再停桥接删 `state/memory/`（不可恢复）。

### 2.7 跨会话 Markdown 记忆（可选）

如果目标 DSH 的 profile 装了 `dsh-memory-evolve` 插件，bot 还会有一套 Markdown 五轨记忆（`MEMORY.md` / `USER.md` / 项目 / 每日 / KEY），数据在 `<DSH_HOME>/memories`（Windows 常见 `C:\Users\<你>\.dsh\memories`）。

- 未装不影响上面的深度记忆；装了会由插件每回合自动注入摘要。
- 安装/卸载用 DSH 的插件管理（`dsh plugin --profile <name> add dsh-memory-evolve`），装完重启 DSH。
- 两套记忆不要互相抄：Markdown 轨记「长期稳定事实」，`mcp__memory` 记「会遗忘的细节/关系」。

---

## 3. 部署时怎么开（合并进 DEPLOY.md 的步骤）

1. **P4 配置**：`Copy-Item config.example.json config.json` 后，确认 `socialV2.memory / userMemory / photoMemory` 三块在；不需要的按 2.2 关。
2. **P5 注册**：`node scripts/setup-dsh.mjs web` 会挂 `mcp-memory`；装完**重启 DSH**。
3. **P7 自检**：在 DEPLOY.md 的四连验后追加：
   ```powershell
   node src/memory/cli.mjs stats
   node -e "const c=JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('effort=',c.dsh.reasoningEffort,'autoRecall=',c.socialV2.memory.autoRecall)"
   ```
4. **P8 端到端**：按 2.5 的「记住 → 统计 +1 → 召回」走一遍；思考过程按 1.5 看日志/控制台。
5. **P9 守护**：把 `memory-maintenance.mjs` 加进每日计划任务（2.4）。

---

## 4. 排错表

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 记忆页 0 条 | 新库 / 没触发 remember | 让 bot 记一条；看 `[memory]` 日志 |
| 有记忆但不注入 | `autoRecall=false`；会话 key 不匹配；库为空 | 查配置；`stats`；看唤醒日志 |
| `stats` 报锁超时 | 另一个进程正在写（控制台/桥接/MCP） | 等 5s 重试；确认没有两个桥接实例 |
| `memory.vault` FAIL | vault 还没生成（空库属预期） | 先让 bot 记一条，再跑 `memory-maintenance.mjs --vault-only` |
| vault 不更新 | 没跑维护 / vault 路径不可写 | 手动跑维护；检查 `vaultDir` 权限 |
| 用户画像不生效 | `userMemory.enabled=false`；该用户消息太少 | 打开开关；多聊几句 |
| 照片记不住 | `photoMemory.enabled=false`；图没描述；超过保留期 | 查配置；看控制台照片页；调 `keepDays` |
| `mcp__memory` 工具不存在 | `setup-dsh` 没跑/DSH 没重启/`mcp-memory` 没挂上（与 `tools.memory` 无关） | 重跑 setup-dsh → 重启 DSH → 查 `cordis.patch.yml` 里 `mcp-memory` |
| 思考很慢/很贵 | `high/max` | 改 `auto`；看用量页 reasoning token |
| 日志没有思考过程 | DSH 会话不打印 reasoning；只有 API 直连才打 | 用控制台 API 测试或 DSH GUI 看 |

---

## 5. 最小验收清单

- [ ] `dsh.reasoningEffort` 是 `auto/low/high/max` 之一；控制台模型页显示一致。
- [ ] `ackMessage` 符合预期（要回执就填，不要就留空）。
- [ ] `socialV2.memory.autoRecall=true`（或明确知道为什么关）。
- [ ] `node src/memory/cli.mjs stats` 能跑通。
- [ ] 让 bot 记一条 → 统计 +1 → 能召回。
- [ ] 控制台 `#memory` / `#neural` 能打开。
- [ ] 每日维护任务已建（或明确不建）。
- [ ] `state/` 没有被打进任何对外压缩包。
