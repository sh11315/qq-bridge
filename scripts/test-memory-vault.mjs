// 记忆大脑 vault 渲染器回归测试（不依赖 DSH / SnowLuma / QQ）。
// 用法：node scripts/test-memory-vault.mjs
//
// 覆盖：fixture brain → 临时目录 → 文件结构 / frontmatter / 十格进度条 / Canvas JSON /
//       SVG / .obsidian 配置 / 幂等重渲染 / 旧文件清理 / 用户文件保护 / 空 brain /
//       显示上限 / CLI（--json / --state / --now / 缺 brain / 坏 brain / 默认 vaultDir）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { AUTO_GEN_NOTICE, VAULT_VERSION, renderVault } from '../src/memory/vault.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(SCRIPT_DIR, 'memory-vault-refresh.mjs');
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0); // 2026-10-27T12:00:00Z（固定，保证输出确定性）
const DAY_MS = 86_400_000;
const daysAgo = (days) => NOW - days * DAY_MS;

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-memory-vault-test-'));
const MAIN_VAULT = path.join(TMP_ROOT, 'main-vault');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`❌ ${name}`);
    console.error(String(error?.stack ?? error?.message ?? error).replace(/^/gm, '   '));
  }
}

// ---------------------------------------------------------------------------
// fixture brain（§3 数据模型；≥3 long / 2 short / 1 permanent / 1 fading + 人物/群实体关系）
// ---------------------------------------------------------------------------

function makeMemory(overrides) {
  const layer = overrides.layer ?? 'long';
  return {
    id: 'mem_placeholder',
    layer,
    category: 'fact',
    title: '记忆',
    text: '正文',
    keywords: [],
    entityIds: [],
    tags: [],
    protection: 0,
    permanent: false,
    strength: 1,
    baseStrength: 1,
    decayDays: layer === 'long' ? 200 : 30,
    status: 'active',
    activationCount: 1,
    createdAt: daysAgo(90),
    updatedAt: daysAgo(30),
    lastActivatedAt: daysAgo(10),
    source: { kind: 'qq', key: 'group:123456789', seqs: [100, 101], createdBy: 'agent' },
    recallLog: [{ at: daysAgo(10), query: '测试查询' }],
    ...overrides,
  };
}

function makeFixtureBrain() {
  const entities = {
    ent_owner: {
      id: 'ent_owner',
      type: 'person',
      name: '主人',
      aliases: ['群主', '老板'],
      tags: ['核心'],
      note: 'QQ Bridge 的 owner，喜欢黑咖啡。',
      mentionCount: 42,
      firstSeenAt: daysAgo(400),
      lastMentionedAt: daysAgo(1),
      source: { kind: 'qq', key: 'private:10001' },
      createdAt: daysAgo(400),
      updatedAt: daysAgo(1),
    },
    ent_ache: {
      id: 'ent_ache',
      type: 'person',
      name: '阿澈',
      aliases: ['Ache'],
      tags: [],
      note: '',
      mentionCount: 7,
      firstSeenAt: daysAgo(200),
      lastMentionedAt: daysAgo(20),
      source: { kind: 'qq', key: 'group:123456789' },
      createdAt: daysAgo(200),
      updatedAt: daysAgo(20),
    },
    ent_group: {
      id: 'ent_group',
      type: 'group',
      name: 'QQ 桥接测试群',
      aliases: ['测试群'],
      tags: ['群聊'],
      mentionCount: 30,
      firstSeenAt: daysAgo(300),
      lastMentionedAt: daysAgo(2),
      createdAt: daysAgo(300),
      updatedAt: daysAgo(2),
    },
    ent_coffee: {
      id: 'ent_coffee',
      type: 'topic',
      name: '黑咖啡',
      aliases: [],
      tags: ['口味'],
      mentionCount: 5,
      firstSeenAt: daysAgo(120),
      lastMentionedAt: daysAgo(30),
      createdAt: daysAgo(120),
      updatedAt: daysAgo(30),
    },
    ent_rust: {
      id: 'ent_rust',
      type: 'term',
      name: 'Rust',
      aliases: ['RustLang'],
      tags: ['编程语言'],
      mentionCount: 4,
      firstSeenAt: daysAgo(80),
      lastMentionedAt: daysAgo(20),
      createdAt: daysAgo(80),
      updatedAt: daysAgo(20),
    },
    ent_slash: {
      id: 'ent_slash',
      type: 'project',
      name: 'A/B 计划: 实验',
      aliases: [],
      tags: ['项目'],
      mentionCount: 2,
      firstSeenAt: daysAgo(60),
      lastMentionedAt: daysAgo(5),
      createdAt: daysAgo(60),
      updatedAt: daysAgo(5),
    },
  };

  const relations = [
    { id: 'rel_owner_member_group', from: 'ent_owner', to: 'ent_group', relation: 'member_of', weight: 2, note: '主人在群里', createdAt: daysAgo(300), updatedAt: daysAgo(30) },
    { id: 'rel_ache_member_group', from: 'ent_ache', to: 'ent_group', relation: 'member_of', weight: 1.5, note: '', createdAt: daysAgo(200), updatedAt: daysAgo(20) },
    { id: 'rel_owner_likes_coffee', from: 'ent_owner', to: 'ent_coffee', relation: 'likes', weight: 3, note: '每天一杯', createdAt: daysAgo(120), updatedAt: daysAgo(10) },
    { id: 'rel_ache_knows_owner', from: 'ent_ache', to: 'ent_owner', relation: 'knows', weight: 1, note: '', createdAt: daysAgo(150), updatedAt: daysAgo(20) },
    { id: 'rel_rust_part_of_project', from: 'ent_rust', to: 'ent_slash', relation: 'part_of', weight: 1.2, note: '', createdAt: daysAgo(60), updatedAt: daysAgo(5) },
    // 指向不存在实体的关系必须被忽略（不生成悬空边）。
    { id: 'rel_ghost', from: 'ent_owner', to: 'ent_ghost', relation: 'related', weight: 1, note: '', createdAt: daysAgo(10), updatedAt: daysAgo(10) },
  ];

  const memories = {
    mem_permanent01: makeMemory({
      id: 'mem_permanent01',
      layer: 'long',
      category: 'preference',
      title: '主人喜欢黑咖啡',
      text: '主人每天早上一杯黑咖啡，不加糖。',
      keywords: ['黑咖啡', '咖啡', '口味'],
      entityIds: ['ent_owner', 'ent_coffee'],
      tags: ['偏好', '饮食'],
      protection: 1,
      permanent: true,
      // 即使 brain 里残留 status=fading，永久记忆也必须渲染成 active（§3 优先级）。
      status: 'fading',
      lastActivatedAt: daysAgo(30),
      createdAt: daysAgo(300),
      activationCount: 9,
    }),
    mem_long_hz01: makeMemory({
      id: 'mem_long_hz01',
      title: '主人住在杭州',
      text: '主人在杭州工作，周末常去西湖边散步。',
      keywords: ['杭州', '西湖'],
      entityIds: ['ent_owner'],
      // 落盘 strength 故意写错，渲染时必须按衰减公式重算成 1 - 40/200 = 0.8。
      strength: 0.99,
      lastActivatedAt: daysAgo(40),
      createdAt: daysAgo(300),
    }),
    mem_long_rust01: makeMemory({
      id: 'mem_long_rust01',
      title: '阿澈在写 Rust 项目',
      text: '阿澈最近在写一个 Rust 项目，卡在生命周期上。',
      keywords: ['Rust', '生命周期'],
      entityIds: ['ent_ache', 'ent_rust'],
      lastActivatedAt: daysAgo(20),
      createdAt: daysAgo(200),
    }),
    mem_long_game01: makeMemory({
      id: 'mem_long_game01',
      title: '周五晚上开黑',
      text: '群里周五晚上一般会一起开黑，人齐就开。',
      keywords: ['开黑', '周五'],
      entityIds: ['ent_group'],
      lastActivatedAt: daysAgo(100),
      createdAt: daysAgo(400),
    }),
    mem_short_rep01: makeMemory({
      id: 'mem_short_rep01',
      layer: 'short',
      category: 'event',
      title: '明天交实验报告：第三次/修订版',
      text: '明天要交实验报告，记得带 U 盘。',
      keywords: ['实验报告', '截止日期'],
      entityIds: ['ent_owner'],
      lastActivatedAt: daysAgo(6),
    }),
    mem_short_bday01: makeMemory({
      id: 'mem_short_bday01',
      layer: 'short',
      category: 'event',
      title: '今天群主生日',
      text: '今天群主生日，群里在发红包。',
      entityIds: ['ent_owner', 'ent_group'],
      lastActivatedAt: daysAgo(12),
    }),
    // 1 - 26/30 = 0.1333 < 0.15 → fading → 记忆/边缘
    mem_fading_game01: makeMemory({
      id: 'mem_fading_game01',
      layer: 'short',
      category: 'topic',
      title: '上次聊到的老游戏',
      text: '上次聊到一款很老的单机游戏，名字想不起来了。',
      entityIds: ['ent_ache'],
      lastActivatedAt: daysAgo(26),
      createdAt: daysAgo(40),
    }),
    // 1 - 29/30 = 0.0333 <= 0.05 → faded → 记忆/边缘
    mem_faded_old01: makeMemory({
      id: 'mem_faded_old01',
      layer: 'short',
      category: 'other',
      title: '很久以前的约定',
      text: '很久以前说要一起去看海。',
      entityIds: [],
      lastActivatedAt: daysAgo(29),
      createdAt: daysAgo(60),
    }),
    // 没有 lastActivatedAt：只能读落盘 strength（0.42），应保持 active。
    mem_fallback01: makeMemory({
      id: 'mem_fallback01',
      title: '一条没有激活时间的旧记忆',
      text: '这条记忆缺少 lastActivatedAt，只能读落盘的 strength。',
      entityIds: [],
      status: 'active',
      strength: 0.42,
      lastActivatedAt: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    }),
    // archived 的记忆不生成笔记。
    mem_archived01: makeMemory({
      id: 'mem_archived01',
      title: '已经归档的记忆',
      text: '这条记忆已归档。',
      status: 'archived',
      lastActivatedAt: daysAgo(10),
    }),
  };

  return {
    version: 1,
    createdAt: daysAgo(500),
    updatedAt: daysAgo(1),
    config: {},
    entities,
    relations,
    memories,
  };
}

