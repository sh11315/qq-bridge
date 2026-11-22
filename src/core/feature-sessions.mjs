/**
 * 功能会话（feature sessions）纯逻辑。
 *
 * 背景：QQ 机器人的能力被拆成五套**独立 DSH 会话**：
 *
 *   chat     聊天      群聊用基础模型、私聊用进阶模型；只有对话类工具
 *   sticker  表情包    固定基础模型（省额度）；只放表情包工具 + 最小收尾工具
 *   vision   看图      固定进阶模型；图片/视频/文件/转发
 *   voice    语音      固定进阶模型；TTS / 语音库
 *   web      联网      固定进阶模型；web_search / web_fetch
 *
 * 五套会话共享桥接层同一份「最近消息快照 + 记忆 + 黑话库」（历史共享），
 * 但各自持有独立的 DSH 会话（上下文/工具调用历史互不污染）。
 * 切换功能时旧会话被"停放"（sessions.json 的 parkedSessions），切回复用。
 *
 * 本模块只做**纯计算**：不读文件、不碰网络、不依赖 bridge.js 的全局状态，
 * 这样路由/模型/工具面可以脱离 DSH 与 QQ 做单元测试。bridge.js 负责把
 * 这里的结论落到 DSH 会话、MCP 工具与 QQ 发送上。
 */

// ── 功能域 ──────────────────────────────────────────────────────────────────

export const FEATURES = Object.freeze(['chat', 'sticker', 'vision', 'voice', 'web']);

export const FEATURE_LABELS = Object.freeze({
  chat: '聊天',
  sticker: '表情包',
  vision: '看图',
  voice: '语音',
  web: '联网',
});

/** 每个功能域的默认模型档位（chat 按群聊/私聊再分）。 */
export const DEFAULT_FEATURE_LEVELS = Object.freeze({
  chat: Object.freeze({ group: 'basic', private: 'advanced' }),
  sticker: 'basic',
  vision: 'advanced',
  voice: 'advanced',
  web: 'advanced',
});

/** 没有显式指定档位时，variant 的默认档位（从旧数据迁移时用）。 */
const FALLBACK_LEVEL = Object.freeze({
  chat: 'basic',
  sticker: 'basic',
  vision: 'advanced',
  voice: 'advanced',
  web: 'advanced',
});

/** 文本触发词：只在「自动路由」下使用；管理员显式 /vision 等优先。 */
export const DEFAULT_FEATURE_TRIGGERS = Object.freeze({
  sticker: Object.freeze(['表情包', '斗图', '贴纸']),
  vision: Object.freeze(['看图', '这张图', '图里', '图片里', '截图', '照片']),
  voice: Object.freeze(['语音', '读出来', '念一下', '发条语音', '说句话']),
  web: Object.freeze(['搜索', '搜一下', '搜一搜', '联网', '上网', '查一下', '查一查', '最新', '翻译', '新闻']),
});

/**
 * 归一化 config.json 的 `dsh.features` 段。
 *
 * 配置示例（全部可省略，省略即用这里的默认值）：
 *
 *   "features": {
 *     "enabled": true,
 *     "explicitCommands": true,
 *     "proactiveFeature": "web",
 *     "models": {
 *       "chat": { "group": "basic", "private": "advanced" },
 *       "sticker": "basic",
 *       "vision": "advanced",
 *       "voice": "advanced",
 *       "web": "advanced"
 *     },
 *     "triggers": {
 *       "sticker": ["表情包", "斗图"],
 *       "vision": ["看图", "截图"],
 *       "voice": ["语音", "念一下"],
 *       "web": ["搜索", "查一下", "翻译"]
 *     }
 *   }
 *
 * 非法值一律回退默认（config.json 是用户可编辑的，不能因为手滑把路由弄成
 * 无条件进阶、或把某个功能彻底关死却没人知道）。
 */
export function normalizeFeatureSessions(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const modelsRaw = src.models && typeof src.models === 'object' && !Array.isArray(src.models) ? src.models : {};
  const models = {};
  for (const feature of FEATURES) {
    const fallback = DEFAULT_FEATURE_LEVELS[feature];
    const value = modelsRaw[feature];
    if (feature === 'chat') {
      // chat 支持两种写法：字符串（两档相同）或 { group, private }
      const group = normalizeLevel(
        (value && typeof value === 'object' && !Array.isArray(value) ? value.group : value),
        fallback.group,
      );
      const priv = normalizeLevel(
        (value && typeof value === 'object' && !Array.isArray(value) ? value.private : value),
        fallback.private,
      );
      models.chat = { group, private: priv };
    } else {
      // false / 'off' = 关闭该功能域（路由会回退到 chat）
      models[feature] = value === false || value === 'off' ? 'off' : normalizeLevel(value, fallback);
    }
  }
  const triggersRaw = src.triggers && typeof src.triggers === 'object' && !Array.isArray(src.triggers) ? src.triggers : {};
  const triggers = {};
  for (const feature of ['sticker', 'vision', 'voice', 'web']) {
    const list = triggersRaw[feature];
    if (Array.isArray(list)) {
      triggers[feature] = [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, 40);
    } else {
      triggers[feature] = [...DEFAULT_FEATURE_TRIGGERS[feature]];
    }
  }
  const proactiveRaw = String(src.proactiveFeature ?? 'web').trim();
  const proactiveFeature = FEATURES.includes(proactiveRaw) || proactiveRaw === '' || proactiveRaw === 'off'
    ? (proactiveRaw === 'off' ? '' : proactiveRaw)
    : 'web';
  return {
    enabled: src.enabled !== false,
    // 显式命令默认开：管理员发 /vision 等时强制走对应会话。
    explicitCommands: src.explicitCommands !== false,
    // 冷场主动冒泡默认走联网会话：它既能搜索热点，也有完整对话工具。
    proactiveFeature,
    models,
    triggers,
  };
}

