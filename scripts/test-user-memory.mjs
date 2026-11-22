#!/usr/bin/env node
// 跨群用户记忆回归：四维演进、衰减、边界确认、档位词、存储读写与淘汰。
// 用法：node scripts/test-user-memory.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyProfile,
  applyMessage,
  decayProfile,
  detectBoundaries,
  recordBoundaries,
  relationshipWords,
  formatUserMemoryHint,
  messageSeed
} from '../src/core/user-memory.mjs';
import {
  loadUserMemory,
  saveUserMemory,
  recordIncomingMessage,
  pruneUsers,
  getProfile
} from '../src/user-memory-store.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';

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

await test('空档案：四维基线（信任 48 / 亲近 20，其余 0）', () => {
  const p = emptyProfile('2001', now);
  assert.equal(p.familiarity, 0);
  assert.equal(p.trust, 48);
  assert.equal(p.closeness, 20);
  assert.equal(p.rapport, 0);
  assert.equal(p.qq, '2001');
});

await test('消息推进：熟悉/默契上涨，正面互动推高亲近、负面压低', () => {
  let p = emptyProfile('2001', now);
  for (let i = 0; i < 30; i += 1) p = applyMessage(p, { userId: '2001', nick: '小明', key: 'group:456', text: '今天天气不错', now: now + i });
  assert.ok(p.messageCount === 30);
  assert.ok(p.familiarity > 0, '熟悉度应上涨');
  assert.ok(p.rapport > 0, '默契应上涨');
  const before = p.closeness;
  p = applyMessage(p, { userId: '2001', text: '谢谢你，真靠谱', key: 'group:456', now: now + 40 });
  assert.ok(p.closeness > before, '正面互动应推高亲近');
  p = applyMessage(p, { userId: '2001', text: '滚，闭嘴', key: 'group:456', now: now + 41 });
  assert.ok(p.closeness < before + 1.2, '负面互动应压低亲近');
  assert.deepEqual(p.groups, ['456']);
});

await test('衰减：半衰期到了会回落，但发言量种子仍在', () => {
  let p = emptyProfile('2001', now);
  for (let i = 0; i < 80; i += 1) p = applyMessage(p, { userId: '2001', key: 'group:456', text: '聊天', now });
  const before = p.familiarity;
  const later = decayProfile(p, now + 60 * 86400000);
  assert.ok(later.familiarity < before, '60 天后熟悉度应下降');
  assert.ok(later.familiarity > 0, '不应归零（还有历史发言量）');
  assert.ok(messageSeed(p.messageCount, 92) > before * 0.5);
});

await test('边界识别：称呼/话题/玩笑/肉麻', () => {
  const kinds = (text) => detectBoundaries(text).map((b) => b.kind);
  assert.ok(kinds('别叫我小明').includes('name_forbidden'));
  assert.ok(kinds('叫我老王吧').includes('name_preferred'));
  assert.ok(kinds('别聊工资了').includes('topic_sensitive'));
  assert.ok(kinds('别开我玩笑').includes('joke_off'));
  assert.ok(kinds('可以拿我开玩笑').includes('joke_ok'));
  assert.ok(kinds('别肉麻').includes('warm_off'));
});

await test('边界必须出现 2 次才确认', () => {
  let p = emptyProfile('2001', now);
  p = recordBoundaries(p, '别叫我小明', now + 1);
  assert.equal(p.boundaries[0].hits, 1);
  assert.equal(p.boundaries[0].confirmedAt, 0);
  const visible = formatUserMemoryHint(p);
  assert.doesNotMatch(visible, /别叫“小明”/, '未确认的边界不进提示词');

  p = recordBoundaries(p, '都说了别叫我小明', now + 2);
  assert.equal(p.boundaries[0].hits, 2);
  assert.ok(p.boundaries[0].confirmedAt > 0);
  assert.match(formatUserMemoryHint(p), /别叫“小明”/);
});

await test('档位词与提示格式：只给词，不给分数、不给别人', () => {
  const p = { ...emptyProfile('2001', now), nick: '小明', familiarity: 88, trust: 70, closeness: 40, rapport: 90 };
  const words = relationshipWords(p);
  assert.equal(words.familiarity, '老朋友了');
  assert.equal(words.trust, '比较信任');
  assert.equal(words.closeness, '客客气气');
  assert.equal(words.rapport, '合拍');
  const line = formatUserMemoryHint(p);
  assert.match(line, /【对这个人】小明（QQ 2001）/);
  assert.match(line, /熟悉：老朋友了/);
  assert.doesNotMatch(line, /88|70|40|90/);
  assert.equal(formatUserMemoryHint(null), '');
});

await test('存储：原子写读、消息记录、超额淘汰', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-user-memory-'));
  try {
    const file = path.join(dir, 'user-memory.json');
    const store = loadUserMemory(file);
    recordIncomingMessage(store, { userId: '2001', nick: '小明', key: 'group:456', text: '你好', now }, { maxUsers: 5000 });
    assert.equal(getProfile(store, '2001').messageCount, 1);
    assert.ok(saveUserMemory(file, store));
    const reloaded = loadUserMemory(file);
    assert.equal(reloaded.users['2001'].nick, '小明');

    for (let i = 0; i < 5; i += 1) recordIncomingMessage(store, { userId: `900${i}`, key: 'group:456', text: 'x', now: now + i }, { maxUsers: 5000 });
    const removed = pruneUsers(store, 2);
    assert.equal(removed, 4);
    assert.ok(Object.keys(store.users).length === 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('关闭开关时 bridge 不写关系（store 层不依赖开关，只验证空 userId 安全）', () => {
  const store = loadUserMemory(path.join(os.tmpdir(), 'never-exists-user-memory.json'));
  assert.equal(recordIncomingMessage(store, { userId: '', text: 'x' }), null);
  assert.deepEqual(Object.keys(store.users), []);
});

await test('bridge 集成：入站消息更新关系并生成档位行', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message('group:456', '小明', '谢谢你，真靠谱', '谢谢你，真靠谱', false, false, 'm1', [], '2001', [], '');
    const profile = h.userMemoryStore.users['2001'];
    assert.ok(profile, '应写入用户档案');
    assert.equal(profile.messageCount, 1);
    assert.equal(profile.nick, '小明');
    const line = h.buildUserMemoryLine('group:456');
    assert.match(line, /QQ 2001/);
    assert.match(line, /熟悉：/);
  } finally {
    await h.close();
  }
});

await test('bridge 集成：出图文件按日期落盘', async () => {
  const h = await bridgeHarness();
  try {
    const file = h.saveGeneratedImage(Buffer.from(PNG, 'base64'), 'image/png');
    assert.ok(file.includes('generated-images'));
    assert.ok(fs.existsSync(file));
  } finally {
    await h.close();
  }
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部跨群用户记忆用例通过');
process.exit(failed ? 1 : 0);