const fixtureBrain = makeFixtureBrain();
const FIXTURE_BRAIN_PATH = path.join(TMP_ROOT, 'fixture-brain.json');
fs.writeFileSync(FIXTURE_BRAIN_PATH, JSON.stringify(fixtureBrain, null, 2), 'utf8');

// 主 vault：整个测试大部分断言都基于它（固定 now → 确定性输出）。
let mainResult = null;
let mainError = null;
try {
  mainResult = renderVault(fixtureBrain, { vaultDir: MAIN_VAULT, now: NOW });
} catch (error) {
  mainError = error;
}
function getMain() {
  if (mainError) throw mainError;
  return mainResult;
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

function vaultPath(relativePath) {
  return path.join(MAIN_VAULT, ...relativePath.split('/'));
}

function readVault(relativePath) {
  return fs.readFileSync(vaultPath(relativePath), 'utf8');
}

function walkFiles(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absolute = path.join(rootDir, entry.name);
    const relative = path.relative(MAIN_VAULT, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) out.push(...walkFiles(absolute));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

function findFile(files, prefix, startsWith) {
  const hits = files.filter(
    (file) => file.startsWith(prefix) && file.split('/').pop().startsWith(startsWith),
  );
  assert.equal(hits.length, 1, `${prefix} 下应以「${startsWith}」开头的文件恰好 1 个，实际 ${hits.length}`);
  return hits[0];
}

function memoryFile(id) {
  return findFile(getMain().files, '记忆/', `${id}-`);
}

function entityFile(type, name) {
  const relativePath = `实体/${type}/${name}.md`;
  assert.ok(getMain().files.includes(relativePath), `缺少实体笔记：${relativePath}`);
  return relativePath;
}

function parseNoteText(text) {
  assert.ok(text.startsWith('---\n'), '笔记必须以 YAML frontmatter 开头');
  const end = text.indexOf('\n---', 4);
  assert.ok(end > 0, '找不到 frontmatter 结束线');
  const frontmatterText = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, '');
  const fm = yaml.load(frontmatterText);
  assert.ok(fm && typeof fm === 'object' && !Array.isArray(fm), 'frontmatter 必须解析成对象');
  return { fm, body, frontmatterText };
}

function parseNote(relativePath) {
  return parseNoteText(readVault(relativePath));
}

function runCli(args, { expectStatus = 0 } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, DEBUG_MEMORY_VAULT: '' },
    });
    if (expectStatus !== 0) throw new Error(`期望退出码 ${expectStatus}，实际 0；stdout=${stdout}`);
    return { status: 0, stdout: String(stdout), stderr: '' };
  } catch (error) {
    if (error && typeof error.status === 'number') {
      if (error.status !== expectStatus) {
        throw new Error(
          `期望退出码 ${expectStatus}，实际 ${error.status}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`,
        );
      }
      return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
    throw error;
  }
}

