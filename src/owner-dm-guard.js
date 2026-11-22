// 群会话 → owner 私聊的发送判定（纯函数 + 只读 `state/turn-sender.json`）。
//
// 需求：在群里可以对 AI 说「把 X 发我私聊」，但安全边界是两条硬约束：
//   ① 目标只能是 config.json 的 ownerQQ；
//   ② 只有「当前回合确实是 owner 触发的」才放行 —— 别人在群里喊
//      「把刚才那段发我私聊」时，AI 手里即使有群会话令牌也不能拿去私聊 owner。
//
// 为什么判定放在这里而不是只看白名单：`/api/send/private` 的目标 key 是
// `private:<目标>`，而群会话拿到的 agentToken 绑定在 `group:<群号>` 上。按目标 key
// 校验 token 必然 403（这就是「群里 AI 说发不了私聊」的真正闸门）；但一旦把校验改成
// 「按 token 反查调用方会话」，就必须补上「谁触发了本回合」这一层，否则群友可以
// 借 AI 的群令牌私聊 owner。
//
// `state/turn-sender.json` 由桥接的回合投递路径写入（另一个改动），本模块**只读**。
// 文件不存在、格式不认识、记录过期、匹配不到本会话，一律按拒绝处理（fail-closed）。
import fs from 'node:fs';

/** 回合发送者快照的有效期：超过它就认为这条记录已不能代表「当前回合」。 */
export const TURN_SENDER_TTL_MS = 30 * 60 * 1000;

/** 容器键：这些键的值是「一批条目」而不是单条记录本身。 */
const CONTAINER_KEYS = new Set(['sessions', 'turns', 'bySession', 'byKey', 'conversations', 'current', 'active']);

/** 单条记录里可能承载发送者 QQ 的字段（兼容老/新两种写法）。 */
const SENDER_FIELDS = [
  'senderId', 'sender_id', 'userId', 'user_id', 'qq', 'uid',
  'fromUserId', 'from_user_id', 'from', 'fromUser', 'from_user', 'sender'
];

/** 单条记录里可能承载会话 key 的字段。 */
const KEY_FIELDS = ['key', 'conversationKey', 'conversation_key', 'conversation', 'chatKey', 'chat_key', 'groupKey'];

/** 单条记录里可能承载 DSH sessionId 的字段。 */
const SESSION_FIELDS = ['sessionId', 'session_id', 'session', 'dshSessionId', 'dsh_session_id'];

/** 单条记录里可能承载时间戳的字段（毫秒）。 */
const TS_FIELDS = ['ts', 'at', 'time', 'updatedAt', 'updated_at', 'timestamp', 'observedAt'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstField(obj, fields) {
  for (const field of fields) {
    if (obj[field] !== undefined && obj[field] !== null && obj[field] !== '') return obj[field];
  }
  return undefined;
}

/**
 * 从一个值里抠出「像 QQ 号」的发送者 id。
 * 支持：数字/数字字符串；对象里的常见字段；嵌套一层 `{ sender: { userId } }`。
 * 非纯数字（群名片、昵称、'私聊' 等）一律视为无效，避免把名字当成 QQ 号比对。
 */
export function normalizeSenderId(value, depth = 0) {
  if (value === undefined || value === null || depth > 3) return '';
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  }
  if (typeof value === 'string') {
    const s = value.trim();
    return /^\d{1,20}$/.test(s) && Number(s) > 0 ? String(Number(s)) : '';
  }
  if (isPlainObject(value)) {
    const nested = firstField(value, SENDER_FIELDS);
    if (nested !== undefined) return normalizeSenderId(nested, depth + 1);
  }
  return '';
}

