#!/usr/bin/env node
// 回忆检索回归：剥实词、短答案、数量扫描、时间/发送者过滤、上下文、归档轮转。
// 用法：node scripts/test-history-search.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractQueryTerms,
  extractQueryPhrase,
  isQuantityQuery,
  findQuantityAnswers,
  searchHistoryMessages,
  formatHistoryHitsForModel
} from '../src/core/history-search.mjs';
import { appendArchive, readArchive, resetArchiveCounts } from '../src/history-archive.mjs';
import { FEATURE_TOOL_FLAGS, featureAllowsFlag } from '../src/core/feature-sessions.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

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

const HOUR = 3600 * 1000;
const now = Date.now();
const messages = [
  { seq: 1, messageId: 'm1', time: now - 48 * HOUR, sender: '小明', userId: '2001', text: '昨天带猫去看病了' },
  { seq: 2, messageId: 'm2', time: now - 47 * HOUR, sender: '我', userId: '1001', text: '严重吗', isSelf: true },
  { seq: 3, messageId: 'm3', time: now - 47 * HOUR, sender: '小明', userId: '2001', text: '4只' },
  { seq: 4, messageId: 'm4', time: now - 46 * HOUR, sender: '小明', userId: '2001', text: '至少2只都救回来了' },
  { seq: 5, messageId: 'm5', time: now - 2 * HOUR, sender: '小红', userId: '3001', text: '今晚吃火锅吗' },
  { seq: 6, messageId: 'm6', time: now - 20 * 24 * HOUR, sender: '小明', userId: '2001', text: '很早以前也养过猫' }
];

await test('剥实词：疑问句式不参与检索，但保留实词', () => {
  const terms = extractQueryTerms('你还记得我有几只猫吗');
  assert.ok(terms.includes('猫'), `应保留“猫”，实际：${terms.join('/')}`);
  assert.ok(!terms.includes('你'));
  assert.ok(!terms.includes('吗'));
  assert.equal(extractQueryPhrase('你还记得我有几只猫吗'), '猫');
  assert.equal(isQuantityQuery('我有几只猫'), true);
  // 联调实测：口语后缀不剥会切成 ["还","猫来着"]，0 命中。
  const colloquial = extractQueryTerms('我还有几只猫来着');
  assert.ok(colloquial.includes('猫'), `口语后缀应剥掉，实际：${colloquial.join('/')}`);
  assert.ok(!colloquial.includes('猫来着'));
  assert.ok(!colloquial.includes('还'));
});

await test('全是停用词时明确标记 emptyQuery，并给出可操作提示', () => {
  // 联调实测：query=的 被剥光后只返回 0 命中，模型不知道是“没搜到”还是“查了个空”。
  const res = searchHistoryMessages(messages, { query: '的', hours: 72, limit: 10, now });
  assert.deepEqual(res.terms, []);
  assert.equal(res.emptyQuery, true);
  assert.equal(res.hits.length, 0);
  const text = formatHistoryHitsForModel('group:456', res);
  assert.match(text, /没有可检索的实词/);
  // 数量型查询即使没有关键词，也不应被当成 emptyQuery
  const qty = searchHistoryMessages(messages, { query: '几只', hours: 72, limit: 10, now });
  assert.equal(qty.emptyQuery, false);
});

await test('数量答案：识别「数字+量词」，排除时长类假数字', () => {
  assert.deepEqual(findQuantityAnswers('4只').map((x) => x.value), ['4只']);
  assert.equal(findQuantityAnswers('预计 20 分钟内到').length, 0);
});

await test('短答案与数量扫描都能命中', () => {
  const res = searchHistoryMessages(messages, { query: '我有几只猫', hours: 72, limit: 10, now });
  assert.ok(res.quantityMode);
  const texts = res.hits.map((h) => h.text);
  assert.ok(texts.includes('4只'), '短答案 4只 必须保留');
  assert.ok(texts.some((t) => t.includes('至少2只')), '数量型应扫到“至少2只”');
  assert.ok(texts.some((t) => t.includes('带猫去看病')), '关键词应命中“带猫去看病”');
});