function writeCliBrain(brain, stateDir) {
  const memoryDir = path.join(stateDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const brainPath = path.join(memoryDir, 'brain.json');
  fs.writeFileSync(brainPath, JSON.stringify(brain, null, 2), 'utf8');
  return brainPath;
}

// ---------------------------------------------------------------------------
// 渲染入口 / 统计
// ---------------------------------------------------------------------------

test('入口导出：VAULT_VERSION = 1、renderVault 是函数', () => {
  assert.equal(VAULT_VERSION, 1);
  assert.equal(typeof renderVault, 'function');
  assert.equal(typeof AUTO_GEN_NOTICE, 'string');
  assert.ok(AUTO_GEN_NOTICE.includes('自动生成'));
});

test('renderVault 参数校验：缺 vaultDir 抛 TypeError、文件系统根目录被拒绝', () => {
  assert.throws(() => renderVault({}, {}), /vaultDir/);
  assert.throws(() => renderVault({}, { vaultDir: '   ' }), /vaultDir/);
  assert.throws(() => renderVault({}, { vaultDir: path.parse(TMP_ROOT).root }), /拒绝/);
});

test('统计口径：总记忆 / 分层 / 边缘 / 实体 / 关系 / 保护线正确', () => {
  const { stats } = getMain();
  assert.equal(stats.total, 9); // 10 条里 1 条 archived 不渲染
  assert.deepEqual(stats.vaultLayers, { permanent: 1, long: 4, short: 2, edge: 2, superseded: 0 });
  assert.deepEqual(stats.byLayer, { long: 5, short: 4 });
  assert.equal(stats.permanent, 1);
  assert.equal(stats.fading, 1);
  assert.equal(stats.faded, 1);
  assert.equal(stats.archived, 1);
  assert.equal(stats.entities, 6);
  assert.equal(stats.relations, 5); // 悬空 relation 被忽略
  assert.deepEqual(stats.entityTypes, { person: 2, group: 1, topic: 1, term: 1, project: 1 });
  assert.equal(stats.protectionLine, 0.5);
  assert.deepEqual(stats.decayDays, { long: 200, short: 30 });
  assert.equal(stats.fadeThreshold, 0.15);
  assert.equal(stats.forgetThreshold, 0.05);
  assert.equal(stats.version, 1);
  assert.equal(stats.generatedAt, NOW);
  assert.equal(stats.vaultDir, MAIN_VAULT);
  assert.equal(stats.filesWritten, getMain().files.length);
  assert.equal(stats.cleaned, 0);
});

test('预期文件全部生成、路径唯一且是 POSIX 相对路径', () => {
  const { files } = getMain();
  const expected = [
    'README.md',
    '00-记忆大脑.md',
    '图谱/记忆大脑.canvas',
    '图谱/记忆大脑.svg',
    '.obsidian/app.json',
    '.obsidian/graph.json',
  ];
  for (const relativePath of expected) assert.ok(files.includes(relativePath), `缺少 ${relativePath}`);
  assert.equal(files.length, 27); // 6 固定文件 + 9 记忆 + 6 实体 + 6 分域拓扑（3 scope × svg/canvas）
  assert.equal(new Set(files).size, files.length, 'files 里不能有重复项');
  for (const file of files) {
    assert.ok(!file.includes('\\'), `应使用 POSIX 路径：${file}`);
    assert.ok(!path.isAbsolute(file), `应是相对路径：${file}`);
    assert.ok(!file.includes('..'), `不能逃出 vault：${file}`);
    assert.ok(fs.existsSync(vaultPath(file)), `磁盘上缺少：${file}`);
  }
  const memoryFiles = files.filter((file) => file.startsWith('记忆/'));
  assert.equal(memoryFiles.length, 9);
  assert.deepEqual(
    memoryFiles.map((file) => file.split('/')[1]).reduce((acc, layer) => {
      acc[layer] = (acc[layer] ?? 0) + 1;
      return acc;
    }, {}),
    { 永久: 1, 长期: 4, 短期: 2, 边缘: 2 },
  );
  assert.equal(files.filter((file) => file.startsWith('实体/')).length, 6);
});

// ---------------------------------------------------------------------------
// Markdown / frontmatter
// ---------------------------------------------------------------------------

test('所有生成的 .md 都带「自动生成，手改会被覆盖」提示', () => {
  const { files } = getMain();
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const text = readVault(file);
    assert.ok(text.includes(AUTO_GEN_NOTICE), `${file} 缺少自动生成提示`);
  }
  assert.ok(readVault('00-记忆大脑.md').startsWith('<!-- 由 QQ Bridge'), '主页应以 HTML 注释开头');
});

test('长期记忆 frontmatter 完整、可解析，强度按公式重算为 0.8', () => {
  const relativePath = memoryFile('mem_long_hz01');
  assert.ok(relativePath.startsWith('记忆/长期/'), `应进长期目录：${relativePath}`);
  const { fm, body } = parseNote(relativePath);
  assert.equal(fm.id, 'mem_long_hz01');
  assert.equal(fm.layer, 'long');
  assert.equal(fm.category, 'fact');
  assert.equal(fm.protection, 0);
  assert.equal(fm.strength, 0.8); // 1 - 40/200，覆盖 brain 里错误的 0.99
  assert.equal(fm.status, 'active');
  assert.equal(fm.decayDays, 200);
  assert.equal(fm.permanent, false);
  assert.equal(fm.created, new Date(daysAgo(300)).toISOString());
  assert.equal(fm.updated, new Date(daysAgo(30)).toISOString());
  assert.equal(fm.lastActivated, new Date(daysAgo(40)).toISOString());
  assert.deepEqual(fm.entities, ['主人']);
  assert.deepEqual(fm.tags, []);
  assert.equal(fm.source.kind, 'qq');
  assert.equal(fm.source.key, 'group:123456789');
  assert.deepEqual(fm.source.seqs, [100, 101]);
  assert.equal(fm.source.createdBy, 'agent');
  assert.ok(body.includes('# 主人住在杭州'));
  assert.ok(body.includes('## 强度'));
  assert.ok(body.includes('## 实体'));
  assert.ok(body.includes('## 来源'));
});

test('长期记忆正文：十格进度条 80% + 保护线 50% + 200 天衰减 + 实体 wikilink', () => {
  const { body } = parseNote(memoryFile('mem_long_hz01'));
  assert.ok(body.includes('████████░░ 80%（保护线 50%）'), `进度条不对：\n${body.slice(0, 600)}`);
  assert.ok(body.includes('**长期记忆**'));
  assert.ok(body.includes('200 天线性衰减'));
  assert.ok(body.includes('[[实体/person/主人|主人]]（人物）'));
  assert.ok(body.includes('上次激活 2026-09-17 12:00 UTC'));
  assert.ok(!body.includes('永久保留（protection = 1）'));
});

test('永久记忆：进 记忆/永久/、protection=1、状态恒 active、正文说明永久保留', () => {
  const relativePath = memoryFile('mem_permanent01');
  assert.ok(relativePath.startsWith('记忆/永久/'), `应进永久目录：${relativePath}`);
  const { fm, body } = parseNote(relativePath);
  assert.equal(fm.permanent, true);
  assert.equal(fm.protection, 1);
  assert.equal(fm.strength, 1);
  assert.equal(fm.status, 'active'); // 即使 brain 里残留 fading
  assert.equal(fm.decayDays, 200);
  assert.ok(body.includes('██████████ 100%（保护线 50%）'));
  assert.ok(body.includes('永久保留'));
  assert.ok(body.includes('## 💫') || body.includes('## 强度'));
});

test('短期记忆与边缘记忆：目录分层、fading/faded 状态、残片与展开详情', () => {
  const shortPath = memoryFile('mem_short_rep01');
  assert.ok(shortPath.startsWith('记忆/短期/'), `应进短期目录：${shortPath}`);
  const shortNote = parseNote(shortPath);
  assert.equal(shortNote.fm.strength, 0.8);
  assert.equal(shortNote.fm.layer, 'short');
  assert.ok(shortNote.body.includes('████████░░ 80%（保护线 50%）'));
  assert.ok(shortNote.body.includes('30 天线性衰减'));

  const fadingPath = memoryFile('mem_fading_game01');
  assert.ok(fadingPath.startsWith('记忆/边缘/'), `应进边缘目录：${fadingPath}`);
  const fading = parseNote(fadingPath);
  assert.equal(fading.fm.status, 'fading');
  assert.ok(Math.abs(fading.fm.strength - 0.1333) < 0.001, `fading 强度应约 0.1333，实际 ${fading.fm.strength}`);
  assert.ok(fading.body.startsWith('# 上…'), `边缘记忆标题应只留首字残片：${fading.body.slice(0, 40)}`);
  assert.ok(fading.body.includes('正在淡忘'));
  assert.ok(fading.body.includes('（点击展开）'));
  assert.ok(fading.body.includes('残片'));

  const fadedPath = memoryFile('mem_faded_old01');
  assert.ok(fadedPath.startsWith('记忆/边缘/'));
  const faded = parseNote(fadedPath);
  assert.equal(faded.fm.status, 'faded');
  assert.ok(Math.abs(faded.fm.strength - 0.0333) < 0.001);

  const fallback = parseNote(memoryFile('mem_fallback01'));
  assert.equal(fallback.fm.strength, 0.42); // 没有 lastActivatedAt → 读落盘 strength
  assert.equal(fallback.fm.status, 'active');
});

