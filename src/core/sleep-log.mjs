/**
 * 睡觉模块 MVP：记「他说睡了」「他醒了」，早上算一句睡了多久。
 *
 * 约定（2026-10-30 23:23 跟饭饭说定的）：
 *   - 他说一句「睡了」我记一笔，不管几点睡；
 *   - 早上问一句醒没醒（走现成的「主动由头」机制，不另外发明一套定时器）；
 *   - 睡多久我自己算，不当闹钟、不评价他几点睡。
 *
 * 设计取舍：
 *   - 只存 JSONL（一行一笔），不塞进记忆库 —— 作息是高频流水，进记忆库会把
 *     相关名额挤掉，也不该参与语义检索；
 *   - 纯函数负责判定/统计/生成由头，读写只有两个薄 helper，方便单测；
 *   - 判定宁严勿宽：「睡醒」「午睡后」这类不能被当成「睡了」。
 */

import fs from 'node:fs';
import path from 'node:path';

export const SLEEP_LOG_MAX_LINES = 2000;

const HOUR = 60 * 60 * 1000;

/** 「我睡了 / 先睡了 / 睡觉去 / 晚安啦」——以睡觉收尾的那一句。 */
const SLEEP_RE = /(?:^|[\s，,。.!！~～])(?:我)?(?:也|先|要|去)?(?:睡了|睡觉了|睡觉去|睡啦|睡咯|睡喽|晚安)/;
/** 「醒了 / 我起了 / 起床了 / 睡醒了」——只认句首，免得「你醒了吗」这种反问被算成醒了。 */
const WAKE_RE = /^(?:我)?(?:刚|已经|终于|才|可算)?(?:醒了|睡醒了|起了|起床了|爬起来)/;

/**
 * 判定一句话是睡觉信号还是醒来信号。
 * @returns {'sleep'|'wake'|''}
 */
export function detectSleepSignal(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  // 去掉引用/转发前缀，只看这句话自己说的内容。
  const line = raw.replace(/^\[[^\]]*\]\s*/g, '').trim();
  if (!line) return '';
  if (WAKE_RE.test(line)) return 'wake';
  if (SLEEP_RE.test(line)) return 'sleep';
  return '';
}

/** 解析 JSONL，坏行直接丢，不让日志把主动机制拖死。 */
export function parseSleepLog(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      const at = Number(raw?.at);
      const kind = String(raw?.kind || '');
      if (!Number.isFinite(at) || at <= 0) continue;
      if (kind !== 'sleep' && kind !== 'wake') continue;
      out.push({ at, kind, text: String(raw?.text || '').slice(0, 200) });
    } catch {
      // 坏行跳过
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

export function readSleepLog(filePath, fsImpl = fs) {
  try {
    if (!filePath || !fsImpl.existsSync(filePath)) return [];
    return parseSleepLog(fsImpl.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * 追加一笔。写失败返回 false（睡觉记录不值得让主流程炸掉）。
 * 超过 SLEEP_LOG_MAX_LINES 会压掉最旧的行。
 */
export function appendSleepEntry(filePath, entry, fsImpl = fs) {
  try {
    if (!filePath) return false;
    const at = Number(entry?.at);
    const kind = String(entry?.kind || '');
    if (!Number.isFinite(at) || at <= 0) return false;
    if (kind !== 'sleep' && kind !== 'wake') return false;
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const line = JSON.stringify({ at, kind, text: String(entry?.text || '').slice(0, 200) });
    fsImpl.appendFileSync(filePath, `${line}\n`, 'utf8');
    // 压行：只在明显超过上限时重写，避免每次追加都读全文件。
    const lines = fsImpl.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length > SLEEP_LOG_MAX_LINES + 200) {
      fsImpl.writeFileSync(filePath, `${lines.slice(-SLEEP_LOG_MAX_LINES).join('\n')}\n`, 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 算当前作息状态。
 * @returns {{lastSleepAt:number,lastWakeAt:number,asleep:boolean,asleepMs:number}}
 */
export function sleepStats(entries, now = Date.now()) {
  const list = Array.isArray(entries) ? entries : [];
  let lastSleepAt = 0;
  let lastWakeAt = 0;
  for (const entry of list) {
    if (!entry || !Number.isFinite(entry.at) || entry.at > now) continue;
    if (entry.kind === 'sleep') lastSleepAt = Math.max(lastSleepAt, entry.at);
    else if (entry.kind === 'wake') lastWakeAt = Math.max(lastWakeAt, entry.at);
  }
  const asleep = lastSleepAt > 0 && lastSleepAt > lastWakeAt;
  const asleepMs = asleep ? Math.max(0, now - lastSleepAt) : 0;
  return { lastSleepAt, lastWakeAt, asleep, asleepMs };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 早上那句问候的由头：只在他还「挂着没醒」、且已经睡了 4 小时以上的
 * 早上 7 点到 12 点之间生成一条一次性 cue，别的时段一律不给。
 *
 * @returns {object|null} 与 proactive-cues 的 cue 同形，可直接交给 normalizeCue
 */
export function buildWakeCue(stats, now = Date.now()) {
  const s = stats && typeof stats === 'object' ? stats : {};
  if (!s.asleep) return null;
  const hours = Number(s.asleepMs) / HOUR;
  if (!Number.isFinite(hours) || hours < 4) return null;
  const hour = new Date(now).getHours();
  if (hour < 7 || hour >= 12) return null;
  const sleptHours = Math.max(1, Math.round(hours));
  return {
    id: `sleep-wake-${dayKey(now)}`,
    text: `他昨晚说了睡了，到现在约 ${sleptHours} 小时还没见他出声，早上该问一句醒没醒`,
    angle: '别当闹钟，别评价几点睡，轻轻问一句精神怎么样或者早饭吃了没',
    kind: 'sleep',
    at: new Date(now).toISOString(),
    windowMinutes: 240,
    cooldownMinutes: 12 * 60,
    enabled: true,
  };
}