function normalizeLevel(value, fallback) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'basic' || text === 'advanced') return text;
  return fallback;
}

/** `basic` / `advanced` / `chat:basic` / `vision:advanced` → `feature:level`。 */
export function normalizeVariant(raw) {
  if (raw === 'basic') return 'chat:basic';
  if (raw === 'advanced') return 'chat:advanced';
  const text = String(raw ?? '').trim().toLowerCase();
  const idx = text.indexOf(':');
  if (idx > 0) {
    const feature = text.slice(0, idx);
    if (FEATURES.includes(feature)) {
      const level = text.slice(idx + 1);
      return `${feature}:${normalizeLevel(level, FALLBACK_LEVEL[feature])}`;
    }
  }
  if (FEATURES.includes(text)) return `${text}:${FALLBACK_LEVEL[text]}`;
  return 'chat:basic';
}

export function featureOfVariant(raw) {
  return normalizeVariant(raw).split(':')[0];
}

export function levelOfVariant(raw) {
  return normalizeVariant(raw).split(':')[1];
}

export function variantOf(feature, level) {
  const f = FEATURES.includes(String(feature)) ? String(feature) : 'chat';
  return `${f}:${normalizeLevel(level, FALLBACK_LEVEL[f])}`;
}

/** 该功能域是否被配置关闭（models.<feature> === 'off'）。 */
export function isFeatureEnabled(config, feature) {
  const cfg = config || normalizeFeatureSessions({});
  if (!FEATURES.includes(feature)) return false;
  if (feature === 'chat') return true;
  return cfg.models?.[feature] !== 'off';
}

/** 按功能域取模型档位（chat 再区分群聊/私聊）。 */
export function modelLevelForFeature(config, feature, isGroup) {
  const cfg = config || normalizeFeatureSessions({});
  if (feature === 'chat') {
    return isGroup ? (cfg.models?.chat?.group || 'basic') : (cfg.models?.chat?.private || 'advanced');
  }
  const level = cfg.models?.[feature];
  return level === 'advanced' ? 'advanced' : 'basic';
}

// 文件段里只有这些扩展名才当"图"进看图路；其余文件正文在入站时已提取成 fileText，
// 进 chat 会话就能读到，没必要占一个看图回合（2026-11-01：`[文件]` 曾被一律塞给 vision）。
const VISION_FILE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i;

function isVisionFile(entry) {
  const name = String(entry?.name ?? entry?.fileName ?? entry?.filename ?? '');
  return VISION_FILE_EXT_RE.test(name.trim());
}

/**
 * 从媒体列表判断功能域：
 *   · 表情/贴纸/emoji → sticker
 *   · 图片/视频 → vision；文件（kind:'file'）只有图片类扩展名才算图，
 *     其余文件正文已在入站时提取成 fileText，交回 chat 处理
 * 注意顺序：表情优先于图片（QQ 里"表情"常被当成 image 段，但 kind 已区分）。
 */
export function detectFeatureFromMedia(mediaList) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const kinds = list.map((m) => String(m?.kind || m?.type || '').toLowerCase());
  if (kinds.some((k) => k === 'face' || k === 'mface' || k === 'emoji' || k === 'sticker')) return 'sticker';
  if (kinds.some((k) => k === 'image' || k === 'video')) return 'vision';
  if (list.some((m) => {
    const kind = String(m?.kind || m?.type || '').toLowerCase();
    return kind === 'file' && isVisionFile(m);
  })) return 'vision';
  return null;
}

/**
 * 从文本里判断功能域。按 sticker → vision → voice → web 的顺序匹配，
 * 与旧 bridge 的优先级一致（"发个表情包" 归表情包，而不是联网/看图）。
 */
export function detectFeatureFromText(text, triggers) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  const table = triggers && typeof triggers === 'object' ? triggers : DEFAULT_FEATURE_TRIGGERS;
  for (const feature of ['sticker', 'vision', 'voice', 'web']) {
    const list = Array.isArray(table[feature]) ? table[feature] : [];
    if (list.some((keyword) => keyword && t.includes(keyword))) return feature;
    if (feature === 'web' && /https?:\/\//i.test(t)) return 'web';
  }
  return null;
}

