// 历史消息检索（纯函数）：中文逐字/短语匹配 + 剥实词 + 短答案 + 数量扫描。
//
// 设计参照 astrbot_plugin_qq_user_memory 的「回忆检索通道」，但只做当前会话、
// 不依赖 embedding / SQLite：
//   · 整句直接当关键词多半 0 命中（"你还记得我有几只猫吗"），先剥成实词；
//   · 短答案（"4只"）不能按长度过滤掉；
//   · 问数量时答案里可能根本没有"猫"，额外扫「数字 + 量词」；
//   · 命中句带前后各一句，避免丢一个孤零零的"4只"给模型。

// 截断必须按码点走：slice 会切在 emoji 代理对中间，留下孤立代理（显示成 �）。
import { truncateText } from '../md-to-plain.js';

const STOP_WORDS = [
  '你还记得', '记不记得', '还记不记得', '我跟你说过', '我跟你讲过', '我跟你说',
  '有没有', '是不是', '记不记得', '记得吗', '还记得',
  '之前', '以前', '上次', '刚才', '前面', '那次',
  '什么', '怎么', '哪里', '哪个', '哪天', '多少', '几个', '几只', '几次', '几条',
  '可以', '一下', '帮我', '请', '麻烦', '告诉',
  '吗', '呢', '吧', '啊', '呀', '嘛', '哦', '嗯', '哈',
  '的', '了', '在', '是', '有', '这', '那', '就', '都', '也', '和', '跟', '过',
  '我', '你', '他', '她', '它', '我们', '你们', '他们'
].sort((a, b) => b.length - a.length);

const PUNCT_RE = /[，。！？、,.!?;；:："'“”‘’（）()\[\]【】《》…·~～\s]+/g;
const QTY_RE = /([0-9一二两三四五六七八九十百千万]+\s*(?:只|个|条|次|天|年|岁|块|元|小时|分钟|斤|公斤|公里|人|张|份|杯|瓶|岁))/g;
const QUANTITY_QUERY_RE = /(几|多少|数量|几只|几个|几条|几次|几天)/;

/** 问句 → 检索实词（去疑问句式与停用词，最多 8 个）。 */
export function extractQueryTerms(query, options = {}) {
  const maxTerms = Math.max(1, Number(options.maxTerms) || 8);
  let text = String(query ?? '');
  for (const word of STOP_WORDS) {
    if (text.includes(word)) text = text.split(word).join(' ');
  }
  text = text.replace(PUNCT_RE, ' ');
  const terms = [];
  for (const rawChunk of text.split(/\s+/)) {
    let clean = rawChunk.trim();
    if (!clean) continue;
    // 剥掉口语残留：前缀“还/又/就…”，后缀“来着/了吧/了吗…”。
    // 实测「我还有几只猫来着」会切成 ["还","猫来着"]，不剥就 0 命中。
    clean = clean.replace(/^(还|又|就|也|都|再|才|其实|原来|那个|这个)/, '');
    clean = clean.replace(/(来着|了吧|了吗|了呢|的话|的了|过的)$/, '');
    if (!clean) continue;
    if (!terms.includes(clean)) terms.push(clean);
    if (terms.length >= maxTerms) break;
  }
  return terms;
}

/** 去掉疑问/回忆句式后剩下的连续短语（用于加分，不是必须命中）。 */
export function extractQueryPhrase(query) {
  let text = String(query ?? '');
  for (const word of STOP_WORDS) {
    if (text.includes(word)) text = text.split(word).join(' ');
  }
  return text.replace(PUNCT_RE, '').trim();
}

export function isQuantityQuery(query) {
  return QUANTITY_QUERY_RE.test(String(query ?? ''));
}

/** 从一篇文本里抽出「数字 + 量词」形状的短句（用于数量型提问）。 */
export function findQuantityAnswers(text) {
  const source = String(text ?? '');
  const out = [];
  for (const match of source.matchAll(QTY_RE)) {
    // 排除「预计 20 分钟内」「3 天后」这类时长/计划，不是数量答案
    const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 2);
    if (/内|后|左右|之前/.test(tail)) continue;
    out.push({ value: match[0], at: match.index });
  }
  return out;
}