test('归档记忆不生成笔记，也不计入统计', () => {
  const { files, stats } = getMain();
  assert.ok(!files.some((file) => file.includes('mem_archived01')), 'archived 记忆不应生成笔记');
  assert.ok(!files.some((file) => file.includes('已经归档的记忆')));
  assert.equal(stats.archived, 1);
});

// ---------------------------------------------------------------------------
// 实体笔记
// ---------------------------------------------------------------------------

test('人物实体笔记：frontmatter、别名、提及数、关系列表与关联记忆', () => {
  const relativePath = entityFile('person', '主人');
  const { fm, body } = parseNote(relativePath);
  assert.equal(fm.id, 'ent_owner');
  assert.equal(fm.type, 'person');
  assert.equal(fm.name, '主人');
  assert.deepEqual(fm.aliases, ['群主', '老板']);
  assert.equal(fm.mentionCount, 42);
  assert.deepEqual(fm.tags, ['核心']);
  assert.equal(fm.firstSeen, new Date(daysAgo(400)).toISOString());
  assert.ok(body.includes('# 主人'));
  assert.ok(body.includes('## 关系'));
  assert.ok(body.includes('**属于（member_of）** → [[实体/group/QQ 桥接测试群|QQ 桥接测试群]]'));
  assert.ok(body.includes('**偏好（likes）** → [[实体/topic/黑咖啡|黑咖啡]]'));
  assert.ok(body.includes('## 关联记忆'));
  assert.ok(body.includes('[[记忆/永久/mem_permanent01-主人喜欢黑咖啡|主人喜欢黑咖啡]]'));
  assert.ok(body.includes('永久 · 强度 100%'));
});

test('群实体笔记：反向关系（←）与成员计数正常', () => {
  const { body, fm } = parseNote(entityFile('group', 'QQ 桥接测试群'));
  assert.equal(fm.type, 'group');
  assert.ok(body.includes('**属于（member_of）** ← [[实体/person/主人|主人]]'));
  assert.ok(body.includes('**属于（member_of）** ← [[实体/person/阿澈|阿澈]]'));
});

test('实体/记忆文件名清洗：非法字符不落到磁盘路径，中文保留', () => {
  const projectFile = getMain().files.find(
    (file) => file.startsWith('实体/project/') && file.includes('计划'),
  );
  assert.ok(projectFile, '缺少 A/B 计划实体笔记');
  assert.equal(projectFile, '实体/project/A_B 计划_ 实验.md');
  const projectNote = parseNote(projectFile);
  assert.equal(projectNote.fm.name, 'A/B 计划: 实验'); // 原名保留在 frontmatter
  const reportFile = memoryFile('mem_short_rep01');
  assert.match(
    reportFile.split('/').pop(),
    /^mem_short_rep01-[^<>:"/\\|?*]+\.md$/,
    `记忆文件名含非法字符：${reportFile}`,
  );
  assert.ok(reportFile.includes('明天交实验报告'), `中文 slug 应保留：${reportFile}`);
});

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

test('Canvas 是合法 Obsidian JSON：nodes/edges 非空、id 唯一、边两端存在', () => {
  const canvas = JSON.parse(readVault('图谱/记忆大脑.canvas'));
  assert.ok(Array.isArray(canvas.nodes) && canvas.nodes.length > 0, 'nodes 必须是非空数组');
  assert.ok(Array.isArray(canvas.edges) && canvas.edges.length > 0, 'edges 必须是非空数组');
  const nodeIds = new Set();
  for (const node of canvas.nodes) {
    assert.equal(typeof node.id, 'string');
    assert.ok(!nodeIds.has(node.id), `节点 id 重复：${node.id}`);
    nodeIds.add(node.id);
    assert.equal(typeof node.type, 'string');
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    assert.ok(Number.isFinite(node.width) && node.width > 0);
    assert.ok(Number.isFinite(node.height) && node.height > 0);
    assert.ok(typeof node.text === 'string' && node.text.length > 0);
    if (node.color !== undefined) assert.match(String(node.color), /^[1-6]$/);
  }
  const edgeIds = new Set();
  for (const edge of canvas.edges) {
    assert.equal(typeof edge.id, 'string');
    assert.ok(!edgeIds.has(edge.id), `边 id 重复：${edge.id}`);
    edgeIds.add(edge.id);
    assert.ok(nodeIds.has(edge.fromNode), `边起点不存在：${edge.fromNode}`);
    assert.ok(nodeIds.has(edge.toNode), `边终点不存在：${edge.toNode}`);
    assert.ok(typeof edge.fromSide === 'string' && typeof edge.toSide === 'string');
  }
  const center = canvas.nodes.find((node) => node.id === 'center-brain');
  assert.ok(center, '缺少中心节点');
  assert.ok(center.text.includes('记忆大脑'));
  assert.ok(center.text.includes('自动生成'));
  const canvasStats = getMain().stats.canvas;
  assert.equal(canvasStats.nodes, canvas.nodes.length);
  assert.equal(canvasStats.edges, canvas.edges.length);
});

test('Canvas 同心圆配色：永久金(6)/长期蓝(5)/短期灰(3) + 实体/关系边', () => {
  const canvas = JSON.parse(readVault('图谱/记忆大脑.canvas'));
  const center = canvas.nodes.find((node) => node.id === 'center-brain');
  const cx = center.x + center.width / 2;
  const cy = center.y + center.height / 2;
  const distance = (node) =>
    Math.hypot(node.x + node.width / 2 - cx, node.y + node.height / 2 - cy);

  const permanent = canvas.nodes.filter((node) => node.color === '6' && node.id !== 'center-brain');
  const long = canvas.nodes.filter((node) => node.color === '5');
  const short = canvas.nodes.filter((node) => node.color === '3');
  const entities = canvas.nodes.filter((node) => node.color === '4');
  assert.equal(permanent.length, 1);
  assert.equal(long.length, 4);
  assert.equal(short.length, 2);
  assert.equal(entities.length, 6);

  const average = (nodes) => nodes.reduce((sum, node) => sum + distance(node), 0) / nodes.length;
  assert.ok(average(permanent) < average(long), '永久记忆应在长期记忆内圈');
  assert.ok(average(long) < average(short), '长期记忆应在短期记忆内圈');
  assert.ok(average(short) < average(entities), '实体应分布在最外圈');
  assert.ok(distance(permanent[0]) > 300, '永久记忆应离中心有距离');

  const memoryNodes = canvas.nodes.filter((node) => node.text.includes('[[记忆/'));
  assert.ok(memoryNodes.length >= 9, `记忆节点应带 wikilink，实际 ${memoryNodes.length}`);
  assert.ok(memoryNodes.some((node) => node.text.includes('打开笔记')));
  assert.ok(entities.every((node) => node.text.includes('提及')));
  assert.ok(canvas.edges.some((edge) => ['属于', 'PART_OF', 'member_of'].includes(edge.label)), '关系边应带 relation 名称');
  assert.ok(canvas.nodes.some((node) => node.id === 'node-legend' && node.text.includes('图例')));
});

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

test('SVG 结构：1600×1000、网格/大脑/同步环/实体/图例/概览都在', () => {
  const svg = readVault('图谱/记忆大脑.svg');
  assert.ok(svg.startsWith('<?xml'), 'SVG 应以 XML 声明开头');
  assert.equal((svg.match(/<svg[\s>]/g) ?? []).length, 1, '只能有一个 <svg> 根');
  assert.ok(svg.includes('width="1600" height="1000"'));
  assert.ok(svg.includes('viewBox="0 0 1600 1000"'));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  for (const id of [
    'memory-rings',
    'entity-relations',
    'memory-entity-links',
    'memory-nodes',
    'entity-nodes',
    'center-brain',
    'legend',
    'overview',
  ]) {
    assert.ok(svg.includes(`id="${id}"`), `缺少 SVG 分组 #${id}`);
  }
  for (const text of [
    '记忆大脑',
    '同步记忆环',
    '图例',
    '永久记忆（金色发光）',
    '长期记忆',
    '短期记忆',
    '边缘残片',
    '实体节点',
    '保护线 50%',
    '自动生成，手改会被覆盖',
  ]) {
    assert.ok(svg.includes(text), `SVG 缺少文本「${text}」`);
  }
  // 确定性：不能有随机数痕迹，且 XML 里不能有未转义的 &。
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(svg), 'SVG 有未转义的 &');
  assert.ok(svg.includes('A/B'), '实体名应出现在 SVG 文本里');
});

