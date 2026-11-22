#!/usr/bin/env node
// 记忆系统引擎测试：model（纯函数）/ store（持久化 + 锁 + 备份 + 恢复）/ service（业务状态机）/
// cli（运维命令）。全部使用 os.tmpdir() 下的临时仓库，绝不读写真实 state/memory。
//
// 运行：D:\node.exe scripts/test-memory-engine.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as model from '../src/memory/model.mjs';
import { MemoryStore } from '../src/memory/store.mjs';
import { MemoryError, createService } from '../src/memory/service.mjs';
import { runCli } from '../src/memory/cli.mjs';
import * as autoRecallModule from '../src/memory/auto-recall.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI_PATH = path.join(ROOT, 'src', 'memory', 'cli.mjs');
const DAY = model.DAY_MS;
const T0 = Date.parse('2026-01-01T00:00:00Z');

const tmpDirs = [];
const failures = [];
let passed = 0;

function makeRepo(label = 'repo') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-memory-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function section(title) {
  console.log(`\n# ${title}`);
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`not ok - ${name}`);
    console.log(
      String(error?.stack ?? error)
        .split('\n')
        .slice(0, 8)
        .join('\n')
    );
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`not ok - ${name}`);
    console.log(
      String(error?.stack ?? error)
        .split('\n')
        .slice(0, 8)
        .join('\n')
    );
  }
}

function throwsMemoryError(fn, code) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, '期望抛出错误，但没有');
  assert.ok(thrown instanceof MemoryError, `期望 MemoryError，实际是 ${thrown?.name}: ${thrown?.message}`);
  if (code) assert.equal(thrown.code, code);
  return thrown;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function brainPathOf(repo) {
  return path.join(repo, 'state', 'memory', 'brain.json');
}

