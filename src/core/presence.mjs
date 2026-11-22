// 活人感行为提示（纯规则，零额外模型调用）。
//
// 只回答「这一轮该怎么说话」，不改人格、记忆、路由与工具：
// bridge 里已有的 antiAiLine 管「态度」（不是客服、不用有求必应），
// 这里补「形式」——长度、结构、标点、复述、分条。
//
// 为什么只对 chat 生效：vision/voice/web/sticker 是任务回合，
// 强制短句会把"看图说话/复述搜索结果"这类必要输出也压坏。

export const PRESENCE_LEVELS = Object.freeze(['off', 'light', 'standard']);
export const PRESENCE_DEFAULT_MAX_CHARS = 220;

/**
 * @param {object} input
 * @param {boolean} [input.enabled=true]  总开关（false 时返回空串）
 * @param {'off'|'light'|'standard'} [input.level='light']
 * @param {'group'|'private'} [input.scene='group']
 * @param {string} [input.feature='chat']  功能会话名；非 chat 一律不注入
 * @param {boolean} [input.proactive=false] 是否主动冒泡回合
 * @param {number} [input.maxChars=220]    硬上限（配置写大了也会被夹住）
 * @returns {string} 空串表示不注入
 */
export function buildPresenceHint(input = {}) {
  const {
    enabled = true,
    level = 'light',
    scene = 'group',
    feature = 'chat',
    proactive = false,
    maxChars = PRESENCE_DEFAULT_MAX_CHARS
  } = input;

  const lv = String(level || 'light').toLowerCase();
  if (enabled === false || lv === 'off') return '';
  if (!PRESENCE_LEVELS.includes(lv)) return ''; // 未知档位不注入（fail-safe）
  if (String(feature) !== 'chat') return '';

  const lines = [
    '像熟人打字，不像客服：一两句为主，一句能说完就别写三段。',
    '别列点、别总结，别用“首先/其次/另外/总之”；不用每句都带句号，也别每条都写得很完整。',
    '别复述对方刚说的，也别重复自己上一轮；不要用“我理解你的意思/你说得对”这类开场。'
  ];
  if (scene === 'group') lines.push('群里没被点到、话题不是等你时，别接话。');
  if (proactive) lines.push('主动开口只发 1~2 条，像刚想起来才说一句，别写成公告。');
  if (lv === 'standard') {
    lines.push('同一件事别拆成多条；要分条就给 qq_send_message 传数组，每条单独也能读懂。');
    lines.push('少堆感叹号和 emoji，一个够了。');
  }

  const block = `【这一轮怎么说】\n${lines.map((line) => `- ${line}`).join('\n')}`;
  const limit = Math.max(80, Number(maxChars) || PRESENCE_DEFAULT_MAX_CHARS);
  return block.length > limit ? block.slice(0, limit) : block;
}