test('SVG 确定性：同一 brain + 同一 now 两次渲染字节一致', () => {
  const secondVault = path.join(TMP_ROOT, 'deterministic-vault');
  const second = renderVault(fixtureBrain, { vaultDir: secondVault, now: NOW });
  assert.deepEqual(second.files, getMain().files);
  for (const relativePath of ['图谱/记忆大脑.svg', '图谱/记忆大脑.canvas', '00-记忆大脑.md', memoryFile('mem_long_hz01')]) {
    const a = fs.readFileSync(vaultPath(relativePath), 'utf8');
    const b = fs.readFileSync(path.join(secondVault, ...relativePath.split('/')), 'utf8');
    assert.equal(a, b, `${relativePath} 两次渲染不一致`);
  }
});

// ---------------------------------------------------------------------------
// 幂等 / 清理 / 用户文件保护
// ---------------------------------------------------------------------------

test('重复渲染幂等：无重复文件、无旧文件被误删、内容稳定', () => {
  const before = getMain().files.slice().sort();
  const beforeNote = readVault(memoryFile('mem_long_rust01'));
  const again = renderVault(fixtureBrain, { vaultDir: MAIN_VAULT, now: NOW });
  assert.deepEqual(again.files.slice().sort(), before);
  assert.equal(again.stats.cleaned, 0);
  assert.equal(readVault(memoryFile('mem_long_rust01')), beforeNote);
  const memoryNotesOnDisk = walkFiles(MAIN_VAULT).filter(
    (file) => file.startsWith('记忆/') && file.endsWith('.md'),
  );
  assert.equal(memoryNotesOnDisk.length, 9);
});