function writeConfig(repo, config) {
  const memoryDir = path.join(repo, 'state', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function listTmpFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

// ---------------------------------------------------------------------------
// A. model：id / 衰减公式 / 状态机 / 排序 / 配置
// ---------------------------------------------------------------------------
section('model：id 与衰减公式');

check('id 稳定、格式正确且受来源影响', () => {
  const a = model.memoryId('今天天气不错', 'group:1');
  const b = model.memoryId('今天天气不错', 'group:1');
  assert.equal(a, b);
  assert.match(a, /^mem_[0-9a-f]{12}$/);
  assert.match(model.entityId('person', '张三'), /^ent_[0-9a-f]{12}$/);
  assert.match(model.relationId('ent_a', 'likes', 'ent_b'), /^rel_[0-9a-f]{12}$/);
  assert.notEqual(model.memoryId('今天天气不错', 'group:2'), a);
});

check('长期层衰减：第 100 天 0.5、第 200 天 0', () => {
  const memory = { lastActivatedAt: T0, baseStrength: 1, decayDays: 200, protection: 0 };
  assert.equal(model.computeStrength(memory, T0 + 100 * DAY), 0.5);
  assert.equal(model.computeStrength(memory, T0 + 200 * DAY), 0);
  assert.equal(model.computeStrength(memory, T0 + 15 * DAY), 0.925);
  assert.equal(model.computeStrength(memory, T0 - 5 * DAY), 1); // 未来时间不影响
});

check('短期层衰减：第 30 天归零、强度保留 4 位小数', () => {
  const memory = { lastActivatedAt: T0, baseStrength: 1, decayDays: 30, protection: 0 };
  assert.equal(model.computeStrength(memory, T0 + DAY), 0.9667);
  assert.equal(model.computeStrength(memory, T0 + 15 * DAY), 0.5);
  assert.equal(model.computeStrength(memory, T0 + 30 * DAY), 0);
});

check('protection=0.5 不是永久且不设下限；protection=1 永久', () => {
  const base = { lastActivatedAt: T0, baseStrength: 1, decayDays: 200 };
  const half = { ...base, protection: 0.5 };
  assert.equal(model.isPermanent(half), false);
  // 若 protection 被误当作下限，这里会是 0.5
  assert.equal(model.computeStrength(half, T0 + 100 * DAY), 0.5);
  const permanent = { ...base, protection: 1 };
  assert.equal(model.isPermanent(permanent), true);
  assert.equal(model.computeStrength(permanent, T0 + 999 * DAY), 1);
});

check('statusForStrength 阈值边界', () => {
  const config = model.normalizeConfig({});
  assert.equal(model.statusForStrength(1, config), 'active');
  assert.equal(model.statusForStrength(0.15, config), 'active');
  assert.equal(model.statusForStrength(0.1499, config), 'fading');
  assert.equal(model.statusForStrength(0.0501, config), 'fading');
  assert.equal(model.statusForStrength(0.05, config), 'faded');
  assert.equal(model.statusForStrength(0, config), 'faded');
});

section('model：materialize 状态机');

check('active → fading → faded，purgeAfter 只设置一次不后推', () => {
  const config = model.normalizeConfig({});
  const base = { ...model.emptyMemory({ text: '测试记忆', now: T0 }), decayDays: 30, protection: 0 };

  const day20 = clone(base);
  model.materializeMemory(day20, T0 + 20 * DAY, config);
  assert.equal(day20.status, 'active');
  assert.equal(day20.strength, 0.3333);
  assert.equal(day20.fadingSince, null);

  const day26 = clone(base);
  model.materializeMemory(day26, T0 + 26 * DAY, config);
  assert.equal(day26.status, 'fading');
  assert.equal(day26.fadingSince, T0 + 26 * DAY);
  assert.equal(day26.purgeAfter, null);

  const day29 = clone(base);
  model.materializeMemory(day29, T0 + 29 * DAY, config);
  assert.equal(day29.status, 'faded');
  assert.equal(day29.purgeAfter, T0 + 29 * DAY + 7 * DAY);

  model.materializeMemory(day29, T0 + 30 * DAY, config);
  assert.equal(day29.purgeAfter, T0 + 29 * DAY + 7 * DAY, 'purgeAfter 不能被反复后推');
  assert.equal(model.isPurgeDue(day29, T0 + 29 * DAY + 7 * DAY - 1), false);
  assert.equal(model.isPurgeDue(day29, T0 + 29 * DAY + 7 * DAY), true);
});

check('永久记忆物化后 strength=1 / status=active；归档记忆冻结', () => {
  const config = model.normalizeConfig({});
  const permanent = { ...model.emptyMemory({ text: '永久记忆', now: T0 }), protection: 1 };
  model.materializeMemory(permanent, T0 + 999 * DAY, config);
  assert.equal(permanent.strength, 1);
  assert.equal(permanent.status, 'active');
  assert.equal(permanent.permanent, true);

  const archived = { ...model.emptyMemory({ text: '归档记忆', now: T0 }), status: 'archived' };
  model.materializeMemory(archived, T0 + 999 * DAY, config);
  assert.equal(archived.status, 'archived');
});

check('materializeBrain(archive) 归档到期边缘记忆而不是删除', () => {
  const config = model.normalizeConfig({});
  const brain = model.emptyBrain(T0, config);
  const memory = { ...model.emptyMemory({ text: '将被归档', now: T0 }), decayDays: 30, protection: 0 };
  brain.memories[memory.id] = memory;
  model.materializeMemory(memory, T0 + 29 * DAY, config);
  assert.equal(memory.status, 'faded');
  const result = model.materializeBrain(brain, T0 + 29 * DAY + 7 * DAY, config, { archive: true });
  assert.equal(result.archived.length, 1);
  assert.equal(result.archived[0].id, memory.id);
  assert.equal(result.archived[0].reason, 'decayed');
  assert.equal(Object.keys(brain.memories).length, 1, '归档不删除记忆');
  assert.equal(brain.memories[memory.id].status, 'archived');
  assert.equal(brain.memories[memory.id].archivedReason, 'decayed');
  assert.equal(result.changed, true);
});

section('model：文本相似度 / 关键词 / 排序 / 配置');

check('中文分词与关键词提取', () => {
  const words = model.segmentWords('小明喜欢喝冰美式咖啡，不加糖');
  assert.ok(words.length >= 3, `分词结果太少：${JSON.stringify(words)}`);
  const keywords = model.extractKeywords('小明喜欢喝冰美式，不加糖', { limit: 8 });
  assert.ok(keywords.length > 0);
  assert.ok(keywords.some((word) => word.includes('冰美式') || word.includes('喜欢') || word.includes('小明')));
});

check('textSimilarity：去标点等价 = 1，相似句 >= 0.82，无关句 < 0.82', () => {
  assert.equal(model.textSimilarity('小明喜欢喝冰美式，不加糖。', '小明喜欢喝冰美式，不加糖！'), 1);
  const similar = model.textSimilarity('小明喜欢喝冰美式，不加糖。', '小明喜欢喝冰美式，不加糖也不加奶。');
  assert.ok(similar >= 0.82, `相似句得分 ${similar}`);
  const different = model.textSimilarity('小明喜欢喝冰美式，不加糖。', '周五下午三点在会议室讨论新版本文案。');
  assert.ok(different < 0.82, `无关句得分 ${different}`);
});

check('scoreMemory：相关度 / 层级 / 新近度影响排序', () => {
  const now = T0;
  const base = { lastActivatedAt: now - 60 * DAY, baseStrength: 1, decayDays: 200, strength: 0.7, layer: 'short' };
  const hit = { ...base, title: '小明喜欢冰美式', text: '小明喜欢冰美式，不加糖', keywords: ['小明', '冰美式'] };
  const miss = { ...base, title: '周五开会', text: '周五下午开会讨论文案', keywords: ['开会'] };
  assert.ok(model.scoreMemory(hit, { query: '小明', now }) > model.scoreMemory(miss, { query: '小明', now }));
  const long = { ...hit, layer: 'long' };
  assert.ok(model.scoreMemory(long, { query: '小明', now }) > model.scoreMemory(hit, { query: '小明', now }));
  const fresh = { ...hit, lastActivatedAt: now };
  assert.ok(model.scoreMemory(fresh, { query: '小明', now }) > model.scoreMemory(hit, { query: '小明', now }));
  assert.equal(model.scoreMemory(hit, { query: '', now }), model.scoreMemory(hit, { query: '', now, entityHit: 0 }));
});

check('normalizeConfig：默认值、范围钳制、fade/forget 语义保护', () => {
  const defaults = model.normalizeConfig({});
  assert.equal(defaults.decayDaysLong, 200);
  assert.equal(defaults.decayDaysShort, 30);
  assert.equal(defaults.protectionLine, 0.5);
  assert.equal(defaults.fadeThreshold, 0.15);
  assert.equal(defaults.forgetThreshold, 0.05);
  assert.equal(defaults.purgeGraceDays, 7);
  assert.equal(defaults.defaultLayer, 'short');
  assert.equal(defaults.vaultDir, 'memory-vault');
  const custom = model.normalizeConfig({
    decayDaysLong: 99999,
    decayDaysShort: -5,
    defaultLayer: 'long',
    fadeThreshold: 0.02,
    forgetThreshold: 0.4,
    vaultDir: 'obsidian-vault',
    unknownKey: '忽略',
  });
  assert.equal(custom.decayDaysLong, 36500);
  assert.equal(custom.decayDaysShort, 1);
  assert.equal(custom.defaultLayer, 'long');
  assert.equal(custom.fadeThreshold, 0.4, 'fadeThreshold 必须 >= forgetThreshold');
  assert.equal(custom.vaultDir, 'obsidian-vault');
  assert.equal(custom.unknownKey, undefined);
});

// ---------------------------------------------------------------------------
// B. store：原子写 / 备份轮转 / 损坏恢复 / 跨进程锁 / 事件日志
// ---------------------------------------------------------------------------
section('store：持久化与健壮性');

check('空库 load 不抛错、不落盘；save 原子写入且不留 tmp', () => {
  const repo = makeRepo('store-basic');
  let NOW = T0;
  const store = new MemoryStore({ repoRoot: repo, now: () => NOW });
  const loaded = store.load();
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.memories, {});
  assert.equal(fs.existsSync(brainPathOf(repo)), false, 'load 不应创建 brain.json');

  const brain = store.load();
  brain.memories.mem_test = { ...model.emptyMemory({ text: '测试写入', now: NOW }) };
  store.save(brain);
  const memoryDir = path.join(repo, 'state', 'memory');
  assert.equal(fs.existsSync(brainPathOf(repo)), true);
  assert.equal(listTmpFiles(memoryDir).length, 0);
  const reparsed = JSON.parse(fs.readFileSync(brainPathOf(repo), 'utf8'));
  assert.ok(reparsed.memories.mem_test);
  assert.ok(reparsed.updatedAt > 0);
});

check('v1.6 增量持久化：journal 追加 + 回放 + purge + 超限 compact', () => {
  const repo = makeRepo('store-journal');
  let NOW = T0;
  const store = new MemoryStore({ repoRoot: repo, now: () => NOW, journalMaxBytes: 64 * 1024 });
  const memoryDir = path.join(repo, 'state', 'memory');
  const journalPath = path.join(memoryDir, 'journal.jsonl');
  // 首次全量写
  const base = store.load();
  base.memories.mem_j1 = { ...model.emptyMemory({ text: '第一条增量测试记忆', now: NOW }) };
  store.save(base);
  assert.equal(fs.existsSync(journalPath), false, '全量写后 journal 应被截断');
  const baseMtime = fs.statSync(brainPathOf(repo)).mtimeMs;
  NOW += 1000;
  // 增量写：只追加 journal，不动 brain.json
  const next = store.load();
  next.memories.mem_j2 = { ...model.emptyMemory({ text: '第二条增量测试记忆', now: NOW }) };
  store.save(next, { events: [{ type: 'remember', id: 'mem_j2' }] });
  assert.equal(fs.existsSync(journalPath), true, '增量写应生成 journal');
  assert.equal(fs.statSync(brainPathOf(repo)).mtimeMs, baseMtime, '增量写不应全量重写 brain.json');
  // 新进程回放：能看到两条
  const replay = new MemoryStore({ repoRoot: repo, now: () => NOW, journalMaxBytes: 64 * 1024 });
  const loaded = replay.load();
  assert.ok(loaded.memories.mem_j1, '全量快照里的记忆仍在');
  assert.ok(loaded.memories.mem_j2, 'journal 回放应带回增量记忆');
  // purge：journal 记录 removedMemories
  const third = replay.load();
  delete third.memories.mem_j2;
  replay.save(third, { events: [{ type: 'purge', id: 'mem_j2' }] });
  const afterPurge = new MemoryStore({ repoRoot: repo, now: () => NOW }).load();
  assert.equal(afterPurge.memories.mem_j2, undefined, 'journal 回放应执行 purge 删除');
  // 超过阈值 → compact 全量落盘并清空 journal
  NOW += 1000;
  const heavy = replay.load();
  for (let index = 0; index < 40; index += 1) {
    const text = `大块增量测试第 ${index} 条：${'内容'.repeat(9000)}`;
    heavy.memories[`mem_heavy_${index}`] = { ...model.emptyMemory({ text, now: NOW }) };
    replay.save(heavy, { events: [{ type: 'remember', id: `mem_heavy_${index}` }] });
    if (fs.existsSync(journalPath)) {
      assert.ok(fs.statSync(journalPath).size <= 64 * 1024 + 8192, 'journal 不应无限增长');
    }
  }
  const brainRaw = JSON.parse(fs.readFileSync(brainPathOf(repo), 'utf8'));
  assert.ok(brainRaw.memories.mem_heavy_20, 'journal 超限时应 compact 到 brain.json');
  const journalBytes = fs.existsSync(journalPath) ? fs.statSync(journalPath).size : 0;
  assert.ok(journalBytes <= 64 * 1024 + 8192, `journal 不应无限增长（当前 ${journalBytes}）`);
  const compacted = new MemoryStore({ repoRoot: repo, now: () => NOW }).load();
  assert.ok(compacted.memories.mem_heavy_39, 'compact 后回放包含最新记忆');
});

check('备份轮转：保留 backupKeep 份，内容为写前快照', () => {
  const repo = makeRepo('store-backup');
  let NOW = T0;
  writeConfig(repo, { backupKeep: 3 });
  const store = new MemoryStore({ repoRoot: repo, now: () => NOW });
  for (let index = 0; index < 7; index += 1) {
    const brain = store.withLock(() => {
      const snapshot = store.load();
      snapshot.memories[`mem_${String(index).padStart(12, '0')}`] = {
        ...model.emptyMemory({ text: `第 ${index} 条备份测试`, now: NOW }),
      };
      store.save(snapshot);
      return snapshot;
    });
    NOW += 1000;
  }
  const backups = fs.readdirSync(path.join(repo, 'state', 'memory', 'backups'));
  assert.equal(backups.length, 3, `期望 3 份备份，实际 ${backups.length}`);
  const latest = JSON.parse(fs.readFileSync(path.join(repo, 'state', 'memory', 'backups', backups[0]), 'utf8'));
  assert.ok(latest.memories && typeof latest.memories === 'object');
});

check('损坏恢复：坏 brain.json → 改名 corrupt → 从最新备份恢复，不抛错', () => {
  const repo = makeRepo('store-corrupt');
  let NOW = T0;
  const store = new MemoryStore({ repoRoot: repo, now: () => NOW });
  for (let index = 0; index < 3; index += 1) {
    const brain = store.load();
    brain.memories[`mem_corrupt_${index}`] = { ...model.emptyMemory({ text: `损坏恢复前第 ${index} 条`, now: NOW }) };
    store.save(brain);
    NOW += 1000;
  }
  const backupDir = path.join(repo, 'state', 'memory', 'backups');
  const backupCount = fs.readdirSync(backupDir).length;
  assert.ok(backupCount >= 2);
  fs.writeFileSync(brainPathOf(repo), '{ 这不是合法 JSON ', 'utf8');

  const store2 = new MemoryStore({ repoRoot: repo, now: () => NOW });
  let recovered;
  assert.doesNotThrow(() => {
    recovered = store2.load();
  });
  assert.ok(recovered && typeof recovered === 'object');
  const reparsed = JSON.parse(fs.readFileSync(brainPathOf(repo), 'utf8'));
  assert.ok(reparsed.memories, '恢复后 brain 必须是合法结构');
  assert.ok(Object.keys(reparsed.memories).length >= 1, '应从备份中恢复出至少 1 条记忆');
  const corruptFiles = fs.readdirSync(path.join(repo, 'state', 'memory')).filter((name) => name.startsWith('brain.corrupt-'));
  assert.equal(corruptFiles.length, 1, '坏文件应改名为 brain.corrupt-*');
  const events = store2.readEvents({ limit: 50 });
  assert.ok(events.some((event) => event.type === 'recover'));
});

check('events.jsonl 追加与超限轮转', () => {
  const repo = makeRepo('store-events');
  const store = new MemoryStore({ repoRoot: repo, now: () => T0 });
  for (let index = 0; index < 10; index += 1) {
    store.appendEvent({ type: 'test', id: `evt_${index}`, detail: { payload: 'x'.repeat(200) } }, { keepBytes: 1024 });
  }
  const eventsPath = path.join(repo, 'state', 'memory', 'events.jsonl');
  assert.equal(fs.existsSync(eventsPath), true);
  assert.equal(fs.existsSync(`${eventsPath}.1`), true, '超过 keepBytes 应轮转为 .1');
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  for (const line of lines) JSON.parse(line);
  const parsed = store.readEvents({ limit: 100 });
  assert.ok(parsed.length >= 1);
  assert.ok(parsed.every((event) => event.type === 'test'));
});

check('跨进程锁：陈旧锁可接管、活锁超时报 LOCK_TIMEOUT、异常后释放', () => {
  const repo = makeRepo('store-lock');
  const store = new MemoryStore({ repoRoot: repo, staleLockMs: 1000 });
  store.ensureDirs();
  const lockPath = store.paths().lockPath;

  // 1) 陈旧锁（mtime 很久以前）→ 接管
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: 0, token: 'stale' }), 'utf8');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  let ran = false;
  store.withLock(() => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.ok(store.staleBreaks >= 1);
  assert.equal(fs.existsSync(lockPath), false, '释放后锁文件应删除');

  // 2) 活锁（刚创建）→ 等待超时
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 12345, at: Date.now(), token: 'fresh' }), 'utf8');
  const impatient = new MemoryStore({ repoRoot: repo, lockRetries: 1, lockRetryDelayMs: 5, staleLockMs: 60_000 });
  throwsMemoryError(
    () =>
      impatient.withLock(() => {
        throw new Error('不应执行');
      }),
    'LOCK_TIMEOUT'
  );
  fs.unlinkSync(lockPath);

  // 3) 持锁期间抛异常 → finally 释放
  assert.throws(() => {
    store.withLock(() => {
      assert.equal(fs.existsSync(lockPath), true);
      throw new Error('业务失败');
    });
  }, /业务失败/);
  assert.equal(fs.existsSync(lockPath), false);
});

check('inspect 不创建任何文件', () => {
  const repo = makeRepo('store-inspect');
  const store = new MemoryStore({ repoRoot: repo });
  const info = store.inspect();
  assert.equal(info.exists, false);
  assert.equal(info.brainBytes, 0);
  assert.equal(info.backupCount, 0);
  assert.equal(fs.existsSync(path.join(repo, 'state')), false);
  const vaultDir = store.resolveVaultDir('memory-vault');
  assert.equal(vaultDir, path.join(path.resolve(repo), 'state', 'memory-vault'));
});

// ---------------------------------------------------------------------------
// C. service：记忆生命周期
// ---------------------------------------------------------------------------
section('service：remember / 去重 / 来源合并 / 实体');

check('remember 默认值、标题、id 与状态', () => {
  const repo = makeRepo('svc-remember');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const text = '小明喜欢喝冰美式，不加糖。';
  const result = service.remember({ text });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.match(result.id, /^mem_[0-9a-f]{12}$/);
  const memory = result.memory;
  assert.equal(memory.layer, 'short');
  assert.equal(memory.decayDays, 30);
  assert.equal(memory.category, 'other');
  assert.equal(memory.strength, 1);
  assert.equal(memory.status, 'active');
  assert.equal(memory.protection, 0);
  assert.equal(memory.permanent, false);
  assert.equal(memory.title, text);
  assert.ok(memory.keywords.length > 0);
  assert.equal(memory.source.kind, 'chat');
  assert.equal(memory.source.key, 'manual');

  const long = service.remember({ text: '项目上线日期定在十一月，由老王负责。', layer: 'long', title: '上线计划', category: 'event' });
  assert.equal(long.memory.layer, 'long');
  assert.equal(long.memory.decayDays, 200);
  assert.equal(long.memory.title, '上线计划');
  assert.equal(long.memory.category, 'event');
});