/**
 * 在当前会话的历史消息里检索。
 *
 * @param {Array<{seq?:number,messageId?:string|null,time:number,sender?:string,userId?:string|null,text?:string,isSelf?:boolean}>} messages 时间升序
 * @param {object} options { query, hours, limit, userId, now }
 * @returns {{terms:string[], phrase:string, quantityMode:boolean, scanned:number, hits:Array, truncated:boolean}}
 */
export function searchHistoryMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const query = String(options.query ?? '');
  const now = Number(options.now) || Date.now();
  const hours = Math.min(24 * 365, Math.max(1, Number(options.hours) || 168));
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 20));
  const userId = options.userId != null && String(options.userId).trim() ? String(options.userId).trim() : '';
  const since = now - hours * 3600 * 1000;

  const terms = extractQueryTerms(query);
  const phrase = extractQueryPhrase(query);
  const quantityMode = isQuantityQuery(query);

  const filtered = list
    .map((msg, index) => ({ msg, index }))
    .filter(({ msg }) => msg && (Number(msg.time) || 0) >= since && (!userId || String(msg.userId ?? '') === userId));

  const scored = [];
  for (const { msg, index } of filtered) {
    const text = String(msg.text ?? '');
    const matched = terms.filter((term) => text.includes(term));
    const phraseHit = phrase.length >= 2 && text.includes(phrase);
    const quantityHit = quantityMode && findQuantityAnswers(text).length > 0;
    if (!matched.length && !phraseHit && !quantityHit) continue;
    const score = matched.length * 2
      + (phraseHit ? 3 : 0)
      + (quantityHit ? 2 : 0)
      + (text.length <= 6 ? 1 : 0); // 短答案（"4只"）保留并加权
    scored.push({ msg, index, score, match: matched.length || phraseHit ? 'keyword' : 'quantity' });
  }

  scored.sort((a, b) => (b.score - a.score) || ((Number(b.msg.time) || 0) - (Number(a.msg.time) || 0)));

  const hits = scored.slice(0, limit).map(({ msg, index, score, match }) => ({
    seq: msg.seq ?? null,
    messageId: msg.messageId ?? null,
    time: Number(msg.time) || 0,
    sender: msg.sender ?? '',
    userId: msg.userId ?? null,
    isSelf: !!msg.isSelf,
    text: truncateText(msg.text ?? '', 200),
    match,
    score,
    before: index > 0 ? truncateText(list[index - 1]?.text ?? '', 120) : null,
    after: index + 1 < list.length ? truncateText(list[index + 1]?.text ?? '', 120) : null
  }));

  const emptyQuery = terms.length === 0 && !quantityMode;
  return { terms, phrase, quantityMode, emptyQuery, scanned: filtered.length, hits, truncated: scored.length > hits.length };
}

/**
 * 跨群（按 QQ 号）检索的权限：仅主人私聊、closed-agent 或控制台管理端。
 * 群友即使持有自己会话的 agent token，也不能跨群查别人说过的话。
 */
export function canUseUserScope({ callerKey = '', ownerQQ = '', mode = '', consoleRequest = false } = {}) {
  if (consoleRequest === true) return true;
  if (String(mode) === 'closed-agent') return true;
  const owner = String(ownerQQ || '').trim();
  return !!owner && String(callerKey || '') === `private:${owner}`;
}

/** 给模型读的紧凑文本（一行一条，带时间与说话人）。 */
export function formatHistoryHitsForModel(key, result) {
  if (!result || !Array.isArray(result.hits) || result.hits.length === 0) {
    if (result?.emptyQuery) {
      return `这次查询没有可检索的实词（全是“的/了/吗”这类停用词）：换个具体名词、人名或事件再查。已扫描 ${result.scanned ?? 0} 条。`;
    }
    return `没有在 ${key} 的历史里找到匹配的消息（扫描 ${result?.scanned ?? 0} 条，检索词：${(result?.terms || []).join('/') || '无'}）。`;
  }
  const lines = result.hits.map((hit) => {
    const time = new Date(hit.time).toLocaleString('zh-CN', { hour12: false });
    const who = hit.isSelf ? '我' : (hit.sender || hit.userId || '未知');
    const mark = hit.match === 'quantity' ? '★数量' : '·';
    return `${mark} [${time}] ${who}：${hit.text}`;
  });
  return `【${key} 历史命中 ${result.hits.length} 条，扫描 ${result.scanned} 条】\n${lines.join('\n')}`;
}