// 语音入站（别人发来的语音 → 文字）
//
// 现状：bridge.js 里 segmentsToText 对 record 段只产出占位文本「[语音]」，
// 收到的语音不进上下文（README 里也写明了）。NapCat 提供 fetch_ptt_text
// （POST <httpUrl>/fetch_ptt_text，body {message_id}）可以取 QQ 侧的语音
// 转写结果，本模块把「要不要转、怎么清洗、怎么放进 prompt」这几步拆成
// 纯函数，方便单测，也方便 bridge.js 接线。
//
// 本文件零依赖：不读配置、不联网、不 import bridge.js，所有导出都保证
// 不抛异常（脏输入一律降级为安全值）。

/** 转写文本上限：超长截断，防止把 QQ 的异常长文本塞进 prompt。 */
export const PTT_TEXT_MAX = 2000;

/** 有转写结果时，放进上下文的注记前缀。 */
export const PTT_NOTE_PREFIX = '[语音转写]';

/** 没拿到转写结果时的占位注记（与 bridge.js 现有的 [语音] 占位并存）。 */
export const PTT_UNAVAILABLE_NOTE = '[语音，转写不可用]';

/** 各形态下代表「这是一条语音」的媒体种类名（小写比较）。 */
export const VOICE_MEDIA_KINDS = ['record', 'voice', 'audio', 'ptt'];

/** planInboundVoice 默认每轮最多转写几条（防止一轮里连发多条语音把请求打满）。 */
export const DEFAULT_MAX_TRANSCRIBE_PER_TURN = 3;

const VOICE_KIND_SET = new Set(VOICE_MEDIA_KINDS);

/** 把 undefined/null/数字/字符串统一成 trim 过的字符串，其余类型降级为 ''。 */
function asTrimmedString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).trim();
  if (typeof value === 'bigint') return String(value).trim();
  return '';
}

/**
 * 判断一个媒体项是不是语音。
 *
 * 兼容两种形态：字符串（'record' / 'voice'）与 OneBot 段对象
 * （{ type: 'record', data: {...} }）或桥接内部归一化后的媒体对象
 * （{ kind: 'record', ... }）。
 *
 * @param {unknown} media
 * @returns {boolean}
 */
export function isVoiceMedia(media) {
  try {
    if (typeof media === 'string') {
      return VOICE_KIND_SET.has(media.trim().toLowerCase());
    }
    if (!media || typeof media !== 'object') return false;
    for (const key of ['kind', 'type', 'mediaType', 'segType', 'msgType']) {
      const kind = asTrimmedString(media[key]).toLowerCase();
      if (kind && VOICE_KIND_SET.has(kind)) return true;
    }
    return false;
  } catch {
    // 理论上的极端输入（带 getter 的对象等）：不抛，当非语音处理。
    return false;
  }
}

/** 从 fetch_ptt_text 的响应里取原始文本，兼容三种形状。 */
function pickRawPttText(payload) {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  // 直接给 {text} 或 {text: 123}
  if (typeof payload.text === 'string' || typeof payload.text === 'number') {
    return payload.text;
  }
  // NapCat/OneBot 响应原样：{status:'ok', retcode:0, data:{text}}
  const data = payload.data;
  if (data && typeof data === 'object') {
    if (typeof data.text === 'string' || typeof data.text === 'number') {
      return data.text;
    }
  }
  return '';
}

/** 压平换行、合并连续空白、trim、超长截断。 */
function sanitizePttText(raw) {
  const flattened = String(raw)
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[ \u00a0\u3000]{2,}/g, ' ')
    .trim();
  if (!flattened) return '';
  if (flattened.length <= PTT_TEXT_MAX) return flattened;
  const head = flattened.slice(0, PTT_TEXT_MAX - 1).trimEnd();
  return `${head}…`;
}

/**
 * 把 fetch_ptt_text 的响应（或裸文本）归一化成可用的一行转写文本。
 *
 * 支持：
 *   - 裸字符串：'今天降温了'
 *   - { text: '今天降温了' }
 *   - { status:'ok', retcode:0, data:{ text:'今天降温了' } }
 *
 * @param {unknown} payload
 * @returns {string} 清洗后的文本；拿不到/空内容返回 ''
 */
export function normalizePttText(payload) {
  try {
    if (Array.isArray(payload)) {
      // 某些实现把结果放在数组里，取第一条能用的。
      for (const item of payload) {
        const text = normalizePttText(item);
        if (text) return text;
      }
      return '';
    }
    const raw = pickRawPttText(payload);
    if (!raw) return '';
    return sanitizePttText(raw);
  } catch {
    return '';
  }
}

/**
 * 生成入站语音的上下文注记。
 *
 * 有转写 → `[语音转写] <清洗后的文本>`；没有 → `[语音，转写不可用]`。
 * duration 参数只为接口兼容保留，不拼进输出（避免测试/文案随版本漂移）。
 *
 * @param {{text?: unknown, duration?: unknown}|string|null|undefined} input
 * @returns {string}
 */