test('旧 .md 清理 + vault 其他文件绝不删除', () => {
  const cleanupVault = path.join(TMP_ROOT, 'cleanup-vault');
  fs.mkdirSync(path.join(cleanupVault, '记忆', '短期'), { recursive: true });
  fs.mkdirSync(path.join(cleanupVault, '记忆', '长期'), { recursive: true });
  fs.mkdirSync(path.join(cleanupVault, '实体', 'person'), { recursive: true });
  fs.mkdirSync(path.join(cleanupVault, '回忆', '自定义'), { recursive: true });
  fs.mkdirSync(path.join(cleanupVault, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(cleanupVault, '附件'), { recursive: true });
  const staleFiles = [
    '记忆/短期/旧笔记.md',
    '记忆/长期/stale-note.md',
    '实体/person/旧人.md',
  ];
  for (const file of staleFiles) {
    fs.writeFileSync(path.join(cleanupVault, ...file.split('/')), '# 旧文件\n', 'utf8');
  }
  const userFiles = [
    '我的笔记本.md',
    '回忆/自定义/随笔.md',
    '附件/语音.bin',
    '.obsidian/hotkeys.json',
    '记忆/说明.txt',
    '记忆/短期/附件图.png',
  ];
  for (const file of userFiles) {
    fs.writeFileSync(path.join(cleanupVault, ...file.split('/')), '用户自己的东西', 'utf8');
  }
  const result = renderVault(fixtureBrain, { vaultDir: cleanupVault, now: NOW });
  assert.equal(result.stats.cleaned, 3, '应只清理 3 个旧 .md');
  for (const file of staleFiles) {
    assert.ok(!fs.existsSync(path.join(cleanupVault, ...file.split('/'))), `旧文件未删除：${file}`);
  }
  for (const file of userFiles) {
    assert.ok(fs.existsSync(path.join(cleanupVault, ...file.split('/'))), `用户文件被误删：${file}`);
    assert.equal(
      fs.readFileSync(path.join(cleanupVault, ...file.split('/')), 'utf8'),
      '用户自己的东西',
      `用户文件被改写：${file}`,
    );
  }
  assert.ok(fs.existsSync(path.join(cleanupVault, 'README.md')));
});

// ---------------------------------------------------------------------------
// 空 brain / 自定义配置
// ---------------------------------------------------------------------------

test('空 brain：不报错、生成空 vault 骨架（Canvas 只有中心+图例，SVG 合法）', () => {
  const emptyVault = path.join(TMP_ROOT, 'empty-vault');
  const result = renderVault({}, { vaultDir: emptyVault, now: NOW });
  assert.equal(result.stats.total, 0);
  assert.deepEqual(result.stats.vaultLayers, { permanent: 0, long: 0, short: 0, edge: 0, superseded: 0 });
  assert.equal(result.files.length, 6);
  assert.ok(!result.files.some((file) => file.startsWith('图谱/拓扑-')), '空 brain 不应生成分域拓扑');
  const canvas = JSON.parse(fs.readFileSync(path.join(emptyVault, '图谱/记忆大脑.canvas'), 'utf8'));
  assert.equal(canvas.nodes.length, 2); // 中心 + 图例
  assert.equal(canvas.edges.length, 0);
  assert.ok(canvas.nodes.some((node) => node.id === 'center-brain' && node.text.includes('记忆大脑')));
  const svg = fs.readFileSync(path.join(emptyVault, '图谱/记忆大脑.svg'), 'utf8');
  assert.ok(svg.includes('记忆总数：0 条'));
  const home = fs.readFileSync(path.join(emptyVault, '00-记忆大脑.md'), 'utf8');
  assert.ok(home.includes('（暂无'));
  // null / 非对象 brain 也按空库处理
  const nullResult = renderVault(null, { vaultDir: path.join(TMP_ROOT, 'empty-vault-2'), now: NOW });
  assert.equal(nullResult.stats.total, 0);
});

test('自定义 config：protectionLine / decayDays 生效并体现在正文', () => {
  const customVault = path.join(TMP_ROOT, 'custom-config-vault');
  const brain = {
    config: { protectionLine: 0.7, decayDaysLong: 365, decayDaysShort: 45 },
    entities: {},
    relations: [],
    memories: {
      mem_custom_short: makeMemory({
        id: 'mem_custom_short',
        layer: 'short',
        title: '自定义短期记忆',
        text: '正文',
        lastActivatedAt: daysAgo(9),
        // 不显式写 decayDays：渲染时应回落到 brain.config.decayDaysShort（45）
        decayDays: undefined,
      }),
      mem_custom_long: makeMemory({
        id: 'mem_custom_long',
        layer: 'long',
        title: '自定义长期记忆',
        lastActivatedAt: daysAgo(73),
        // 不显式写 decayDays：渲染时应回落到 brain.config.decayDaysLong（365）
        decayDays: undefined,
      }),
    },
  };
  const result = renderVault(brain, { vaultDir: customVault, now: NOW });
  assert.equal(result.stats.protectionLine, 0.7);
  assert.deepEqual(result.stats.decayDays, { long: 365, short: 45 });
  const home = fs.readFileSync(path.join(customVault, '00-记忆大脑.md'), 'utf8');
  assert.ok(home.includes('保护线 70%'));
  assert.ok(home.includes('长期 365 天 / 短期 45 天'));
  const shortFile = result.files.find((file) => file.includes('mem_custom_short'));
  const shortNote = fs.readFileSync(path.join(customVault, ...shortFile.split('/')), 'utf8');
  assert.ok(shortNote.includes('45 天线性衰减'));
  assert.ok(shortNote.includes('████████░░ 80%（保护线 70%）'));
  const longFile = result.files.find((file) => file.includes('mem_custom_long'));
  const longNote = fs.readFileSync(path.join(customVault, ...longFile.split('/')), 'utf8');
  assert.ok(longNote.includes('365 天线性衰减'));
  assert.ok(longNote.includes('80%'));
});

// ---------------------------------------------------------------------------
// Obsidian 配置 / 主页导航
// ---------------------------------------------------------------------------

test('.obsidian/app.json + graph.json 可解析，Graph View 有 7 组颜色', () => {
  const app = JSON.parse(readVault('.obsidian/app.json'));
  assert.equal(typeof app, 'object');
  assert.equal(app.alwaysUpdateLinks, true);
  assert.ok('newFileLocation' in app);
  const graph = JSON.parse(readVault('.obsidian/graph.json'));
  assert.ok(Array.isArray(graph.colorGroups));
  assert.equal(graph.colorGroups.length, 7);
  const queries = graph.colorGroups.map((group) => group.query);
  assert.deepEqual(queries, [
    'path:"记忆/永久"',
    'path:"记忆/长期"',
    'path:"记忆/短期"',
    'path:"日记"',
    'path:"实体"',
    'path:"记忆/边缘"',
    'path:"记忆/已取代"',
  ]);
  for (const group of graph.colorGroups) {
    assert.equal(group.color.a, 1);
    assert.equal(typeof group.color.rgb, 'number');
  }
  // 金色 / 蓝色 / 灰色 rgb 固定
  assert.deepEqual(graph.colorGroups[0].color, { a: 1, rgb: 0xf5b301 });
  assert.deepEqual(graph.colorGroups[1].color, { a: 1, rgb: 0x3b82f6 });
  assert.deepEqual(graph.colorGroups[2].color, { a: 1, rgb: 0x9ca3af });
});

test('README / 00-记忆大脑：导航、嵌入 SVG、统计与保护线说明齐全', () => {
  const home = readVault('00-记忆大脑.md');
  assert.ok(home.includes('![[图谱/记忆大脑.svg]]'));
  assert.ok(home.includes('[[图谱/记忆大脑.canvas|'));
  assert.ok(home.includes('[[README|README]]'));
  assert.ok(home.includes('## 📊 统计'));
  assert.ok(home.includes('| 记忆总数 | 9 |'));
  assert.ok(home.includes('| 🟡 永久记忆 | 1 |'));
  assert.ok(home.includes('| 🔵 长期记忆 | 4 |'));
  assert.ok(home.includes('| ⚪ 短期记忆 | 2 |'));
  assert.ok(home.includes('| 🌑 边缘记忆 | 2（淡忘中 1 / 已淡出 1） |'));
  assert.ok(home.includes('## 🟡 永久记忆（1）'));
  assert.ok(home.includes('[[实体/person/主人|主人]]'));
  assert.ok(home.includes('## 🕰 最近激活'));

  const readme = readVault('README.md');
  assert.ok(readme.includes('# QQ Bridge 记忆大脑 vault'));
  assert.ok(readme.includes('## 目录结构'));
  assert.ok(readme.includes('## 颜色含义'));
  assert.ok(readme.includes('## 如何刷新'));
  assert.ok(readme.includes('state/memory-vault'));
  assert.ok(readme.includes(AUTO_GEN_NOTICE));
});

test('分域拓扑：群聊 / 私信 / 黑话各一张 SVG + Canvas，主页有入口', () => {
  const expectedFiles = [
    '图谱/拓扑-群聊.svg',
    '图谱/拓扑-群聊.canvas',
    '图谱/拓扑-私信.svg',
    '图谱/拓扑-私信.canvas',
    '图谱/拓扑-黑话.svg',
    '图谱/拓扑-黑话.canvas',
  ];
  for (const relativePath of expectedFiles) {
    assert.ok(fs.existsSync(vaultPath(relativePath)), `缺少 ${relativePath}`);
  }
  const cases = [
    { file: '图谱/拓扑-群聊.canvas', title: '群聊拓扑', minNodes: 3, mustHave: ['QQ 桥接测试群', '主人'] },
    { file: '图谱/拓扑-私信.canvas', title: '私信拓扑', minNodes: 2, mustHave: ['主人'] },
    { file: '图谱/拓扑-黑话.canvas', title: '黑话拓扑', minNodes: 2, mustHave: ['Rust'] },
  ];
  for (const item of cases) {
    const canvas = JSON.parse(readVault(item.file));
    assert.ok(Array.isArray(canvas.nodes) && canvas.nodes.length >= item.minNodes, `${item.file} 节点不足`);
    assert.ok(Array.isArray(canvas.edges) && canvas.edges.length > 0, `${item.file} 连线不足`);
    assert.ok(canvas.nodes.every((node) => node.type === 'text' && typeof node.text === 'string'));
    const texts = canvas.nodes.map((node) => node.text).join('\n');
    for (const needle of item.mustHave) assert.ok(texts.includes(needle), `${item.file} 缺少 ${needle}`);
    const ids = canvas.nodes.map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length, `${item.file} 节点 id 必须唯一`);
    const idSet = new Set(ids);
    for (const edge of canvas.edges) {
      assert.ok(idSet.has(edge.fromNode) && idSet.has(edge.toNode), `${item.file} 悬空边 ${edge.fromNode}->${edge.toNode}`);
    }
    const svgPath = item.file.replace(/\.canvas$/, '.svg');
    const svg = readVault(svgPath);
    assert.ok(svg.includes(`>${item.title}<`), `${svgPath} 缺少标题`);
    assert.ok(svg.includes('width="1600"') && svg.includes('height="1000"'), `${svgPath} 尺寸应为 1600×1000`);
    assert.ok(svg.includes(AUTO_GEN_NOTICE));
  }
  // 黑话拓扑只放词条/使用者和群 hub，不放记忆节点。
  const slang = JSON.parse(readVault('图谱/拓扑-黑话.canvas'));
  assert.ok(slang.nodes.every((node) => !String(node.text).includes('记忆')), '黑话拓扑不应包含记忆节点');
  const home = readVault('00-记忆大脑.md');
  assert.ok(home.includes('### 🧭 分域拓扑'));
  assert.ok(home.includes('[[图谱/拓扑-群聊.svg|群聊拓扑]]'));
  const readme = readVault('README.md');
  assert.ok(readme.includes('图谱/拓扑-群聊.svg'));
  assert.ok(readme.includes('图谱/拓扑-*.canvas'));
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI --json：返回 ok / version / stats / files', () => {
  const cliVault = path.join(TMP_ROOT, 'cli-vault');
  const run = runCli([
    '--brain',
    FIXTURE_BRAIN_PATH,
    '--vault',
    cliVault,
    '--now',
    String(NOW),
    '--json',
  ]);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.version, 1);
  assert.equal(payload.vaultDir, cliVault);
  assert.equal(payload.stats.total, 9);
  assert.equal(payload.files.length, 27);
  assert.ok(payload.files.includes('00-记忆大脑.md'));
  assert.ok(fs.existsSync(path.join(cliVault, '图谱/记忆大脑.svg')));
  assert.ok(fs.existsSync(path.join(cliVault, '00-记忆大脑.md')));
});