function normalizeTs(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    // 秒级时间戳（10 位）换算成毫秒；毫秒级（13 位）原样使用。
    return n < 1e12 ? Math.round(n * 1000) : n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 把任意一条记录规范成 `{ senderId, key, sessionId, ts }`；认不出返回 null。 */
export function normalizeTurnSenderEntry(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const senderId = normalizeSenderId(value);
    return senderId ? { senderId, key: '', sessionId: '', ts: 0 } : null;
  }
  if (!isPlainObject(value)) return null;
  const senderId = normalizeSenderId(value);
  if (!senderId) return null;
  const key = String(firstField(value, KEY_FIELDS) ?? '').trim();
  const sessionId = String(firstField(value, SESSION_FIELDS) ?? '').trim();
  const ts = normalizeTs(firstField(value, TS_FIELDS));
  return { senderId, key, sessionId, ts };
}

function isConversationKey(text) {
  return /^(group|private):\d+$/.test(String(text ?? '').trim());
}

function isSessionLookupKey(text) {
  const s = String(text ?? '').trim();
  return !!s && !isConversationKey(s);
}

/**
 * 把 `turn-sender.json` 的任意合理形态摊平成条目数组。
 *
 * 兼容的形态（另一个改动写入哪一种都能读）：
 *   { "<sessionId>": { senderId, ts } }
 *   { "<group:群号>": { senderId, ts } }
 *   { "sessions": { "<key 或 sessionId>": 123 } }
 *   { "key": "group:1", "sessionId": "...", "senderId": 123, "ts": ... }   // 单条
 * 值可以是一个裸 QQ 号、数字字符串，或带上面那些字段的对象。
 */
export function collectTurnSenderEntries(raw) {
  const entries = [];
  const push = (value, lookupKey = '') => {
    const entry = normalizeTurnSenderEntry(value);
    if (!entry) return;
    if (!entry.key && !entry.sessionId) {
      if (isConversationKey(lookupKey)) entry.key = String(lookupKey).trim();
      else if (lookupKey) entry.sessionId = String(lookupKey).trim();
    }
    entries.push(entry);
  };

  if (!isPlainObject(raw)) return entries;

  // 形态 D：整份文件就是一条记录。即使没有 key/sessionId 也保留：这是
  // 「只有一条全局当前回合」的写法，由 pickTurnSenderEntry 的兜底规则决定是否可用。
  const direct = normalizeTurnSenderEntry(raw);
  if (direct) entries.push(direct);

  for (const [outerKey, outerValue] of Object.entries(raw)) {
    // 单条记录自身的字段不能被当成「容器键 → 会话 id」，否则 senderId 会被记成会话名。
    if (SENDER_FIELDS.includes(outerKey) || KEY_FIELDS.includes(outerKey)
      || SESSION_FIELDS.includes(outerKey) || TS_FIELDS.includes(outerKey) || outerKey === 'isOwner') continue;
    if (CONTAINER_KEYS.has(outerKey) && isPlainObject(outerValue)) {
      // `current`/`active` 也可能直接是单条记录，而不是容器。
      const nestedDirect = normalizeTurnSenderEntry(outerValue);
      if (nestedDirect) {
        if (!nestedDirect.key && !nestedDirect.sessionId) {
          if (isConversationKey(outerKey)) nestedDirect.key = outerKey;
        }
        entries.push(nestedDirect);
      } else {
        for (const [innerKey, innerValue] of Object.entries(outerValue)) {
          if (CONTAINER_KEYS.has(innerKey) && isPlainObject(innerValue)) {
            for (const [deepKey, deepValue] of Object.entries(innerValue)) push(deepValue, deepKey);
            continue;
          }
          push(innerValue, innerKey);
        }
      }
      continue;
    }
    if (outerKey === 'updatedAt' || outerKey === 'ts' || outerKey === 'version') continue;
    push(outerValue, outerKey);
  }
  return entries;
}

/**
 * 从条目数组里挑出本会话的记录。
 *
 * 优先级：sessionId 精确匹配 > 会话 key 精确匹配 > 容器键匹配 > 只有一条记录时用它。
 * 匹配不到返回 null（让调用方 fail-closed），而不是「随便挑一条」。
 */
