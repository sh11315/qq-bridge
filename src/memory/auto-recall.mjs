/**
 * v1.5-lite：人格型记忆的「读取层」。
 *
 * 每轮唤醒时从记忆库里挑几样东西塞进提示词：
 *   1) 置顶（关系/约定/身体/手动 pinned，不占普通名额）
 *   2) 相关（按重要度 × 新鲜度 × 当前话相关性排序）
 *   3) 忽然想起（小概率抽一条旧事，并明确允许"接不上就别提"）
 *   4) 状态（精力/心情用感受词表达，不注入数字）
 *
 * 纯读模块：不写 brain、不 touch、不发事件；brain 文件按 mtime+size 缓存。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  hasSensitiveInfo,
  isDayMemory,
  isDiaryMemory,
  isPrivateMemory,
  normalizeSelf,
  normalizeBrainShape,
  personaStateSnapshot,
  pinRank,
  scoreMemory,
} from './model.mjs';
import { activeEmotions, emotionPrompt } from './emotion.mjs';
import { wakeHabitPrompt, emotionToneHint } from './wake-habit.mjs';
import { pickAnchors, salienceTier } from './salience.mjs';
import { MemoryStore } from './store.mjs';

const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 3000;
const cache = new Map();

/** state/memory/brain.json（也兼容显式传 stateDir）。 */
export function resolveBrainFile({ repoRoot = process.cwd(), stateDir } = {}) {
  const dir = stateDir ? path.resolve(stateDir) : path.join(path.resolve(repoRoot), 'state', 'memory');
  return path.join(dir, 'brain.json');
}

/**
 * 读 brain 供注入使用：按 mtime+size 缓存，避免每轮重复解析大 JSON。
 * 文件不存在/解析失败返回 null（注入层静默跳过）。
 */