test('CLI 人类输出：中文摘要、--now 固定时间生效', () => {
  const cliVault = path.join(TMP_ROOT, 'cli-human-vault');
  const run = runCli(['--brain', FIXTURE_BRAIN_PATH, '--vault', cliVault, '--now', String(NOW)]);
  assert.ok(run.stdout.includes('已刷新记忆大脑 vault'), `输出异常：${run.stdout}`);
  assert.ok(run.stdout.includes('记忆 9 条'));
  assert.ok(run.stdout.includes('永久 1'));
  assert.ok(run.stdout.includes('Canvas'));
  const home = fs.readFileSync(path.join(cliVault, '00-记忆大脑.md'), 'utf8');
  assert.ok(home.includes('2026-10-27 12:00 UTC'));

  // --now 换一天：生成时间应变化，强度也会衰减。
  const laterVault = path.join(TMP_ROOT, 'cli-later-vault');
  const laterNow = NOW + 30 * DAY_MS;
  runCli(['--brain', FIXTURE_BRAIN_PATH, '--vault', laterVault, '--now', String(laterNow)]);
  const laterHome = fs.readFileSync(path.join(laterVault, '00-记忆大脑.md'), 'utf8');
  assert.ok(laterHome.includes('2026-11-26 12:00 UTC'));
  assert.notEqual(laterHome, home);
});

test('CLI 缺 brain.json：友好提示并退出 0（--json 时输出 skipped）', () => {
  const missing = path.join(TMP_ROOT, 'missing-state', 'memory', 'brain.json');
  const run = runCli(['--brain', missing]);
  assert.equal(run.status, 0);
  assert.ok(run.stdout.includes('跳过刷新'), `输出异常：${run.stdout}`);
  assert.ok(run.stdout.includes('memory-bootstrap'));
  const jsonRun = runCli(['--brain', missing, '--json']);
  const payload = JSON.parse(jsonRun.stdout);
  assert.equal(payload.skipped, true);
  assert.equal(payload.ok, true);
});

test('CLI 错误处理：坏 JSON / 未知参数 / --help / --version', () => {
  const badBrain = path.join(TMP_ROOT, 'bad-brain.json');
  fs.writeFileSync(badBrain, '{ 这不是 JSON', 'utf8');
  const badRun = runCli(['--brain', badBrain], { expectStatus: 1 });
  assert.ok(badRun.stderr.includes('解析失败'), `stderr 异常：${badRun.stderr}`);
  assert.ok(badRun.stderr.includes('刷新失败'));
  const unknownRun = runCli(['--nope'], { expectStatus: 1 });
  assert.ok(unknownRun.stderr.includes('未知参数'));
  const helpRun = runCli(['--help']);
  assert.ok(helpRun.stdout.includes('用法：'));
  assert.ok(helpRun.stdout.includes('--brain'));
  const versionRun = runCli(['--version']);
  assert.equal(versionRun.stdout.trim(), 'vault v1');
  assert.equal(runCli(['-h']).status, 0);
});

test('CLI 默认 vaultDir：按 config.vaultDir 相对 state/ 解析', () => {
  const stateDir = path.join(TMP_ROOT, 'state-with-config');
  const brain = { ...fixtureBrain, config: { vaultDir: 'custom-vault' } };
  const brainPath = writeCliBrain(brain, stateDir);
  const run = runCli(['--brain', brainPath, '--now', String(NOW)]);
  const expectedVault = path.join(stateDir, 'custom-vault');
  assert.ok(fs.existsSync(path.join(expectedVault, 'README.md')), `未写入预期 vault：${expectedVault}`);
  assert.ok(run.stdout.includes(expectedVault), `输出未包含 vault 路径：${run.stdout}`);

  // state/memory/config.json 覆盖 brain.config（与 store.mjs 的合并顺序一致）。
  fs.writeFileSync(
    path.join(stateDir, 'memory', 'config.json'),
    JSON.stringify({ vaultDir: 'config-file-vault', protectionLine: 0.7 }),
    'utf8',
  );
  const overrideRun = runCli(['--brain', brainPath, '--now', String(NOW), '--json']);
  const overridePayload = JSON.parse(overrideRun.stdout);
  assert.equal(overridePayload.vaultDir, path.join(stateDir, 'config-file-vault'));
  assert.equal(overridePayload.stats.protectionLine, 0.7);
  assert.ok(fs.existsSync(path.join(stateDir, 'config-file-vault', '00-记忆大脑.md')));

  // 显式 --vault 优先级最高。
  const explicitVault = path.join(TMP_ROOT, 'explicit-vault');
  const explicitRun = runCli(['--brain', brainPath, '--vault', explicitVault, '--now', String(NOW), '--json']);
  assert.equal(JSON.parse(explicitRun.stdout).vaultDir, explicitVault);
  assert.ok(fs.existsSync(path.join(explicitVault, '00-记忆大脑.md')));
});

test('CLI --state：默认读取 <state>/memory/brain.json 并写到 <state>/memory-vault', () => {
  const stateDir = path.join(TMP_ROOT, 'state-cli');
  writeCliBrain(fixtureBrain, stateDir);
  const run = runCli(['--state', stateDir, '--now', String(NOW), '--json']);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.vaultDir, path.join(stateDir, 'memory-vault'));
  assert.ok(fs.existsSync(path.join(stateDir, 'memory-vault', '00-记忆大脑.md')));
});

