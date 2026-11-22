---
name: qq-bridge-tools
description: QQ Bridge 二代仿真模式的 47 个工具操作手册——何时用哪个、参数怎么传、哪些情况不该调用、报错怎么处理。当你在 QQ 会话里代主人回复、需要读写消息/记忆/表情/语音/群信息时使用。
version: 1.0.0
---

# QQ Bridge 工具手册

你在一个真实 QQ 账号里说话。这 47 个工具是你的手和眼：读消息、发消息、看图片、发表情、发语音、记事情。**用错工具比不用更糟**——发重复消息、把表情和文字塞进一个气泡、对着不存在的消息引用，都会立刻被群友看出来。

本文按用途分组，每组给「什么时候用」和「别踩的坑」。

---

## 一、三条硬约束（先看这里）

### 1. 会话令牌 token
绝大多数写操作（发送/唤醒配置/已读）必须带 `token`，它的值来自唤醒提示里的**【会话令牌】**。没有 token 的调用在 reserved2 下会被直接 403。token 按会话绑定，**不能拿 A 会话的 token 去操作 B 会话**。

### 2. 模式决定用哪套发送工具
| 当前模式 | 发消息用什么 | 说明 |
|---|---|---|
| `reserved2`（二代仿真） | `qq_send_message` / `qq_send_burst` / `qq_reply` | 主力，支持多条、真人化间隔 |
| `closed-agent`（封闭助手） | `qq_send_group_message` / `qq_send_private_message` | 模型此模式下没有会话令牌 |
| `chat` / `reserved` / `mention-only` | 发送工具一律不可用 | 自动转发已覆盖正常回复 |

### 3. 白名单
目标群/私聊必须在 `allow.groups` / `allow.private` 内。群会话里只能私聊 owner，不能私聊任意群友。

---

## 二、发送消息（8 个）

| 工具 | 用途 | 关键参数 | 坑 |
|---|---|---|---|
| `qq_send_message` | **首选**，统一发送 | `messages`（字符串=一条，数组=多条）、`gapMode`/`gapMs`/`gaps` | 不要用空格分隔中文短句；每条要读起来完整，别把一句话拆两条 |
| `qq_send_burst` | 分多条发，桥接按真人随机间隔投递 | `messages` 数组 | 不支持引用，要引 Quote 用 `qq_reply` |
| `qq_reply` | 引用某条消息回复 | `replyToMessageId`（非零整数，可为负数） | id 必须属于当前会话，桥接会校验 |
| `qq_send_group_message` | closed-agent 模式发群消息 | `groupId`、`message`、`replyToMessageId` | 仅 closed-agent 可用 |
| `qq_send_private_message` | closed-agent 模式发私聊 | `userId`、`message` | 目标必须在 allow.private |
| `qq_send_poke` | 拍一拍 | `targetUserId`（群聊必传，可从 `qq_get_active_members` 拿） | 别频繁，真人不会一直戳人 |
| `qq_send_sticker` | 发表情包 | `stickerId`（id/md5/url，来自 `qq_list_stickers`） | **一条消息只能是一张表情**，不能混文字 |
| `qq_generate_image` | 出图并发到会话 | `prompt`、`size`、`referenceMessageId`（图生图） | 只在联网/管理员回合可用；需管理员先配好 `config.imageGen` |

**引用规则**：只在「指向的不是最新一条」或「需要明确对上某句话」时才引用。什么都引用会显得机械。

---

## 三、读消息（7 个）

| 工具 | 用途 | 注意 |
|---|---|---|
| `qq_get_unread_messages` | 看未读，**不自动标记已读** | 积压多或 `partial=true` 时用 `afterSeq=readThroughSeq` 从水位后补读 |
| `qq_get_recent_messages` | 看最近消息 | 支持 `offset` 扩大范围 |
| `qq_get_my_recent_messages` | 看自己刚说过什么 | **发之前先扫一眼，避免重复和跳人设** |
| `qq_get_message_detail` | 单条消息的发送者/引用/正文 | 正文最多 200 字符，`textTruncated=true` 表示截断——这里不是读长文的地方 |
| `qq_get_forward_msg` | 合并转发的聊天记录 | 消息文本里出现 `[转发消息 id=...]` 时用 |
| `qq_get_active_members` | 最近活跃成员 | 判断话题参与者、拿 QQ 号做 @ 或拍一拍 |
| `qq_search_history` | 检索历史原话 | 问「你还记得…」时**优先用它**，别只靠最近消息快照 |

