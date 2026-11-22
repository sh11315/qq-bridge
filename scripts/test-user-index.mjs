#!/usr/bin/env node
// 跨群用户索引回归：写入/过滤/轮转、跨群权限、bridge 集成（只记入站）。
// 用法：node scripts/test-user-index.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendUserIndex, readUserIndex, resetUserIndexCounts } from '../src/user-index.mjs';
import { canUseUserScope } from '../src/core/history-search.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

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

await test('索引：按 QQ 过滤读取，sender 保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-user-index-'));
  try {
    resetUserIndexCounts();
    appendUserIndex(dir, 'group:456', { at: now, userId: '2001', sender: '小明', seq: 1, text: 'a' }, { maxLines: 1000 });
    appendUserIndex(dir, 'group:789', { at: now + 1, userId: '2001', sender: '小明', seq: 2, text: 'b' }, { maxLines: 1000 });
    appendUserIndex(dir, 'group:456', { at: now + 2, userId: '3001', sender: '小红', seq: 3, text: 'c' }, { maxLines: 1000 });
    const rows = readUserIndex(dir, '2001');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.text), ['a', 'b']);
    assert.equal(rows[0].sender, '小明');
    assert.equal(readUserIndex(dir, '3001').length, 1);
    assert.deepEqual(readUserIndex(dir, ''), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('索引达到上限后轮转 .1，旧数据仍可读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-user-index-'));
  try {
    resetUserIndexCounts();
    for (let i = 0; i <= 1000; i += 1) {
      appendUserIndex(dir, 'group:456', { at: now + i, userId: '2001', sender: '小明', seq: i, text: `m${i}` }, { maxLines: 1000 });
    }
    const rows = readUserIndex(dir, '2001');
    assert.ok(rows.length >= 1000, `轮转后应仍能读到大部分历史，实际 ${rows.length}`);
    assert.ok(fs.existsSync(path.join(dir, 'user-index.jsonl.1')), '.1 备份应存在');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('索引：截断不切断 emoji 代理对（不落盘孤立代理）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-user-index-'));
  try {
    resetUserIndexCounts();
    const emoji = String.fromCodePoint(0x1f600);
    // 1 个 BMP 字符 + 200 个 emoji = 401 码元。按码元 slice(0,200) 正好切在第 100 个
    // emoji 的高代理上，留下孤立高代理（落盘后显示成 �）。必须按码点截断。
    appendUserIndex(dir, 'group:456', { at: now, userId: '2001', sender: 'S', text: `a${emoji.repeat(200)}` }, { maxLines: 1000 });
    const [row] = readUserIndex(dir, '2001');
    assert.equal(typeof row?.text, 'string', '应能读回写入的记录');
    const text = String(row.text);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code < 0xd800 || code > 0xdbff) continue;
      const next = text.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `位置 ${i} 出现孤立高代理（截断切坏了 emoji）`);
    }
    assert.equal(text.length <= 200, true, `截断后不应超过 200 码元，实际 ${text.length}`);
    assert.equal(text.endsWith(emoji), true, '截断点应落在完整码点上');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('跨群权限：主人私聊 / closed-agent / 控制台可用，群会话不可', () => {
  assert.equal(canUseUserScope({ callerKey: 'private:100000001', ownerQQ: 100000001 }), true);
  assert.equal(canUseUserScope({ callerKey: 'group:100000004', ownerQQ: 100000001 }), false);
  assert.equal(canUseUserScope({ callerKey: 'group:100000004', ownerQQ: 100000001, mode: 'closed-agent' }), true);
  assert.equal(canUseUserScope({ callerKey: '', ownerQQ: 100000001, consoleRequest: true }), true);
  assert.equal(canUseUserScope({ callerKey: 'private:999', ownerQQ: 100000001 }), false);
});

await test('bridge 集成：入站写索引，自己发的消息不写', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message('group:456', '小明', '测试消息', '测试消息', false, false, 'm1', [], '2001', [], '');
    h.recordSentMessagesV2('group:456', ['我发的']);
    const file = path.join(h.temp, 'state', 'user-index.jsonl');
    assert.ok(fs.existsSync(file), '应生成用户索引文件');
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(rows.length, 1, '只应记录入站消息');
    assert.equal(rows[0].userId, '2001');
    assert.equal(rows[0].sender, '小明');
    assert.equal(rows[0].key, 'group:456');
  } finally {
    await h.close();
  }
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部跨群用户索引用例通过');
process.exit(failed ? 1 : 0);