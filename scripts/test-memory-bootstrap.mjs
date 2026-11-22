// memory-bootstrap 自检：
//   - seed.json 符合 §7 schema（version/generatedAt/sources/entities/relations/memories）
//   - 真实字段映射：会话→group/person、memberImpressions→人物 note、activeTopics→topic+long 记忆、
//     lastTurnSummary→long 记忆、sessionPolicies→会话实体 tags、slang→term 实体
//   - 过滤（空/纯表情/重复/被拒绝的黑话）、脱敏（token/密码/绝对路径/URL）、截断（2000/500/60/48）
//   - 幂等（同参数重复运行字节级一致）、不改动 state 原始数据文件
//   - 可选 --include-sessions（zstd 多帧归档）
// 运行：node scripts/test-memory-bootstrap.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

import {
  deriveCoreTokens,
  decompressZstdArchive,
  extractAssistantTexts,
  isMeaningfulText,
  parseJsonl,
  redactSensitive,
  containsSensitive,
  shortTitle,
  splitZstdFrames,
  LIMITS,
  SEED_VERSION,
} from './memory-bootstrap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'memory-bootstrap.mjs');
const NOW = 1700000000000;

const VALID_ENTITY_TYPES = new Set(['person', 'group', 'topic', 'term', 'event', 'project', 'self']);
const VALID_RELATIONS = new Set([
  'member_of',
  'likes',
  'knows',
  'discussed',
  'part_of',
  'owner_of',
  'related',
  'alias_of',
]);
const VALID_LAYERS = new Set(['long', 'short']);
const VALID_CATEGORIES = new Set([
  'fact',
  'preference',
  'event',
  'relationship',
  'promise',
  'topic',
  'profile',
  'other',
]);

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 120000,
  });
}