/**
 * 路由决策。
 *
 * 输入都是普通值（bridge 负责取最近一条未读/媒体/唤醒原因）：
 *   key / text / mediaList / wakeReason / forcedFeature /
 *   isGroup / routingMode('auto'|'basic'|'advanced') / forceAdvanced /
 *   features（normalizeFeatureSessions 的结果）
 *
 * 输出 { feature, level, variant, reason }。
 *
 * 优先级：
 *   1. 显式指定（/vision、上一条 /voice 的 TTL 覆盖）—— 管理员说了算；
 *   2. 冷场主动冒泡（proactiveCheck）→ 配置的 proactiveFeature（默认 web）；
 *   3. 媒体：表情/贴纸 → sticker；图片/视频/文件 → vision；
 *   4. 文本关键词：sticker → vision → voice → web；
 *   5. 兜底 chat：群聊基础 / 私聊进阶。
 * 全局 dsh.routing.mode（basic/advanced）只覆盖 **chat**：功能域模型是固定的，
 * 否则"表情包固定基础"这类需求会被全局开关悄悄改掉。
 */
export function routeFeature(input = {}) {
  const features = input.features || normalizeFeatureSessions({});
  const isGroup = input.isGroup === true;
  const routingMode = input.routingMode === 'basic' || input.routingMode === 'advanced' ? input.routingMode : 'auto';

  // 功能会话关闭：保持旧的单会话/单档位行为（回滚开关）。
  if (!features.enabled) {
    const level = routingMode === 'advanced' ? 'advanced' : 'basic';
    return { feature: 'chat', level, variant: `chat:${level}`, reason: 'features-disabled' };
  }

  let feature = 'chat';
  let reason = 'default-chat';
  const forced = String(input.forcedFeature ?? '').trim();
  if (forced && FEATURES.includes(forced) && isFeatureEnabled(features, forced)) {
    feature = forced;
    reason = 'explicit';
  } else if (input.wakeReason === 'proactiveCheck' && features.proactiveFeature
    && isFeatureEnabled(features, features.proactiveFeature)) {
    feature = features.proactiveFeature;
    reason = 'proactive';
  } else {
    const byMedia = detectFeatureFromMedia(input.mediaList);
    const byText = detectFeatureFromText(input.text, features.triggers);
    const candidate = byMedia || byText;
    if (candidate && isFeatureEnabled(features, candidate)) {
      feature = candidate;
      reason = byMedia ? 'media' : 'keyword';
    }
  }

  let level = modelLevelForFeature(features, feature, isGroup);
  // 全局档位开关只对 chat 生效；功能域档位固定（需求：表情包固定基础等）。
  if (feature === 'chat' && routingMode !== 'auto') level = routingMode;
  // WorkBuddy 上游故障窗口：所有回合临时切进阶（否则基础网关会把每个回合拖到超时）。
  if (input.forceAdvanced === true && level !== 'advanced') level = 'advanced';

  return { feature, level, variant: `${feature}:${level}`, reason };
}

/** 媒体的 kind 列表（保留顺序，便于日志一眼看出"为什么进看图"）。 */
export function mediaKindsOf(mediaList) {
  return (Array.isArray(mediaList) ? mediaList : [])
    .map((m) => String(m?.kind || m?.type || '').toLowerCase())
    .filter(Boolean);
}

/**
 * 把「已经投给模型看过」的消息从未读里挑出来（纯函数）。
 *
 * 为什么需要：分路投递时每条 lane 的 readThroughSeq 只能推进到「自己这组连续看到的地方」，
 * 中间被别的 lane 带走读过的消息会留在未读里（2026-10-31 群 100000004 实证：seq 117/118/122
 * 在 16:23 投过，17:06 又整组重投一遍，还把后面的文字一起拖进看图路）。
 * 这里只做判定，清理动作由 bridge 执行。
 *
 * @param {Array<{seq:number}>} messages 未读列表
 * @param {Iterable<number>|Set<number>} deliveredSeqs 已投递过的 seq 集合
 * @returns {{ live: Array, dupes: Array }} live=该投的，dupes=投过又复活的
 */
export function partitionDeliveredSeqs(messages, deliveredSeqs) {
  const seen = deliveredSeqs instanceof Set
    ? deliveredSeqs
    : new Set(Array.isArray(deliveredSeqs) ? deliveredSeqs : []);
  const live = [];
  const dupes = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message && Number.isSafeInteger(message.seq) && seen.has(message.seq)) dupes.push(message);
    else live.push(message);
  }
  return { live, dupes };
}

/**
 * 把一批消息按上限切成若干块（纯函数）。
 *
 * 为什么需要：分路投递原来遇到「未读 > maxMessages」就整批回退成单回合，
 * 于是这次请求又变成「按最新一条判定」——图多的批次会把一圈文字拖进看图路。
 * 现在改成按块投，每块都仍按单条判定，块与块之间由 bridge 串行投递。
 *
 * @param {Array} messages 未读消息（按 seq 升序）
 * @param {number} size 每块最多几条
 * @param {number} maxChunks 本次最多投几块，剩下的留在未读里等下一轮
 * @returns {{ batches: Array<Array>, dropped: number }}
 */
export function chunkMessagesForDelivery(messages, size, maxChunks = 3) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Math.max(1, Number(size) || 10);
  const cap = Math.max(1, Number(maxChunks) || 3);
  const batches = [];
  for (let i = 0; i < list.length && batches.length < cap; i += limit) {
    batches.push(list.slice(i, i + limit));
  }
  const delivered = batches.reduce((sum, batch) => sum + batch.length, 0);
  return { batches, dropped: Math.max(0, list.length - delivered) };
}

