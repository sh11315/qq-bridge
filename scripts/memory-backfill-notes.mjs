#!/usr/bin/env node
/**
 * 记忆实体备注回填（memory entity notes backfill）
 *
 * 目的：brain.json 里不少实体 note 为空。此脚本从以下来源回填**空备注**，不覆盖已有备注：
 *   1) state/slang.json —— 黑话/梗：content → 含义/用法（term 实体）
 *   2) state/social-v2.json —— 群聊最近消息：发言人 → 发言条数/最近时间/典型发言（person 实体）
 *   3) state/slang.json 的 evidence —— 黑话证据里的发言人发言（比最近消息窗口更早）
 *   4) 桥接在线时 GET /api/socialV2/group-members —— 补充 QQ 号/昵称/群名片
 *   5) brain.memories / activeTopics / 聊天消息 —— 话题实体的相关记忆与上下文（topic 实体）
 *
 * 用法：
 *   node scripts/memory-backfill-notes.mjs [--root <repo>] [--state <stateDir>] [--dry-run] [--json] [--offline] [--help]
 *   --offline  不访问桥接（只用本地 state 文件）
 *   --dry-run  只打印将写入的备注，不落盘
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/memory/store.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

function parseArgs(argv) {
  const opts = { root: REPO_ROOT, state: '', dryRun: false, json: false, offline: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') opts.root = path.resolve(String(argv[++i] ?? ''));
    else if (arg === '--state') opts.state = path.resolve(String(argv[++i] ?? ''));
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--offline') opts.offline = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!opts.state) opts.state = path.join(opts.root, 'state');
  return opts;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function norm(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

const MEDIA_RE = /\[(?:图片|表情[^\]]*|动画表情|文件[^\]]*|语音[^\]]*|视频[^\]]*|转发消息[^\]]*|拍一拍[^\]]*|红包[^\]]*|链接[^\]]*|音乐[^\]]*)\]/g;

/** 不适合写进备注的发言样本：系统日志、拍一拍、露骨内容（备注会进模型上下文）。 */
const SAMPLE_BLOCK_RE = /(?:qq_onebot|GroupMessage|UMO:|\[CQ:|拍了拍|收到文件|token来|色情|裸|脱光|小穴|做爱|约炮|淫|高潮|肉棒|奶子|性交|射精|怀孕|未成年|调教成)/i;

function isUsableSample(text) {
  if (!text || !hasMeaningfulText(text)) return false;
  return !SAMPLE_BLOCK_RE.test(text);
}

function cleanSnippet(raw, max = 60) {
  let text = String(raw ?? '');
  text = text.replace(/\[引用[^\]]*\]/g, ' ');
  text = text.replace(MEDIA_RE, ' ');
  text = text.replace(/[「」『』"]/g, ' ');
  text = norm(text);
  if (!text) return '';
  if (/^[\s。，、！？!?.,~～…]+$/.test(text)) return '';
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

function hasMeaningfulText(text) {
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(text);
}

function fmtDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function clipNote(text, max = 500) {
  const clean = norm(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function buildSlangMap(slangList) {
  const map = new Map();
  for (const entry of Array.isArray(slangList) ? slangList : []) {
    const content = norm(entry?.content);
    if (!content) continue;
    const meaning = norm(entry?.meaning);
    const usage = norm(entry?.usage);
    const example = norm(entry?.example);
    if (!meaning && !usage) continue;
    const note = [
      meaning ? `含义：${meaning}` : '',
      usage ? `用法：${usage}` : '',
      example ? `例子：${example}` : '',
    ].filter(Boolean).join('；');
    map.set(content.toLowerCase(), clipNote(note));
  }
  return map;
}

function buildSlangEvidence(slangList) {
  const bySender = new Map();
  for (const entry of Array.isArray(slangList) ? slangList : []) {
    const evidence = Array.isArray(entry?.evidence) ? entry.evidence : [];
    for (const item of evidence) {
      const sender = norm(item?.sender);
      const text = cleanSnippet(item?.text);
      const time = Number(item?.time) || 0;
      if (!sender || !text || sender === '我') continue;
      const bucket = bySender.get(sender) ?? { count: 0, lastSeenAt: 0, samples: [], texts: new Set() };
      bucket.count += 1;
      bucket.lastSeenAt = Math.max(bucket.lastSeenAt, time);
      if (hasMeaningfulText(text) && text.length >= 4 && !bucket.texts.has(text)) {
        bucket.texts.add(text);
        bucket.samples.push(text);
      }
      bySender.set(sender, bucket);
    }
  }
  return bySender;
}

function buildChatStats(social) {
  const bySender = new Map();
  const byTopic = new Map();
  const conversations = social?.conversations && typeof social.conversations === 'object' ? social.conversations : {};
  for (const [key, conv] of Object.entries(conversations)) {
    const isGroup = key.startsWith('group:');
    const messages = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
    for (const msg of messages) {
      const sender = norm(msg?.sender);
      const text = cleanSnippet(msg?.plain ?? msg?.text);
      const time = Number(msg?.time) || 0;
      const self = msg?.isSelf === true || sender === '我';
      if (isGroup && !self && sender && sender !== '私聊') {
        const bucket = bySender.get(sender) ?? { count: 0, lastSeenAt: 0, samples: [], texts: new Set(), userId: '' };
        bucket.count += 1;
        bucket.lastSeenAt = Math.max(bucket.lastSeenAt, time);
        if (msg?.userId) bucket.userId = String(msg.userId);
        if (hasMeaningfulText(text) && text.length >= 4 && bucket.samples.length < 6 && !bucket.texts.has(text)) {
          bucket.texts.add(text);
          bucket.samples.push(text);
        }
        bySender.set(sender, bucket);
      }
      if (text) {
        const plain = norm(msg?.plain ?? msg?.text);
        for (const token of new Set(plain.match(/[\u4e00-\u9fffA-Za-z0-9_#]{2,20}/g) ?? [])) {
          const bucket = byTopic.get(token) ?? [];
          if (bucket.length < 5 && !bucket.includes(text)) bucket.push(text);
          byTopic.set(token, bucket);
        }
      }
    }
  }
  return { bySender, byTopic };
}

async function fetchGroupMembers({ root, stateDir, social, offline }) {
  if (offline) return { members: [], reason: 'offline' };
  const tokenFile = path.join(stateDir, 'console-token');
  if (!fs.existsSync(tokenFile)) return { members: [], reason: 'no-token' };
  const conversations = social?.conversations ?? {};
  const groupKey = Object.keys(conversations).find((k) => k.startsWith('group:'));
  if (!groupKey) return { members: [], reason: 'no-group' };
  const consoleToken = fs.readFileSync(tokenFile, 'utf8').trim();
  const agentToken = String(conversations[groupKey]?.agentToken ?? '');
  try {
    const url = `http://127.0.0.1:3100/api/socialV2/group-members?key=${encodeURIComponent(groupKey)}&limit=200&token=${encodeURIComponent(consoleToken)}`;
    const res = await fetch(url, {
      headers: agentToken ? { 'x-agent-token': agentToken } : {},
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { members: [], reason: `http-${res.status}` };
    const data = await res.json();
    const members = Array.isArray(data?.members) ? data.members : [];
    return { members, reason: `ok-${members.length}` };
  } catch (error) {
    return { members: [], reason: `fetch-failed:${error?.message ?? error}` };
  }
}

function buildMemberMap(members) {
  const map = new Map();
  for (const member of Array.isArray(members) ? members : []) {
    const nickname = norm(member?.nickname);
    const card = norm(member?.card);
    const userId = norm(member?.userId);
    const entry = { nickname, card, userId };
    if (nickname) map.set(nickname.toLowerCase(), entry);
    if (card && card !== nickname) map.set(card.toLowerCase(), entry);
  }
  return map;
}

function pickSamples(samples, max = 2) {
  const usable = [...new Set(samples.filter((text) => isUsableSample(text)))];
  // 备注会长期进模型上下文：只挑短、干净、像本人原话的句子，长段引用/转发不要。
  const clean = usable.filter((text) => {
    if (text.length < 4 || text.length > 32) return false;
    if (/^[^\u4e00-\u9fffA-Za-z0-9]/.test(text)) return false; // 表情/符号开头
    if (/^[\d０-９]/.test(text)) return false; // 编号式引用
    if (/——|群圣经|变态/.test(text)) return false;
    return true;
  });
  return clean.sort((a, b) => a.length - b.length).slice(0, max);
}

function suggestPersonNote({ name, chat, evidence, members }) {
  const key = name.toLowerCase();
  const member = members.get(key) ?? null;
  const chatStat = chat.get(name) ?? null;
  const evStat = evidence.get(name) ?? null;
  const parts = [];
  const role = member ? '群友' : chatStat ? '群友' : evStat ? '群友' : '';
  if (!role) return '';
  parts.push(role);
  if (member?.nickname && member.nickname !== name) parts.push(`昵称「${member.nickname}」`);
  if (member?.card && member.card !== name) parts.push(`群名片「${member.card}」`);
  const userId = member?.userId || chatStat?.userId || '';
  if (userId) parts.push(`QQ ${userId}`);
  const meta = [];
  const count = (chatStat?.count ?? 0) + (evStat?.count ?? 0);
  if (count) meta.push(`最近记录 ${count} 条`);
  const lastSeen = Math.max(chatStat?.lastSeenAt ?? 0, evStat?.lastSeenAt ?? 0);
  if (lastSeen) meta.push(`最近发言 ${fmtDate(lastSeen)}`);
  if (meta.length) parts.push(meta.join('，'));
  const samples = pickSamples([...(chatStat?.samples ?? []), ...(evStat?.samples ?? [])], 2);
  if (samples.length) parts.push(`典型发言：${samples.map((text) => `「${text}」`).join('')}`);
  return clipNote(parts.join('；'));
}

function suggestTopicNote({ name, entityId, brain, topics, chatTopics }) {
  const relations = [];
  const entitiesById = brain?.entities ?? {};
  for (const relation of Array.isArray(brain?.relations) ? brain.relations : []) {
    if (relation.from !== entityId && relation.to !== entityId) continue;
    const otherId = relation.from === entityId ? relation.to : relation.from;
    const other = entitiesById[otherId];
    if (!other || !norm(other.name)) continue;
    const label = norm(relation.relation) ? `${relation.relation} ${other.name}` : other.name;
    if (!relations.includes(label) && relations.length < 3) relations.push(label);
  }

  const titleMatches = [];
  const textMatches = [];
  for (const memory of Object.values(brain?.memories ?? {})) {
    const title = norm(memory?.title);
    const text = norm(memory?.text);
    if (title.includes(name)) titleMatches.push(title || text.slice(0, 40));
    else if (text.includes(name)) textMatches.push(title || text.slice(0, 40));
  }

  const evidences = [];
  if (relations.length) evidences.push(`关联：${relations.join('、')}`);
  const memoryLabels = [...titleMatches.slice(0, 2), ...textMatches.slice(0, 2)].filter(Boolean).slice(0, 2);
  if (memoryLabels.length) evidences.push(`相关记忆：${memoryLabels.map((title) => `「${title}」`).join('')}`);
  for (const topic of Array.isArray(topics) ? topics : []) {
    const text = norm(topic?.text);
    if (text.includes(name)) evidences.push(`话题「${text.slice(0, 60)}」`);
    if (evidences.length >= 4) break;
  }
  const chatSamples = (chatTopics.get(name) ?? []).slice(0, 2).map((text) => `「${text}」`).join('');
  if (chatSamples) evidences.push(`相关聊天：${chatSamples}`);
  if (!evidences.length) return '';
  return clipNote(`话题；${evidences.join('；')}`);
}

function suggestTermNote({ name, aliases, slangMap }) {
  for (const candidate of [name, ...(Array.isArray(aliases) ? aliases : [])]) {
    const hit = slangMap.get(norm(candidate).toLowerCase());
    if (hit) return hit;
  }
  return '';
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(2);
  }
  if (opts.help) {
    console.log('用法：node scripts/memory-backfill-notes.mjs [--root <repo>] [--state <stateDir>] [--dry-run] [--json] [--offline]');
    return;
  }

  const stateDir = opts.state;
  const store = new MemoryStore({ repoRoot: opts.root, stateDir });
  if (!fs.existsSync(store.paths().brainPath)) {
    console.error(`找不到 brain.json：${store.paths().brainPath}`);
    process.exit(1);
  }

  const slangList = readJson(path.join(stateDir, 'slang.json'), []);
  const social = readJson(path.join(stateDir, 'social-v2.json'), {});
  const slangMap = buildSlangMap(slangList);
  const evidence = buildSlangEvidence(slangList);
  const { bySender: chat, byTopic: chatTopics } = buildChatStats(social);
  const memberResult = await fetchGroupMembers({ root: opts.root, stateDir, social, offline: opts.offline });
  const members = buildMemberMap(memberResult.members);
  const activeTopics = [];
  for (const conv of Object.values(social?.conversations ?? {})) {
    if (Array.isArray(conv?.activeTopics)) activeTopics.push(...conv.activeTopics);
  }

  const brain = store.load();
  const suggestions = [];
  const scanned = Object.values(brain?.entities ?? {});
  for (const entity of scanned) {
    const name = norm(entity?.name);
    if (!name) continue;
    if (norm(entity?.note)) continue;
    let note = '';
    if (entity.type === 'term') note = suggestTermNote({ name, aliases: entity.aliases, slangMap });
    else if (entity.type === 'person') note = suggestPersonNote({ name, chat, evidence, members });
    else if (entity.type === 'topic') {
      note = suggestTopicNote({ name, entityId: String(entity.id), brain, topics: activeTopics, chatTopics });
    }
    if (note) suggestions.push({ id: String(entity.id), name, type: entity.type, note });
  }

  if (opts.dryRun) {
    printResult(opts, { scanned: scanned.length, filled: 0, suggestions, memberResult, dryRun: true, stateDir });
    return;
  }

  let filled = 0;
  if (suggestions.length) {
    store.withLock(() => {
      const latest = store.load();
      for (const suggestion of suggestions) {
        const entity = latest.entities?.[suggestion.id];
        if (!entity) continue;
        if (norm(entity.note)) continue;
        entity.note = suggestion.note;
        entity.updatedAt = new Date(store.now()).toISOString();
        filled += 1;
        store.appendEvent({
          type: 'entity',
          id: entity.id,
          detail: { name: entity.name, type: entity.type, backfilled: true, by: 'memory-backfill-notes' },
        });
      }
      store.save(latest);
    });
  }

  printResult(opts, { scanned: scanned.length, filled, suggestions, memberResult, dryRun: false, stateDir });
}

function printResult(opts, result) {
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 1));
    return;
  }
  console.log(`记忆实体备注回填${result.dryRun ? '（dry-run，不落盘）' : ''}`);
  console.log(`state: ${result.stateDir}`);
  console.log(`群成员接口：${result.memberResult.reason}`);
  console.log(`扫描实体 ${result.scanned} 个，可回填 ${result.suggestions.length} 个，已写入 ${result.filled} 个`);
  for (const item of result.suggestions) {
    console.log(`- [${item.type}] ${item.name} ← ${item.note}`);
  }
}

main().catch((error) => {
  console.error(`回填失败：${error?.stack ?? error}`);
  process.exit(1);
});