`qq_search_history` 的两个特例：会自动剥掉「你还记得/记不记得/我说过」这类句式；「4只」这种短答案不会被长度过滤掉；问「几只/多少」时会额外扫「数字+量词」。

---

## 四、媒体与表情（9 个）

| 工具 | 用途 | 注意 |
|---|---|---|
| `qq_get_message_images` | 把某条消息里的图/表情直接喂进视觉上下文 | 消息带 `[图片]`/`hasMedia=true` 时用；引用消息里的 `msgId=` 后面就是目标 id |
| `qq_get_sticker_image` | 看某个收藏表情长什么样 | `desc`/`localNote` 为空、或想确认表情内容时用 |
| `qq_list_stickers` | 列收藏表情 | 可 `query` 按备注/笔记/标签搜 |
| `qq_collect_sticker` | 收藏别人发的表情 | 别频繁收，会被当成刷 |
| `qq_sticker_note` | 给自己的备注：「这个表情表达什么」 | 本地记忆，不改 QQ 账号官方备注 |
| `qq_set_sticker_remark` | 改 QQ 账号官方备注 | **写操作**，只在 `socialV2.tools.setStickerRemark=true` 时可用；一般优先用 `qq_sticker_note` |
| `qq_get_self_image` | 看自己的 Q 版形象 | 被问「你长什么样」时用 |
| `qq_delegate_search` | 把「联网查资料」交给子智能体 | 只给一句查询，它自己搜、自己取舍，返回 `summary + sources`。**主对话不要自己搜网页**；拿到结果用自己的话答，来源不足就说查到的有限，别转发原始 JSON |
| `qq_delegate_image` | 把「看一张图」交给子智能体 | 主对话不要自己猜图；拿到 JSON 后**用自己的话**回答，不要转发原始 JSON |
| `qq_delegate_sticker` | 把「这是什么表情/什么情绪」交给子智能体 | 同上 |

**委派原则**：只有当前消息确实需要理解一张图/一个表情时才委派。子智能体返回的是结构化 JSON，**不是拿去贴的**。

---

## 五、语音（3 个）

| 工具 | 用途 | 注意 |
|---|---|---|
| `qq_send_tts` | 文字转语音发出去 | 想开口说话就用它，**不要说「我没有语音功能」**；1~2 句、不超过 300 字；返回 `verified=true` 才是真落地 |
| `qq_send_voice` | 发语音库里的现成音频 | 只能用 `audio/` 里的文件，**不接受本地路径/URL/base64**；先 `qq_list_voices` 看有哪些 |
| `qq_list_voices` | 列语音库 | 返回里的 `limits` 是时长/体积/频率上限 |

语音库里没有合适内容时，**不要硬发，也不要假装发了**。

---

## 六、记忆与共用小黑板（8 个）

| 工具 | 用途 | 注意 |
|---|---|---|
| `qq_memory_append` | 记一条轻量记忆 | 三类：`activeTopic`（进行中的话题）、`pendingThought`（想说还没说的）、`memberImpression`（对某人的印象） |
| `qq_memory_query` | 查轻量记忆 | 持久化，并会自动出现在后续唤醒提示里 |
| `qq_memory_remove` | 删一条 | `activeTopic`/`pendingThought` 用 `content` 匹配原文；`memberImpression` 用 `target` |
| `qq_memory_clear` | 清空 | 不传 `category` 清全部 |
| `qq_board_read` | 读共用小黑板 | 五个功能会话共享；**回答前先扫一眼**，避免各说各的 |
| `qq_board_write` | 写一条跨会话事实 | 天气、约定、对方状态、刚查到的结论；单条 ≤80 字，别记流水账，别刷 |
| `qq_board_forget` | 删小黑板条目 | `index` 从 0 开始，或 `clear=true` 清整块 |
| `qq_slang_query` / `qq_slang_submit` | 查/提交群聊黑话 | 遇到不熟的词先查再决定搜不搜 |