/**
 * 逐条消息路由：把一批未读拆成「每条消息进哪个功能会话」。
 *
 * 与 routeFeature 的区别：每条消息**只用自己的文本/媒体**判定，禁止拿整批里最新
 * 一条替所有消息做决定（2026-10-28 用户需求：按单条判，别整批算）。
 *
 * 纯函数，不读盘、不联网；bridge 负责取未读、执行投递、写日志。
 *
 * messages: [{ seq, messageId, text, media, sender, ... }]（bridge 的未读结构）
 * options:
 *   features        normalizeFeatureSessions() 结果
 *   isGroup         是否群聊
 *   routingMode     'auto' | 'basic' | 'advanced'（只影响 chat 档位）
 *   forceAdvanced   WorkBuddy 故障窗口
 *   wakeReason      本次唤醒原因（proactiveCheck 会改变路由）
 *   forcedFeature   显式 /vision 等覆盖（只作用于 forcedSeq 那条）
 *   forcedSeq       被覆盖消息的本地 seq
 *
 * 返回 [{ seq, messageId, feature, level, variant, reason, mediaKinds, text, sender }]
 * 说明：
 *   · 跳过 isSelf 的消息；
 *   · feature 相关配置关闭（models.feature==='off'）时 routeFeature 会回退 chat；
 *   · features.enabled=false 时全部回退 chat（与旧单会话行为一致，可整体回滚）。
 */
export function planMessageRoutes(messages, options = {}) {
  const features = options.features || normalizeFeatureSessions({});
  const isGroup = options.isGroup === true;
  const routingMode = options.routingMode === 'basic' || options.routingMode === 'advanced'
    ? options.routingMode
    : 'auto';
  const forcedFeature = String(options.forcedFeature ?? '').trim();
  const forcedSeq = Number.isSafeInteger(options.forcedSeq) ? options.forcedSeq : null;
  const list = Array.isArray(messages) ? messages : [];
  const decisions = [];
  for (const message of list) {
    if (!message || message.isSelf) continue;
    const seq = Number.isSafeInteger(message.seq) ? message.seq : null;
    if (seq === null) continue;
    const text = String(message.text ?? '');
    const mediaList = Array.isArray(message.media) ? message.media : [];
    const forced = forcedFeature && forcedSeq === seq ? forcedFeature : '';
    const decision = routeFeature({
      text,
      mediaList,
      wakeReason: options.wakeReason || '',
      forcedFeature: forced,
      isGroup,
      routingMode,
      forceAdvanced: options.forceAdvanced === true,
      features,
    });
    decisions.push({
      seq,
      messageId: message.messageId ?? null,
      feature: decision.feature,
      level: decision.level,
      variant: decision.variant,
      reason: decision.reason,
      mediaKinds: mediaKindsOf(mediaList),
      text,
      sender: String(message.sender ?? message.nickname ?? ''),
    });
  }
  return decisions;
}

// ── 显式命令 ────────────────────────────────────────────────────────────────

const FEATURE_COMMAND_ALIASES = Object.freeze({
  chat: 'chat', 聊天: 'chat', 对话: 'chat',
  sticker: 'sticker', 表情: 'sticker', 表情包: 'sticker', 斗图: 'sticker',
  vision: 'vision', 看图: 'vision', 图片: 'vision', 图: 'vision',
  voice: 'voice', 语音: 'voice', 说话: 'voice',
  web: 'web', 联网: 'web', 搜索: 'web',
  auto: '', 自动: '',
});

/**
 * 解析 `/vision`、`/vision 这张图里是什么`、`/表情`、`/auto`。
 *
 * 返回 null 表示"不是功能命令"（交给其它 / 命令处理）；否则：
 *   { feature: 'vision'|...|'' , command: 原词, rest: 剩余文字, standalone: 有没有剩余文字 }
 * feature='' 表示 `/auto`：清除强制覆盖、恢复自动路由。
 *
 * 注意：只认**整条消息的开头**，避免把正文里的 "/vision" 当命令。
 */
export function parseFeatureCommand(text) {
  const raw = String(text ?? '');
  const m = /^\s*\/([A-Za-z\u4e00-\u9fa5]+)(?:[ \t]+([\s\S]*))?$/.exec(raw);
  if (!m) return null;
  const word = m[1];
  const key = word.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(FEATURE_COMMAND_ALIASES, key)) return null;
  const rest = String(m[2] ?? '').trim();
  return {
    feature: FEATURE_COMMAND_ALIASES[key],
    command: word,
    rest,
    standalone: rest.length === 0,
  };
}

// ── 工具面 ──────────────────────────────────────────────────────────────────

// bridge 内部的工具开关名（v2ToolEnabled(flag, key) 的 flag），
// 与 config.socialV2.tools[flag] 以及 MCP 工具一一对应。

/**
 * 对话核心工具（2026-10-28 收窄）：只保留「能收发消息、能收尾一个回合」的最小集合。
 *
 * 成员列表 / 历史消息 / 消息详情 / 社交状态这些"读取型"工具不再算基础工具：
 * bridge 每回合已经把最近消息快照注入 prompt，功能会话不需要再主动拉取；
 * 它们从 chat 移除后，vision/voice/web 也一并改用本集合，避免「看图会话顺手
 * 翻成员列表」这种跨功能调用。
 *
 * 注意：markRead / setWakeConfig 是所有功能会话的收尾必需项，不能删。
 */