function expectCli(args, expectedStatus = 0) {
  const result = runCli(args);
  assert.equal(
    result.status,
    expectedStatus,
    `CLI 退出码应为 ${expectedStatus}，实际 ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

const SENSITIVE_FIXTURE_TEXT =
  '主人让我看 C:\\Users\\secret\\notes.txt 里的密码：hunter2，还说 api_key: sk-abcdef1234567890 别乱发；链接 https://example.com/a?token=abc 也打不开。';
const LONG_TOPIC_TEXT = `${'长'.repeat(2600)}结尾`;

function buildSocialFixture() {
  return {
    paused: false,
    conversations: {
      'group:111': {
        recentMessages: [
          { seq: 1, messageId: 1, sender: '群友A', userId: '10001', text: '周末去钓鱼吗', isSelf: false, time: 1 },
          { seq: 2, messageId: 2, sender: '群友B', userId: '10002', text: '好啊好啊', isSelf: false, time: 2 },
          { seq: 3, messageId: 3, sender: '我', userId: '999', text: '喵～', isSelf: true, time: 3 },
          { seq: 4, messageId: 4, sender: '群友A', userId: '10001', text: '[表情]', isSelf: false, time: 4 },
          { seq: 5, messageId: 5, sender: '群友A', userId: '10001', text: '   ', isSelf: false, time: 5 },
        ],
        memberImpressions: {
          群友A: { traits: ['爱钓鱼', '[表情]', '话多'], interactionCount: 2, lastSeenAt: 1 },
        },
        activeTopics: [
          {
            text: '周末钓鱼计划',
            lastMentionAt: 1,
            participants: ['群友A', '群友B'],
            pendingQuestion: '去哪钓？',
          },
          { text: '周末钓鱼计划', lastMentionAt: 2, participants: [], pendingQuestion: '' },
          { text: '[表情]', lastMentionAt: 3, participants: [], pendingQuestion: '' },
          { text: LONG_TOPIC_TEXT, lastMentionAt: 4, participants: [], pendingQuestion: '' },
        ],
        lastTurnSummary: {
          text: '大家在聊周末钓鱼，群友A 提议去水库。',
          feature: 'chat',
          at: 2,
        },
      },
      'private:222': {
        recentMessages: [
          { sender: '私聊', text: '在吗', isSelf: false, isOwner: true, time: 1 },
          { sender: '我', text: '在的喵', isSelf: true, time: 2 },
        ],
        memberImpressions: {
          管理员: { traits: ['爱逗人', '喜欢猫娘'], interactionCount: 3, lastSeenAt: 1 },
        },
        activeTopics: [],
        lastTurnSummary: { text: SENSITIVE_FIXTURE_TEXT, feature: 'web', at: 3 },
      },
    },
  };
}

const SESSIONS_FIXTURE = {
  sessions: { 'group:111': 'session-aaa', 'private:222': 'session-bbb' },
  sessionPolicies: {
    'group:111': '["qq-chat-v2",null]',
    'private:222': '["qq-chat-v2",null]',
  },
  parkedSessions: {
    'group:111': { vision: { mode: 'advanced', sessionId: 'session-ccc' } },
  },
  sessionVariants: { 'group:111': 'web:advanced', 'private:222': 'chat:basic' },
};

const SLANG_FIXTURE = [
  {
    id: 's1',
    content: 'yyds',
    meaning: '永远的神',
    usage: '夸赞',
    example: '这波 yyds',
    status: 'confirmed',
    evidence: [{ key: 'group:111', sender: '群友A', text: '这波 yyds' }],
  },
  {
    id: 's2',
    content: '绝绝子',
    meaning: '非常厉害',
    status: 'candidate',
    evidence: [{ key: 'group:111', sender: '群友B', text: '绝绝子' }],
  },
  { id: 's3', content: '空的', meaning: '', status: 'candidate' },
  { id: 's4', content: '拒收词', meaning: '不该出现', status: 'rejected' },
  {
    id: 's5',
    content: '泄漏词',
    meaning: 'api_key: sk-abcdef1234567890 和 C:\\Users\\secret\\notes.txt',
    status: 'confirmed',
  },
  {
    id: 's6',
    content: '重复词',
    meaning: '第一次',
    status: 'confirmed',
    evidence: [{ key: 'group:111', sender: '群友A' }],
  },
  { id: 's7', content: '重复词', meaning: '第二次重复内容', status: 'confirmed' },
];

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function jsonlLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function writeSessionArchive(sessionsRoot, sessionId, assistantTexts) {
  const dir = path.join(sessionsRoot, '--C-Users-test--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const records = [
    { type: 'session', id: sessionId },
    ...assistantTexts.map((text) => ({
      type: 'assistant/message',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '这段推理不该进记忆' },
          { type: 'text', text },
          { type: 'tool-call', toolName: 'noop', input: {} },
        ],
      },
    })),
    { type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: '【会话令牌】不该进记忆' }] } },
  ];
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(jsonlLines(records), 'utf8')));
}

function entityKey(entity) {
  return `${entity.type}|${entity.name}`;
}

function findEntity(seed, type, name) {
  return seed.entities.find((entity) => entity.type === type && entity.name === name);
}

function relationExists(seed, from, relation, to) {
  return seed.relations.some((item) => item.from === from && item.relation === relation && item.to === to);
}

// ---------------------------------------------------------------------------
// 0. 纯函数单测
// ---------------------------------------------------------------------------

{
  assert.equal(isMeaningfulText('周末钓鱼'), true);
  assert.equal(isMeaningfulText('666'), true, '数字昵称/黑话应保留');
  assert.equal(isMeaningfulText('[表情]'), false);
  assert.equal(isMeaningfulText('[图片] [表情]'), false);
  assert.equal(isMeaningfulText('😀😀🎉'), false);
  assert.equal(isMeaningfulText('。。。！！'), false);
  assert.equal(isMeaningfulText('   '), false);
  ok('isMeaningfulText 过滤空/纯表情/纯标点，保留数字文本');

  assert.equal(containsSensitive('C:\\Users\\example\\secret.txt'), true);
  assert.equal(containsSensitive('sk-abcdef1234567890'), true);
  assert.equal(containsSensitive('密码：hunter2'), true);
  assert.equal(containsSensitive('https://example.com/a?token=abc'), true);
  assert.equal(containsSensitive('周末去钓鱼'), false);
  const redacted = redactSensitive(`看 C:\\Users\\example\\a.txt，密钥 sk-abcdef1234567890，链接 https://example.com/x 谢谢`);
  assert.ok(redacted.hits >= 3, '应命中路径/密钥/链接');
  assert.ok(!redacted.text.includes('Users'), '路径应被脱敏');
  assert.ok(!redacted.text.includes('sk-abcdef'), '密钥应被脱敏');
  assert.ok(!redacted.text.includes('https://'), 'URL 应被脱敏');
  assert.ok(redacted.text.includes('[路径]') && redacted.text.includes('[链接]'));
  ok('redactSensitive / containsSensitive 覆盖 token、密码、绝对路径、URL');

  assert.deepEqual(deriveCoreTokens('木蘸糖QAQ'), ['木蘸糖']);
  assert.deepEqual(deriveCoreTokens('喵小言（颜心）'), ['喵小言']);
  assert.deepEqual(deriveCoreTokens('群友A'), [], '单字尾巴不派生核心名');
  assert.deepEqual(deriveCoreTokens('管理员'), []);
  ok('deriveCoreTokens 只派生可靠核心名');

  assert.equal(shortTitle('大家好。今天去钓鱼。', 60), '大家好。');
  assert.equal(shortTitle(LONG_TOPIC_TEXT, 60).length, 60);
  ok('shortTitle 取第一句并在超长时截断');

  const frameA = zstdCompressSync(Buffer.from('第一帧内容\n', 'utf8'));
  const frameB = zstdCompressSync(Buffer.from('第二帧内容\n', 'utf8'));
  const multiFrame = Buffer.concat([frameA, frameB]);
  const frames = splitZstdFrames(multiFrame);
  assert.equal(frames.length, 2);
  const decoded = decompressZstdArchive(multiFrame).toString('utf8');
  assert.ok(decoded.includes('第一帧内容') && decoded.includes('第二帧内容'), '多帧 zstd 应全部解出');
  ok('splitZstdFrames / decompressZstdArchive 支持多帧 zstd');

  const parsed = parseJsonl('{"a":1}\n坏行\n{"b":2}\n');
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.badLines, 1);
  assert.deepEqual(
    extractAssistantTexts([
      { type: 'assistant/message', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '回复' }] } },
      { type: 'tool/call', name: 'x' },
      { type: 'assistant/message', content: [{ type: 'text', text: '旧格式回复' }] },
    ]),
    ['回复', '旧格式回复'],
  );
  ok('parseJsonl / extractAssistantTexts 解析 DSH 归档记录');
}