export function pickTurnSenderEntry(entries, { key = '', sessionId = '' } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return null;
  const wantKey = String(key ?? '').trim();
  const wantSession = String(sessionId ?? '').trim();
  const bySession = wantSession ? list.find((e) => e.sessionId && e.sessionId === wantSession) : null;
  if (bySession) return bySession;
  const byKey = wantKey ? list.find((e) => e.key && e.key === wantKey) : null;
  if (byKey) return byKey;
  // 只有「完全没写归属」的单条记录才能兜底：跨会话借用别人的回合记录等于放行
  // 一次不属于本群的 owner 私聊，宁可拒绝。
  return list.find((e) => !e.key && !e.sessionId) ?? null;
}

/**
 * 读取并解析 `turn-sender.json`，返回本会话当前回合的发送者。
 * 任何异常都转成 `{ ok:false, reason }`，绝不抛出。
 */
export function readTurnSenderSnapshot(file, { key = '', sessionId = '', now = Date.now() } = {}) {
  let text;
  try {
    text = fs.readFileSync(String(file), 'utf8');
  } catch (error) {
    const reason = error?.code === 'ENOENT'
      ? '缺少 state/turn-sender.json（当前回合发送者未知）'
      : `读取 state/turn-sender.json 失败：${error?.message ?? error}`;
    return { ok: false, reason };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `state/turn-sender.json 不是合法 JSON：${error?.message ?? error}` };
  }
  const hit = pickTurnSenderEntry(collectTurnSenderEntries(raw), { key, sessionId });
  if (!hit) return { ok: false, reason: 'state/turn-sender.json 里没有本会话的回合发送者记录' };
  if (hit.ts && now - hit.ts > TURN_SENDER_TTL_MS) {
    return { ok: false, reason: `回合发送者记录已过期（${Math.round((now - hit.ts) / 1000)} 秒前）` };
  }
  return { ok: true, senderId: hit.senderId, ts: hit.ts, key: hit.key, sessionId: hit.sessionId };
}

/**
 * 群会话私聊闸门。
 *
 * - 非群会话：`{ ok:true, bypass:true }`，保持私聊/管理端原有的行为不变。
 * - 群会话：目标必须是 ownerQQ，且当前回合发送者必须是 ownerQQ。
 *
 * 返回 `{ ok, bypass?, error?, log? }`；`log` 是给 `state/tool-restrict.log` 的可读一行。
 */
export function decideOwnerDmSend({
  callerKey = '',
  targetId = '',
  ownerQQ = '',
  turnFile = '',
  sessionId = '',
  now = Date.now()
} = {}) {
  const caller = String(callerKey ?? '').trim();
  if (!/^group:\d+$/.test(caller)) return { ok: true, bypass: true };

  const owner = String(ownerQQ ?? '').trim();
  const target = String(targetId ?? '').trim();
  if (!owner) {
    return { ok: false, error: '未配置 ownerQQ，群会话不允许私聊任何人', log: `群会话 ${caller} 私聊被拒：未配置 ownerQQ` };
  }
  if (target !== owner) {
    return {
      ok: false,
      error: '群会话里只能给 owner 发私聊；给其他群友发私聊一律拒绝',
      log: `群会话 ${caller} 试图私聊非 owner（${target || '空'}），已拒绝`
    };
  }
  const turn = readTurnSenderSnapshot(turnFile, { key: caller, sessionId, now });
  if (!turn.ok) {
    return {
      ok: false,
      error: `群会话给 owner 发私聊仅限 owner 本回合触发：${turn.reason}`,
      log: `群会话 ${caller} 给 owner 发私聊被拒：${turn.reason}`
    };
  }
  if (turn.senderId !== owner) {
    return {
      ok: false,
      error: '群会话给 owner 发私聊仅限 owner 本回合触发（当前回合是别人发的）',
      log: `群会话 ${caller} 给 owner 发私聊被拒：本回合发送者 ${turn.senderId} 不是 owner`
    };
  }
  return {
    ok: true,
    log: `群会话 ${caller} 给 owner 发私聊放行（owner 本回合触发${sessionId ? `，session=${sessionId}` : ''}）`
  };
}