const CORE_FLAGS = Object.freeze([
  'getPrompt', 'getUnread', 'markRead', 'setWakeConfig', 'planWake',
  'sendMessage', 'sendBurst', 'reply', 'sendGroup', 'sendPrivate', 'waitMessages',
  // 共用小黑板：每套功能会话都要能读（回答前先扫一眼另一路看到了什么）和写
  // （把本路刚确认的事实留给别的会话）。它是跨会话共享面，不属于任何单一功能。
  'board',
]);

/** 对话类附加工具：记忆 / 黑话 / 拍一拍 / 反馈。 */
const CONVERSATION_EXTRAS = Object.freeze(['sendPoke', 'feedback', 'memory', 'slangQuery', 'slangSubmit']);

/** 表情包工具。 */
const STICKER_FLAGS = Object.freeze([
  'sendSticker', 'listStickers', 'getStickerImage', 'collectSticker', 'stickerNote',
  'setStickerRemark', 'getSelfImage',
]);

/**
 * 看图工具：完整看图能力（读图 + 合并转发）。
 *
 * 注意和下面的 CHAT_IMAGE_FLAGS 区分：`getForwardMsg` 会读取整段合并转发里的
 * 文字/嵌套转发，属于「扩大读取面」的能力，只留给 vision 会话；chat 只开
 * 「按消息 id 读一张图」的只读小口子。
 */
const VISION_FLAGS = Object.freeze(['getImages', 'getForwardMsg']);

/**
 * 聊天会话的「只读看图」小口子（2026-10-26）。
 *
 * 背景：图片消息默认仍按路由进 vision 会话（见 detectFeatureFromMedia），但聊天
 * 会话里经常只想瞄一眼刚才那张图（群友发的表情/截图），不值得为它整体切会话。
 * 因此 chat 只多给 **qq_get_message_images** 这一个只读工具：
 *   · 只读指定 messageId 的图片/表情，图片以图像内容回到模型上下文；
 *   · 不下载、不转发、不发送、不改会话/唤醒状态；
 *   · 合并转发（getForwardMsg）和表情包/语音/联网仍留在各自功能会话。
 * 文案侧由 buildFeatureHint('chat') 告诉模型怎么用；硬边界仍是
 * v2ToolEnabled('getImages') + qq-tool-restrict 守卫（两者都从本文件取政策）。
 */
const CHAT_IMAGE_FLAGS = Object.freeze(['getImages']);

/**
 * 聊天会话的「配表情」小口子（2026-10-30）。
 *
 * 背景：私聊里他明确要「表情和文字掺着发」，但 chat 会话只能打字，每次发图都得
 * 整轮切到 sticker 会话，切过去就接不上话了。折中：chat 多给四个**表情相关**工具：
 *   · listStickers / getStickerImage —— 选图前先看自己有哪张（只读）；
 *   · sendSticker —— 单独一个气泡发图，不能带字（工具本身就不支持）；
 *   · stickerNote —— 给新图记本地含义，方便下次挑；
 *   · collectSticker —— 2026-10-30 23:46 owner 明确要求「自己能收藏喜欢的表情」，
 *     于是把「偷图」也放进聊天回合：看到喜欢的直接收进 QQ 收藏夹，不用切会话。
 * 仍然不给 setStickerRemark（改官方备注属于「改账号备注」，留在 sticker 会话里做）。
 */
const CHAT_STICKER_FLAGS = Object.freeze(['listStickers', 'sendSticker', 'getStickerImage', 'stickerNote', 'collectSticker']);

/**
 * 聊天会话的工具面（2026-10-28 收窄）。
 *
 * 背景：功能会话隔离此前只在执行期拦截（qq-tool-restrict 的 guard），chat 会话
 * 的工具清单里仍能看到成员列表/历史消息/详情等"读取型"工具，机器人会顺手翻成员
 * 列表、重读历史，用户感知为「工具分开没有生效」。
 *
 * 这些信息 bridge 每回合都以最近消息快照的形式注入 prompt，聊天回合不需要再主动
 * 拉取；因此从 chat 工具面移除 getGroupMembers / getActiveMembers / getRecent /
 * getMyRecent / getMessageDetail / socialState，只保留「聊完一个回合必需的」收发
 * 消息/引用/已读/等待/唤醒 + 记忆/黑话/拍一拍/反馈 + 只读看图小口子。
 *
 * 该清单同时驱动三处：bridge 的 v2ToolEnabled、qq-tool-restrict 的执行期门禁、
 * MCP 工具清单的 per-session schema 隐藏（见 qq-tool-restrict 的 schema-restrict）。
 */
