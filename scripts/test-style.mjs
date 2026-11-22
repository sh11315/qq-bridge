#!/usr/bin/env node
// 风格画像回归：特征统计、摘要、门槛/防抖、版本化、注入行、存储淘汰。
// 用法：node scripts/test-style.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeStyleConfig,
  extractStyleFeatures,
  buildStyleSummary,
  styleDistance,
  shouldUpdateStyle,
  mergeStyleProfile,
  buildStyleLine
} from '../src/core/style-profile.mjs';
import {
  loadStyleProfiles,
  saveStyleProfiles,
  pruneStyleProfiles,
  getStyleProfile,
  setStyleProfile
} from '../src/style-store.mjs';

const now = Date.now();
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

const makeMessages = (count, text, { startAt = now - 4 * 86400000, stepMs = 60000 } = {}) => Array.from({ length: count }, (_, i) => ({
  sender: '群友',
  text,
  isSelf: false,
  time: startAt + i * stepMs
}));

await test('特征统计：短句/笑声/问句，且不计自己说的话', () => {
  const messages = [
    ...makeMessages(30, '哈哈哈'),
    ...makeMessages(30, '在吗？'),
    ...makeMessages(30, '这是一句比较长的完整句子用来测试平均长度'),
    { sender: '我', text: '哈哈哈哈哈哈', isSelf: true, time: now }
  ];
  const f = extractStyleFeatures(messages);
  assert.equal(f.sampleCount, 90, '自己的消息不计入');
  assert.ok(f.shortRatio > 0.5);
  assert.ok(f.laughRatio > 0.3);
  assert.ok(f.questionRatio > 0.3);
  assert.ok(f.avgLen > 0);
  assert.ok(f.firstAt < f.lastAt);
});

await test('摘要：短句 + 哈哈哈 + 反问', () => {
  const summary = buildStyleSummary(extractStyleFeatures([...makeMessages(40, '哈哈哈'), ...makeMessages(40, '真的吗？'), ...makeMessages(40, '好')]));
  assert.match(summary, /短句|句子偏短/);
  assert.match(summary, /哈哈哈/);
  assert.match(summary, /反问/);
});

await test('门槛：样本不足 / 跨度不足 / 首次通过', () => {
  const cfg = normalizeStyleConfig({ minSamples: 50, minSpanHours: 72 });
  const few = extractStyleFeatures(makeMessages(10, '好'));
  assert.equal(shouldUpdateStyle(null, few, cfg, now).update, false);
  const tooShort = extractStyleFeatures(makeMessages(60, '好', { startAt: now - 3600000, stepMs: 10000 }));
  assert.equal(shouldUpdateStyle(null, tooShort, cfg, now).update, false);
  const good = extractStyleFeatures(makeMessages(60, '好', { startAt: now - 4 * 86400000, stepMs: (4 * 86400000) / 59 }));
  assert.equal(shouldUpdateStyle(null, good, cfg, now).update, true);
});

await test('防抖：变化小不更新，变化大更新；冻结态不更新', () => {
  const cfg = normalizeStyleConfig({ minSamples: 50, minSpanHours: 1, minDistance: 0.2 });
  const base = extractStyleFeatures(makeMessages(60, '这是一句长度适中的话', { startAt: now - 4 * 86400000 }));
  const profile = mergeStyleProfile(null, base, cfg, now);
  assert.equal(shouldUpdateStyle(profile, base, cfg, now).update, false, '同样本不应更新');

  const changed = extractStyleFeatures([...makeMessages(30, '这是一句长度适中的话', { startAt: now - 4 * 86400000 }), ...makeMessages(30, '哈', { startAt: now - 86400000 })]);
  assert.equal(shouldUpdateStyle(profile, changed, cfg, now).update, true, '变化大应更新');

  const frozen = { ...profile, status: 'frozen' };
  assert.equal(shouldUpdateStyle(frozen, changed, cfg, now).update, false);
});

await test('版本化：只增不改，prev 只保留最近 3 个', () => {
  let profile = null;
  const features = extractStyleFeatures(makeMessages(60, '好', { startAt: now - 4 * 86400000 }));
  for (let i = 0; i < 5; i += 1) profile = mergeStyleProfile(profile, features, normalizeStyleConfig({ maxVersions: 3 }), now + i);
  assert.equal(profile.version, 5);
  assert.equal(profile.prev.length, 3);
  assert.deepEqual(profile.prev.map((p) => p.version), [2, 3, 4]);
});

await test('注入行：样本不足不注入，正常才注入', () => {
  const cfg = normalizeStyleConfig({ minSamples: 50 });
  const few = { sampleCount: 10, summary: '句子偏短' };
  assert.equal(buildStyleLine(few, cfg), '');
  const ok = { sampleCount: 60, summary: '句子偏短；爱用“哈哈哈”' };
  assert.match(buildStyleLine(ok, cfg), /【本群说话习惯】/);
  assert.match(buildStyleLine(ok, cfg), /样本 60 条/);
});

await test('存储：原子写读、按上限淘汰', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-style-'));
  try {
    const file = path.join(dir, 'style-profiles.json');
    const store = loadStyleProfiles(file);
    setStyleProfile(store, 'group:1', { version: 1, updatedAt: now, summary: 'x', sampleCount: 60 }, 200);
    setStyleProfile(store, 'group:2', { version: 1, updatedAt: now + 1, summary: 'y', sampleCount: 60 }, 200);
    assert.ok(saveStyleProfiles(file, store));
    const reloaded = loadStyleProfiles(file);
    assert.equal(getStyleProfile(reloaded, 'group:1').summary, 'x');
    for (let i = 0; i < 5; i += 1) setStyleProfile(store, `group:9${i}`, { version: 1, updatedAt: now + 10 + i }, 200);
    const removed = pruneStyleProfiles(store, 2);
    assert.equal(removed, 5);
    assert.equal(Object.keys(store.profiles).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部风格画像用例通过');
process.exit(failed ? 1 : 0);