// ---------------------------------------------------------------------------
// 1. fixture：生成 seed 并校验 schema / 数据映射 / 数量
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-memory-bootstrap-'));
console.log(`\n[fixture] ${tmpRoot}\n`);
const stateDir = path.join(tmpRoot, 'state');
const sessionsRoot = path.join(tmpRoot, 'dsh-sessions');
const outDir = path.join(tmpRoot, 'out');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
writeJson(path.join(stateDir, 'social-v2.json'), buildSocialFixture());
writeJson(path.join(stateDir, 'sessions.json'), SESSIONS_FIXTURE);
writeJson(path.join(stateDir, 'slang.json'), SLANG_FIXTURE);
writeJson(path.join(stateDir, 'current-role.json'), { role: '测试喵', mode: 'active' });
writeSessionArchive(sessionsRoot, 'session-aaa', [
  '归档回复一：周末钓鱼记得带伞。',
  '归档回复二：我也想去。',
]);
writeSessionArchive(sessionsRoot, 'session-bbb', ['归档回复三：主人晚安。']);

const RAW_FILES = ['social-v2.json', 'sessions.json', 'slang.json', 'current-role.json'];
const rawBefore = new Map(RAW_FILES.map((name) => [name, fs.readFileSync(path.join(stateDir, name), 'utf8')]));