const CHAT_FLAGS = Object.freeze([
  'getPrompt', 'getUnread', 'markRead', 'setWakeConfig', 'planWake',
  'sendMessage', 'sendBurst', 'reply', 'sendGroup', 'sendPrivate', 'waitMessages',
  // 小黑板是跨会话共享的：聊天这路既要读「看图那路」写下的天气，也要把自己
  // 确认的约定写回去，否则用户会看到「两路各说各的」。
  'board',
  // v1.8 试点：主对话可以只交任务卡给「检索子智能体」，自己只负责收/分/发。
  // 只有聊天会话能派活；表情包/看图/语音子会话不参与调度。
  'delegate',
  // 2026-11-18 联调：私聊里用户让“找上次说的笔记”，chat 看不到 qq_search_history，
  // 只能翻记忆库（mcp__memory__search）→ 找不到。回忆检索对私聊同样必要，加入 chat 域。
  'searchHistory',
  ...CONVERSATION_EXTRAS, ...CHAT_IMAGE_FLAGS, ...CHAT_STICKER_FLAGS,
]);

/**
 * 回忆检索（2026-11-17）：在当前会话的历史归档里按关键词/时间/发送者找原话。
 *
 * 2026-11-18 起同时放给 **chat 与 web**：
 *   · 私聊里「你还记得…/上次说的笔记」是最常见场景，联调时 chat 看不到它，
 *     只能翻记忆库 → 找不到；
 *   · 群聊仍由普通提示与快照兜底，模型不会每轮都搜（描述里明确“只在需要时用”）；
 *   · closed-agent（管理员私聊）不启用功能会话，不会走 schema 收窄，仍能看到它；
 *   · 其它域（sticker/vision/voice）任务单一，不给。
 * 执行期仍由 v2ToolEnabled('searchHistory') + qq-tool-restrict 守卫双重把关。
 */
const HISTORY_FLAGS = Object.freeze(['searchHistory']);

/**
 * 出图（2026-11-17）：生成一张图并作为图片消息发到当前会话。
 * 只放给 web 域（联网/进阶）与管理员回合：出图慢、贵，不该被普通聊天顺手触发。
 */
const IMAGE_GEN_FLAGS = Object.freeze(['generateImage']);

/** 语音工具。 */
const VOICE_FLAGS = Object.freeze(['sendVoice', 'listVoices']);

/**
 * 五套功能会话各自的工具面。
 *
 * 设计取舍：
 *   · chat        = 对话基础 + 记忆/黑话/拍一拍/反馈 + **只读看图口子**（只给
 *                   qq_get_message_images，不给合并转发/表情包/语音/联网）。
 *   · sticker     = 表情包 + 最小收尾工具（读/发/等/已读/唤醒）。需求里的"只放
 *                   表情包工具"如果做到字面意义（连 mark_read 都不给），这个会话
 *                   永远无法完成回合收尾，会卡死唤醒循环；所以保留最小收尾集合，
 *                   并在提示词里要求它只发表情/极短文字。
 *   · vision      = 对话 + 看图/转发（完整看图能力）。
 *   · voice       = 对话 + TTS/语音库。
 *   · web         = 对话 + 联网（web 搜索走另一个 MCP，见 qq-tool-restrict 守卫）
 *                   + 和 chat 一样的**只读看图**口子：冷场主动冒泡默认落在联网会话，
 *                   对方常在那一轮甩表情/截图回来，没这个口子就只能说「看不见图」。
 */
export const FEATURE_TOOL_FLAGS = Object.freeze({
  chat: Object.freeze([...CHAT_FLAGS]),
  // 2026-10-28：表情包会话也收窄到核心对话工具 —— 快照由 bridge 每回合注入，
  // 读历史/成员/详情/社交状态都不再是收尾必需；这样这六个读取工具在所有 feature
  // 里都被移除，apply 期才能把它们当作「全局无用工具」在第一回合就隐藏。
  sticker: Object.freeze([...CORE_FLAGS, ...STICKER_FLAGS]),
  vision: Object.freeze([...CORE_FLAGS, ...CONVERSATION_EXTRAS, ...VISION_FLAGS]),
  voice: Object.freeze([...CORE_FLAGS, ...CONVERSATION_EXTRAS, ...VOICE_FLAGS]),
  web: Object.freeze([...CORE_FLAGS, ...CONVERSATION_EXTRAS, ...CHAT_IMAGE_FLAGS, ...HISTORY_FLAGS, ...IMAGE_GEN_FLAGS]),
});

const FEATURE_FLAG_SETS = Object.freeze(Object.fromEntries(
  Object.entries(FEATURE_TOOL_FLAGS).map(([feature, flags]) => [feature, new Set(flags)]),
));

/** 该功能会话是否允许某个 bridge 工具开关。未知 feature 回退 chat。 */
export function featureAllowsFlag(feature, flag) {
  const set = FEATURE_FLAG_SETS[feature] || FEATURE_FLAG_SETS.chat;
  return set.has(String(flag ?? ''));
}

/** 某功能会话的完整工具开关清单（供控制台/自检展示）。 */
export function toolFlagsForFeature(feature) {
  return [...(FEATURE_TOOL_FLAGS[feature] || FEATURE_TOOL_FLAGS.chat)];
}

// ── MCP 工具名映射（与 qq-tool-restrict 守卫共用同一份口径）────────────────