export function loadBrainForRecall({ repoRoot, stateDir, now = Date.now() } = {}) {
  const file = resolveBrainFile({ repoRoot, stateDir });
  const dir = path.dirname(file);
  const journalFile = path.join(dir, 'journal.jsonl');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let journalStat = null;
  try {
    journalStat = fs.statSync(journalFile);
  } catch {
    journalStat = null;
  }
  const hit = cache.get(file);
  if (
    hit &&
    hit.mtimeMs === stat.mtimeMs &&
    hit.size === stat.size &&
    hit.journalMtimeMs === (journalStat ? journalStat.mtimeMs : 0) &&
    hit.journalSize === (journalStat ? journalStat.size : 0) &&
    now - hit.at < CACHE_TTL_MS
  ) {
    return hit.brain;
  }
  try {
    let brain;
    if (journalStat) {
      // 增量写盘模式：必须回放 journal，否则最近写入的情绪/记忆看不到。
      const memoryDir = dir;
      const stateDirPath = path.dirname(memoryDir);
      const rootPath = path.dirname(stateDirPath);
      const store = new MemoryStore({ repoRoot: rootPath, stateDir: stateDirPath });
      brain = store.load();
    } else {
      brain = normalizeBrainShape(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    if (!brain) return null;
    cache.set(file, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      journalMtimeMs: journalStat ? journalStat.mtimeMs : 0,
      journalSize: journalStat ? journalStat.size : 0,
      at: now,
      brain,
    });
    return brain;
  } catch {
    return null;
  }
}

function brief(memory) {
  const text = String(memory.text || '');
  return {
    id: memory.id,
    title: String(memory.title || text.slice(0, 20)),
    text: text.length > 140 ? `${text.slice(0, 140)}…` : text,
    category: memory.category || 'other',
    layer: memory.layer || 'short',
    strength: Number(memory.strength) || 0,
    pinned: pinRank(memory) >= 2,
    private: isPrivateMemory(memory),
    at: Number(memory.lastActivatedAt || memory.updatedAt || memory.createdAt) || 0,
  };
}

/**
 * 挑出本轮要注入的记忆与状态。
 * @param {object} opts
 * @param {object} opts.brain normalizeBrainShape 之后的 brain
 * @param {boolean} opts.isGroup 群聊时过滤私聊来源记忆
 * @param {string} opts.query 本轮最近消息拼成的查询串
 * @param {number} opts.limit 普通记忆条数上限（置顶另算）
 * @param {number} opts.serendipity 忽然想起的概率
 */
export function autoRecall({
  brain,
  isGroup = false,
  query = '',
  limit = 6,
  serendipity = 0.18,
  now = Date.now(),
  random = Math.random,
} = {}) {
  const state = personaStateSnapshot(brain?.state, now);
  const empty = { ok: false, at: now, state, query, anchor: '', persona: null, narratives: [], values: [], digest: null, days: [], top: [], ordinary: [], anchors: [], serendipity: [], emotions: [], emotionText: '', wake: '', toneHints: [], counts: { top: 0, ordinary: 0, anchors: 0, serendipity: 0, days: 0, emotions: 0 } };
  if (!brain || !brain.memories) return empty;

  const all = Object.values(brain.memories).filter((memory) => {
    if (!memory || !memory.id) return false;
    if (memory.status !== 'active') return false;
    if (isDiaryMemory(memory)) return false;
    if (isDayMemory(memory)) return false;
    return true;
  });
  // 群聊：私聊来源的记忆一条都不注入（边界规则）。
  const visible = all.filter((memory) => !(isGroup && isPrivateMemory(memory)));
  const safeLimit = Math.max(0, Math.min(10, Number(limit) || 6));

  const self = normalizeSelf(brain.self);
  const persona = self.persona.status === 'approved' ? { text: self.persona.text, at: self.persona.at } : null;
  const narratives = self.narratives.slice(-2).map((item) => ({ id: item.id, text: item.text, at: item.at }));
  const anchor = String(self.anchor || '');
  const values = self.values.slice(-5).map((item) => ({ id: item.id, text: item.text, at: item.at }));
  const digest = self.digests.length ? self.digests[self.digests.length - 1] : null;
  const days = Object.values(brain.memories)
    .filter((memory) => memory && memory.status === 'active' && isDayMemory(memory))
    .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0))
    .slice(0, 2)
    .map((memory) => {
      const date = (Array.isArray(memory.tags) ? memory.tags : []).find((tag) => /^\d{4}-\d{2}-\d{2}$/.test(String(tag))) || '';
      return { id: memory.id, date, text: String(memory.text || ''), at: Number(memory.createdAt) || 0 };
    });

  const top = visible
    .filter((memory) => pinRank(memory) >= 2)
    .sort((a, b) => (Number(b.lastActivatedAt || b.updatedAt || 0)) - (Number(a.lastActivatedAt || a.updatedAt || 0)))
    .slice(0, 3);

  const topIds = new Set(top.map((memory) => memory.id));
  const scored = visible
    .filter((memory) => !topIds.has(memory.id))
    .map((memory) => ({ memory, score: scoreMemory(memory, { query, now }) }))
    .sort((a, b) => b.score - a.score);
  const ordinary = scored.slice(0, Math.max(0, safeLimit - top.length)).map((item) => item.memory);
  const usedIds = new Set([...topIds, ...ordinary.map((memory) => memory.id)]);

  // 忽然想起：从"很久没动过"的旧事里抽 1 条，过滤敏感信息；允许它接不上就不提。
  const remembered = [];
  const probability = Math.max(0, Math.min(1, Number(serendipity) || 0));
  if (probability > 0 && random() < probability) {
    const pool = visible.filter((memory) => {
      if (usedIds.has(memory.id)) return false;
      const age = now - Number(memory.lastActivatedAt || memory.updatedAt || memory.createdAt || now);
      if (age < 6 * 3_600_000) return false;
      const text = `${memory.title || ''} ${memory.text || ''}`;
      return !hasSensitiveInfo(text);
    });
    if (pool.length > 0) {
      const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
      remembered.push(pool[index]);
    }
  }

  // v1.7：醒来先看 + 此刻情绪 + 已批准的语气提示。
  // 压底（anchor）：按关键度挑「核心」档，但没被 pinRank 收进置顶的那几条——
  // 置顶是主人点过的，压底是我自己判断「这条不能随口改口」的，两拨互不顶替。
  const relationDegree = new Map();
  for (const relation of Array.isArray(brain.relations) ? brain.relations : []) {
    if (!relation) continue;
    for (const side of [relation.from, relation.to, relation.source, relation.target]) {
      const id = String(side ?? '');
      if (id) relationDegree.set(id, (relationDegree.get(id) || 0) + 1);
    }
  }
  const anchors = pickAnchors(
    visible.filter((memory) => !usedIds.has(memory.id) && !topIds.has(memory.id)),
    {
      limit: 12,
      ctxOf: (memory) => {
        const entityTypes = {};
        for (const id of Array.isArray(memory.entityIds) ? memory.entityIds : []) {
          const type = brain.entities?.[id]?.type || 'other';
          entityTypes[type] = (entityTypes[type] || 0) + 1;
        }
        return { relations: relationDegree.get(String(memory.id)) || 0, entityTypes };
      },
    },
  )
    .filter((item) => salienceTier(item.score) === 'core')
    .slice(0, 3)
    .map((item) => item.memory);
  const wake = wakeHabitPrompt({ brain, now, anchors });
  const activeEmotionList = activeEmotions(brain.emotions, now);
  const latestEmotion = activeEmotionList.length ? activeEmotionList[activeEmotionList.length - 1] : null;
  const emotionText = latestEmotion ? emotionPrompt(latestEmotion, now) : '';
  // 情绪不只是复读一句：强度要能改语气（烦就短句、软就软），否则情绪模块等于挂件。
  const emotionTone = latestEmotion ? emotionToneHint(latestEmotion) : '';
  const toneHints = Array.isArray(self.toneHints) ? self.toneHints.slice(-5) : [];

  return {
    ok: true,
    at: now,
    state,
    wake,
    emotionText,
    emotionTone,
    emotions: activeEmotionList.slice(-5).map((item) => ({ label: item.label, intensity: item.intensity, at: item.at })),
    toneHints,
    query: String(query || '').slice(0, 200),
    anchor,
    persona,
    narratives,
    values,
    digest,
    days,
    top: top.map(brief),
    ordinary: ordinary.map(brief),
    anchors: anchors.map(brief),
    serendipity: remembered.map(brief),
    counts: { top: top.length, ordinary: ordinary.length, anchors: anchors.length, serendipity: remembered.length, days: days.length, emotions: activeEmotionList.length },
  };
}