const defaultArgs = ['--state', stateDir, '--owner-qq', '222', '--now', String(NOW)];
const seedPath = path.join(stateDir, 'memory', 'seed.json');
const firstRun = expectCli(defaultArgs);
assert.ok(fs.existsSync(seedPath), '默认输出位置应为 <state>/memory/seed.json');
const seedText = fs.readFileSync(seedPath, 'utf8');
const seed = JSON.parse(seedText);

{
  assert.equal(seed.version, SEED_VERSION);
  assert.equal(seed.version, 1);
  assert.equal(seed.generatedAt, NOW);
  assert.deepEqual(seed.sources, [
    'state/social-v2.json',
    'state/sessions.json',
    'state/slang.json',
    'state/current-role.json',
  ]);
  assert.ok(firstRun.stdout.includes('实体 11'), `CLI 统计应打印实体 11：${firstRun.stdout}`);
  ok('seed 顶层版本/生成时间/数据源正确，CLI 打印统计');

  assert.equal(seed.entities.length, 11, '实体数量应为 fixture 预期');
  const entityByType = {};
  for (const entity of seed.entities) entityByType[entity.type] = (entityByType[entity.type] || 0) + 1;
  assert.deepEqual(entityByType, { self: 1, person: 3, group: 1, topic: 2, term: 4 });

  const entityKeys = new Set();
  for (const entity of seed.entities) {
    assert.ok(entity.name && typeof entity.name === 'string');
    assert.ok(VALID_ENTITY_TYPES.has(entity.type), `非法实体类型：${entity.type}`);
    assert.ok(Array.isArray(entity.aliases));
    assert.ok(entity.aliases.length <= LIMITS.aliasesPerEntity);
    assert.ok(typeof entity.note === 'string' && entity.note.length <= LIMITS.entityNote);
    assert.ok(Array.isArray(entity.tags) && entity.tags.length <= LIMITS.tagsPerEntity);
    assert.ok(entity.source && typeof entity.source === 'object' && typeof entity.source.kind === 'string');
    assert.ok(entity.name.length <= LIMITS.entityName);
    const key = entityKey(entity);
    assert.ok(!entityKeys.has(key), `实体重复：${key}`);
    entityKeys.add(key);
  }
  ok('entities schema 合法且无重复');

  assert.equal(seed.relations.length, 12, '关系数量应为 fixture 预期');
  const relationByType = {};
  for (const relation of seed.relations) relationByType[relation.relation] = (relationByType[relation.relation] || 0) + 1;
  assert.deepEqual(relationByType, { member_of: 3, owner_of: 1, discussed: 2, related: 6 });
  for (const relation of seed.relations) {
    assert.ok(VALID_RELATIONS.has(relation.relation));
    assert.ok(entityKeys.has(`${relation.from}`) || seed.entities.some((entity) => entity.name === relation.from));
    assert.ok(seed.entities.some((entity) => entity.name === relation.to), `关系目标实体不存在：${relation.to}`);
    assert.ok(typeof relation.note === 'string');
  }
  assert.ok(relationExists(seed, '群友A', 'member_of', 'QQ群 111'));
  assert.ok(relationExists(seed, '群友B', 'member_of', 'QQ群 111'));
  assert.ok(relationExists(seed, '测试喵', 'member_of', 'QQ群 111'), 'self 发言过 → member_of 群');
  assert.ok(relationExists(seed, '管理员', 'owner_of', '测试喵'));
  assert.ok(relationExists(seed, 'QQ群 111', 'discussed', '周末钓鱼计划'));
  assert.ok(relationExists(seed, 'QQ群 111', 'related', 'yyds'));
  assert.ok(relationExists(seed, '群友A', 'related', 'yyds'));
  ok('relations schema 合法、端点可解析、关键关系正确');

  assert.equal(seed.memories.length, 4, '记忆数量：2 话题 + 2 lastTurnSummary');
  const categoryCount = {};
  for (const memory of seed.memories) categoryCount[memory.category] = (categoryCount[memory.category] || 0) + 1;
  assert.deepEqual(categoryCount, { topic: 2, event: 2 });
  const memoryKeys = new Set();
  for (const memory of seed.memories) {
    assert.equal(memory.layer, 'long');
    assert.ok(VALID_LAYERS.has(memory.layer));
    assert.ok(VALID_CATEGORIES.has(memory.category));
    assert.ok(memory.text.length > 0 && memory.text.length <= LIMITS.memoryText);
    assert.ok(memory.title.length > 0 && memory.title.length <= LIMITS.title);
    assert.ok(Array.isArray(memory.keywords) && memory.keywords.length <= LIMITS.keywordsPerMemory);
    assert.ok(Array.isArray(memory.entityNames) && memory.entityNames.length <= LIMITS.entityNamesPerMemory);
    for (const name of memory.entityNames) {
      assert.ok(seed.entities.some((entity) => entity.name === name), `记忆引用的实体不存在：${name}`);
    }
    assert.ok(typeof memory.protection === 'number' && memory.protection >= 0 && memory.protection <= 1);
    assert.ok(memory.source && memory.source.key, '记忆 source.key 必填');
    assert.ok(Array.isArray(memory.source.seqs));
    const key = `${memory.source.key}|${memory.text}`;
    assert.ok(!memoryKeys.has(key), `记忆重复：${key}`);
    memoryKeys.add(key);
  }
  ok('memories schema 合法、分类/层/实体引用/去重键正确');

  // 人物实体：memberImpressions → note；owner 来自私聊会话 key + ownerQQ
  const memberA = findEntity(seed, 'person', '群友A');
  assert.ok(memberA, '群友A 实体应存在（群成员）');
  assert.equal(memberA.note, '爱钓鱼；话多', '[表情] 印象应被过滤');
  assert.ok(memberA.tags.includes('群友') && memberA.tags.includes('成员印象'));
  const owner = findEntity(seed, 'person', '管理员');
  assert.ok(owner, '私聊对象/owner 实体应存在');
  assert.ok(owner.aliases.includes('222') && owner.aliases.includes('主人'));
  assert.ok(owner.note.includes('爱逗人') && owner.tags.includes('owner'));
  const selfEntity = findEntity(seed, 'self', '测试喵');
  assert.ok(selfEntity, 'current-role.json 的 role 应成为 self 实体');
  assert.ok(selfEntity.aliases.includes('我'));
  ok('person/self 实体字段映射正确（印象→note、ownerQQ→owner）');

  // 会话实体：sessions.json 的 sessionPolicies / sessionVariants → tags + note
  const groupEntity = findEntity(seed, 'group', 'QQ群 111');
  assert.ok(groupEntity, '群实体应存在');
  assert.ok(groupEntity.tags.includes('预设:qq-chat-v2'));
  assert.ok(groupEntity.tags.includes('变体:web:advanced'));
  assert.ok(groupEntity.note.includes('会话预设 qq-chat-v2'));
  ok('sessions.json 的 sessionPolicies/sessionVariants 落到会话实体 tags/note');

  // 黑话：confirmed + 带含义 candidate；rejected/无含义跳过；同 content 去重
  assert.ok(findEntity(seed, 'term', 'yyds'), 'confirmed 词条应导入');
  assert.ok(findEntity(seed, 'term', '绝绝子'), '带含义 candidate 默认应导入');
  assert.ok(!findEntity(seed, 'term', '拒收词'), 'rejected 词条不应导入');
  assert.ok(!findEntity(seed, 'term', '空的'), '无含义词条不应导入');
  assert.equal(seed.entities.filter((entity) => entity.type === 'term').length, 4);
  const duplicateTerm = findEntity(seed, 'term', '重复词');
  assert.ok(duplicateTerm, '同 content 的黑话应合并成一个 term');
  ok('slang → term 实体：confirmed/带含义 candidate 导入、rejected 跳过、重复合并');

  // 话题 / lastTurnSummary / 截断 / 待问
  const fishingMemories = seed.memories.filter((memory) => memory.title === '周末钓鱼计划');
  assert.equal(fishingMemories.length, 1, '重复 activeTopic 只落一条记忆');
  assert.ok(fishingMemories[0].text.includes('待问：去哪钓？'), 'pendingQuestion 应拼进话题记忆');
  assert.ok(fishingMemories[0].entityNames.includes('QQ群 111'));
  const groupSummary = seed.memories.find((memory) => memory.tags.includes('lastTurnSummary') && memory.source.key === 'group:111');
  assert.ok(groupSummary, 'lastTurnSummary 应落 long 记忆且 source 带会话 key');
  assert.ok(groupSummary.text.includes('周末钓鱼'));
  assert.ok(groupSummary.entityNames.includes('群友A'), '摘要里提到的群友应挂到记忆实体');
  assert.ok(groupSummary.tags.includes('feature:chat'));
  const longTopicEntity = seed.entities.find((entity) => entity.type === 'topic' && entity.name.endsWith('…'));
  assert.ok(longTopicEntity, '超长话题名应截断');
  assert.equal(longTopicEntity.name.length, LIMITS.entityName);
  assert.ok(longTopicEntity.note.length <= LIMITS.entityNote);
  const longTopicMemory = seed.memories.find((memory) => memory.text.startsWith('长长长'));
  assert.ok(longTopicMemory);
  assert.equal(longTopicMemory.text.length, LIMITS.memoryText, '记忆 text 应截断到 2000');
  assert.ok(longTopicMemory.text.endsWith('…'));
  assert.equal(longTopicMemory.title.length, LIMITS.title);
  assert.equal(seed.entities.filter((entity) => entity.name.includes('表情')).length, 0, '纯表情话题不应成为实体');
  ok('activeTopics/lastTurnSummary 映射正确，长文本按 2000/500/60/48 截断');

  // 脱敏：seed 文本里不应出现 fixture 里的敏感串；泄漏词的 note 已脱敏
  for (const secret of ['secret', 'hunter2', 'sk-abcdef', 'token=abc', 'https://example.com', 'api_key', 'C:\\Users']) {
    assert.ok(!seedText.includes(secret), `seed 不应包含敏感串：${secret}`);
  }
  const privateSummary = seed.memories.find((memory) => memory.source.key === 'private:222');
  assert.ok(privateSummary);
  assert.ok(privateSummary.text.includes('[路径]'), '绝对路径应替换为 [路径]');
  assert.ok(privateSummary.text.includes('[已脱敏]'), '密码/token 应替换为 [已脱敏]');
  assert.ok(privateSummary.text.includes('[链接]'), 'URL 应替换为 [链接]');
  const leakTerm = findEntity(seed, 'term', '泄漏词');
  assert.ok(leakTerm);
  assert.ok(!leakTerm.note.includes('sk-abcdef'));
  assert.ok(!leakTerm.note.includes('Users'));
  ok('敏感串脱敏：token/密码/绝对路径/URL 不进入 seed');
}