export function formatVoiceNote(input) {
  try {
    if (typeof input === 'string') {
      const text = normalizePttText(input);
      return text ? `${PTT_NOTE_PREFIX} ${text}` : PTT_UNAVAILABLE_NOTE;
    }
    const record = input && typeof input === 'object' ? input : {};
    const text = normalizePttText(record.text ?? record.transcript ?? '');
    return text ? `${PTT_NOTE_PREFIX} ${text}` : PTT_UNAVAILABLE_NOTE;
  } catch {
    return PTT_UNAVAILABLE_NOTE;
  }
}

/** 校验 message_id：与 bridge.js usableMessageId 同规则（数字/数字串、非 0、安全整数）。 */
function usableMessageId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value !== 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed === 0) return null;
    return parsed;
  }
  return null;
}

/**
 * 构造 fetch_ptt_text 的请求体。
 *
 * 非法/缺失 message_id 返回 null（调用方据此跳过，避免拿空 id 打 NapCat
 * 刷「消息不存在」ERROR 日志，和 bridge.js 现有发送后回读的做法一致）。
 *
 * @param {unknown} messageId
 * @returns {{message_id: string}|null}
 */
export function buildTranscribeBody(messageId) {
  try {
    const usable = usableMessageId(messageId);
    if (usable === null) return null;
    return { message_id: String(usable) };
  } catch {
    return null;
  }
}

/**
 * 在消息对象上找第一个语音媒体段的下标。
 *
 * 依次尝试桥接内部字段（media/mediaList）与 OneBot 原始段数组（message/segments），
 * 取「第一个真的含语音段的数组」里的下标。注意 bridge.js 的 extractMediaFromSegments
 * 目前不产 record 段，所以 media 里有图没语音时还要回退到 message 段数组。
 *
 * @returns {number} 语音段下标；没有语音返回 -1
 */
function findVoiceMediaIndex(message) {
  const candidates = [
    message.media,
    message.mediaList,
    message.media_list,
    message.segments,
    message.message,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const index = candidate.findIndex((item) => isVoiceMedia(item));
    if (index >= 0) return index;
  }
  return -1;
}

/** 数字/数字串 → 数字；否则用 fallback。 */
function numberOr(value, fallback) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fallback;
}

/** 该消息是否已经带过语音注记（转写成功或已确认不可用），避免重复请求。 */
function hasVoiceNote(message) {
  for (const key of ['voiceText', 'voice_text', 'transcript', 'pttText', 'ptt_text']) {
    if (normalizePttText(message[key])) return true;
  }
  for (const key of ['text', 'plain', 'plainText', 'content']) {
    const rendered = message[key];
    if (typeof rendered !== 'string') continue;
    if (rendered.includes(PTT_NOTE_PREFIX) || rendered.includes(PTT_UNAVAILABLE_NOTE)) {
      return true;
    }
  }
  return false;
}

/**
 * 规划本轮要转写哪些入站语音。
 *
 * 只挑：带语音媒体段、messageId 合法、不是自己发的、还没有语音注记的消息，
 * 每条取第一个语音段的 mediaIndex，最多 maxPerTurn 条。
 *
 * 消息对象支持字段（宽松）：
 *   - seq / message_seq / messageSeq：消息序号（缺省用数组下标）
 *   - messageId / message_id / msgId / msg_id：消息 id
 *   - media / mediaList / segments / message：媒体段数组
 *   - text / plain / plainText / content：已渲染文本
 *   - voiceText / transcript / pttText：已有转写
 *   - isSelf / self：是否自己发的（自己发的语音 QQ 侧没有转写，跳过）
 *
 * @param {unknown} messages
 * @param {{enabled?: boolean, maxPerTurn?: number}} [options]
 * @returns {Array<{seq: number, messageId: string, mediaIndex: number}>}
 */
export function planInboundVoice(messages, options = {}) {
  try {
    const opts = options && typeof options === 'object' ? options : {};
    if (opts.enabled === false) return [];
    if (!Array.isArray(messages)) return [];

    let max = DEFAULT_MAX_TRANSCRIBE_PER_TURN;
    if (Number.isSafeInteger(opts.maxPerTurn)) max = opts.maxPerTurn;
    // 显式 ≤0：本轮关闭（区别于「没配」的默认 3）。
    if (max <= 0) return [];

    const plan = [];
    for (let index = 0; index < messages.length; index += 1) {
      if (plan.length >= max) break;
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      if (message.isSelf === true || message.self === true) continue;

      const messageId = usableMessageId(
        message.messageId ?? message.message_id ?? message.msgId ?? message.msg_id,
      );
      if (messageId === null) continue;

      const mediaIndex = findVoiceMediaIndex(message);
      if (mediaIndex < 0) continue;

      if (hasVoiceNote(message)) continue;

      const seq = numberOr(
        message.seq ?? message.message_seq ?? message.messageSeq,
        index,
      );
      plan.push({ seq, messageId: String(messageId), mediaIndex });
    }
    return plan;
  } catch {
    return [];
  }
}
