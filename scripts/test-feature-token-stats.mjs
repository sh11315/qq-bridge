/**
 * 「按功能（chat / sticker / vision / voice / web）分账」测试。
 *
 * 覆盖点：
 * 1. 五套功能会话（不同 sessionId、同一 QQ 会话）能按 feature:level 拆开；
 * 2. 每套的 token / 花费 / 轮次 / 缓存命中率正确，份额（share）之和 = 1；
 * 3. 基础 vs 进阶对比：level 取自 variant 后半段，两个档位分别汇总；
 * 4. 无法归属的旧会话进 unknown，不污染五个功能域；
 * 5. 旧日志没有 f 字段时，用 resolveFeature 回填；新日志落盘带 f，重启后不再依赖反查；
 * 6. since 时间窗只统计窗口内采样（基线无法按时间切，按既有口径排除）；
 * 7. 全时段口径下 byFeature.totals 与 summary.totals 自洽（不会多算/漏算）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PRICE_TABLE } from '../src/model-prices.js';
import { createTokenLedger } from '../src/token-ledger.js';

// 固定到周一 20:00（空闲档），避免测试随跑的时刻遇到高峰 2 倍价而红绿不定。
const at = Date.parse('2026-03-02T20:00:00+08:00');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-token-feature-'));
const ledgerFile = path.join(tmpDir, 'token-usage.jsonl');

const usage = (inputTokens, outputTokens, cacheReadTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens });
const evMsg = (seq, turn, step, u) => ({ seq, time: at, type: 'assistant/message', data: { turn, step, usage: u } });

// sessionId → 功能档位（模拟 bridge 反查 sessions.json）
const FEATURES = new Map([
  ['s-chat-basic', 'chat:basic'],
  ['s-chat-adv', 'chat:advanced'],
  ['s-sticker', 'sticker:basic'],
  ['s-vision', 'vision:advanced'],
  ['s-voice', 'voice:advanced'],
  ['s-web', 'web:advanced'],
  ['s-legacy-vision', 'vision:advanced'],
]);
const resolveFeature = (sid) => FEATURES.get(sid);

function freshLedger(opts = {}) {
  try { fs.unlinkSync(ledgerFile); } catch {}
  return createTokenLedger({
    file: ledgerFile,
    priceTable: DEFAULT_PRICE_TABLE,
    resolveKey: (sid) => (sid.startsWith('s-') ? 'group:1' : undefined),
    resolveFeature,
    ...opts,
  });
}

// ── 1) 五套会话各摄入一轮真实形态的 usage ─────────────────────────────────
let ledger = freshLedger();
const rounds = [
  ['s-chat-basic', evMsg(10, 1, 1, usage(1000, 100))],
  ['s-chat-basic', evMsg(11, 1, 2, usage(400, 40))],
  ['s-chat-adv', evMsg(12, 1, 1, usage(2000, 200))],
  ['s-sticker', evMsg(13, 1, 1, usage(300, 20))],
  ['s-vision', evMsg(14, 1, 1, usage(5000, 500))],
  ['s-vision', evMsg(15, 2, 1, usage(600, 60))],
  ['s-voice', evMsg(16, 1, 1, usage(700, 80))],
  ['s-web', evMsg(17, 1, 1, usage(900, 90))],
  ['s-unknown', evMsg(18, 1, 1, usage(50, 5))], // 不在映射里 → unknown
];
for (const [sid, event] of rounds) {
  assert.equal(ledger.ingestEvent({ sessionId: sid, event }), true, `摄入 ${sid} seq=${event.seq}`);
}

const byFeature = ledger.byFeature({
  featureList: ['chat', 'sticker', 'vision', 'voice', 'web'].map((feature) => ({ feature, label: feature })),
});
const summary = ledger.summary();

const expectedTokens = {
  chat: 1000 + 100 + 400 + 40 + 2000 + 200, // chat:basic 两轮 + chat:advanced 一轮
  sticker: 300 + 20,
  vision: 5000 + 500 + 600 + 60,
  voice: 700 + 80,
  web: 900 + 90,
  unknown: 50 + 5,
};
const featureMap = Object.fromEntries(byFeature.features.map((row) => [row.feature, row]));
for (const [feature, tokens] of Object.entries(expectedTokens)) {
  assert.ok(featureMap[feature], `必须出现功能域 ${feature}`);
  assert.equal(featureMap[feature].totalTokens, tokens, `${feature} token 数应等于各会话之和`);
}
assert.equal(byFeature.totals.totalTokens, Object.values(expectedTokens).reduce((a, b) => a + b, 0), '总 token = 各功能域之和');
// 五域内占比：分母排除 unknown（旧会话/内部任务会把 5 套功能的占比压到失真）。
const attributedExpected = Object.entries(expectedTokens).filter(([feature]) => feature !== 'unknown')
  .reduce((sum, [, tokens]) => sum + tokens, 0);
assert.equal(featureMap.unknown.share, null, 'unknown 不参与五域百分比');
assert.ok(Math.abs(featureMap.vision.share - expectedTokens.vision / attributedExpected) < 1e-9,
  `vision 占比应在五域内归一（实得 ${featureMap.vision.share}）`);
assert.ok(Math.abs(featureMap.unknown.shareOfAll - expectedTokens.unknown / byFeature.totals.totalTokens) < 1e-9,
  'unknown 用 shareOfAll 表示「占全部 token」备查');
const shareSum = byFeature.features.filter((row) => row.feature !== 'unknown').reduce((sum, row) => sum + row.share, 0);
assert.ok(Math.abs(shareSum - 1) < 1e-9, `五域占比之和必须 = 1（实得 ${shareSum}）`);
assert.deepEqual(byFeature.features.map((row) => row.feature), ['chat', 'sticker', 'vision', 'voice', 'web', 'unknown'],
  '功能域按固定顺序输出，unknown 最后');

// 轮次：同一 session 的两个 turn 记 2 轮，同一 turn 的两个 step 只记 1 轮
assert.equal(featureMap.chat.turns, 2, 'chat 两个 turn（basic 1 + advanced 1）');
assert.equal(featureMap.chat.steps, 3, 'chat 三次计费请求（basic 2 + advanced 1）');
assert.equal(featureMap.vision.turns, 2, 'vision 两个 turn');

// ── 2) 基础 / 进阶拆分 ────────────────────────────────────────────────────
assert.equal(featureMap.chat.levels.basic.totalTokens, 1000 + 100 + 400 + 40, 'chat:basic 进基础档');
assert.equal(featureMap.chat.levels.advanced.totalTokens, 2000 + 200, 'chat:advanced 进进阶档');
assert.equal(featureMap.sticker.levels.basic.totalTokens, 300 + 20, 'sticker 固定基础档');
assert.equal(featureMap.vision.levels.advanced.totalTokens, 5000 + 500 + 600 + 60, 'vision 固定进阶档');
assert.equal(byFeature.totals.levels.basic.totalTokens,
  (1000 + 100 + 400 + 40) + (300 + 20), '基础档合计 = chat:basic + sticker');
assert.equal(byFeature.totals.levels.advanced.totalTokens,
  (2000 + 200) + (5000 + 500 + 600 + 60) + (700 + 80) + (900 + 90), '进阶档合计 = chat:advanced + vision + voice + web');
assert.equal(byFeature.totals.levels.unknown.totalTokens, 50 + 5, '无法归属的进 unknown 档');
// 五域口径的「基础/进阶对比」：同样排除 unknown，才是 5 套功能的真实分工。
assert.equal(byFeature.attributed.totalTokens, attributedExpected, 'attributed 总量 = 五域之和');
assert.equal(byFeature.attributed.levels.basic.totalTokens,
  (1000 + 100 + 400 + 40) + (300 + 20), '五域基础档 = chat:basic + sticker');
assert.equal(byFeature.attributed.levels.advanced.totalTokens,
  (2000 + 200) + (5000 + 500 + 600 + 60) + (700 + 80) + (900 + 90), '五域进阶档 = chat:advanced + vision + voice + web');

// ── 3) 与 summary 的权威总量自洽（全时段口径） ────────────────────────────
assert.equal(byFeature.totals.totalTokens, summary.totals.totalTokens, 'byFeature 总量必须等于 summary 总量');
assert.ok(Math.abs(byFeature.totals.cost - summary.totals.cost) < 1e-9, 'byFeature 花费必须等于 summary 花费');
assert.ok(Math.abs(byFeature.totals.cacheHitRate - summary.totals.cacheHitRate) < 1e-9, '缓存命中率口径一致');

// ── 4) 落盘带 f：重启后不依赖 resolveFeature 也能分账 ─────────────────────
const raw = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.ok(raw.length >= rounds.length, '逐轮采样都应落盘');
// 有功能映射的会话必须带 f；映射不到的（s-unknown）允许没有 f（进 unknown）。
assert.ok(raw.every((record) => record.k !== 'turn' || !FEATURES.has(record.sid) || typeof record.f === 'string'),
  '新日志的 turn 行必须带 f 功能档位');
const reloadedNoResolver = createTokenLedger({ file: ledgerFile, priceTable: DEFAULT_PRICE_TABLE });
const reloadedFeatures = reloadedNoResolver.byFeature();
assert.equal(reloadedFeatures.features.find((r) => r.feature === 'vision')?.totalTokens, expectedTokens.vision,
  '重启后仅靠落盘 f 也能还原 vision 分账');

// ── 5) 旧日志没有 f：用 resolveFeature 回填 ───────────────────────────────
{
  try { fs.unlinkSync(ledgerFile); } catch {}
  const legacyLines = [
    { k: 'turn', t: at, sid: 's-legacy-vision', key: 'group:1', seq: 100, turn: 1, step: 1, retry: 0, model: 'deepseek-flash', provider: 'deepseek-account', b: { cacheMiss: 800, cacheHit: 0, cacheWrite: 0, output: 80, reasoning: 0 } },
    { k: 'turn', t: at, sid: 's-ancient', key: 'group:1', seq: 101, turn: 1, step: 1, retry: 0, model: 'deepseek-flash', provider: 'deepseek-account', b: { cacheMiss: 200, cacheHit: 0, cacheWrite: 0, output: 20, reasoning: 0 } },
  ];
  fs.writeFileSync(ledgerFile, legacyLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const legacy = createTokenLedger({ file: ledgerFile, priceTable: DEFAULT_PRICE_TABLE, resolveFeature });
  const legacyFeatures = legacy.byFeature();
  const legacyVision = legacyFeatures.features.find((r) => r.feature === 'vision');
  assert.ok(legacyVision && legacyVision.totalTokens === 880, '旧日志按 resolveFeature 回填到 vision');
  const legacyUnknown = legacyFeatures.features.find((r) => r.feature === 'unknown');
  assert.ok(legacyUnknown && legacyUnknown.totalTokens === 220, '查不到的旧会话进 unknown，不冒充功能域');
}

// ── 6) since 时间窗：只算窗口内采样 ──────────────────────────────────────
{
  ledger = freshLedger();
  ledger.ingestEvent({ sessionId: 's-vision', event: { seq: 20, time: at - 60_000, type: 'assistant/message', data: { turn: 1, step: 1, usage: usage(1000, 100) } } });
  ledger.ingestEvent({ sessionId: 's-vision', event: { seq: 21, time: at, type: 'assistant/message', data: { turn: 2, step: 1, usage: usage(2000, 200) } } });
  const windowed = ledger.byFeature({ since: at - 1000 });
  const visionWindow = windowed.features.find((r) => r.feature === 'vision');
  assert.equal(visionWindow.totalTokens, 2200, 'since 窗口只统计窗口内那一轮');
  assert.equal(visionWindow.turns, 1);
  assert.equal(windowed.features.reduce((s, r) => s + (r.share || 0), 0), 1, '窗口内五域份额仍归一化为 1');
}

// ── 7) 未使用的功能域也要出 0 行（控制台表格不能缺行）──────────────────────
{
  ledger = freshLedger();
  ledger.ingestEvent({ sessionId: 's-chat-basic', event: evMsg(30, 1, 1, usage(100, 10)) });
  const seeded = ledger.byFeature({
    featureList: ['chat', 'sticker', 'vision', 'voice', 'web'].map((feature) => ({ feature, label: feature })),
  });
  assert.deepEqual(seeded.features.map((row) => row.feature), ['chat', 'sticker', 'vision', 'voice', 'web'],
    '没有用量的功能域也要出 0 行，且顺序固定');
  for (const feature of ['sticker', 'vision', 'voice', 'web']) {
    const row = seeded.features.find((item) => item.feature === feature);
    assert.equal(row.totalTokens, 0, `${feature} 本期无用量应为 0`);
    assert.equal(row.share, 0, `${feature} 占比应为 0（不是 null：已归属但没花钱）`);
  }
  assert.equal(seeded.attributed.totalTokens, 110, '五域总量只算已归属');
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log('PASS 功能分账：五域拆分 / 基础进阶对比 / 份额归一 / 旧日志回填 / 时间窗口径');