// ---------------------------------------------------------------------------
// 2. 幂等 / 不改动 state 原始文件
// ---------------------------------------------------------------------------

{
  const secondRun = expectCli(defaultArgs);
  assert.ok(secondRun.stdout.includes('未变化'), `重复运行应识别未变化：${secondRun.stdout}`);
  assert.equal(fs.readFileSync(seedPath, 'utf8'), seedText, '同参数重复运行应字节级一致');

  const thirdRun = expectCli([...defaultArgs, '--json']);
  const stats = JSON.parse(thirdRun.stdout);
  assert.equal(stats.entities.total, 11);
  assert.equal(stats.memories.total, 4);
  assert.equal(stats.generatedAt, NOW);
  assert.equal(stats.unchanged, true);
  ok('幂等：重复运行输出字节级一致，--json 统计可解析');

  for (const name of RAW_FILES) {
    assert.equal(fs.readFileSync(path.join(stateDir, name), 'utf8'), rawBefore.get(name), `${name} 不应被修改`);
  }
  ok('只读真实数据：state 原始文件内容未被修改');
}

// ---------------------------------------------------------------------------
// 3. --strict-slang / --dry-run / 缺数据源报错
// ---------------------------------------------------------------------------

{
  const strictOut = path.join(outDir, 'seed-strict.json');
  expectCli([...defaultArgs, '--strict-slang', '--out', strictOut]);
  const strictSeed = JSON.parse(fs.readFileSync(strictOut, 'utf8'));
  assert.equal(strictSeed.entities.filter((entity) => entity.type === 'term').length, 3);
  assert.ok(!strictSeed.entities.some((entity) => entity.name === '绝绝子'), '--strict-slang 不应收 candidate');
  assert.equal(strictSeed.memories.length, 4);
  ok('--strict-slang 只导入 confirmed 词条');

  const dryOut = path.join(outDir, 'seed-dry.json');
  const dryRun = expectCli([...defaultArgs, '--dry-run', '--out', dryOut]);
  assert.ok(dryRun.stdout.includes('实体 11'));
  assert.ok(!fs.existsSync(dryOut), '--dry-run 不应写文件');
  const jsonDryRun = runCli([...defaultArgs, '--dry-run', '--json']);
  assert.equal(jsonDryRun.status, 0);
  assert.doesNotThrow(() => JSON.parse(jsonDryRun.stdout), '--json 输出应是纯 JSON');
  assert.equal(JSON.parse(jsonDryRun.stdout).memories.total, 4);
  ok('--dry-run 不写文件；--json 输出可解析');

  const emptyStateDir = fs.mkdtempSync(path.join(tmpRoot, 'empty-state-'));
  const missing = runCli(['--state', emptyStateDir, '--now', String(NOW)]);
  assert.equal(missing.status, 1, '没有数据源时应非 0 退出');
  assert.ok(missing.stderr.includes('找不到任何数据源'), `stderr 应说明原因：${missing.stderr}`);
  const help = expectCli(['--help']);
  assert.ok(help.stdout.includes('--include-sessions'));
  const badArg = runCli(['--no-such-arg']);
  assert.equal(badArg.status, 1, '未知参数应非 0 退出');
  ok('缺数据源/未知参数报错，--help 输出用法');
}