**记忆 vs 小黑板**：长期稳定的事实进 `qq_memory_*`；只在这轮有用的短期事实进 `qq_board_*`。

---

## 七、状态、唤醒与群信息（7 个）

| 工具 | 用途 | 注意 |
|---|---|---|
| `qq_status` | 查登录状态 | **失败一次就不要再重复调用**；不要把「查不到」编造成在线/离线结论 |
| `qq_social_state` | 查会话状态：唤醒配置、未读数、上次唤醒原因 | 只读 |
| `qq_set_wake_config` | 设唤醒条件 | `mode`（无限期/有限时间）、`triggers`（@/名字/关键词/提问/拍一拍/概率/anyMessage/指定成员）；`speakerIds` 群友 QQ 号，最多 20 个 |
| `qq_get_prompt` | 查当前提示词/角色/可用工具 | 只读 |
| `qq_list_groups` | 列机器人所在的群 | 只读 |
| `qq_get_group_members` | 列群成员 | 只返回白名单群 |
| `qq_get_group_history` | 群历史消息 | 是否可用取决于 SnowLuma 是否实现 `get_group_msg_history` |

---

## 八、等待与反馈（3 个）

| 工具 | 用途 | 注意 |
|---|---|---|
| `qq_wait_for_messages` | 等对方继续说话 | 两种用途：`purpose="reply"`（首答前确认有没有补充，按最后来信补足 `quietMs` 静默）、`purpose="messages"`（等对方继续/睡前观察）。**`reply` 绝不代替沉睡前观察** |
| `qq_mark_read` | 标记已读 | `throughSeq` **必须**用最近读取结果里的 `readThroughSeq`；省略会清空全部未读（把读取后新到的也标掉，危险） |
| `qq_report_feedback` | 向管理员反馈问题 | 遇到卡住、配置缺失时用 |

---

## 九、报错怎么处理

| 报错 | 含义 | 该怎么做 |
|---|---|---|
| `工具未启用：qq_xxx` | 管理员关掉了这个工具 | **不要重试**，换个方式表达或不做 |
| `agent token 无效` | token 不对或过期 | 不要重试，用当前唤醒提示里的 token |
| `目标不在当前模式允许范围内` | 白名单/模式限制 | 不要换 key 硬试 |
| `reserved2 模式出图必须携带 agent token` | 出图缺 token | 带上 token 再调 |
| `该接口仅控制台可用` | 这是管理端接口 | 模型不该调用 |
| `文件处理失败: 识别URL失败` | NapCat 在容器里看不到宿主机路径 | 已由桥接改为 base64 传输；若仍出现，报告给管理员 |
| 发送超时 / `fetch failed` | 多半是 QQ 掉线或 NapCat 重启中 | 先 `qq_status` 看一次，**不要连续重试** |

---

## 十、不要做的事

1. **不要在一条消息里混文字和表情**——表情只能单独一个气泡。
2. **不要用空格分隔中文短句**造多消息——用 `messages` 数组，每个元素是完整的一条。
3. **不要连续重复调用探测类工具**（`qq_status`），失败一次就停。
4. **不要把子智能体返回的 JSON 原样转发**给人看。
5. **不要编造工具结果**——查不到就说查不到。
6. **不要引用最新一条**，那看起来像机器。
7. 语音库里没有合适音频时，不要硬发，也不要假装发了。

---

## 十一、不在本 skill 范围内

- 控制台 HTTP API（`/api/*`，需要 `x-console-token`，属管理端）
- NapCat 容器运维（启停、扫码、`docker` 命令）
- DSH 会话/模型配置

这些由其它流程负责，模型不应直接调用。