function lineOf(memory) {
  const title = String(memory.title || '').trim();
  const text = String(memory.text || '').trim();
  if (title && !text.startsWith(title)) return `- ${title}：${text}`;
  return `- ${text || title}`;
}

/**
 * 旧版语气提案尾巴上的「自评嫌疑…主人批准后才生效」说明，现在自动采纳后会误导她，
 * 渲染前统一剥掉（历史 brain 数据还带着这一段）。
 */
const STALE_TONE_NOTE_RE = /这只是机器人的自评嫌疑[^。]*。|外部卡尺[^。]*。|主人批准后才会变成生效的语气提示。/g;
function cleanToneHint(text) {
  return String(text || '').replace(STALE_TONE_NOTE_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * 把 autoRecall 结果拼成注入提示词。空结果返回空串。
 * 状态用感受词，不出现数字。
 */
﻿export function formatMemoryHint(result, { isGroup = false } = {}) {
  if (!result || !result.state) return '';
  const blocks = [];
  if (result.wake) blocks.push(`【醒来先看】\n- ${result.wake}`);
  if (result.emotionText) blocks.push(`【此刻情绪】\n- ${result.emotionText}（情绪不是台词，别念标签和强度，别把它当借口。）${result.emotionTone ? `\n- 顺着这股劲儿说：${result.emotionTone}` : ''}`);
  if (Array.isArray(result.toneHints) && result.toneHints.length) {
    // 旧版语气提案尾巴带「只是自评嫌疑…主人批准后才生效」，现在护栏会自动采纳，
    // 这类尾注会误导她以为还要等批准；渲染时统一剥掉，历史数据也一并清洗。
    const hints = result.toneHints.map(cleanToneHint).filter(Boolean);
    if (hints.length) blocks.push(['【语气校准（主人已批准）】', ...hints.map((item) => `- ${item}`)].join('\n'));
  }
  if (result.anchor) blocks.push(`【人设锚点】\n- ${result.anchor}`);
  if (result.persona && result.persona.text) {
    blocks.push(['【人设基调】', `- ${result.persona.text}`].join('\n'));
  }
  if (result.digest && result.digest.text) {
    blocks.push(`【自述·回炉】\n- ${result.digest.text}`);
  }
  if (Array.isArray(result.narratives) && result.narratives.length) {
    blocks.push(['【自述】', ...result.narratives.map((item) => `- ${item.text}`)].join('\n'));
  }
  if (Array.isArray(result.values) && result.values.length) {
    blocks.push(['【在乎的】', ...result.values.map((item) => `- ${item.text}`)].join('\n'));
  }
  if (result.top.length) blocks.push(['【记忆·置顶】', ...result.top.map(lineOf)].join('\n'));
  if (Array.isArray(result.anchors) && result.anchors.length) {
    blocks.push(['【记忆·压底】', ...result.anchors.map(lineOf)].join('\n'));
  }
  if (result.ordinary.length) blocks.push(['【记忆·相关】', ...result.ordinary.map(lineOf)].join('\n'));
  if (Array.isArray(result.days) && result.days.length) {
    blocks.push(['【近期】', ...result.days.map((day) => `- ${day.date || ''} ${String(day.text || '').replace(/^【日层[^】]*】/, '').trim()}`)].join('\n'));
  }
  if (result.serendipity.length) {
    blocks.push(['【忽然想起】', ...result.serendipity.map(lineOf), '（可以提一句，也可以不提；接不上就别硬接，别为了圆这个故事编细节。）'].join('\n'));
  }
  const state = result.state;
  blocks.push(`【状态】现在${state.energyWord}，${state.moodWord}。按这个感觉说话就行，不要把精力/心情说成数值。`);
  blocks.push(`以上是记忆里的参考，不是本轮对话内容；记不准就说不记得，别编；${isGroup ? '群聊里不要提私下聊过的内容。' : '不确定的事先核对再说。'}`);
  const text = blocks.join('\n\n');
  return text.length > 2800 ? `${text.slice(0, 2790)}…` : text;
}

/**
 * 桥接调用入口：读 brain → 选记忆 → 拼提示词。异常一律吞掉（记忆坏了不能影响回消息）。
 */
export function buildMemoryHintForPrompt({ repoRoot, stateDir, key = '', isGroup = false, query = '', limit = 6, serendipity = 0.18, now = Date.now() } = {}) {
  try {
    const brain = loadBrainForRecall({ repoRoot, stateDir, now });
    if (!brain) return { ok: false, text: '', counts: { top: 0, ordinary: 0, serendipity: 0 } };
    const result = autoRecall({ brain, isGroup, query, limit, serendipity, now });
    const text = formatMemoryHint(result, { isGroup });
    return { ok: true, text, counts: result.counts, state: result.state, emotionText: result.emotionText, emotionTone: result.emotionTone || '', wake: result.wake, toneHints: result.toneHints };
  } catch {
    return { ok: false, text: '', counts: { top: 0, ordinary: 0, serendipity: 0, emotions: 0 }, emotionText: '', emotionTone: '', wake: '', toneHints: [] };
  }
}