check('同层高相似度合并；跨层不合并；同文本不同来源合并并累积 seqs/keys', () => {
  const repo = makeRepo('svc-dedupe');
  let NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const first = service.remember({
    text: '线下聚会定在周六下午三点，地点是城南咖啡店。',
    layer: 'long',
    source: { key: 'group:100', seqs: [11, 12] },
  });
  const second = service.remember({
    text: '线下聚会定在周六下午三点，地点是城南咖啡店！',
    layer: 'long',
    source: { key: 'group:200', seqs: [21] },
  });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(second.mergedInto, first.id);
  assert.equal(second.memory.activationCount, 2);
  assert.equal(second.memory.strength, 1);
  const seqs = (second.memory.source.seqs ?? []).slice().sort((a, b) => a - b);
  assert.deepEqual(seqs, [11, 12, 21], 'source.seqs 应合并追加');
  assert.ok((second.memory.source.keys ?? []).includes('group:100'));
  assert.ok((second.memory.source.keys ?? []).includes('group:200'));

  // 跨层：同文本不同来源不合并（identity 不同）+ 不同层不参与相似度去重
  const crossLayer = service.remember({
    text: '线下聚会定在周六下午三点，地点是城南咖啡店。',
    layer: 'short',
    source: { key: 'group:300' },
  });
  assert.equal(crossLayer.created, true);
  assert.notEqual(crossLayer.id, first.id);

  // 无关文本不合并
  const unrelated = service.remember({ text: '明天的天气看起来是多云转晴，气温十五度。', layer: 'long' });
  assert.equal(unrelated.created, true);
});

check('remember 自动 upsert 实体并累计 mentionCount；relations 参数建立关系', () => {
  const repo = makeRepo('svc-entities');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const first = service.remember({
    text: '张三在群里说下周三要去上海出差。',
    entityNames: ['张三', '上海'],
    relations: [{ to: '上海', relation: 'part_of' }],
  });
  assert.equal(first.memory.entityIds.length, 2);
  const zhang = service.getEntity('张三');
  assert.equal(zhang.type, 'topic');
  assert.equal(zhang.mentionCount, 1);

  service.remember({ text: '张三这次出差会带新品样品过去。', entityNames: ['张三'] });
  const zhang2 = service.getEntity('张三');
  assert.equal(zhang2.mentionCount, 2, '再次提及时 mentionCount 应 +1');

  const graph = service.graph({ entity: '张三', depth: 1 });
  assert.ok(graph.entities.some((entity) => entity.name === '张三'));
  assert.ok(graph.memories.length >= 1, '实体应关联到记忆');
});

section('service：衰减 / search 只读 / recall / touch');

check('search 只读不重置衰减；recall 强化前 3 条并重置衰减', () => {
  const repo = makeRepo('svc-decay');
  let NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const longMemory = service.remember({ text: '小明喜欢喝冰美式，不加糖。', layer: 'long', entityNames: ['小明'] });
  const other = service.remember({ text: '周五下午开会讨论新版本文案。', layer: 'long' });

  const before = fs.readFileSync(brainPathOf(repo), 'utf8');
  NOW = T0 + 100 * DAY;
  const found = service.search({ query: '小明' });
  assert.equal(found.memories.length, 1);
  assert.equal(found.memories[0].id, longMemory.id);
  assert.equal(found.memories[0].strength, 0.5, '第 100 天长期记忆强度应为 0.5');
  assert.equal(fs.readFileSync(brainPathOf(repo), 'utf8'), before, 'search 不应写盘');

  const recalled = service.recall({ query: '小明', limit: 5 });
  assert.ok(recalled.memories.length >= 1);
  assert.ok(recalled.reinforced.includes(longMemory.id));
  assert.equal(typeof recalled.hint, 'string');
  assert.ok(recalled.hint.length > 0);
  const afterRecall = service.getMemory(longMemory.id);
  assert.equal(afterRecall.strength, 1);
  assert.equal(afterRecall.status, 'active');
  assert.equal(afterRecall.activationCount, 2);
  assert.equal(service.getMemory(other.id).strength, 0.5, '未命中的记忆不应被强化');

  // 50 天后再次衰减到 0.75，touch 重置
  NOW = T0 + 150 * DAY;
  assert.equal(service.getMemory(longMemory.id).strength, 0.75);
  const touched = service.touch({ ids: [longMemory.id] });
  assert.ok(touched.touched.some((item) => item.id === longMemory.id));
  assert.equal(service.getMemory(longMemory.id).strength, 1);

  // touch 未知 id → missed
  const missed = service.touch({ ids: ['mem_000000000000'] });
  assert.deepEqual(missed.touched, []);
  assert.deepEqual(missed.missed, ['mem_000000000000']);
});

check('状态机：第 26 天 fading、第 29 天 faded、搜索默认排除 faded', () => {
  const repo = makeRepo('svc-state');
  let NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const created = service.remember({ text: '短期记忆会随时间淡忘，需要不断提起。' });

  NOW = T0 + 26 * DAY;
  assert.equal(service.getMemory(created.id).status, 'fading');
  assert.equal(service.search({ query: '淡忘' }).memories.length, 1, 'fading 仍应可检索');

  NOW = T0 + 29 * DAY;
  const faded = service.getMemory(created.id);
  assert.equal(faded.status, 'faded');
  assert.equal(service.search({ query: '淡忘' }).memories.length, 0);
  const withFaded = service.search({ query: '淡忘', includeFaded: true });
  assert.equal(withFaded.memories.length, 1);
  assert.equal(withFaded.memories[0].status, 'faded');
});

section('service：pin / update / forget / 容量');

check('pin：永久记忆 500 天后强度仍为 1；取消 pin 后恢复衰减', () => {
  const repo = makeRepo('svc-pin');
  let NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const created = service.remember({ text: '这是要永久保留的约定内容。' });
  const pinned = service.pin({ id: created.id, note: '重要约定' });
  assert.equal(pinned.ok, true);
  assert.equal(pinned.protection, 1);
  assert.equal(pinned.permanent, true);
  assert.equal(pinned.note, '重要约定');

  NOW = T0 + 500 * DAY;
  const forever = service.getMemory(created.id);
  assert.equal(forever.strength, 1);
  assert.equal(forever.status, 'active');
  assert.equal(forever.permanent, true);

  const unpinned = service.pin({ id: created.id, protection: 0 });
  assert.equal(unpinned.permanent, false);
  assert.equal(service.getMemory(created.id).status, 'faded', '取消 pin 后按原计时继续衰减（500 天已归零）');

  // 永久记忆拒绝 forget（除非 force）：先在宽限期内重新 pin 回来（别让时钟越过 purgeAfter）
  service.pin({ id: created.id });
  const refused = service.forget({ id: created.id });
  assert.equal(refused.forgotten.length, 0);
  assert.equal(refused.refused[0].reason, 'permanent');
  const forced = service.forget({ id: created.id, mode: 'purge', force: true });
  assert.deepEqual(forced.forgotten, [created.id]);
  assert.equal(service.getMemory(created.id), null);
});

check('update：改文本不影响衰减计时，resetDecay 才重置', () => {
  const repo = makeRepo('svc-update');
  let NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const created = service.remember({ text: '这条记忆后面会被更新标题和关键词。' });
  NOW = T0 + 50 * DAY;
  const updated = service.update({
    id: created.id,
    title: '新标题',
    category: 'preference',
    keywords: ['更新', '关键词'],
    tags: ['测试'],
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.memory.title, '新标题');
  assert.equal(updated.memory.category, 'preference');
  assert.deepEqual(updated.memory.keywords, ['更新', '关键词']);
  assert.equal(updated.memory.lastActivatedAt, T0, '普通 update 不重置衰减计时');
  assert.equal(updated.memory.strength, 0, '第 50 天短期记忆强度已归零');

  const reset = service.update({ id: created.id, text: '这条记忆的正文已经改写。', resetDecay: true });
  assert.equal(reset.memory.text, '这条记忆的正文已经改写。');
  assert.equal(reset.memory.strength, 1);
  assert.equal(reset.memory.lastActivatedAt, NOW);

  const relayer = service.update({ id: created.id, layer: 'long' });
  assert.equal(relayer.memory.layer, 'long');
  assert.equal(relayer.memory.decayDays, 200);

  throwsMemoryError(() => service.update({ id: created.id, layer: 'invalid' }));
  throwsMemoryError(() => service.update({ id: 'mem_000000000000' }), 'NOT_FOUND');
});

check('forget：archive 保留可检索、purge 删除并写 tombstone 事件', () => {
  const repo = makeRepo('svc-forget');
  let NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const a = service.remember({ text: '临时话题A的内容，之后会被归档。' });
  const b = service.remember({ text: '临时话题B的内容，之后会被彻底删除。' });
  NOW = T0 + 40 * DAY;

  const archived = service.forget({ id: a.id });
  assert.deepEqual(archived.forgotten, [a.id]);
  assert.equal(service.getMemory(a.id).status, 'archived');
  assert.equal(service.search({ query: '话题A' }).memories.length, 0, '归档记忆默认不展示');
  const archivedSearch = service.search({ query: '话题A', status: 'archived' });
  assert.equal(archivedSearch.memories.length, 1);

  const purged = service.forget({ query: '话题B', mode: 'purge' });
  assert.ok(purged.forgotten.includes(b.id));
  assert.equal(service.getMemory(b.id), null);
  const events = service.recentEvents({ limit: 200 });
  assert.ok(events.some((event) => event.type === 'purge' && event.id === b.id && event.detail?.reason === 'forget'));

  const missing = service.forget({ id: 'mem_000000000000' });
  assert.equal(missing.refused[0].reason, 'not_found');
  throwsMemoryError(() => service.forget({}));
});

check('容量 v1.6：按层独立配额，long/short 互不抢名额', () => {
  const repo = makeRepo('svc-capacity');
  const NOW = T0;
  writeConfig(repo, { maxMemories: 3, maxMemoriesLong: 2, maxMemoriesShort: 3 });
  const service = createService({ repoRoot: repo, now: () => NOW });
  const shortIds = [];
  for (let index = 0; index < 5; index += 1) {
    const result = service.remember({
      text: `短期容量测试的第 ${index} 条记忆，每条内容都不一样。`,
      source: { key: `capacity-short:${index}` },
    });
    shortIds.push(result.id);
  }
  assert.equal(service.stats().archived, 2, '短期层超出 3 条的部分被归档');
  assert.equal(service.getMemory(shortIds[0]).status, 'archived');
  assert.equal(service.getMemory(shortIds[0]).archivedReason, 'capacity');
  assert.equal(service.getMemory(shortIds[3]).status, 'active');
  // 长期层独立配额：再写 4 条 long，只淘汰 long，不动 short。
  const longIds = [];
  for (let index = 0; index < 4; index += 1) {
    const result = service.remember({
      text: `长期容量测试的第 ${index} 条长期记忆，内容彼此不同。`,
      layer: 'long',
      source: { key: `capacity-long:${index}` },
    });
    longIds.push(result.id);
  }
  const stats = service.stats();
  const shortActive = shortIds.filter((id) => service.getMemory(id).status === 'active').length;
  const longActive = longIds.filter((id) => service.getMemory(id).status === 'active').length;
  assert.equal(shortActive, 3, '长期写入不应挤掉短期记忆');
  assert.equal(longActive, 2, '长期层保持自身配额');
  assert.equal(service.getMemory(shortIds[4]).status, 'active', '短期记忆仍保留');
  assert.equal(service.getMemory(longIds[0]).status, 'archived', '长期层最弱的被归档');
  assert.equal(service.getMemory(longIds[3]).status, 'active');
  assert.equal(stats.capacity.short, 3);
  assert.equal(stats.capacity.long, 2);
});

section('service：entity / graph / stats / materialize / seed');

check('entity：upsert 别名、同名不同类别新建 + alias_of、非法类型报错', () => {
  const repo = makeRepo('svc-entity');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const first = service.entity({ name: '李四', type: 'person', aliases: ['小李'], note: '群友', tags: ['老群友'] });
  assert.equal(first.created, true);
  assert.equal(first.entity.type, 'person');
  assert.deepEqual(first.entity.aliases, ['小李']);

  const again = service.entity({ name: '李四', type: 'person' });
  assert.equal(again.created, false);
  assert.equal(again.entity.id, first.entity.id);

  const otherType = service.entity({ name: '李四', type: 'group' });
  assert.equal(otherType.created, true);
  assert.notEqual(otherType.entity.id, first.entity.id);
  assert.ok(otherType.relations.some((relation) => relation.relation === 'alias_of'));
  assert.ok(otherType.notices.length >= 1);

  const viaAlias = service.entity({ name: '小李' });
  assert.equal(viaAlias.entity.id, first.entity.id, '别名应能命中已有实体');
  throwsMemoryError(() => service.entity({ name: '某人', type: 'not_a_type' }));
  throwsMemoryError(() => service.entity({}));
});

check('graph：实体邻域 + 关系 + 关联记忆；不存在的实体返回空集合', () => {
  const repo = makeRepo('svc-graph');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  service.entity({ name: '张三', type: 'person' });
  service.entity({ name: '李四', type: 'person', relations: [{ to: '张三', relation: 'knows' }] });
  service.link({ from: '张三', to: '李四', relation: 'likes' });
  service.remember({ text: '张三和李四约好周末一起打羽毛球。', entityNames: ['张三'] });

  const graph = service.graph({ entity: '张三', depth: 2, limit: 50 });
  assert.equal(graph.entities.length, 2);
  assert.equal(graph.relations.length, 2);
  assert.ok(graph.memories.length >= 1);

  const missing = service.graph({ entity: '不存在的实体' });
  assert.deepEqual(missing.entities, []);
  assert.deepEqual(missing.relations, []);
  assert.deepEqual(missing.memories, []);

  const all = service.graph({ limit: 10 });
  assert.ok(all.entities.length >= 2);
});

check('stats：字段齐全且与数据一致', () => {
  const repo = makeRepo('svc-stats');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  service.remember({ text: '统计测试的长期记忆内容。', layer: 'long' });
  service.remember({ text: '统计测试的短期记忆内容。' });
  const permanent = service.remember({ text: '统计测试的永久记忆内容。' });
  service.pin({ id: permanent.id });
  const stats = service.stats();
  assert.equal(stats.ok, true);
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.byLayer, { long: 1, short: 2 });
  assert.equal(stats.permanent, 1);
  assert.equal(stats.entities, 0);
  assert.equal(stats.protectionLine, 0.5);
  assert.deepEqual(stats.decayDays, { long: 200, short: 30 });
  assert.ok(stats.vaultDir.endsWith(path.join('state', 'memory-vault')));
  assert.equal(typeof stats.nextDecayHint, 'string');
  assert.ok(stats.nextDecayHint.length > 0);
});