/** bridge 工具开关 → MCP 工具名（一个开关可能对应多个工具名）。 */
export const FLAG_TO_MCP_TOOLS = Object.freeze({
  getPrompt: ['qq_get_prompt'],
  getUnread: ['qq_get_unread_messages'],
  getRecent: ['qq_get_recent_messages'],
  socialState: ['qq_social_state'],
  markRead: ['qq_mark_read'],
  setWakeConfig: ['qq_set_wake_config'],
  planWake: ['qq_plan_wake'],
  sendMessage: ['qq_send_message'],
  sendBurst: ['qq_send_burst'],
  reply: ['qq_reply'],
  sendGroup: ['qq_send_group_message'],
  sendPrivate: ['qq_send_private_message'],
  waitMessages: ['qq_wait_for_messages'],
  searchHistory: ['qq_search_history'],
  getMessageDetail: ['qq_get_message_detail'],
  getActiveMembers: ['qq_get_active_members'],
  getGroupMembers: ['qq_get_group_members'],
  getMyRecent: ['qq_get_my_recent_messages'],
  sendPoke: ['qq_send_poke'],
  feedback: ['qq_report_feedback'],
  memory: ['qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear'],
  delegate: ['qq_delegate_search', 'qq_delegate_image', 'qq_delegate_sticker'],
  board: ['qq_board_read', 'qq_board_write', 'qq_board_forget'],
  slangQuery: ['qq_slang_query'],
  slangSubmit: ['qq_slang_submit'],
  getImages: ['qq_get_message_images'],
  getForwardMsg: ['qq_get_forward_msg'],
  listStickers: ['qq_list_stickers'],
  sendSticker: ['qq_send_sticker'],
  getStickerImage: ['qq_get_sticker_image'],
  collectSticker: ['qq_collect_sticker'],
  stickerNote: ['qq_sticker_note'],
  setStickerRemark: ['qq_set_sticker_remark'],
  getSelfImage: ['qq_get_self_image'],
  sendVoice: ['qq_send_tts', 'qq_send_voice'],
  listVoices: ['qq_list_voices'],
  generateImage: ['qq_generate_image'],
});

/**
 * 低频工具：**保留注册与执行期权限**，但每回合从 schema 隐藏（schema-only）。
 *
 * 为什么单独列：`qq_send_message` 已覆盖群/私聊单条发送，`qq_memory_append/query`
 * 覆盖日常记忆读写；两个旧发送入口与两个记忆清理工具实测 6 天 0~1 次调用，
 * 却常驻每个功能域约 4.5KB（≈1.5k tokens/次）。从 schema 隐藏后模型看不到、
 * 也就不会误调；需要时仍可按名字显式调用（工具仍在 MCP server 注册，执行期
 * flag 与 guard 都没变）。
 */
export const SCHEMA_ONLY_HIDDEN_MCP_TOOLS = Object.freeze([
  'qq_send_group_message',
  'qq_send_private_message',
  'qq_memory_clear',
  'qq_memory_remove',
]);

/** 只读、无副作用、不涉及发送/媒体/语音的通用工具：所有功能会话都放行。 */
export const ALWAYS_ALLOWED_MCP_TOOLS = Object.freeze([
  'qq_status', 'qq_list_groups', 'qq_get_group_history',
]);

/** feature → 允许的 MCP 工具名集合（守卫用；与 bridge 的 flag 策略同源生成）。 */
export function mcpToolNamesForFeature(feature) {
  const flags = FEATURE_TOOL_FLAGS[feature] || FEATURE_TOOL_FLAGS.chat;
  const names = new Set(ALWAYS_ALLOWED_MCP_TOOLS);
  for (const flag of flags) {
    for (const name of FLAG_TO_MCP_TOOLS[flag] || []) names.add(name);
  }
  return names;
}

/** 全部 feature 的 MCP 工具策略快照，便于守卫/测试序列化比对。 */
export function mcpToolPolicySnapshot() {
  return Object.fromEntries(FEATURES.map((feature) => [feature, [...mcpToolNamesForFeature(feature)].sort()]));
}

// ── 模型解析 ────────────────────────────────────────────────────────────────

/**
 * 把 (feature, level) 落成具体模型：
 *   level=advanced → config.dsh.advanced（未配置/关闭时回退基础）
 *   level=basic    → config.dsh.provider/model
 *
 * 返回 { level, advanced, provider, model, reasoningEffort }。
 * reasoningEffort='auto' 由调用方决定是否省略该参数（部分网关不支持）。
 */
export function resolveFeatureModel({ dsh, level } = {}) {
  const base = dsh && typeof dsh === 'object' ? dsh : {};
  const advancedCfg = base.advanced && typeof base.advanced === 'object' && base.advanced.enabled !== false
    ? base.advanced
    : null;
  const useAdvanced = level === 'advanced' && advancedCfg
    && (advancedCfg.provider || advancedCfg.model);
  const source = useAdvanced ? advancedCfg : base;
  return {
    level: useAdvanced ? 'advanced' : 'basic',
    advanced: Boolean(useAdvanced),
    provider: String(source?.provider || 'deepseek-official'),
    model: String(source?.model || 'deepseek-flash'),
    reasoningEffort: String(source?.reasoningEffort || 'auto'),
  };
}

// ── 提示词片段 ──────────────────────────────────────────────────────────────

/**
 * 追加到本回合 prompt 末尾的"你现在在哪套功能会话"说明。
 * 历史（最近消息快照/记忆/黑话）由 bridge 统一注入；这里只讲本回合的能力边界，
 * 避免模型在聊天会话里硬调表情包/看图工具、或在表情包会话里长篇大论。
 */