// ---------------------------------------------------------------------------
// 4. 可选 --include-sessions：读 zstd 多帧归档补充长期记忆
// ---------------------------------------------------------------------------

{
  const archiveOut = path.join(outDir, 'seed-sessions.json');
  expectCli([
    ...defaultArgs,
    '--include-sessions',
    '--sessions-dir',
    sessionsRoot,
    '--out',
    archiveOut,
  ]);
  const archiveSeed = JSON.parse(fs.readFileSync(archiveOut, 'utf8'));
  assert.equal(archiveSeed.entities.length, 11, '归档不应改变实体数量（只补记忆）');
  assert.equal(archiveSeed.memories.length, 7, '4 条基础记忆 + 3 条归档助手回复');
  const archiveMemories = archiveSeed.memories.filter((memory) => memory.tags.includes('sessionArchive'));
  assert.equal(archiveMemories.length, 3);
  assert.ok(archiveMemories.some((memory) => memory.text.includes('归档回复一')));
  assert.ok(archiveMemories.some((memory) => memory.text.includes('归档回复三')));
  assert.ok(archiveSeed.sources.includes('dsh-sessions/'));
  for (const memory of archiveMemories) {
    assert.ok(memory.entityNames.length >= 1, '归档记忆应挂到会话实体');
    assert.equal(memory.layer, 'long');
  }
  assert.ok(!fs.readFileSync(archiveOut, 'utf8').includes('不该进记忆'), '归档只取 assistant text，不导入推理/user prompt');
  ok('--include-sessions 读取 zstd 归档并只导入助手回复记忆');
}

// ---------------------------------------------------------------------------
// 5. 清理
// ---------------------------------------------------------------------------

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n🎉 memory-bootstrap 测试通过（${passed} 项）`);
