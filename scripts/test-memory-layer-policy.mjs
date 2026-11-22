#!/usr/bin/env node
// 记忆层级策略测试（2026-11-22）：layer-policy 纯函数 + service 写入/激活/日层集成。
// 全部在 os.tmpdir() 临时仓库里跑，绝不碰真实 state/memory。
//
// 运行：node scripts/test-memory-layer-policy.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as policy from '../src/memory/layer-policy.mjs';
import { createService } from '../src/memory/service.mjs';

const tmpDirs = [];
let passed = 0;
const failures = [];

function makeRepo(label = 'layer') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-memory-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n    ${error.message}`);
  }
}

console.log('记忆层级策略测试');

check('事件/事实/话题默认短期；模型显式要 long 时尊重它', () => {
  for (const category of ['event', 'fact', 'topic', 'other']) {
    assert.equal(policy.decideMemoryLayer({ requested: 'long', category }), 'long', category);
    assert.equal(policy.decideMemoryLayer({ category }), 'short', category);
    assert.equal(policy.decideMemoryLayer({ requested: 'short', category }), 'short', category);
  }
});

check('承诺/长期偏好/关系/档案天然长期', () => {
  for (const category of ['promise', 'preference', 'relationship', 'profile']) {
    assert.equal(policy.decideMemoryLayer({ category }), 'long', category);
    assert.equal(policy.decideMemoryLayer({ requested: 'short', category }), 'long', category);
  }
});

check('日记与日层永远是长期（归档用途）', () => {
  assert.equal(policy.decideMemoryLayer({ requested: 'short', category: 'event', isDiary: true }), 'long');
  assert.equal(policy.decideMemoryLayer({ requested: 'short', category: 'day', isDay: true }), 'long');
});

check('永久与保护线以上直接长期', () => {
  assert.equal(policy.decideMemoryLayer({ category: 'event', permanent: true }), 'long');
  assert.equal(policy.decideMemoryLayer({ category: 'event', protection: 0.5 }), 'long');
  assert.equal(policy.decideMemoryLayer({ category: 'event', protection: 0.2 }), 'short');
});

check('升级走「被想起够多次」：shouldPromoteToLong 是唯一入口', () => {
  assert.equal(policy.shouldPromoteToLong({ layer: 'short', category: 'event', activationCount: policy.PROMOTE_AFTER_ACTIVATIONS - 1 }), false);
  assert.equal(policy.shouldPromoteToLong({ layer: 'short', category: 'event', activationCount: policy.PROMOTE_AFTER_ACTIVATIONS }), true);
});

check('shouldPromoteToLong 只针对短期、非永久、非日记记忆', () => {
  assert.equal(policy.shouldPromoteToLong({ layer: 'short', category: 'event', activationCount: 3 }), true);
  assert.equal(policy.shouldPromoteToLong({ layer: 'short', category: 'event', activationCount: 2 }), false);
  assert.equal(policy.shouldPromoteToLong({ layer: 'long', category: 'event', activationCount: 9 }), false);
  assert.equal(policy.shouldPromoteToLong({ layer: 'short', category: 'event', activationCount: 9, permanent: true }), false);
  assert.equal(policy.shouldPromoteToLong({ layer: 'short', category: 'event', activationCount: 9, tags: ['diary'] }), false);
  assert.equal(policy.shouldPromoteToLong({ layer: 'short', category: 'day', activationCount: 9 }), false);
  assert.equal(policy.shouldPromoteToLong(null), false);
});

check('decideRetierLayer 只降事件/事实/话题，不碰日记/日层/永久', () => {
  assert.deepEqual(policy.decideRetierLayer({ id: 'm1', layer: 'long', category: 'event', activationCount: 1 }), {
    layer: 'short',
    reason: 'demote-transient',
  });
  assert.equal(policy.decideRetierLayer({ id: 'm2', layer: 'long', category: 'event', activationCount: 3 }), null);
  assert.equal(policy.decideRetierLayer({ id: 'm3', layer: 'long', category: 'day' }), null);
  assert.equal(policy.decideRetierLayer({ id: 'm4', layer: 'long', category: 'event', tags: ['diary'] }), null);
  assert.equal(policy.decideRetierLayer({ id: 'm5', layer: 'long', category: 'event', permanent: true }), null);
  assert.equal(policy.decideRetierLayer({ id: 'm6', layer: 'short', category: 'event' }), null);
  assert.equal(policy.decideRetierLayer({ status: 'archived', layer: 'long', category: 'event' }), null);
});

check('service：写入时按策略裁决层级', () => {
  const repo = makeRepo('write');
  const service = createService({ repoRoot: repo });
  const explicitLong = service.remember({ text: '今天群里有人发了张猫图，笑死', layer: 'long', category: 'event' });
  assert.equal(explicitLong.memory.layer, 'long', '模型显式要 long 时尊重它的判断');
  const defaultEvent = service.remember({ text: '今天群里又有人发了张猫图，笑死', category: 'event' });
  assert.equal(defaultEvent.memory.layer, 'short', '没指定层级的事件默认短期');

  const promise = service.remember({ text: '答应饭饭周末陪他看番', category: 'promise' });
  assert.equal(promise.memory.layer, 'long');

  const diary = service.remember({ text: '日记：今天把记忆层级改明白了', category: 'event', tags: ['diary'] });
  assert.equal(diary.memory.layer, 'long');
});

check('service：短期记忆被反复写入（激活）后升长期', () => {
  const repo = makeRepo('promote');
  const service = createService({ repoRoot: repo });
  const text = '同一个短期事件被反复提起';
  service.remember({ text, category: 'event' });
  service.remember({ text, category: 'event' });
  const third = service.remember({ text, category: 'event' });
  assert.equal(third.memory.activationCount, policy.PROMOTE_AFTER_ACTIVATIONS);
  assert.equal(third.memory.layer, 'long');
});

check('service：空日层不再生成', () => {
  const repo = makeRepo('day');
  const service = createService({ repoRoot: repo });
  const result = service.dayDigest({ date: '2026-01-02' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'empty-day');
  const brain = service.snapshot();
  assert.equal(Object.values(brain.memories).filter((m) => m && m.category === 'day').length, 0);
});

check('service：retierMemories 能归档空日层（dryRun 不落盘）', () => {
  const repo = makeRepo('retier');
  const service = createService({ repoRoot: repo });
  service.remember({ text: '先写一条让 brain.json 落盘', category: 'fact' });
  // 直接往 brain.json 里塞一条旧版空日层，模拟存量脏数据
  const brainPath = path.join(repo, 'state', 'memory', 'brain.json');
  const raw = JSON.parse(fs.readFileSync(brainPath, 'utf8'));
  raw.memories['legacy-empty-day'] = {
    id: 'legacy-empty-day',
    layer: 'long',
    category: 'day',
    title: '日层 2026-01-01 摘要',
    text: '【日层 2026-01-01】当天共 0 条记录：\n- 没有特别的记录',
    tags: ['day', '2026-01-01'],
    strength: 0.95,
    baseStrength: 1,
    status: 'active',
    activationCount: 1,
    decayDays: 200,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(brainPath, JSON.stringify(raw, null, 2));

  const dry = service.retierMemories({ dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.changed >= 1, true);
  assert.notEqual(service.snapshot().memories['legacy-empty-day'].status, 'archived');

  const applied = service.retierMemories({});
  assert.equal(applied.ok, true);
  const after = service.snapshot().memories['legacy-empty-day'];
  assert.equal(after.status, 'archived');
  assert.equal(after.archivedReason, 'empty-day');
});

// 清理临时目录
for (const dir of tmpDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

console.log(`\n层级策略测试：${passed}/${passed + failures.length} 通过`);
if (failures.length) {
  for (const { name, error } of failures) console.error(`FAIL ${name}: ${error.stack || error.message}`);
  process.exit(1);
}