check('salience：只读分级，永久记忆落核心，不写盘', () => {
  const repo = makeRepo('svc-salience');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  service.remember({ text: '普通闲聊一句，没有锚词。' });
  const pinned = service.remember({ text: '这条主人说过记住别忘，是永久记忆。' });
  service.pin({ id: pinned.id });
  const before = service.stats();
  const result = service.salience({ limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.deepEqual(result.counts, { core: 1, important: 0, normal: 1 });
  assert.equal(result.items[0].id, pinned.id);
  assert.equal(result.items[0].tier, 'core');
  assert.equal(service.salience({ tier: 'core' }).items.length, 1);
  // 只读：调用前后库状态一致，不 touch、不落盘。
  const after = service.stats();
  assert.equal(after.total, before.total);
  assert.equal(after.permanent, 1);
  assert.equal(after.active, before.active);
});

check('materialize：落盘 faded → 过了宽限期后归档并写 archive 事件', () => {
  const repo = makeRepo('svc-materialize');
  let NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const created = service.remember({ text: '这条记忆最终会被每日维护归档。' });

  NOW = T0 + 30 * DAY;
  const first = service.materialize();
  assert.equal(first.ok, true);
  assert.equal(service.getMemory(created.id).status, 'faded');
  assert.deepEqual(first.archived, []);

  NOW = T0 + 30 * DAY + 7 * DAY;
  const second = service.materialize();
  assert.ok(second.archived.includes(created.id));
  assert.equal(service.getMemory(created.id).status, 'archived');
  assert.equal(service.getMemory(created.id).archivedReason, 'decayed');
  assert.equal(second.stats.total, 1, '归档不删记忆');
  assert.equal(second.stats.archived, 1);
  const events = service.recentEvents({ limit: 200 });
  assert.ok(events.some((event) => event.type === 'archive' && event.id === created.id && event.detail?.reason === 'decayed'));
});

check('seed：顺序导入、source.kind=seed、重复导入幂等', () => {
  const repo = makeRepo('svc-seed');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const seedData = {
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: [{ key: 'seed-1', kind: 'seed' }],
    entities: [
      { name: '王五', type: 'person', aliases: ['小王'] },
      { name: '项目X', type: 'project' },
    ],
    relations: [{ from: '王五', to: '项目X', relation: 'part_of' }],
    memories: [
      {
        text: '王五负责项目X的前端开发工作。',
        title: '项目X分工',
        layer: 'long',
        entityNames: ['王五', '项目X'],
        source: { key: 'seed-1' },
      },
      { text: '项目X计划在十二月上线。', layer: 'long', entityNames: ['项目X'], source: { key: 'seed-1' } },
    ],
  };
  const first = service.seed(seedData);
  assert.equal(first.ok, true);
  assert.equal(first.memories.created, 2);
  assert.equal(first.entities.created, 2);
  assert.equal(first.relations.created, 1);
  assert.equal(first.stats.total, 2);
  assert.equal(first.skipped, 0);

  const seededMemory = service.search({ query: '王五负责' }).memories[0];
  assert.equal(seededMemory.source.kind, 'seed');

  const second = service.seed(seedData);
  assert.equal(second.memories.created, 0);
  assert.equal(second.memories.merged, 2);
  assert.equal(second.stats.total, 2, 'seed 必须幂等');
  assert.equal(second.entities.created, 0);
  assert.equal(second.relations.created, 0);
});

// ---------------------------------------------------------------------------
// D. 跨进程并发写（模拟两个 DSH 实例各起一个 memory MCP server）
// ---------------------------------------------------------------------------
section('并发：两个子进程同时写同一个记忆库');

await checkAsync('两个进程各写 12 条，锁 + 原子写后总数一致且无残留', async () => {
  const repo = makeRepo('concurrency');
  const workerPath = path.join(repo, 'concurrency-worker.mjs');
  const serviceUrl = pathToFileURL(path.join(ROOT, 'src', 'memory', 'service.mjs')).href;
  // 每个 worker 用完全不重叠的句子（共 24 句不同内容），避免同层 dedupe 把不同进程写入合并掉。
  const sentencePool = [
    '春天里公园的樱花开了，粉色花瓣铺满了石板小路。',
    '图书馆新到了一批关于天体物理和宇宙学的科普读物。',
    '小区门口的早餐店换老板了，豆浆味道变得偏甜。',
    '周日下午三点在体育馆有一场羽毛球友谊赛。',
    '地铁四号线延伸段预计明年夏天正式开通运营。',
    '冰箱里的酸奶快过期了，记得晚饭后处理掉。',
    '这本书讲的是二战期间破译恩尼格玛密码的故事。',
    '楼下猫咪生了三只小橘猫，见人就往纸箱里躲。',
    '公司年会抽奖一等奖是一台轻薄笔记本电脑。',
    '昨天晚上的雷阵雨把阳台上的绿萝淋得东倒西歪。',
    '菜市场最近西红柿便宜了两块钱，买了一大袋。',
    '纪录片拍的是青藏高原牧民一年四季的迁徙生活。',
    '手机电池健康度掉到百分之八十，考虑换块新电池。',
    '高铁站旁边的便利店二十四小时营业，很方便。',
    '周末打算去郊外的水库钓鱼，顺便搭个帐篷烧烤。',
    '新买的机械键盘声音清脆，写代码变得很有节奏感。',
    '这部电影的配乐拿了国际大奖，片尾曲特别好听。',
    '奶奶学会了用视频通话，每周都给远方的亲戚打电话。',
    '社区医院新开了中医理疗科，针灸拔罐都能做。',
    '咖啡馆二楼靠窗的位置能看到整条梧桐树街道。',
    '马拉松比赛当天早上六点就开始封路进行交通管制。',
    '旧相机是胶卷的，冲洗照片要等整整一个星期。',
    '台风过境后海边满地都是被吹断的树枝和贝壳。',
    '数学老师用折纸演示了正十二面体的空间结构。',
  ];
  fs.writeFileSync(
    workerPath,
    `import { createService } from ${JSON.stringify(serviceUrl)};
const [repoRoot, workerId, count] = process.argv.slice(2);
const pool = ${JSON.stringify(sentencePool)};
const service = createService({ repoRoot });
for (let index = 0; index < Number(count); index += 1) {
  const text = pool[(Number(workerId) - 1) * Number(count) + index];
  service.remember({
    text,
    source: { key: \`group:\${workerId}\`, seqs: [index] },
    layer: index % 2 === 0 ? 'long' : 'short',
  });
}
process.stdout.write('worker-done ' + workerId + '\\n');
`,
    'utf8'
  );
  const spawnWorker = (workerId) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, repo, String(workerId), '12'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  const [one, two] = await Promise.all([spawnWorker(1), spawnWorker(2)]);
  assert.equal(one.code, 0, `worker1 退出码 ${one.code}，stderr：${one.stderr}`);
  assert.equal(two.code, 0, `worker2 退出码 ${two.code}，stderr：${two.stderr}`);
  assert.match(one.stdout, /worker-done 1/);
  assert.match(two.stdout, /worker-done 2/);

  const service = createService({ repoRoot: repo });
  const stats = service.stats();
  assert.equal(stats.total, 24, `并发写后应有 24 条记忆，实际 ${stats.total}`);
  const memoryDir = path.join(repo, 'state', 'memory');
  assert.equal(listTmpFiles(memoryDir).length, 0, '不应残留 .tmp 文件');
  assert.equal(fs.existsSync(path.join(memoryDir, 'brain.lock')), false, '锁文件应已释放');
  // journal 模式下 brain.json 可能仍是旧快照，显式 compact 后应完整落盘。
  const compacted = service.store.compactNow();
  assert.equal(Object.keys(compacted.brain.memories).length, 24);
  const reparsed = JSON.parse(fs.readFileSync(brainPathOf(repo), 'utf8'));
  assert.equal(Object.keys(reparsed.memories).length, 24);
});

// ---------------------------------------------------------------------------
// E. CLI：stats / add / search / pin / seed / decay / export-vault / 未知命令
// ---------------------------------------------------------------------------
section('cli：运维命令');

function captureCli(argv, options = {}) {
  const out = [];
  const err = [];
  const originalLog = console.log;
  console.log = (...args) => out.push(args.map((item) => String(item)).join(' '));
  let code = null;
  try {
    code = runCli([...(options.root ? ['--root', options.root] : []), ...argv], {
      stdout: (line) => out.push(String(line)),
      stderr: (line) => err.push(String(line)),
    });
  } finally {
    console.log = originalLog;
  }
  return { code, out, err, text: out.join('\n') };
}

check('cli stats / add / search / pin / decay / export-vault / help / 未知命令', () => {
  const repo = makeRepo('cli');
  const statsText = captureCli(['stats'], { root: repo });
  assert.equal(statsText.code, 0);
  assert.match(statsText.text, /总记忆：0/);

  const added = captureCli(['add', '--text', 'CLI 添加的第一条记忆内容。', '--layer', 'long', '--entity', '测试实体', '--json'], {
    root: repo,
  });
  assert.equal(added.code, 0);
  const addedResult = JSON.parse(added.out[added.out.length - 1]);
  assert.equal(addedResult.created, true);
  assert.match(addedResult.id, /^mem_[0-9a-f]{12}$/);

  const searched = captureCli(['search', 'CLI'], { root: repo });
  assert.equal(searched.code, 0);
  assert.match(searched.text, /CLI 添加的第一条记忆内容/);

  const pinned = captureCli(['pin', '--query', 'CLI', '--note', 'cli 固定'], { root: repo });
  assert.equal(pinned.code, 0);
  assert.match(pinned.text, /已固定为永久记忆/);

  const statsJson = captureCli(['stats', '--json'], { root: repo });
  assert.equal(statsJson.code, 0);
  const stats = JSON.parse(statsJson.out[statsJson.out.length - 1]);
  assert.equal(stats.total, 1);
  assert.equal(stats.permanent, 1);

  const decayJson = captureCli(['decay', '--json'], { root: repo });
  assert.equal(decayJson.code, 0);
  const decayResult = JSON.parse(decayJson.out[decayJson.out.length - 1]);
  assert.equal(decayResult.ok, true);
  assert.equal(decayResult.total, 1);

  const outPath = path.join(repo, 'vault-export-test.json');
  const exported = captureCli(['export-vault', '--out', outPath], { root: repo });
  assert.equal(exported.code, 0);
  assert.equal(fs.existsSync(outPath), true);
  const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(Object.keys(payload.brain.memories).length, 1);
  assert.ok(payload.vaultDir.endsWith('memory-vault'));

  const seedFile = path.join(repo, 'seed.json');
  fs.writeFileSync(
    seedFile,
    JSON.stringify({
      version: 1,
      entities: [{ name: 'seed实体', type: 'topic' }],
      relations: [],
      memories: [{ text: '通过 CLI 导入的 seed 记忆内容。', source: { key: 'seed-cli' } }],
    }),
    'utf8'
  );
  const seeded = captureCli(['seed', seedFile], { root: repo });
  assert.equal(seeded.code, 0);
  assert.match(seeded.text, /seed 完成/);

  const help = captureCli(['help'], { root: repo });
  assert.equal(help.code, 0);
  assert.match(help.text, /记忆系统运维 CLI/);

  const unknown = captureCli(['not-a-command'], { root: repo });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err.join('\n'), /未知命令/);

  const noText = captureCli(['add'], { root: repo });
  assert.equal(noText.code, 1);
  assert.match(noText.err.join('\n'), /需要 --text/);
});

check('cli 直接执行 + QQBRIDGE_MEMORY_ROOT 环境变量覆盖仓库根', () => {
  const repo = makeRepo('cli-direct');
  const env = { ...process.env, QQBRIDGE_MEMORY_ROOT: repo };
  delete env.QQBRIDGE_REPO_ROOT;
  const result = spawnSync(process.execPath, [CLI_PATH, 'add', '--text', '直接执行 CLI 写入的记忆。', '--json'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.created, true);
  assert.equal(fs.existsSync(brainPathOf(repo)), true, '环境变量指定的仓库根应落盘');
});

// ---------------------------------------------------------------------------
// G. service：按日期 / 分类过滤（日记、昨天这类检索）
// ---------------------------------------------------------------------------
section('service：date / since / until / category 过滤');

check('date 按本地日期命中，支持 since/until 区间与 category，并校验非法输入', () => {
  const repo = makeRepo('svc-date');
  // 用本地时间构造，避免测试机时区不同导致「本地日期」漂移。
  const D1 = new Date(2026, 0, 1, 12, 0, 0).getTime();
  const D2 = D1 + 86_400_000;
  const D3 = D2 + 86_400_000;
  let NOW = D1;
  const service = createService({ repoRoot: repo, now: () => NOW });

  const day1 = service.remember({ text: '第一天：把猫条账记上。', layer: 'long', category: 'event' });
  NOW = D2;
  const day2 = service.remember({ text: '第二天：写了日记，体育课点名。', category: 'event', title: '日记·2026-01-02' });
  NOW = D3;
  const day3 = service.remember({ text: '第三天：偏好记录，喜欢黑咖啡。', layer: 'long', category: 'preference' });

  const d1 = service.search({ date: '2026-01-01' });
  assert.deepEqual(
    d1.memories.map((m) => m.id),
    [day1.id]
  );
  const d2 = service.search({ date: '2026-01-02' });
  assert.deepEqual(
    d2.memories.map((m) => m.id),
    [day2.id]
  );
  assert.equal(d2.total, 1);

  const exactDay = service.search({ since: '2026-01-02', until: '2026-01-02' });
  assert.deepEqual(
    exactDay.memories.map((m) => m.id),
    [day2.id]
  );
  const tail = service.search({ since: '2026-01-02' });
  assert.equal(tail.total, 2, 'since=2026-01-02 应命中 2、3 号两条');
  assert.ok(tail.memories.every((m) => m.id !== day1.id));

  const prefs = service.search({ category: 'preference' });
  assert.deepEqual(
    prefs.memories.map((m) => m.id),
    [day3.id]
  );
  const combined = service.search({ date: '2026-01-02', category: 'event' });
  assert.deepEqual(
    combined.memories.map((m) => m.id),
    [day2.id]
  );
  assert.equal(service.search({ date: '2025-12-31' }).total, 0);

  assert.throws(() => service.search({ date: '2026/01/02' }), /YYYY-MM-DD/);
  assert.throws(() => service.search({ since: '2026-02-30' }), /不是合法日期/);
  assert.throws(() => service.search({ since: '2026-01-03', until: '2026-01-01' }), /since 不能晚于 until/);
  assert.throws(() => service.search({ category: 'diary' }), /category 无效/);

  // recall 透传 date，并把命中的记忆重新激活
  NOW = D3 + 86_400_000;
  const recalled = service.recall({ date: '2026-01-02' });
  assert.deepEqual(
    recalled.memories.map((m) => m.id),
    [day2.id]
  );
  assert.ok(recalled.reinforced.includes(day2.id));
});

section('service：日记单独保存');
check('日记：写入自动归为 long/event、不衰减、不会被 purge，且 isDiaryMemory 可识别', () => {
  const repo = makeRepo('svc-diary');
  let NOW = new Date(2026, 2, 1, 12, 0, 0).getTime();
  const service = createService({ repoRoot: repo, now: () => NOW });
  const diary = service.remember({ title: '日记·2026-03-01', text: '今天被主人夸了。', tags: ['diary'] });
  const stored = service.getMemory(diary.id);
  assert.equal(stored.layer, 'long');
  assert.equal(stored.category, 'event');
  assert.deepEqual(stored.tags, ['diary']);
  assert.equal(stored.strength, 1);

  NOW += 400 * 86_400_000;
  const later = service.materialize();
  assert.deepEqual(later.purged, []);
  const after = service.getMemory(diary.id);
  assert.equal(after.strength, 1, '日记不应衰减');
  assert.equal(after.status, 'active');

  assert.equal(model.isDiaryMemory({ tags: ['Diary'] }), true);
  assert.equal(model.isDiaryMemory({ tags: ['bugfix', 'diary'] }), true);
  assert.equal(model.isDiaryMemory({ tags: ['bugfix'] }), false);
  assert.equal(model.isDiaryMemory({ tags: [] }), false);
});

section('记忆巩固（consolidate）与三路召回');

check('三路召回：实体名/别名与模糊线索都能召回', () => {
  const repo = makeRepo('svc-recall-three-routes');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const ent = service.entity({ name: '小芙', type: 'person', aliases: ['芙芙'] });
  assert.equal(ent.created, true);
  const mem = service.remember({
    text: '今天给猫买了三罐罐头。',
    entityNames: ['小芙'],
    source: { key: 'routes:1' },
  });
  const byName = service.search({ query: '小芙' });
  assert.ok(byName.memories.some((item) => item.id === mem.id), '实体名应召回');
  const byAlias = service.search({ query: '芙芙' });
  assert.ok(byAlias.memories.some((item) => item.id === mem.id), '实体别名应召回');
  const byText = service.search({ query: '猫罐头' });
  assert.ok(byText.memories.some((item) => item.id === mem.id), '模糊线索应召回');
});

check('consolidate：short→long 提升、近重复归档、关键词清洗、metrics 落盘', () => {
  const repo = makeRepo('svc-consolidate');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const stable = service.remember({
    text: '主人喜欢喝无糖冰美式。',
    keywords: ['一条', '内容', '冰美式', '桥接'],
    source: { key: 'consolidate:1' },
  });
  service.remember({ text: '主人喜欢喝无糖冰美式。', source: { key: 'consolidate:2' } });
  service.remember({ text: '主人喜欢喝无糖冰美式。', source: { key: 'consolidate:3' } });
  // 不同 layer 会绕过写入时的合并，用来构造近重复
  const dupShort = service.remember({ text: '明天下午三点开桥接项目的讨论会。', layer: 'short', source: { key: 'consolidate:4' } });
  const dupLong = service.remember({ text: '明天下午三点开桥接项目的讨论会。', layer: 'long', source: { key: 'consolidate:5' } });

  // 层级策略上线后，短期记忆在「激活次数到线」时就会升长期，不必等 consolidate。
  assert.equal(service.getMemory(stable.id).layer, 'long', '反复提起的短期记忆在激活时升为长期');
  const result = service.consolidate();
  const stableMem = service.getMemory(stable.id);
  assert.equal(stableMem.layer, 'long');
  assert.equal(stableMem.decayDays, 200);
  assert.ok(!stableMem.keywords.includes('一条'), '噪声关键词应被清掉');
  assert.ok(!stableMem.keywords.includes('内容'), '噪声关键词应被清掉');
  assert.ok(stableMem.keywords.includes('冰美式'), '有效关键词应保留');
  assert.ok(result.dedupedItems.length >= 1, '近重复应被归档');
  const droppedId = result.dedupedItems[0].id;
  assert.equal(service.getMemory(droppedId).status, 'archived');
  assert.equal(service.getMemory(droppedId).archivedReason, 'duplicate');
  assert.ok([dupShort.id, dupLong.id].includes(droppedId));
  assert.equal(typeof result.duplicateRate, 'number');
  const metricsFile = path.join(repo, 'state', 'memory', 'last-consolidation.json');
  assert.ok(fs.existsSync(metricsFile), 'consolidate 应写 last-consolidation.json');
  const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
  // 层级策略上线后，短期记忆在激活次数到线时就会升长期，consolidate 不再重复计一次。
  assert.equal(metrics.promoted, 0);
  assert.ok(metrics.deduped >= 1);
});

check('consolidate v1.6：同主题进展只留最新 3 条 + 1 条摘要，二次巩固不重复合并', () => {
  const repo = makeRepo('svc-time-merge');
  const NOW = T0;
  const service = createService({ repoRoot: repo, now: () => NOW });
  const ids = [];
  const texts = [
    '天猫项目方案定了，前端用 Vue，后端 Node。',
    '天猫项目的接口联调卡在鉴权，明天找后端一起看。',
    '天猫项目要加一个订单导出功能，优先做 CSV。',
    '天猫项目进度：首页改版完成，剩下支付页。',
    '天猫项目决定先上线灰度版本，只开放 10% 用户。',
    '天猫项目复盘：这次工期估短了，下次多留两天。',
  ];
  for (let index = 0; index < texts.length; index += 1) {
    const result = service.remember({
      text: texts[index],
      category: 'fact',
      entityNames: ['天猫项目'],
      layer: 'short',
      source: { key: `time-merge:${index}` },
    });
    ids.push(result.id);
  }
  const first = service.consolidate();
  assert.ok(first.timeMerged >= 1, '应发生同主题时间合并');
  assert.equal(first.timeMergedItems[0].mergedInto.startsWith('mem_'), true);
  const summaryId = first.timeMergedItems[0].mergedInto;
  const summary = service.getMemory(summaryId);
  assert.equal(summary.status, 'active');
  assert.ok(summary.tags.includes('progress-summary'), '应生成进展摘要记忆');
  assert.ok(summary.text.includes('进展摘要'), '摘要正文可读');
  const archivedIds = first.timeMergedItems.map((item) => item.id);
  assert.equal(service.getMemory(archivedIds[0]).status, 'archived');
  assert.equal(service.getMemory(archivedIds[0]).archivedReason, 'time-merge');
  const activeCount = ids.filter((id) => !archivedIds.includes(id)).length;
  assert.equal(activeCount, 3, '合并后只保留最新 3 条原文');
  const second = service.consolidate();
  assert.equal(second.timeMerged, 0, '二次巩固不应再重复合并');
});

// ---------------------------------------------------------------------------
// v1.3：NeuralMemory 风格 —— 扩散激活 / 矛盾降权 / 共激活突触 / 零 LLM 抽取
// ---------------------------------------------------------------------------
section('v1.3 扩散激活、矛盾降权、Hebbian 共激活与 ingest');

check('扩散激活：depth 1/2 能把「共享实体但字面不重合」的记忆带出来，depth 0 不行', () => {
  const repo = makeRepo('svc-spreading');
  const service = createService({ repoRoot: repo, now: () => T0 });
  const a = service.remember({ text: '鉴权方案用 JWT token。', entityNames: ['鉴权'], source: { key: 'spread:1' } });
  const b = service.remember({ text: '迁移到 Session 登录方案。', entityNames: ['鉴权'], source: { key: 'spread:2' } });
  const shallow = service.search({ query: 'jwt', depth: 0 });
  assert.deepEqual(shallow.memories.map((m) => m.id), [a.id], 'depth 0 只做字面/实体直达');
  assert.equal(shallow.activated, 0);
  const deep = service.search({ query: 'jwt', depth: 2 });
  assert.ok(deep.memories.some((m) => m.id === b.id), 'depth 2 应沿实体扩散带回 B');
  assert.ok(deep.activated >= 1);
  assert.equal(deep.depth, 2);
  assert.equal(deep.depthProfile.name, 'Habit');
});

check('矛盾降权：新记忆压旧的，旧记忆 superseded 且默认不再召回，显式 includeSuperseded 可查', () => {
  const repo = makeRepo('svc-supersede');
  const service = createService({ repoRoot: repo, now: () => T0 });
  const old = service.remember({ text: '鉴权方案用 JWT token。', category: 'fact', source: { key: 'sup:1' } });
  const fresh = service.remember({ text: '鉴权方案改用 Session，JWT 不再用了。', category: 'fact', source: { key: 'sup:2' } });
  assert.ok(fresh.superseded.includes(old.id), '应把旧记忆标记为 superseded');
  const oldStored = service.getMemory(old.id);
  assert.equal(oldStored.status, 'superseded');
  assert.equal(oldStored.deprioritized, true);
  assert.equal(oldStored.supersededBy, fresh.id);
  assert.ok(service.getMemory(fresh.id).supersedes.includes(old.id));
  const byDefault = service.search({ query: '鉴权' });
  assert.ok(!byDefault.memories.some((m) => m.id === old.id), '默认召回不应带出已被取代的旧记忆');
  assert.ok(byDefault.memories.some((m) => m.id === fresh.id));
  const explicit = service.search({ query: '鉴权', includeSuperseded: true });
  assert.ok(explicit.memories.some((m) => m.id === old.id), '显式要求时应能查历史');
  assert.equal(service.stats().superseded, 1);
  // 手动 pin 旧记忆 = 明确恢复它
  service.pin({ id: old.id, protection: 0 });
  assert.equal(service.getMemory(old.id).status, 'active');
  assert.equal(service.getMemory(old.id).deprioritized, false);
});

check('矛盾降权防误杀：候选一多（主题泛化）就不自动 supersede，显式 supersedes 仍可控', () => {
  const repo = makeRepo('svc-supersede-guard');
  const service = createService({ repoRoot: repo, now: () => T0 });
  const olds = [
    '路由规则一：按批次判定功能会话。',
    '路由规则二：图片消息整批进入看图会话。',
    '路由规则三：普通消息都走聊天会话。',
    '路由规则四：唤醒按 3 秒窗口合并。',
    '路由规则五：每个 QQ key 只保留一个活跃会话。',
  ].map((text, index) => service.remember({ text, category: 'fact', source: { key: `guard:${index}` } }));
  const fresh = service.remember({
    text: '路由规则已改成 v2：按单条判定，不再整批合并，以后用逐条路由。',
    category: 'fact',
    source: { key: 'guard:new' },
  });
  assert.equal(fresh.superseded.length, 0, '候选过多属主题泛化，应放弃启发式而不是一次降权一大批');
  assert.equal(service.stats().superseded, 0);
  const explicit = service.remember({
    text: '路由规则确认升级为 v2 逐条判定。',
    category: 'fact',
    supersedes: [olds[0].id],
    source: { key: 'guard:explicit' },
  });
  assert.deepEqual(explicit.superseded, [olds[0].id], '显式 supersedes 应精确生效');
  assert.equal(service.getMemory(olds[0].id).status, 'superseded');
});

check('Hebbian 共激活：同一轮 recall 的记忆建立突触并随重复召回加强', () => {
  const repo = makeRepo('svc-synapse');
  const service = createService({ repoRoot: repo, now: () => T0 });
  const one = service.remember({ text: '主人喜欢猫条零食。', source: { key: 'syn:1' } });
  const two = service.remember({ text: '主人晚上在跑桥接项目。', source: { key: 'syn:2' } });
  const first = service.recall({ query: '主人', limit: 5 });
  assert.ok(first.memories.length >= 2);
  assert.equal(first.learned, 1, '首个共激活应新建 1 条突触');
  const stats = service.stats();
  assert.equal(stats.synapses, 1);
  const synapse = service.snapshot().synapses[0];
  assert.deepEqual([synapse.from, synapse.to].sort(), [one.id, two.id].sort());
  assert.equal(synapse.coactivations, 1);
  const second = service.recall({ query: '主人', limit: 5 });
  assert.equal(second.learned, 0, '已存在的突触不重复计新建');
  const updated = service.snapshot().synapses[0];
  assert.equal(updated.coactivations, 2);
  assert.ok(updated.weight > synapse.weight, '共激活次数越多权重越高');
  assert.ok(updated.coactivations > 0);
});

check('ingest：零 LLM 规则抽取候选（decision/preference/error），dryRun 只返回不落库，正式入库带 auto 标签', () => {
  const repo = makeRepo('svc-ingest');
  const service = createService({ repoRoot: repo, now: () => T0 });
  const text = '今天决定以后都用 SQLite。我喜欢喝冰美式。刚才报错了，登录失败。';
  const dry = service.ingest({ text, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.candidates.length >= 2);
  const kinds = dry.candidates.map((c) => c.kind);
  assert.ok(kinds.includes('decision'));
  assert.ok(kinds.includes('preference'));
  assert.ok(kinds.includes('error'));
  assert.equal(service.stats().total, 0, 'dryRun 不应落库');
  const real = service.ingest({ text });
  assert.ok(real.created >= 2);
  assert.equal(service.stats().total, real.created);
  const stored = service.getMemory(real.ids[0]);
  assert.ok(stored.tags.includes('auto'));
});

// ---------------------------------------------------------------------------
// v1.4：20 种关系 5 大类 / 用进废退分层 / depth 建议
// ---------------------------------------------------------------------------
section('v1.4 关系体系：20 种关系 5 大类 + 旧类型归一 + conflict 突触');

check('20 种关系按 5 大类组织，旧写法自动归一', () => {
  assert.equal(Object.keys(model.RELATION_TYPE_GROUPS).length, 5);
  const total = Object.values(model.RELATION_TYPE_GROUPS).reduce((sum, list) => sum + list.length, 0);
  assert.equal(total, 20);
  assert.equal(model.normalizeRelationType('member_of'), 'PART_OF');
  assert.equal(model.normalizeRelationType('likes'), 'PREFERRED');
  assert.equal(model.normalizeRelationType('caused_by'), 'CAUSED_BY');
  assert.equal(model.normalizeRelationType('alias_of'), 'alias_of');
  assert.equal(model.relationGroupOf('SUPERSEDES'), 'conflict');
  assert.equal(model.relationGroupOf('BEFORE'), 'temporal');
  assert.ok(String(model.relationLabelOf('CONTRADICTS')).length > 0);
  const repo = makeRepo('svc-relations');
  const service = createService({ repoRoot: repo, now: () => T0 });
  service.remember({ text: '项目 A 用 SQLite。', entityNames: ['项目A'], source: { key: 'rel:1' } });
  service.remember({ text: '项目 B 用 Postgres。', entityNames: ['项目B'], source: { key: 'rel:2' } });
  const causal = service.link({ from: '项目A', to: '项目B', relation: 'caused_by' });
  assert.equal(causal.relation.relation, 'CAUSED_BY');
  const semantic = service.link({ from: '项目A', to: '项目B', relation: 'member_of' });
  assert.equal(semantic.relation.relation, 'PART_OF', '旧写法 member_of 应归一为 PART_OF');
  const stats = service.stats();
  assert.equal(stats.relationGroups.causal, 1);
  assert.equal(stats.relationGroups.semantic, 1);
});

check('矛盾降权写 SUPERSEDES 类型的冲突突触', () => {
  const repo = makeRepo('svc-conflict-synapse');
  const service = createService({ repoRoot: repo, now: () => T0 });
  const old = service.remember({ text: '鉴权用 JWT。', category: 'fact', source: { key: 'cs:1' } });
  const newer = service.remember({ text: '鉴权改用 Session。', category: 'fact', supersedes: [old.id], source: { key: 'cs:2' } });
  assert.deepEqual(newer.superseded, [old.id]);
  const conflict = service.snapshot().synapses.find((synapse) => synapse.type === 'SUPERSEDES');
  assert.ok(conflict, 'supersede 应落一条 SUPERSEDES 突触');
  assert.deepEqual([conflict.from, conflict.to].sort(), [old.id, newer.id].sort());
  assert.equal(conflict.weight, 1);
});

section('v1.4 用进废退：三层记忆 + 艾宾浩斯保持率');

check('memoryTier：working / short-term / episodic / long-term 可区分', () => {
  const repo = makeRepo('svc-tiers');
  const service = createService({ repoRoot: repo, now: () => T0 });
  const fresh = service.remember({ text: '刚刚说的临时事实。', source: { key: 'tier:1' } });
  const diary = service.remember({ text: '日记：今天下雨。', tags: ['diary'], source: { key: 'tier:2' } });
  const longMem = service.remember({ text: '主人喜欢猫。', layer: 'long', source: { key: 'tier:3' } });
  assert.equal(model.memoryTier({ ...service.getMemory(fresh.id), lastActivatedAt: T0 }, T0), 'working');
  assert.equal(model.memoryTier(service.getMemory(diary.id), T0), 'episodic');
  assert.equal(model.memoryTier(service.getMemory(longMem.id), T0 + 3 * 3600_000), 'long-term');
  const stats = service.stats();
  assert.ok(stats.byTier.working >= 1);
  assert.ok(stats.byTier.episodic >= 1);
  assert.deepEqual(model.MEMORY_TIERS, ['working', 'short-term', 'episodic', 'long-term']);
});

check('艾宾浩斯：retentionOf 递减，ebbinghaus 曲线前期比线性衰减更快', () => {
  const repo = makeRepo('svc-ebbinghaus');
  const base = { layer: 'short', status: 'active', protection: 0, baseStrength: 1, decayDays: 30, createdAt: T0 };
  const retentionEarly = model.retentionOf(base, T0 + 5 * DAY);
  const retentionLate = model.retentionOf(base, T0 + 20 * DAY);
  assert.ok(retentionEarly > retentionLate && retentionEarly < 1);
  const linear = model.computeStrength(base, T0 + 10 * DAY);
  const exponential = model.computeStrength({ ...base, decayCurve: 'ebbinghaus' }, T0 + 10 * DAY);
  assert.ok(exponential < linear, '指数遗忘曲线前期衰减更快');
  const service = createService({ repoRoot: repo, now: () => T0 });
  const created = service.remember({ text: '曲线测试记忆。', source: { key: 'eb:1' } });
  assert.equal(service.getMemory(created.id).decayCurve, 'linear', '默认线性');
});

section('v1.4 depth 建议：Agent 自己决定要不要深思');

check('suggestedDepth 与 search/recall 的 depthSource', () => {
  assert.equal(model.suggestedDepth('在吗'), 1);
  assert.equal(model.suggestedDepth('为什么之前用 JWT 后来又改成 session 了'), 2);
  assert.equal(model.suggestedDepth('把所有历史决策梳理一遍'), 3);
  const repo = makeRepo('svc-depthhint');
  const service = createService({ repoRoot: repo, now: () => T0 });
  service.remember({ text: '之前鉴权用 JWT。', source: { key: 'dep:1' } });
  const auto = service.search({ query: '鉴权' });
  assert.equal(auto.depthSource, 'suggested');
  assert.equal(auto.suggestedDepth, 1);
  const explicit = service.search({ query: '鉴权', depth: 2 });
  assert.equal(explicit.depthSource, 'explicit');
  assert.equal(explicit.depth, 2);
  const recalled = service.recall({ query: '鉴权', depth: 2, reinforce: false });
  assert.equal(recalled.depth, 2);
  assert.equal(recalled.suggestedDepth, 1);
});

// ---------------------------------------------------------------------------
// 清理 + 汇总
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v1.5-lite：人格型记忆（状态感受词 + 置顶/相关/忽然想起）
// ---------------------------------------------------------------------------
section('v1.5-lite 人格型记忆：状态 / 置顶 / 私聊过滤 / 忽然想起');

check('personaStateSnapshot：精力向昼夜基线漂移、心情平复、输出感受词', () => {
  const night = Date.parse('2026-01-01T02:00:00+08:00');
  const noon = Date.parse('2026-01-01T12:00:00+08:00');
  assert.ok(model.circadianBaseline(noon) > model.circadianBaseline(night), '白天基线高于凌晨');
  const snap = model.personaStateSnapshot({ energy: 0.4, mood: -0.6, updatedAt: night - 6 * 3_600_000 }, night);
  assert.ok(model.circadianBaseline(night) < 0.4);
  assert.ok(snap.energy < 0.4, '精力向夜间基线回落');
  assert.ok(Math.abs(snap.mood) < 0.6, '心情随时间平复');
  assert.equal(typeof snap.energyWord, 'string');
  assert.ok(snap.energyWord.length > 0);
  assert.equal(typeof snap.moodWord, 'string');
  assert.ok(snap.moodWord.length > 0);
  assert.equal(typeof snap.energy, 'number');
});

check('service 状态：updateState 落盘、重新加载仍在、stats.state 同步', () => {
  const repo = makeRepo('svc-persona-state');
  const service = createService({ repoRoot: repo, now: () => T0 });
  assert.ok(service.state().state.energyWord, '默认状态可读');
  const saved = service.updateState({ energy: 0.3, mood: -0.3, reason: '单测' });
  assert.equal(saved.state.energy, 0.3);
  assert.equal(saved.state.mood, -0.3);
  assert.ok(saved.state.energyWord);
  const again = createService({ repoRoot: repo, now: () => T0 });
  assert.equal(again.state().state.energy, 0.3, '状态跨进程保留');
  assert.equal(again.stats().state.energy, 0.3);
});

check('autoRecall：置顶不占普通名额、群聊过滤私聊、忽然想起过滤敏感信息', () => {
  const repo = makeRepo('svc-persona-recall');
  const service = createService({ repoRoot: repo, now: () => T0 });
  const pin = service.remember({ text: '主人 的 生日 是 3 月 5 日，喜欢 吃 橘子。', category: 'relationship', layer: 'long', source: { key: 'private:1' } });
  const normal = service.remember({ text: '昨天 讨论 了 记忆 路由 的 分路 方案。', category: 'topic', source: { key: 'group:9' } });
  const secret = service.remember({ text: '主人 的 银行卡 密码 是 123456，别告诉别人。', category: 'fact', source: { key: 'private:1' } });
  const later = T0 + 7 * 3_600_000;
  const brain = service.snapshot();
  const groupView = autoRecallModule.autoRecall({ brain, isGroup: true, query: '记忆 路由', limit: 5, serendipity: 1, now: later, random: () => 0 });
  assert.ok(groupView.top.every((item) => !item.private), '群聊置顶不含私聊记忆');
  assert.ok(groupView.ordinary.every((item) => !item.private), '群聊相关不含私聊记忆');
  const privateView = autoRecallModule.autoRecall({ brain, isGroup: false, query: '生日', limit: 5, serendipity: 1, now: later, random: () => 0.99 });
  const shown = [...privateView.top, ...privateView.ordinary];
  assert.ok(shown.some((item) => item.id === pin.id), '私聊能取到关系类置顶');
  assert.ok(shown.every((item) => item.id !== secret.id || !/密码/.test(item.text)) || privateView.serendipity.every((item) => !/密码|银行卡/.test(item.text)));

  // 只放一条敏感旧记忆：忽然想起池必须把它过滤掉。
  const mini = model.emptyBrain(T0);
  const oldSensitive = {
    ...model.emptyMemory({ text: '主人 的 银行卡 密码 是 9966，别说出去。', category: 'fact', source: { key: 'private:1' }, now: T0 - 10 * 3_600_000 }),
    id: 'mem_old_sensitive',
  };
  mini.memories.mem_old_sensitive = oldSensitive;
  const onlySensitive = autoRecallModule.autoRecall({ brain: mini, isGroup: false, limit: 0, serendipity: 1, now: T0 + 3_600_000, random: () => 0 });
  assert.equal(onlySensitive.serendipity.length, 0, '敏感记忆不进忽然想起');
});

check('formatMemoryHint + CLI state/set-state', () => {
  const hint = autoRecallModule.formatMemoryHint(
    {
      state: model.personaStateSnapshot({ energy: 0.3, mood: 0.1, updatedAt: T0 }, T0),
      top: [{ title: '置顶事', text: '重要内容' }],
      ordinary: [],
      serendipity: [],
    },
    { isGroup: true }
  );
  assert.match(hint, /【记忆·置顶】/);
  assert.match(hint, /【状态】/);
  assert.match(hint, /群聊里不要提私下聊过的内容/);
  const repo = makeRepo('cli-persona');
  const stateOut = captureCli(['state'], { root: repo });
  assert.equal(stateOut.code, 0);
  assert.match(stateOut.text, /精力/);
  const setOut = captureCli(['set-state', '--energy', '0.4', '--mood', '-0.2', '--reason', '单测'], { root: repo });
  assert.equal(setOut.code, 0);
  assert.match(setOut.text, /状态已更新/);
  const jsonOut = captureCli(['state', '--json'], { root: repo });
  assert.match(jsonOut.text, /"energy"/);
});

﻿section('v1.5-lite 第二批：自述 / 人设审批 / 日层');

check('自述只增不改，最新在前', () => {
  const repo = makeRepo('self-narr');
  const service = createService({ repoRoot: repo });
  const first = service.addSelfNarrative({ text: '我第一次写下自己是谁。' });
  assert.equal(first.total, 1);
  const second = service.addSelfNarrative({ text: '今天学会了把一天压成一段。' });
  assert.equal(second.total, 2);
  const list = service.narratives({ limit: 10 });
  assert.equal(list.total, 2);
  assert.equal(list.items[0].text, '今天学会了把一天压成一段。');
  assert.equal(typeof service.updateSelfNarrative, 'undefined', '没有修改自述的入口（只增不改）');
});

check('人设建议 pending → 主人批准后才注入', () => {
  const repo = makeRepo('persona');
  const service = createService({ repoRoot: repo });
  service.addSelfNarrative({ text: '我说话比较短。' });
  const pending = service.setPersona({ text: '整体人设：话少、爱记账、有点黏人。' });
  assert.equal(pending.persona.status, 'pending');
  const before = autoRecallModule.autoRecall({ brain: service.snapshot(), isGroup: false, serendipity: 0, now: Date.now() });
  assert.equal(before.persona, null, '未批准的人设不注入');
  const approved = service.resolvePersona({ status: 'approved' });
  assert.equal(approved.persona.status, 'approved');
  const after = autoRecallModule.autoRecall({ brain: service.snapshot(), isGroup: false, serendipity: 0, now: Date.now() });
  assert.ok(after.persona && after.persona.text.includes('话少'));
  assert.equal(after.narratives.length, 1);
  const hint = autoRecallModule.formatMemoryHint(after, { isGroup: false });
  assert.match(hint, /【人设基调】/);
  assert.match(hint, /【自述】/);
});

check('日层压缩：dry-run、只生成一次、注入不占普通名额', () => {
  const repo = makeRepo('day');
  const NOW = Date.parse('2026-03-05T12:00:00Z');
  const service = createService({ repoRoot: repo, now: () => NOW });
  service.remember({ text: '上午在搭记忆系统。', title: '搭记忆系统', source: { kind: 'chat', key: 'private:1' } });
  service.remember({ text: '下午去体测了。', title: '体测', source: { kind: 'chat', key: 'private:1' } });
  const dry = service.dayDigest({ date: '2026-03-05', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.count >= 2);
  assert.match(dry.text, /【日层 2026-03-05】/);
  const day = service.dayDigest({ date: '2026-03-05' });
  assert.equal(day.created, true);
  assert.ok(day.id);
  const again = service.dayDigest({ date: '2026-03-05' });
  assert.equal(again.skipped, true);
  const memory = service.getMemory(day.id);
  assert.equal(memory.category, 'day');
  assert.ok(memory.tags.includes('2026-03-05'));
  const brain = service.snapshot();
  const result = autoRecallModule.autoRecall({ brain, isGroup: false, limit: 10, serendipity: 0, now: NOW + 3_600_000 });
  assert.ok(!result.ordinary.some((item) => item.id === day.id), '日层不占普通名额');
  assert.ok(result.days.some((item) => item.id === day.id), '日层进【近期】');
  const hint = autoRecallModule.formatMemoryHint(result, { isGroup: false });
  assert.match(hint, /【近期】/);
});

check('CLI self/day 命令可用', () => {
  const repo = makeRepo('cli-selfday');
  const addSelf = captureCli(['self', '--text', '我不知道自己是谁，但先写着。'], { root: repo });
  assert.equal(addSelf.code, 0);
  assert.match(addSelf.text, /自述/);
  const persona = captureCli(['self', '--persona', '话少、爱记账。'], { root: repo });
  assert.equal(persona.code, 0);
  assert.match(persona.text, /待主人批准/);
  const approve = captureCli(['self', '--approve'], { root: repo });
  assert.equal(approve.code, 0);
  assert.match(approve.text, /批准/);
  const list = captureCli(['self'], { root: repo });
  assert.match(list.text, /自述：1 条/);
  const dry = captureCli(['day', '--date', '2026-03-05', '--dry-run'], { root: repo });
  assert.equal(dry.code, 0);
  assert.match(dry.text, /预览/);
});

section('v1.5-lite 第三批：人设锚点 / 在乎的 / 回炉 / 6h 冷却');

check('人设锚点与「在乎的」可写可读，注入带【人设锚点】【在乎的】', () => {
  const repo = makeRepo('anchor-value');
  const NOW = Date.parse('2026-10-29T01:00:00+08:00');
  const service = createService({ repoRoot: repo, now: () => NOW });
  service.setAnchor({ text: '先接住人，再讲道理。' });
  service.addValue({ text: '他在乎的是我有没有自己改自己。' });
  service.addValue({ text: '他说过的话要自己记住。' });
  const list = service.narratives({ limit: 5 });
  assert.equal(list.anchor, '先接住人，再讲道理。');
  assert.equal(list.values.length, 2);
  const brain = service.snapshot();
  const result = autoRecallModule.autoRecall({ brain, isGroup: false, limit: 8, serendipity: 0, now: NOW });
  assert.equal(result.anchor, '先接住人，再讲道理。');
  const hint = autoRecallModule.formatMemoryHint(result, { isGroup: false });
  assert.match(hint, /人设锚点/);
  assert.match(hint, /在乎的/);
});

check('自述回炉：dryRun 只预览、force 生成摘要且原文保留', () => {
  const repo = makeRepo('self-digest');
  const NOW = Date.parse('2026-10-29T01:00:00+08:00');
  const service = createService({ repoRoot: repo, now: () => NOW });
  for (let i = 1; i <= 5; i += 1) service.addSelfNarrative({ text: `第 ${i} 次自述：我在想怎么接话。` });
  const preview = service.selfDigest({ dryRun: true, force: true });
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, true);
  const r = service.selfDigest({ force: true });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.match(r.digest.text, /自述·回炉/);
  const list = service.narratives({ limit: 10 });
  assert.equal(list.items.length, 5);
  assert.equal(list.digests.length, 1);
});

check('人设批准 6 小时冷却', () => {
  const repo = makeRepo('persona-cooldown');
  const NOW = Date.parse('2026-10-29T01:00:00+08:00');
  const service = createService({ repoRoot: repo, now: () => NOW });
  service.setPersona({ text: '说话更短一点，先接住人再补看法。' });
  assert.equal(service.resolvePersona({ status: 'approved' }).ok, true);
  service.setPersona({ text: '再短一点。' });
  let threw = false;
  try { service.resolvePersona({ status: 'approved' }); } catch (err) { threw = true; assert.match(err.message, /改太快/); }
  assert.equal(threw, true);
});

// ---------------------------------------------------------------------------
// v1.7：情绪复读 / 自升级提案 / 唤醒习惯 / 一个月测试台
// ---------------------------------------------------------------------------
section('v1.7 情绪 / 自升级 / 唤醒习惯 / 测试台');

check('情绪：setEmotion 落盘、24h 过期、注入带【此刻情绪】', () => {
  const repo = makeRepo('emotion');
  const NOW = Date.parse('2026-10-29T01:00:00+08:00');
  const service = createService({ repoRoot: repo, now: () => NOW });
  service.setEmotion({ label: '烦躁', intensity: 0.6, note: '三点被吵醒' });
  const got = service.emotion();
  assert.equal(got.emotion.label, '烦躁');
  assert.equal(Math.round(got.emotion.intensity * 10) / 10, 0.6);
  const brain = service.snapshot();
  const result = autoRecallModule.autoRecall({ brain, isGroup: false, limit: 6, serendipity: 0, now: NOW });
  assert.equal(result.emotionText.includes('烦躁'), true);
  assert.match(autoRecallModule.formatMemoryHint(result, { isGroup: false }), /此刻情绪/);
  const later = NOW + 25 * 60 * 60 * 1000;
  const expired = autoRecallModule.autoRecall({ brain, isGroup: false, limit: 6, serendipity: 0, now: later });
  assert.equal(expired.emotionText, '');
});

check('自升级：selfReview 生成待批准提案，批准后 toneHints 生效、外部卡尺可记', () => {
  const repo = makeRepo('self-review');
  const NOW = Date.parse('2026-10-29T01:00:00+08:00');
  const service = createService({ repoRoot: repo, now: () => NOW });
  for (const text of [
    '希望对您有帮助，如有需要随时告诉我，感谢您的理解。',
    '如有需要随时告诉我，希望对您有帮助。',
    '这样可以吗？要不要现在处理呢？',
    '需要我再解释一下吗？',
  ]) {
    service.remember({ title: '语气样本', text, layer: 'long', category: 'fact' });
  }
  service.remember({ title: '正常的一句', text: '我先去把日志翻了，三点前给你结果。', layer: 'long', category: 'fact' });
  const review = service.selfReview({ days: 7 });
  assert.equal(review.scanned >= 2, true);
  assert.equal(review.proposals.length >= 1, true);
  const proposal = review.proposals[0];
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.externalScore, null);
  const decided = service.resolveProposal({ id: proposal.id, status: 'approved', by: 'owner', externalScore: 0.8 });
  assert.equal(decided.ok, true);
  const list = service.proposals();
  assert.equal(list.counts.approved >= 1, true);
  assert.equal(list.toneHints.length >= 1, true);
  const stored = service.snapshot().self.proposals.find((p) => p.id === proposal.id);
  assert.equal(stored.externalScore, 0.8);
});

check('唤醒习惯：wakeHabitPrompt 说明置顶/情绪；formatMemoryHint 首段是【醒来先看】', () => {
  const repo = makeRepo('wake-habit');
  const NOW = Date.parse('2026-10-29T01:00:00+08:00');
  const service = createService({ repoRoot: repo, now: () => NOW });
  service.remember({ title: '关机前先写日记', text: '他每次关电脑前会让我先写一条日记。', layer: 'long', permanent: true, tags: ['pinned'] });
  service.setEmotion({ label: '平静', intensity: 0.4 });
  const brain = service.snapshot();
  const result = autoRecallModule.autoRecall({ brain, isGroup: false, limit: 6, serendipity: 0, now: NOW });
  assert.equal(result.counts.top >= 1, true);
  assert.equal(typeof result.wake, 'string');
  assert.match(result.wake, /醒来先看|先翻一遍/);
  const hint = autoRecallModule.formatMemoryHint(result, { isGroup: false });
  assert.match(hint, /醒来先看/);
  // 情绪只在【此刻情绪】里说一次：唤醒行不再重复「此刻情绪」。
  assert.equal(result.wake.includes('此刻情绪'), false, '唤醒行不再重复情绪');
  assert.equal((hint.match(/此刻情绪/g) || []).length, 1, '情绪块只出现一次');
});

check('过时语气尾注在渲染层被剥掉，真实建议保留', () => {
  const state = model.personaStateSnapshot({ energy: 0.5, mood: 0.2, updatedAt: T0 }, T0);
  const hint = autoRecallModule.formatMemoryHint(
    {
      state,
      top: [],
      anchors: [],
      ordinary: [],
      serendipity: [],
      toneHints: [
        '以后少说客服话术：直接回应对方在意的点，少用敬语尾巴。这只是机器人的自评嫌疑，不算数；外部卡尺以主人的判定为准，主人批准后才会变成生效的语气提示。',
      ],
    },
    { isGroup: false }
  );
  assert.match(hint, /【语气校准/);
  assert.match(hint, /少用敬语尾巴/);
  assert.equal(hint.includes('自评嫌疑'), false, '旧的「自评嫌疑」尾注被剥掉');
  assert.equal(hint.includes('外部卡尺'), false, '旧的「外部卡尺」尾注被剥掉');
  assert.equal(hint.includes('主人批准后才会变成生效'), false, '旧的「等批准」暗示被剥掉');
});

check('一个月测试台：trial 初始化 + 报告结构 + 开封探针命中', () => {
  const repo = makeRepo('trial');
  const NOW = Date.parse('2026-10-29T01:00:00+08:00');
  const service = createService({ repoRoot: repo, now: () => NOW });
  service.remember({ title: '管理员在开封', text: '主人凌晨说自己在开封，问天气怎么样。', layer: 'long', category: 'event' });
  const init = runCli(['trial', '--init', '--root', repo], { stdout: () => {}, stderr: () => {} });
  assert.equal(init, 0);
  const info = service.trialInfo();
  assert.equal(Boolean(info.trial), true);
  const reportPath = path.join(repo, 'state', 'memory', 'trial-report.json');
  const reportRun = runCli(['trial', '--report', '--root', repo, '--json'], { stdout: () => {}, stderr: () => {} });
  assert.equal(reportRun, 0);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.probe.found, true);
  assert.equal(report.wakes.total >= 0, true);
});

for (const dir of tmpDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
}

console.log(`\n总计：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const failure of failures) console.log(` - ${failure.name}`);
  process.exitCode = 1;
}