export function buildFeatureHint(feature, level, options = {}) {
  const label = FEATURE_LABELS[feature] || feature;
  const shared = '各功能会话共享同一份最近消息快照 / 记忆 / 黑话库，切换功能不会失忆；但工具调用历史彼此独立。';
  const scoped = '不属于本轮的 qq_*/网页工具会从这一轮的工具清单里隐藏，调用也会被拒绝；即使清单里还看得到旧项，也不要调用。';
  const explicit = options.explicit ? '本轮由管理员显式指定。' : '';
  if (feature === 'sticker') {
    return `\n\n【表情包会话 · 基础模型】${explicit}本回合只处理表情包/斗图：可用工具只有表情包相关（qq_send_sticker / qq_list_stickers / qq_get_sticker_image / qq_collect_sticker / qq_sticker_note 等）+ 最小收尾工具（读消息/发一条短文字/等待/已读/唤醒）。不要长篇大论，也不要用看图/语音/联网工具；${shared}${scoped}`;
  }
  if (feature === 'vision') {
    return `\n\n【看图会话 · 进阶模型】${explicit}本回合可以真的看图：消息带 [图片]/[表情] 时先 qq_get_message_images 取图，[转发消息] 用 qq_get_forward_msg；引用消息形如 [引用 msgId=… 含图N …] 时，把 msgId 传给 qq_get_message_images 就能看引用里的图。看完按语境自然回复，别假装看不见。${shared}${scoped}`;
  }
  if (feature === 'voice') {
    return `\n\n【语音会话 · 进阶模型】${explicit}本回合要开口时调用 qq_send_tts(text=你想说的内容) 生成语音条；也可以 qq_list_voices 看语音库。语音是强表达，长度 1~2 句，别连发、别替代正常文字回复。${shared}${scoped}`;
  }
  if (feature === 'web') {
    return `\n\n【联网会话 · 进阶模型】${explicit}本回合需要实时信息/资料/热点时，用 mcp__web-search-safe__web_search 搜索，必要时 mcp__web-search-safe__web_fetch 读正文；拿到结果再回，别只复述搜索摘要。另有一个**只读看图**小口子 qq_get_message_images（消息快照里某条 hasMedia=true 或带 [图片]/[表情] 而你想看时，传 key、本会话 token、messageId=那条消息的 messageId；引用消息看 [引用 msgId=… 含图N …]，msgId 就是被引用消息的 id，直接传它就能看引用里的图；只读这一张，不下载/不转发/不切会话）。冷场主动冒泡常落在这路，对方甩表情/截图回来时别再说「看不见图」。${shared}${scoped}`;
  }
  if (level === 'advanced') {
    return `\n\n【聊天会话 · 进阶模型】${explicit}本回合以聊天为主：工具面是对话类 + 记忆/黑话/拍一拍/反馈，外加一个**只读看图**小口子 qq_get_message_images（消息快照里某条 hasMedia=true 或带 [图片]/[表情]，而你想看时，用它并传 key、本会话 token、messageId=那条消息的 messageId；**引用消息看 [引用 msgId=… 含图N …]，msgId 就是被引用消息的 id，直接传它就能看引用里的图**；它只读这一张，不下载/不转发/不切会话）。本会话**没有**成员列表查询（qq_get_group_members / qq_get_active_members）、**没有**历史消息拉取（qq_get_recent_messages / qq_get_my_recent_messages / qq_get_message_detail）——需要上下文就看快照。**表情可以自己发**：qq_list_stickers 选一张 → 先用文字说想说的话 → 再单独 qq_send_sticker 发出来（表情是独立气泡，不能带字；别每轮都发，按语境挑）。**看到喜欢的也能自己收**：qq_collect_sticker 把那张收进收藏夹（写的是账号收藏，别刷屏式收藏，挑真喜欢的）。改官方备注（qq_set_sticker_remark）、语音、联网仍走各自功能会话，管理员也可用 /sticker /vision /voice /web 指定。${shared}${scoped}`;
  }
  return `\n\n【聊天会话 · 基础模型】${explicit}本回合以聊天为主：工具面是对话类（读消息/发消息/引用/已读/唤醒/等待/记忆/黑话）+ 一个**只读看图**小口子 qq_get_message_images（消息快照里某条 hasMedia=true 或带 [图片]/[表情]，而你想看时，用它并传 key、本会话 token、messageId=那条消息的 messageId；**引用消息看 [引用 msgId=… 含图N …]，msgId 就是被引用消息的 id，直接传它就能看引用里的图**；它只读这一张，不下载/不转发/不切会话）。本会话**没有**成员列表查询（qq_get_group_members / qq_get_active_members）、**没有**历史消息拉取（qq_get_recent_messages / qq_get_my_recent_messages / qq_get_message_detail）——需要上下文就看快照。**表情可以自己发**：qq_list_stickers 选一张 → 先用文字说想说的话 → 再单独 qq_send_sticker 发出来（独立气泡、不能带字、别每轮都发）；看到喜欢的也能用 qq_collect_sticker 收进收藏。改官方备注（qq_set_sticker_remark）、语音、联网仍走各自功能会话（管理员也可用 /sticker /vision /voice /web 指定）。${shared}${scoped}`;
}
