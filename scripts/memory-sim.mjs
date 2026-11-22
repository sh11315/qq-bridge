#!/usr/bin/env node
/**
 * 记忆网络离线规模仿真（v1.5-lite 数据）
 *
 * 目的：在不写真实 brain.json、不发 QQ 的前提下，用 20 万条模拟群聊消息压测
 * 记忆网络的「形成 / 去重 / 矛盾降权 / 容量淘汰 / 衰减 / 巩固 / 召回」整条链路，
 * 输出召回命中率、存储增长、存活率与耗时，作为调参依据。
 *
 * 说明：仿真复用 model.mjs 的纯函数（textSimilarity / scoreMemory / computeStrength /
 * materializeBrain / detectContradiction 等），但不经过 MemoryService 的磁盘事务
 * （20 万次 remember 每次都要 normalize+save 全量 brain，真实写盘会 O(n²)，不可行）。
 * 小样本（--real-probe N）会用真实 MemoryService 跑一遍，用于校准仿真与真机的耗时差异。
 *
 * 用法：
 *   node scripts/memory-sim.mjs --messages 200000 --days 60 --seed 42
 *   node scripts/memory-sim.mjs --messages 20000 --days 30 --json-out state/memory/sim-report.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG,
  clamp,
  computeStrength,
  detectContradiction,
  emptyBrain,
  hebbianWeight,
  isDiaryMemory,
  isPermanent,
  layerWeight,
  materializeBrain,
  recencyScore,
  scoreMemory,
  sha1,
  textSimilarity,
  textRelevance,
} from '../src/memory/model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const DEDUPE_THRESHOLD = 0.82; // 与 service.mjs LIMITS.dedupeThreshold 保持一致
const HOUR = 3_600_000;

function parseArgs(argv) {
  const args = {
    messages: 200_000,
    days: 60,
    seed: 42,
    capLong: DEFAULT_CONFIG.maxMemoriesLong,
    capShort: DEFAULT_CONFIG.maxMemoriesShort,
    jsonOut: '',
    realProbe: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--messages') { args.messages = Math.max(1000, Number(next) || args.messages); i += 1; }
    else if (flag === '--days') { args.days = clamp(Number(next) || args.days, 1, 365); i += 1; }
    else if (flag === '--seed') { args.seed = Number(next) || args.seed; i += 1; }
    else if (flag === '--cap') {
      const both = Math.max(100, Number(next) || 0);
      if (both) { args.capLong = both; args.capShort = both; }
      i += 1;
    } else if (flag === '--cap-long') { args.capLong = Math.max(100, Number(next) || args.capLong); i += 1; }
    else if (flag === '--cap-short') { args.capShort = Math.max(100, Number(next) || args.capShort); i += 1; }
    else if (flag === '--json-out') { args.jsonOut = String(next || ''); i += 1; }
    else if (flag === '--real-probe') { args.realProbe = Math.max(0, Number(next) || 0); i += 1; }
    else if (flag === '--help' || flag === '-h') { args.help = true; }
  }
  return args;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 语料 ──────────────────────────────────────────────────────────────

const SENDERS = [
  { id: 'private:100000001', name: '管理员', owner: true },
  { id: 'group:100000003', name: '小雪喵', self: true },
  ...['阿瓦', '管理员', '喵小言', '小秋灯', '木蘸糖', '吉小喵', '四_', '大肥鱼', '宇宙牛蛙', '我嫩个', '摸', '贴贴', '顺毛', '小西瓜喵', '打瓦'].map((name, i) => ({
    id: `member:${i + 1}`,
    name,
    owner: false,
  })),
];

const THEMES = [
  '桥接项目', '记忆系统', '期末考试', '早八课', '咖啡', '猫条', '小西瓜', '游戏',
  '点歌', '周末出行', '相机', '剪辑', 'Python', '数据库', '部署', '显卡',
  '睡眠', '健身', '做饭', '天气', '群规', '表情包', '语音', '日记',
];

const FACT_TEMPLATES = [
  '最近在弄{theme}，进度差不多到一半了。',
  '我打算把{theme}这件事定下来，先按现在的方案走。',
  '{theme}这块有个坑：昨天试了一版，效果不太行。',
  '关于{theme}，他说过要先查清楚再动手。',
  '{theme}的资料我放群里了，需要的自取。',
  '我偏好{theme}简单一点的方案，别加太多东西。',
  '答应过这周把{theme}弄完，得抽时间。',
  '今天{theme}终于跑通了，记一下免得忘。',
  '下次聊{theme}的时候提醒我一下。',
  '我对{theme}没什么兴趣，别总提。',
];

const PREF_TEMPLATES = [
  '我比较喜欢{theme}这种慢慢来的感觉。',
  '不太喜欢{theme}，太吵了。',
  '{theme}我就认准现在这个做法。',
  '希望{theme}别搞太复杂，简单点好。',
  '我觉得{theme}是目前最舒服的。',
];

const DECISION_TEMPLATES = [
  '{theme}这周决定改成新方案，旧方案先不动了。',
  '关于{theme}，以后统一用 B 方案，A 先废弃。',
  '{theme}不改了，就按现在这样定稿。',
  '{theme}从今天开始换一种做法，之前那套不再用。',
];

const PROMISE_TEMPLATES = [
  '我答应你，{theme}下次一定先跟你说。',
  '这周内把{theme}的结论给你，不会忘。',
  '{theme}的事我来跟，明天给你回话。',
];

const NOISE = [
  '哈哈哈哈', '草', '笑死', '？？？', '在吗', '晚安', '早', '6', '好家伙',
  '懂了', '行', '那挺好', '确实', '绷不住了', '来了来了', '摸', '贴贴',
  '今天吃啥', '有人吗', '救救', '好耶', '可恶',
];

const DETAILS = [
  '今天', '昨天', '刚才', '上周', '前几天', '今早', '晚上', '下午', '这周', '月底',
  '第 2 版', '第 3 次', '第二次', '进度 3 成', '进度一半', '差不多了', '还在试', '没定下来',
  '暂时这样', '后面再看', '细节还没定', '要再确认', '他说可以', '先这样', '再等等', '回头补',
  '有点卡', '还行', '试过了', '没跑通', '换了个写法', '数据对不上', '跑了一晚上', '文件还没发',
];
const dayStart = Date.parse('2026-08-01T00:00:00+08:00');

function pick(rand, list) { return list[Math.floor(rand() * list.length) % list.length]; }

function makeQuote(theme, kind, rand) {
  if (kind === 'fact') return pick(rand, FACT_TEMPLATES).replace('{theme}', theme);
  if (kind === 'preference') return pick(rand, PREF_TEMPLATES).replace('{theme}', theme);
  if (kind === 'decision') return pick(rand, DECISION_TEMPLATES).replace('{theme}', theme);
  if (kind === 'promise') return pick(rand, PROMISE_TEMPLATES).replace('{theme}', theme);
  return pick(rand, NOISE);
}

function generateCorpus({ messages, days, seed }) {
  const rand = mulberry32(seed);
  const perDay = messages / days;
  const out = [];
  const lastText = new Map();
  const themeState = new Map(THEMES.map((theme) => [theme, { lastMemoryId: '', lastDecisionId: '', mentions: 0 }]));
  for (let i = 0; i < messages; i += 1) {
      const day = Math.min(days - 1, Math.floor(i / perDay));
      const ts = dayStart + day * DAY + Math.floor(rand() * DAY);
      const sender = pick(rand, SENDERS);
      const theme = pick(rand, THEMES);
      const roll = rand();
      let kind = 'noise';
      if (roll < 0.42) kind = 'noise';
      else if (roll < 0.56) kind = 'chitchat';
      else if (roll < 0.70) kind = 'fact';
      else if (roll < 0.78) kind = 'preference';
      else if (roll < 0.84) kind = 'decision';
      else if (roll < 0.88) kind = 'promise';
      else if (roll < 0.93) kind = 'question';
      else kind = 'remention';
      let text = makeQuote(theme, kind === 'chitchat' ? 'noise' : kind, rand);
      if (kind === 'question') text = `${theme}之前是怎么定的来着？`;
      if (kind === 'remention') {
        const st = themeState.get(theme);
        text = st.lastMemoryId
          ? `又想起${theme}那事了，${pick(rand, ['还是按之前的来', '别忘了', '上次说的还算数吗'])}。`
          : `${theme}之前是不是聊过？`;
      }
      let isRepeat = false;
      const repeatKey = `${theme}|${kind}`;
      if ((kind === 'fact' || kind === 'preference') && lastText.has(repeatKey) && rand() < 0.12) {
        // 12% 的重复提及：同一句话再出现一次，用来压测写入去重/合并路径。
        text = lastText.get(repeatKey);
        isRepeat = true;
      } else if (kind === 'fact' || kind === 'preference') {
        lastText.set(repeatKey, text);
      }
      const randomTail = !isRepeat && rand() < 0.35 ? ` ${pick(rand, NOISE)}` : '';
      if (!isRepeat && ['fact', 'preference', 'decision', 'promise'].includes(kind)) {
        const detail = rand() < 0.3 ? `${pick(rand, DETAILS)}·${pick(rand, DETAILS)}` : pick(rand, DETAILS);
        text = `${text}（${detail}）`;
      }
      out.push({
        n: out.length + 1,
        day,
        ts,
        sender: sender.name,
        senderId: sender.id,
        self: Boolean(sender.self),
        owner: Boolean(sender.owner),
        isGroup: rand() > 0.12,
        theme,
        kind,
        text: `${text}${randomTail}`.slice(0, 300),
        themeState,
      });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ── 仿真引擎 ──────────────────────────────────────────────────────────

function createEngine({ capLong, capShort }) {
  const brain = emptyBrain(Date.now());
  const rand01 = mulberry32(20261029);
  brain.config = {
    ...DEFAULT_CONFIG,
    maxMemories: capLong + capShort,
    maxMemoriesLong: capLong,
    maxMemoriesShort: capShort,
  };
  const buckets = new Map(); // entityId -> Set<memoryId>
  const memoriesSpan = new Map(); // memoryId -> createdDay
  const counters = {
    created: 0, merged: 0, superseded: 0, archivedDecay: 0, archivedCapacity: 0,
    archivedCapacityLong: 0, archivedCapacityShort: 0,
    archivedDuplicate: 0, promoted: 0, chitchatIgnored: 0,
  };
  let order = 0;
  let activeLong = 0;
  let activeShort = 0;
  let sinceCapacity = 0;
  const synIndex = new Set();

  function entityFor(name, type = 'topic') {
    const id = `ent_${sha1(name).slice(0, 12)}`;
    if (!brain.entities[id]) {
      brain.entities[id] = {
        id, name, type, aliases: [], note: '', firstSeenAt: 0, lastSeenAt: 0,
        mentionCount: 0, confidence: 1, createdAt: Date.now(), updatedAt: Date.now(),
      };
    }
    return brain.entities[id];
  }

  function touchEntity(entity, now) {
    entity.mentionCount = (Number(entity.mentionCount) || 0) + 1;
    entity.lastSeenAt = now;
    if (!entity.firstSeenAt) entity.firstSeenAt = now;
  }

  function bucketSet(entityId) {
    if (!buckets.has(entityId)) buckets.set(entityId, new Set());
    return buckets.get(entityId);
  }

  function candidatesFor(entityIds) {
    // 真实 service 每次 remember 会扫全量 memories；20 万条时不可行。
    // 这里用「每个实体桶最近 40 条 + 均匀抽样 40 条」近似近邻候选，控制单次写入成本。
    const picked = new Map();
    for (const eid of entityIds) {
      const bucket = buckets.get(eid);
      if (!bucket) continue;
      const ids = [...bucket];
      const recentCount = Math.min(40, ids.length);
      for (let i = ids.length - recentCount; i < ids.length; i += 1) picked.set(ids[i], true);
      const older = ids.length - recentCount;
      const sample = Math.min(40, older);
      for (let i = 0; i < sample; i += 1) {
        const pickIndex = older - 1 - Math.floor(((i + 1) * older) / (sample + 1));
        picked.set(ids[pickIndex], true);
      }
    }
    return [...picked.keys()].filter((id) => {
      const memory = brain.memories[id];
      return memory && memory.status !== 'archived';
    });
  }

  function archive(memory, reason, now) {
    if (!memory || memory.status === 'archived') return;
    memory.status = 'archived';
    memory.archivedAt = now;
    memory.archivedReason = reason;
    memory.updatedAt = now;
  }

  function activeTotalCount() {
    return activeLong + activeShort;
  }

  function layerCap(layer) {
    return layer === 'long' ? brain.config.maxMemoriesLong : brain.config.maxMemoriesShort;
  }

  function activeInLayer(layer) {
    return layer === 'long' ? activeLong : activeShort;
  }

  function adjust(layer, delta) {
    if (layer === 'long') activeLong += delta;
    else activeShort += delta;
  }

  function enforceCapacity(now, forcedLayer = '') {
    for (const layer of forcedLayer ? [forcedLayer] : ['long', 'short']) {
      const cap = layerCap(layer);
      if (activeInLayer(layer) <= cap) continue;
      // 近似 MemoryService._enforceMaxMemories：按「强度×新近」找同层最弱的非永久/日记归档。
      const victims = [];
      for (const memory of Object.values(brain.memories)) {
        if (!memory || memory.status === 'archived' || isPermanent(memory) || isDiaryMemory(memory)) continue;
        if ((memory.layer === 'long' ? 'long' : 'short') !== layer) continue;
        const strength = Number(memory.strength) || computeStrength(memory, now);
        victims.push({ memory, rank: strength * 0.7 + recencyScore(memory, now) * 0.3 });
      }
      victims.sort((a, b) => a.rank - b.rank);
      for (let i = 0; i < victims.length && activeInLayer(layer) > cap; i += 1) {
        archive(victims[i].memory, 'capacity', now);
        adjust(layer, -1);
        if (layer === 'long') counters.archivedCapacityLong += 1;
        else counters.archivedCapacityShort += 1;
        counters.archivedCapacity += 1;
      }
    }
  }

  function remember(msg, now) {
    const entity = entityFor(msg.theme, 'topic');
    touchEntity(entity, now);
    const entityIds = [entity.id];
    const category = msg.kind === 'preference' ? 'preference'
      : msg.kind === 'decision' ? 'fact'
      : msg.kind === 'promise' ? 'promise'
      : 'topic';
    const layer = msg.kind === 'decision' || msg.kind === 'promise' ? 'long' : 'short';
    const decayDays = layer === 'long' ? brain.config.decayDaysLong : brain.config.decayDaysShort;
    const title = `${msg.theme}${msg.kind === 'decision' ? '·决定' : msg.kind === 'preference' ? '·偏好' : msg.kind === 'promise' ? '·答应' : '·进展'}`;

    // 去重 / 合并（先按长度比粗筛，避免对每个候选都做分词相似度）
    let best = null;
    let bestSim = 0;
    const inputLength = `${title}\n${msg.text}`.length;
    for (const id of candidatesFor(entityIds)) {
      const memory = brain.memories[id];
      if (!memory || memory.status === 'archived') continue;
      const candidateLength = `${memory.title}\n${memory.text}`.length;
      const ratio = Math.min(inputLength, candidateLength) / Math.max(1, Math.max(inputLength, candidateLength));
      if (ratio < 0.55) continue;
      const sim = textSimilarity(`${title}\n${msg.text}`, `${memory.title}\n${memory.text}`);
      if (sim > bestSim) { bestSim = sim; best = memory; }
    }
    if (best && bestSim >= DEDUPE_THRESHOLD) {
      best.activationCount = (Number(best.activationCount) || 0) + 1;
      best.baseStrength = 1;
      best.updatedAt = now;
      if (!best.entityIds.includes(entity.id)) best.entityIds.push(entity.id);
      counters.merged += 1;
      return { memory: best, merged: true };
    }

    // 矛盾降权（近似 service._applySupersede：只看同主题候选，且候选 ≤2 才自动生效）
    let supersededId = '';
    const conflicts = [];
    if (msg.kind === 'decision') {
      for (const id of candidatesFor(entityIds)) {
        const memory = brain.memories[id];
        if (!memory || memory.status !== 'active') continue;
        if (isPermanent(memory) || isDiaryMemory(memory)) continue;
        const result = detectContradiction(memory, { title, text: msg.text });
        if (result.conflict && result.score >= 0.4) conflicts.push({ memory, score: result.score });
      }
    }
    if (conflicts.length > 0 && conflicts.length <= 2) {
      conflicts.sort((a, b) => b.score - a.score);
      const target = conflicts[0].memory;
      target.status = 'superseded';
      target.supersededBy = `mem_pending_${order}`;
      target.supersededAt = now;
      target.deprioritized = true;
      target.updatedAt = now;
      supersededId = target.id;
      counters.superseded += 1;
    }

    order += 1;
    const id = `mem_${sha1(`${title}|${now}|${order}`).slice(0, 12)}`;
    const memory = {
      id, title, text: msg.text, layer, category, tags: [msg.theme], keywords: [msg.theme],
      entityIds, protection: 0, source: { kind: msg.isGroup ? 'group' : 'private', key: msg.isGroup ? 'group:100000003' : 'private:100000001', seqs: [msg.n], createdBy: 'sim' },
      strength: 1, baseStrength: 1, decayDays, status: 'active', activationCount: 1,
      createdAt: now, updatedAt: now, lastActivatedAt: now,
      permanent: false, diary: false, fadingSince: null, purgeAfter: 0,
      supersedes: supersededId ? [supersededId] : [],
      supersededBy: null, supersededAt: null, deprioritized: false,
      decayCurve: 'linear', archivedAt: null, archivedReason: null, mergedInto: null,
    };
    brain.memories[id] = memory;
    bucketSet(entity.id).add(id);
    memoriesSpan.set(id, msg.day);
    counters.created += 1;
    adjust(layer, 1);
    if (supersededId) {
      const old = brain.memories[supersededId];
      if (old) old.supersededBy = id;
    }
    sinceCapacity += 1;
    if (sinceCapacity >= 200) {
      sinceCapacity = 0;
      enforceCapacity(now);
    }
    return { memory, merged: false };
  }

  function recall(now, { theme, limit = 6 }) {
    const started = process.hrtime.bigint();
    const entity = entityFor(theme, 'topic');
    const ids = candidatesFor([entity.id]).filter((id) => brain.memories[id] && brain.memories[id].status === 'active');
    if (!ids.length) {
      return { top: [], expected: null, hit: false, ageDays: 0, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
    }
    // 目标记忆：60% 偏向较新的一小撮，40% 均匀抽，用来观察不同年龄的召回命中
    const recentWindow = Math.max(1, Math.ceil(ids.length * 0.2));
    const expected = rand01() < 0.6
      ? ids[Math.max(0, ids.length - 1 - Math.floor(rand01() * recentWindow))]
      : ids[Math.floor(rand01() * ids.length)];
    const scored = [];
    for (const id of ids) {
      scored.push([id, scoreMemory(brain.memories[id], { query: theme, now, entityHit: 1 })]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const top = scored.slice(0, limit).map(([id]) => id);
    // 强化 + 共激活
    for (const id of top.slice(0, 3)) {
      const memory = brain.memories[id];
      memory.activationCount = (Number(memory.activationCount) || 0) + 1;
      memory.lastActivatedAt = now;
    }
    for (let i = 0; i < top.length; i += 1) {
      for (let j = i + 1; j < top.length; j += 1) {
        const pair = [top[i], top[j]].sort();
        const sid = `syn_${sha1(pair.join('|') + '|COACTIVATED').slice(0, 16)}`;
        if (synIndex.has(sid)) continue;
        synIndex.add(sid);
        brain.synapses.push({ id: sid, from: pair[0], to: pair[1], type: 'COACTIVATED', coactivations: 1, weight: hebbianWeight(1), loop: 1, createdAt: now, lastAt: now });
        if (brain.synapses.length > 5000) { const dropped = brain.synapses.shift(); if (dropped) synIndex.delete(dropped.id); }
      }
    }
    const target = brain.memories[expected];
    const ageDays = target ? Math.max(0, (now - (Number(target.createdAt) || now)) / DAY) : 0;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { top, expected, hit: top.includes(expected), ageDays, elapsedMs };
  }

  function dailyTick(now) {
    const result = materializeBrain(brain, now, brain.config, { archive: true });
    counters.archivedDecay += Number(result.archived?.length) || 0;
    // materializeBrain 直接改 archived 状态，这里重算一次各层非归档数
    activeLong = 0;
    activeShort = 0;
    for (const memory of Object.values(brain.memories)) {
      if (!memory || memory.status === 'archived') continue;
      adjust(memory.layer === 'long' ? 'long' : 'short', 1);
    }
    enforceCapacity(now);
    return result;
  }

  function consolidate(now) {
    // 近似 service.consolidate：short→long 提升 + 同实体近重复归档（避免 O(n²)）。
    const memories = Object.values(brain.memories);
    for (const memory of memories) {
      if (!memory || memory.status !== 'active' || memory.layer !== 'short') continue;
      if (isDiaryMemory(memory) || isPermanent(memory)) continue;
      if ((Number(memory.activationCount) || 0) < 3) continue;
      if ((Number(memory.strength) || computeStrength(memory, now)) < 0.5) continue;
      memory.layer = 'long';
      memory.decayDays = brain.config.decayDaysLong;
      memory.updatedAt = now;
      activeShort -= 1;
      activeLong += 1;
      counters.promoted += 1;
    }
    for (const [entityId, bucket] of buckets) {
      void entityId;
      const list = [...bucket]
        .slice(-240)
        .map((id) => brain.memories[id])
        .filter((m) => m && m.status === 'active' && m.category !== 'day' && !isPermanent(m) && !isDiaryMemory(m));
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i];
          const b = list[j];
          if (!a || !b || a.status === 'archived' || b.status === 'archived') continue;
          if (a.category !== b.category) continue;
          const sim = textSimilarity(`${a.title}\n${a.text}`, `${b.title}\n${b.text}`);
          if (sim < 0.92) continue;
          const weight = (m) => (Number(m.activationCount) || 0) * 1000 + (Number(m.updatedAt) || 0);
          const [keep, drop] = weight(a) >= weight(b) ? [a, b] : [b, a];
          drop.status = 'archived';
          drop.archivedAt = now;
          drop.archivedReason = 'duplicate';
          drop.mergedInto = keep.id;
          counters.archivedDuplicate += 1;
        }
      }
    }
    activeLong = 0;
    activeShort = 0;
    for (const memory of Object.values(brain.memories)) {
      if (!memory || memory.status === 'archived') continue;
      adjust(memory.layer === 'long' ? 'long' : 'short', 1);
    }
  }

  function sizeBytes() {
    return Buffer.byteLength(JSON.stringify(brain), 'utf8');
  }

  function snapshot() {
    return { active: activeLong + activeShort, activeLong, activeShort, total: Object.keys(brain.memories).length };
  }

  return { brain, counters, remember, recall, dailyTick, consolidate, sizeBytes, snapshot, memoriesSpan };
}

// ── 主流程 ────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[index];
}

export function runSimulation(options) {
  const startedAt = Date.now();
  const corpus = generateCorpus(options);
  const engine = createEngine({ capLong: options.capLong, capShort: options.capShort });
  const brainById = (id) => (id ? engine.brain.memories[id] : null);
  const dayCount = options.days;
  const recallEvery = Math.max(20, Math.floor(options.messages / 4000));
  const recallStats = { queries: 0, hit1: 0, hit6: 0, misses: 0, latencies: [], byAge: { fresh: { q: 0, hit: 0 }, mid: { q: 0, hit: 0 }, old: { q: 0, hit: 0 } } };
  const decisionStats = { queries: 0, hits: 0 };
  const decisionByTheme = new Map();
  const topicStats = { queries: 0, hits: 0 };
  const latestByTheme = new Map();
  const activeOverTime = [];
  const perDayNew = [];
  let dayCursor = 0;
  let newThisDay = 0;
  const rand = mulberry32(options.seed + 7);

  for (let index = 0; index < corpus.length; index += 1) {
    const msg = corpus[index];
    while (dayCursor < msg.day) {
      // 每天收尾：衰减归档 + 每周巩固
      const dayEnd = dayStart + dayCursor * DAY + DAY - 1;
      engine.dailyTick(dayEnd);
      if (dayCursor % 7 === 6) engine.consolidate(dayEnd);
      activeOverTime.push({ day: dayCursor, ...engine.snapshot() });
      perDayNew.push(newThisDay);
      newThisDay = 0;
      dayCursor += 1;
    }
    const now = msg.ts;
    const shouldRemember = msg.kind === 'fact' || msg.kind === 'preference' || msg.kind === 'decision' || msg.kind === 'promise' || (msg.kind === 'remention' && rand() < 0.6);
    if (!shouldRemember) {
      if (msg.kind === 'noise' || msg.kind === 'chitchat') engine.counters.chitchatIgnored += 1;
    } else {
      const before = engine.counters.created + engine.counters.merged;
      const result = engine.remember(msg, now);
      if (result.memory) latestByTheme.set(msg.theme, result.memory.id);
      if (!result.merged) {
        newThisDay += 1;
        if (msg.kind === 'decision') decisionByTheme.set(msg.theme, result.memory.id);
      } else if (before === engine.counters.created + engine.counters.merged) {
        // no-op
      }
    }

    if (index % recallEvery === 0 && index > 0) {
      // 随机挑主题发起一次召回；目标记忆由 recall() 从活跃桶里按年龄分布抽取
      const theme = THEMES[Math.floor(rand() * THEMES.length)];
      const result = engine.recall(now, { theme, limit: 6 });
      recallStats.queries += 1;
      recallStats.latencies.push(result.elapsedMs);
      const bucket = result.ageDays < 7 ? 'fresh' : result.ageDays < 30 ? 'mid' : 'old';
      recallStats.byAge[bucket].q += 1;
      if (result.hit) {
        recallStats.hit6 += 1;
        recallStats.byAge[bucket].hit += 1;
      } else {
        recallStats.misses += 1;
      }
      // 指定主题「最近一次决定」能不能被召回（更接近真实提问）
      const decisionId = decisionByTheme.get(theme);
      const decisionMemory = decisionId ? brainById(decisionId) : null;
      if (decisionMemory && decisionMemory.status === 'active') {
        decisionStats.queries += 1;
        if (result.top.includes(decisionId)) decisionStats.hits += 1;
      }
      // v1.6 主题召回：这个主题最近一条记忆（不区分决定/进展）能否被 top6 带回来
      const latestId = latestByTheme.get(theme);
      const latestMemory = latestId ? brainById(latestId) : null;
      if (latestMemory && latestMemory.status === 'active') {
        topicStats.queries += 1;
        if (result.top.includes(latestId)) topicStats.hits += 1;
      }
    }
  }
  // 收尾：剩余天
  for (let rest = dayCursor; rest < dayCount; rest += 1) {
    const dayEnd = dayStart + rest * DAY + DAY - 1;
    engine.dailyTick(dayEnd);
    if (rest % 7 === 6) engine.consolidate(dayEnd);
    activeOverTime.push({ day: rest, ...engine.snapshot() });
    perDayNew.push(newThisDay);
    newThisDay = 0;
  }
  // 最后再跑一次容量检查，保证收尾时不超过上限
  engine.dailyTick(dayStart + dayCount * DAY - 1);

  const brain = engine.brain;
  const memories = Object.values(brain.memories);
  const active = memories.filter((m) => m.status === 'active');
  const archived = memories.filter((m) => m.status === 'archived');
  const superseded = memories.filter((m) => m.status === 'superseded');
  const diaries = memories.filter((m) => isDiaryMemory(m));
  const cohortDays = [0, Math.floor(dayCount / 2), dayCount - 1].filter((d, i, arr) => arr.indexOf(d) === i && d >= 0);
  const survival = cohortDays.map((day) => {
    const ids = [...engine.memoriesSpan.entries()].filter(([, d]) => d === day).map(([id]) => id);
    if (!ids.length) return { day, created: 0, active: 0, rate: 0 };
    const alive = ids.filter((id) => brain.memories[id] && brain.memories[id].status === 'active').length;
    return { day, created: ids.length, active: alive, rate: Math.round((alive / ids.length) * 1000) / 10 };
  });
  const latencies = recallStats.latencies.slice().sort((a, b) => a - b);
  const total = corpus.length;
  const elapsedMs = Date.now() - startedAt;
  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      capLong: options.capLong,
      capShort: options.capShort,
      maxMemories: options.capLong + options.capShort,
      decayDaysLong: brain.config.decayDaysLong,
      decayDaysShort: brain.config.decayDaysShort,
      dedupeThreshold: DEDUPE_THRESHOLD,
    },
    corpus: { messages: total, days: options.days, perDay: Math.round(total / options.days), seed: options.seed },
    memory: {
      created: engine.counters.created,
      merged: engine.counters.merged,
      superseded: engine.counters.superseded,
      archivedDecay: engine.counters.archivedDecay,
      archivedCapacity: engine.counters.archivedCapacity,
      archivedCapacityLong: engine.counters.archivedCapacityLong,
      archivedCapacityShort: engine.counters.archivedCapacityShort,
      archivedDuplicate: engine.counters.archivedDuplicate,
      promoted: engine.counters.promoted,
      chitchatIgnored: engine.counters.chitchatIgnored,
      active: active.length,
      activeLong: active.filter((m) => m.layer === 'long').length,
      activeShort: active.filter((m) => m.layer !== 'long').length,
      archived: archived.length,
      supersededCount: superseded.length,
      diaries: diaries.length,
      createdPerMessage: Math.round((engine.counters.created / total) * 1000) / 1000,
      entities: Object.keys(brain.entities).length,
      relations: brain.relations.length,
      synapses: brain.synapses.length,
      journalBytes: engine.sizeBytes(),
      perMessageBytes: Math.round((engine.sizeBytes() / total) * 100) / 100,
    },
    recall: {
      queries: recallStats.queries,
      hitRate: recallStats.queries ? Math.round((recallStats.hit6 / recallStats.queries) * 1000) / 10 : 0,
      missRate: recallStats.queries ? Math.round((recallStats.misses / recallStats.queries) * 1000) / 10 : 0,
      decisionQueries: decisionStats.queries,
      decisionHitRate: decisionStats.queries ? Math.round((decisionStats.hits / decisionStats.queries) * 1000) / 10 : 0,
      topicQueries: topicStats.queries,
      topicHitRate: topicStats.queries ? Math.round((topicStats.hits / topicStats.queries) * 1000) / 10 : 0,
      byAge: Object.fromEntries(Object.entries(recallStats.byAge).map(([key, value]) => [key, { queries: value.q, hitRate: value.q ? Math.round((value.hit / value.q) * 1000) / 10 : 0 }])),
      latencyMs: { p50: Math.round(percentile(latencies, 50) * 100) / 100, p95: Math.round(percentile(latencies, 95) * 100) / 100, max: Math.round((latencies[latencies.length - 1] || 0) * 100) / 100 },
    },
    survival,
    activeOverTime,
    perDayNewMemories: { max: Math.max(0, ...perDayNew), avg: Math.round((perDayNew.reduce((a, b) => a + b, 0) / Math.max(1, perDayNew.length)) * 10) / 10 },
    elapsedMs,
    throughputPerSec: Math.round((total / (elapsedMs / 1000)) * 10) / 10,
  };
  return report;
}

async function realProbe({ count, capLong, capShort }) {
  const { MemoryService } = await import('../src/memory/service.mjs');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sim-real-'));
  const svc = new MemoryService({ repoRoot: tempRoot, now: () => Date.now() });
  const rand = mulberry32(99);
  const started = Date.now();
  for (let i = 0; i < count; i += 1) {
    const theme = THEMES[Math.floor(rand() * THEMES.length)];
    svc.remember({
      title: `${theme}·进展 ${i}`,
      text: `${makeQuote(theme, 'fact', rand)} 第 ${i} 条。`,
      layer: 'short',
      category: 'topic',
      entities: [{ name: theme, type: 'topic' }],
    });
  }
  const elapsedMs = Date.now() - started;
  fs.rmSync(tempRoot, { recursive: true, force: true });
  return { count, capLong, capShort, elapsedMs, perWriteMs: Math.round((elapsedMs / count) * 100) / 100, projected200kHours: Math.round((count ? (elapsedMs / count) * 200_000 / 3_600_000 : 0) * 10) / 10 };
}

function printReport(report, probe) {
  const m = report.memory;
  const r = report.recall;
  const lastActive = report.activeOverTime[report.activeOverTime.length - 1];
  console.log('记忆网络规模仿真');
  console.log(`  配置：long 配额 ${report.config.capLong.toLocaleString()} / short 配额 ${report.config.capShort.toLocaleString()}，长/短衰减 ${report.config.decayDaysLong}/${report.config.decayDaysShort} 天，去重阈值 ${report.config.dedupeThreshold}`);
  console.log(`  语料：${report.corpus.messages.toLocaleString()} 条 / ${report.corpus.days} 天（约 ${report.corpus.perDay}/天，seed ${report.corpus.seed}）`);
  console.log(`  记忆形成：新建 ${m.created.toLocaleString()}（${(m.createdPerMessage * 100).toFixed(1)}%/消息）、合并 ${m.merged.toLocaleString()}（${m.merged && (m.merged / (m.created + m.merged) * 100).toFixed(1)}% 写入被去重）、矛盾降权 ${m.superseded.toLocaleString()}`);
  console.log(`  淘汰：容量 ${m.archivedCapacity.toLocaleString()}（long ${m.archivedCapacityLong} / short ${m.archivedCapacityShort}）、衰减 ${m.archivedDecay.toLocaleString()}、近重复 ${m.archivedDuplicate.toLocaleString()}；最终活跃 ${m.active.toLocaleString()}（long ${m.activeLong} / short ${m.activeShort}）/ 已归档 ${m.archived.toLocaleString()} / 已取代 ${m.supersededCount.toLocaleString()}`);
  console.log(`  规模：实体 ${m.entities}、突触 ${m.synapses}；brain JSON ${(m.journalBytes / 1024 / 1024).toFixed(2)} MB（${m.perMessageBytes} B/消息）`);
  console.log(`  召回：主题召回 ${r.topicQueries} 次命中 ${r.topicHitRate}%；最近决策 ${r.decisionQueries} 次命中 ${r.decisionHitRate}%；随机目标参考 ${r.queries} 次命中 ${r.hitRate}%；P50 ${r.latencyMs.p50}ms / P95 ${r.latencyMs.p95}ms`);
  const ageParts = Object.entries(r.byAge).filter(([, v]) => v.queries > 0).map(([k, v]) => `${k} ${v.hitRate}%（${v.queries} 次）`);
  console.log(`  按年龄：${ageParts.length ? ageParts.join(' / ') : '（全部查询目标都在 7 天内）'}`);
  console.log(`  存活：${report.survival.map((s) => `第 ${s.day + 1} 天出生 ${s.created} 条→活跃 ${s.rate}%`).join('；')}`);
  console.log(`  活跃曲线：${report.activeOverTime.filter((_, i) => i % Math.max(1, Math.floor(report.activeOverTime.length / 6)) === 0).map((x) => `D${x.day}:${x.active}`).join(' → ')} → 最终 ${report.memory.active.toLocaleString()}`);
  console.log(`  速度：${report.throughputPerSec.toLocaleString()} 消息/秒，总耗时 ${(report.elapsedMs / 1000).toFixed(1)}s`);
  if (probe) {
    console.log(`  真机对照：MemoryService 写 ${probe.count} 条耗时 ${probe.elapsedMs}ms（${probe.perWriteMs}ms/条，数据量越大越慢）→ 20 万条顺序写盘乐观估计 ${probe.projected200kHours} 小时，实际会因全量 normalize+save 的 O(n²) 更差。`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/memory-sim.mjs --messages 200000 --days 60 --seed 42 [--cap-long 20000] [--cap-short 5000] [--cap N（同设两层）] [--json-out path] [--real-probe 500]');
    return;
  }
  const report = runSimulation(args);
  let probe = null;
  if (args.realProbe > 0) {
    try { probe = await realProbe({ count: args.realProbe, capLong: args.capLong, capShort: args.capShort }); } catch (error) { console.error('real probe 失败：', error.message); }
  }
  if (args.jsonOut) {
    const outPath = path.isAbsolute(args.jsonOut) ? args.jsonOut : path.join(ROOT, args.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ report, probe }, null, 2));
    console.log(`报告已写入 ${outPath}`);
  }
  printReport(report, probe);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