await test('时间窗与发送者过滤生效', () => {
  const older = searchHistoryMessages(messages, { query: '猫', hours: 72, limit: 10, now });
  assert.ok(!older.hits.some((h) => h.text.includes('很早以前')), '20 天前的消息不应进 72 小时窗口');
  const byUser = searchHistoryMessages(messages, { query: '猫', hours: 72, limit: 10, now, userId: '3001' });
  assert.equal(byUser.hits.length, 0, '发送者过滤后不应命中');
});

await test('命中带前后各一句，结果按分数/时间排序且可截断', () => {
  const all = searchHistoryMessages(messages, { query: '几只猫', hours: 72, limit: 10, now });
  const hit = all.hits.find((h) => h.text.includes('带猫去看病'));
  assert.ok(hit, '关键词命中应包含“带猫去看病”');
  assert.equal(hit.before, null, '最早一条没有前文');
  assert.equal(hit.after, '严重吗', '后文应是紧邻的“严重吗”');
  const limited = searchHistoryMessages(messages, { query: '几只猫', hours: 72, limit: 2, now });
  assert.equal(limited.hits.length, 2);
  assert.equal(limited.truncated, true);
});

await test('归档写入/读取按会话隔离', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-archive-'));
  try {
    resetArchiveCounts();
    appendArchive(dir, 'group:456', { at: now, key: 'group:456', seq: 1, text: 'hello' }, { maxLines: 100 });
    appendArchive(dir, 'group:456', { at: now + 1, key: 'group:456', seq: 2, text: 'world' }, { maxLines: 100 });
    appendArchive(dir, 'private:789', { at: now, key: 'private:789', seq: 1, text: 'secret' }, { maxLines: 100 });
    const rows = readArchive(dir, 'group:456');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.text), ['hello', 'world']);
    assert.equal(readArchive(dir, 'private:789').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('归档达到上限后轮转 .1，旧数据仍可读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-archive-'));
  try {
    resetArchiveCounts();
    for (let i = 0; i < 101; i += 1) {
      appendArchive(dir, 'group:456', { at: now + i, key: 'group:456', seq: i, text: `m${i}` }, { maxLines: 100 });
    }
    const rows = readArchive(dir, 'group:456');
    assert.ok(rows.length >= 100, `轮转后应仍能读到大部分历史，实际 ${rows.length}`);
    assert.ok(fs.existsSync(path.join(dir, 'group_456.jsonl.1')), '.1 备份应存在');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('工具面：chat 与 web 允许 searchHistory，其它域不允许', () => {
  for (const feature of ['chat', 'web']) {
    assert.equal(featureAllowsFlag(feature, 'searchHistory'), true, `${feature} 应允许历史检索`);
    assert.ok(FEATURE_TOOL_FLAGS[feature].includes('searchHistory'));
  }
  for (const feature of ['vision', 'voice', 'sticker']) {
    assert.equal(featureAllowsFlag(feature, 'searchHistory'), false, `${feature} 不应允许历史检索`);
  }
});

await test('bridge 入站/出站消息都会写归档（集成）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message('group:456', '小明', '带猫去看病', '带猫去看病', false, false, 'm1', [], '2001', [], '');
    h.recordSentMessagesV2('group:456', ['严重吗']);
    const dir = path.join(h.temp, 'state', 'message-archive');
    const rows = readArchive(dir, 'group:456');
    assert.equal(rows.length, 2, `应写 2 条归档，实际 ${rows.length}`);
    assert.equal(rows[0].text, '带猫去看病');
    assert.equal(rows[0].userId, '2001');
    assert.equal(rows[1].isSelf, true);
  } finally {
    await h.close();
  }
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部回忆检索用例通过');
process.exit(failed ? 1 : 0);