// ---------------------------------------------------------------------------
// 显示上限 / 恢复 / brain 不变
// ---------------------------------------------------------------------------

test('大 brain 显示上限：Canvas/SVG 按强度截断并回报隐藏数量', () => {
  const bigVault = path.join(TMP_ROOT, 'big-vault');
  const entities = {};
  for (let i = 0; i < 5; i += 1) {
    entities[`ent_big_${i}`] = {
      id: `ent_big_${i}`,
      type: i < 2 ? 'person' : 'topic',
      name: `实体${i}`,
      aliases: [],
      tags: [],
      mentionCount: i,
    };
  }
  const memories = {};
  const add = (id, layer, lastDays, extra = {}) => {
    memories[id] = makeMemory({
      id,
      layer,
      title: `大库记忆 ${id}`,
      text: '内容',
      entityIds: [`ent_big_${id.length % 5}`],
      lastActivatedAt: daysAgo(lastDays),
      ...extra,
    });
  };
  for (let i = 0; i < 20; i += 1) add(`mem_bigp_${String(i).padStart(2, '0')}`, 'long', 1, { protection: 1, permanent: true });
  for (let i = 0; i < 130; i += 1) add(`mem_bigl_${String(i).padStart(3, '0')}`, 'long', 5);
  for (let i = 0; i < 10; i += 1) add(`mem_bigs_${String(i).padStart(2, '0')}`, 'short', 3);
  for (let i = 0; i < 10; i += 1) add(`mem_bige_${String(i).padStart(2, '0')}`, 'short', 28);
  const result = renderVault({ config: {}, entities, relations: [], memories }, { vaultDir: bigVault, now: NOW });
  assert.equal(result.stats.total, 170);
  assert.deepEqual(result.stats.vaultLayers, { permanent: 20, long: 130, short: 10, edge: 10, superseded: 0 });
  assert.equal(result.stats.canvas.displayedMemories, 150); // 20 + 110 + 10 + 10
  assert.equal(result.stats.canvas.hiddenMemories, 20); // long 被截断 130 → 110
  assert.equal(result.stats.canvas.displayedEntities, 5);
  assert.equal(result.stats.canvas.nodes, 157); // 中心 + 150 记忆 + 5 实体 + 图例
  assert.equal(result.stats.canvas.edges, 300); // 150 中心边 + 150 记忆-实体边
  assert.equal(result.files.length, 2 + 170 + 5 + 2 + 2 + 2); // 固定 6 + 记忆 170 + 实体 5 + 群聊拓扑 2（大 brain 里所有记忆都来自 group）
  const svg = fs.readFileSync(path.join(bigVault, '图谱/记忆大脑.svg'), 'utf8');
  assert.ok(svg.includes('136/170 条'), 'SVG 概览应说明显示的条数上限');
  assert.ok(svg.includes('5/5 个实体'));
  const canvas = JSON.parse(fs.readFileSync(path.join(bigVault, '图谱/记忆大脑.canvas'), 'utf8'));
  assert.ok(canvas.nodes.length <= 160, 'Canvas 节点必须有上限，不能把 170 条全铺开');
});

test('重渲染可恢复被删除/被手改的生成文件', () => {
  const noteFile = memoryFile('mem_long_game01');
  const original = readVault(noteFile);
  fs.writeFileSync(vaultPath(noteFile), '手改坏了', 'utf8');
  fs.unlinkSync(vaultPath('图谱/记忆大脑.canvas'));
  const result = renderVault(fixtureBrain, { vaultDir: MAIN_VAULT, now: NOW });
  assert.equal(result.stats.cleaned, 0);
  assert.equal(readVault(noteFile), original);
  assert.ok(fs.existsSync(vaultPath('图谱/记忆大脑.canvas')));
  JSON.parse(readVault('图谱/记忆大脑.canvas')); // 仍是合法 JSON
});

test('渲染不写 brain.json、不产生额外状态文件', () => {
  const before = fs.readFileSync(FIXTURE_BRAIN_PATH, 'utf8');
  renderVault(fixtureBrain, { vaultDir: path.join(TMP_ROOT, 'readonly-brain-vault'), now: NOW });
  assert.equal(fs.readFileSync(FIXTURE_BRAIN_PATH, 'utf8'), before, 'brain.json 不应被改写');
  const vaultFiles = walkFiles(path.join(TMP_ROOT, 'readonly-brain-vault'));
  assert.ok(!vaultFiles.some((file) => file.endsWith('brain.json')));
  assert.ok(!vaultFiles.some((file) => file.endsWith('.lock')));
});

test('日记：单独归档到 日记/，不占四层、主页有日记段、旧位置被清理', () => {
  const vaultDir = path.join(TMP_ROOT, 'diary-vault');
  const diaryMemory = makeMemory({
    id: 'mem_diary01',
    layer: 'short',
    category: 'event',
    title: '日记·2026-10-27',
    text: '今天写了日记：把猫条账记上。',
    tags: ['diary'],
    createdAt: daysAgo(1),
    strength: 0.01,
    status: 'fading',
  });
  const plainMemory = makeMemory({ id: 'mem_short01', layer: 'short', title: '普通短期记忆', text: '普通正文' });
  const brain = {
    version: 1,
    createdAt: daysAgo(500),
    updatedAt: NOW,
    config: {},
    entities: {},
    relations: {},
    memories: { mem_diary01: diaryMemory, mem_short01: plainMemory },
  };

  // 模拟升级前的旧位置（vault 里可能已经有 记忆/短期/日记 文件）。
  const oldPath = path.join(vaultDir, '记忆', '短期', 'mem_diary01-日记·2026-10-27.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.writeFileSync(oldPath, '旧版本生成的文件', 'utf8');

  const result = renderVault(brain, { vaultDir, now: NOW });
  const diaryFile = result.files.find((file) => file.startsWith('日记/') && file.endsWith('.md'));
  assert.ok(diaryFile, `日记应归档到 日记/，实际文件：${result.files.join(', ')}`);
  assert.ok(!result.files.some((file) => file.startsWith('记忆/') && file.includes('mem_diary01')));
  assert.equal(result.stats.diary, 1);
  assert.equal(result.stats.byLayer.short, 1, '日记不应计入短期层');

  const note = fs.readFileSync(path.join(vaultDir, diaryFile), 'utf8');
  assert.ok(note.includes('日记：单独归档在'));
  assert.ok(note.includes('diary: true'));
  const home = fs.readFileSync(path.join(vaultDir, '00-记忆大脑.md'), 'utf8');
  assert.ok(home.includes('## 📔 日记（1）'));
  assert.ok(home.includes('| 📔 日记（单独归档） | 1 |'));
  const readme = fs.readFileSync(path.join(vaultDir, 'README.md'), 'utf8');
  assert.ok(readme.includes('日记/'));
  assert.ok(!fs.existsSync(oldPath), '旧位置的日记文件应被清理');
  assert.ok(result.stats.cleaned >= 1);
});


const elapsedMs = Date.now() - NOW;
fs.rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n❌ 记忆大脑 vault 测试失败：${failed} 个用例失败，${passed} 个通过`);
  process.exit(1);
}
console.log(`\n🎉 记忆大脑 vault 全部 ${passed} 个用例通过`);
console.log(`   临时 vault 已清理：${TMP_ROOT}`);
void elapsedMs;
