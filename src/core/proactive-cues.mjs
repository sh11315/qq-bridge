/**
 * 「主动由头清单」：把具体的事变成主动开口的理由。
 *
 * 背景：原来「主动机会」只是在安静够久之后掷骰子，开口内容靠 mood / share / idle 这类
 * 泛泛的角度，容易变成随机冒泡。真正像活人，是「手上有件具体的事」——他几点下课、
 * 明天早八、我欠他/他欠我的账、答应过要办的事。这份清单就是那本小本子。
 *
 * 设计：
 *   - 一条 cue 就是一件具体的事：一句由头（text）+ 一句怎么开口（angle）+ 何时到期；
 *   - 支持一次性时间点（at，ISO 字符串）与每天重复（daily，HH:MM）；
 *   - 到期后有一个窗口（windowMinutes），窗口内算「该提了」；
 *   - 提过一次进入冷却（cooldownMinutes），避免同一件事反复念叨；
 *   - 纯函数 + 极薄的读写 helper，零依赖，便于单测。
 */

import fs from 'node:fs';
import path from 'node:path';

const MINUTE = 60 * 1000;

export const DEFAULT_CUE_WINDOW_MINUTES = 90;
export const DEFAULT_CUE_COOLDOWN_MINUTES = 12 * 60;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 把一条 cue 规整成可判定形状；不合法返回 null。 */
export function normalizeCue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const text = String(raw.text || '').trim();
  if (!id || !text) return null;
  const daily = typeof raw.daily === 'string' && /^\d{1,2}:\d{2}$/.test(raw.daily.trim()) ? raw.daily.trim() : '';
  const at = raw.at ? Date.parse(String(raw.at)) : NaN;
  if (!daily && !Number.isFinite(at)) return null;
  return {
    id,
    text: text.slice(0, 120),
    angle: String(raw.angle || '').trim().slice(0, 200),
    kind: String(raw.kind || 'event').trim().slice(0, 20),
    daily,
    at: Number.isFinite(at) ? at : 0,
    windowMinutes: Math.max(1, num(raw.windowMinutes, DEFAULT_CUE_WINDOW_MINUTES)),
    cooldownMinutes: Math.max(0, num(raw.cooldownMinutes, DEFAULT_CUE_COOLDOWN_MINUTES)),
    lastFiredAt: Math.max(0, num(raw.lastFiredAt, 0)),
    enabled: raw.enabled !== false,
  };
}

/** 解析 / 读取清单，坏条目直接丢掉，不让配置文件把主动机制拖死。 */
export function parseCues(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.cues) ? raw.cues : [];
  return list.map(normalizeCue).filter(Boolean);
}

export function loadCues(filePath, fsImpl = fs) {
  try {
    if (!filePath || !fsImpl.existsSync(filePath)) return [];
    return parseCues(JSON.parse(fsImpl.readFileSync(filePath, 'utf8')));
  } catch {
    return [];
  }
}

export function saveCues(filePath, cues, fsImpl = fs) {
  try {
    if (!filePath) return false;
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = { updatedAt: new Date().toISOString(), cues: cues.map((cue) => ({ ...cue })) };
    fsImpl.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 某个时刻当天最近一次「每天 HH:MM」的发生时间（本地时区）。 */
export function dailyOccurrence(nowTs, hhmm) {
  const [hh, mm] = String(hhmm).split(':').map((n) => Number(n));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return NaN;
  const d = new Date(nowTs);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

/**
 * 挑一条现在该提的 cue。
 * @returns {{cue:object, dueAt:number, lateMinutes:number}|null}
 */
export function pickDueCue(cues, now = Date.now(), { windowScale = 1 } = {}) {
  const list = Array.isArray(cues) ? cues : [];
  const candidates = [];
  for (const cue of list) {
    if (!cue || cue.enabled === false) continue;
    const windowMs = cue.windowMinutes * MINUTE * Math.max(0.1, Number(windowScale) || 1);
    let dueAt = NaN;
    if (cue.daily) {
      // 每天重复：今天的、以及昨天跨夜还没过期的那次都算。
      const today = dailyOccurrence(now, cue.daily);
      const yesterday = today - 24 * 60 * MINUTE;
      if (Number.isFinite(today) && now >= today && now <= today + windowMs) dueAt = today;
      else if (Number.isFinite(yesterday) && now >= yesterday && now <= yesterday + windowMs) dueAt = yesterday;
    } else if (cue.at) {
      if (now >= cue.at && now <= cue.at + windowMs) dueAt = cue.at;
    }
    if (!Number.isFinite(dueAt)) continue;
    if (cue.lastFiredAt && now - cue.lastFiredAt < cue.cooldownMinutes * MINUTE) continue;
    candidates.push({ cue, dueAt, lateMinutes: Math.max(0, Math.round((now - dueAt) / MINUTE)) });
  }
  if (!candidates.length) return null;
  // 越晚越可能忘了提，先提最早的；同分时随机一下，别每次都按文件顺序。
  candidates.sort((a, b) => a.dueAt - b.dueAt || Math.random() - 0.5);
  return candidates[0];
}

/** 标记某条 cue 刚被用过（原地修改并返回同一数组，方便调用方落盘）。 */
export function markCueFired(cues, id, now = Date.now()) {
  const list = Array.isArray(cues) ? cues : [];
  const hit = list.find((cue) => cue && cue.id === id);
  if (hit) hit.lastFiredAt = now;
  return list;
}
