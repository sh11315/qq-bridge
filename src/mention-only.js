// 「仅@」模式（内部名 mention-only）的纯函数判定。
//
// 行为约定：
//   · 群聊：只有满足下面任意一条才处理该消息 ——
//       ① 消息段里有 `type:'at'` 且 `data.qq` 等于机器人自己的 QQ；
//       ② 引用/回复的是机器人自己的消息；
//       ③ 当前消息自己的文字里出现机器人昵称/别名
//          （昵称来自网关登录信息、角色名来自 state/current-role.json，
//           操作者还可以在 config.json 的 mentionOnly.aliases 里补；
//           都取不到时兜底「星辰」「小鲸鱼」）。
//   · 私聊：不受影响，与 chat 一样按白名单照常处理。
//
// 这个文件**只做纯判定**：不读 config、不访问网络、不打日志、不 await。
// 这样判定可以直接单测（scripts/test-mention-only.mjs），也避免把
// 「怎么拿机器人 QQ / 昵称」这类 I/O 混进匹配逻辑里。

/** 模式内部值（与 state/mode.json、DSH 设置里的写法一致）。 */
export const MENTION_ONLY_MODE = 'mention-only';

/**
 * 取不到昵称/角色时的兜底别名。
 *
 * 本机实际值：网关登录昵称是「星辰」，默认角色名是「小鲸鱼」。
 * 兜底只影响「叫名字」这一条，@ 与引用判定不依赖它。
 */
export const FALLBACK_MENTION_ALIASES = Object.freeze(['星辰', '小鲸鱼']);

/** 别名数量上限：防止配置写成超长列表拖慢每条群消息的匹配。 */
const MAX_ALIASES = 32;

/**
 * 归一化别名列表：接受字符串或数组，去空白、去空串、按大小写不敏感去重。
 * 返回的是保留原始大小写的数组（展示/日志用），匹配时统一转小写。
 */
export function normalizeMentionAliases(value) {
  const input = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const alias = String(item ?? '').trim();
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

/**
 * 组装本次判定要用的别名表。
 *
 * 顺序：网关昵称 → 当前角色名 → 操作者配置 → 兜底。
 * 后面的重复项会被 normalizeMentionAliases 去掉，所以顺序只影响「日志里
 * 报告命中的是哪个别名」，不影响是否命中。
 *
 * @param {object} [input]
 * @param {string|string[]} [input.configured] config.json 的 mentionOnly.aliases
 * @param {string|null} [input.roleName] state/current-role.json 里的角色名
 * @param {string|null} [input.nickname] 网关 get_login_info 返回的昵称
 * @returns {string[]}
 */
export function buildMentionAliases({ configured, roleName, nickname } = {}) {
  return normalizeMentionAliases([
    nickname,
    roleName,
    ...(Array.isArray(configured) ? configured : [configured]),
    ...FALLBACK_MENTION_ALIASES
  ]);
}

/**
 * 取消息**自己的**文字段（不含引用原文）。
 *
 * 为什么不复用 bridge 里的 segmentsToText：那个函数会把 @ 解析成群名片、
 * 把引用解析成 `[引用 某人：原文]`，而「叫名字」只应看当前消息自己写的字。
 * 这里也不把 `@别人` 算进文字，避免「@了同名的另一个人」造成误判。
 */
export function messageOwnText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  let out = '';
  for (const seg of message) {
    if (seg?.type === 'text') out += String(seg?.data?.text ?? '');
  }
  return out;
}

/**
 * 判断一条消息是否在叫机器人。
 *
 * @param {object} input
 * @param {Array|string} [input.message] OneBot 消息段（或纯文本/CQ 码字符串）
 * @param {string} [input.text] 调用方已解析好的「当前消息自己的文字」；不传则从 message 提取
 * @param {boolean} [input.quoteTargetIsSelf] 引用/回复的是否是机器人自己的消息
 * @param {string|number|Array<string|number>} [input.selfIds] 机器人自己的 QQ 号（可多个来源）
 * @param {string[]} [input.aliases] 机器人昵称/别名
 * @returns {{matched: boolean, reason: 'at'|'quote'|'name'|null, alias?: string}}
 */
export function detectMention({ message, text, quoteTargetIsSelf = false, selfIds, aliases } = {}) {
  const ids = new Set(
    (Array.isArray(selfIds) ? selfIds : [selfIds])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value && value !== 'all')
  );

  // ① 结构化 at 段。qq 可能是 number 也可能是 string，统一按字符串比。
  if (ids.size > 0) {
    if (Array.isArray(message)) {
      for (const seg of message) {
        if (seg?.type !== 'at') continue;
        const qq = String(seg?.data?.qq ?? '').trim();
        if (ids.has(qq)) return { matched: true, reason: 'at' };
      }
    } else if (typeof message === 'string') {
      // 少数网关只给 CQ 码字符串：再按 `[CQ:at,qq=...]` 兜一层。
      for (const id of ids) {
        if (message.includes(`[CQ:at,qq=${id}]`)) return { matched: true, reason: 'at' };
      }
    }
  }

  // ② 引用/回复机器人自己的消息（由 bridge 用 get_msg 解析后传入）。
  if (quoteTargetIsSelf) return { matched: true, reason: 'quote' };

  // ③ 当前消息自己的文字里出现昵称/别名（大小写不敏感）。
  const ownText = String(text ?? '').trim() ? String(text) : messageOwnText(message);
  if (ownText) {
    const lower = ownText.toLowerCase();
    for (const alias of normalizeMentionAliases(aliases)) {
      if (lower.includes(alias.toLowerCase())) return { matched: true, reason: 'name', alias };
    }
  }

  return { matched: false, reason: null };
}

/**
 * 「仅@」模式的消息级闸门（bridge 在 handleIncoming 入口调用）。
 *
 * 明确的语义：
 *   · 非 mention-only 模式 → handle=true（本函数不参与判定，调用方通常也不会调）；
 *   · 私聊 → handle=true（与 chat 相同，白名单由 modeAllowed 另行把关）；
 *   · 群聊 → 只有 detectMention 命中才 handle=true。
 *
 * @returns {{handle: boolean, matched: boolean, reason: string|null, alias?: string}}
 */
export function evaluateMentionOnlyMessage({ mode, kind, ...mentionInput } = {}) {
  if (mode !== MENTION_ONLY_MODE) return { handle: true, matched: true, reason: 'not-mention-only' };
  if (kind !== 'group') return { handle: true, matched: true, reason: 'private' };
  const hit = detectMention(mentionInput);
  return { handle: hit.matched, matched: hit.matched, reason: hit.reason, ...(hit.alias ? { alias: hit.alias } : {}) };
}
