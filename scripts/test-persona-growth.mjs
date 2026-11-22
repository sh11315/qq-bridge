// 人格自主成长护栏的离线测试：纯函数、零依赖。
import assert from 'node:assert/strict';
import {
  GROWTH_DEFAULTS,
  decideAutoApprove,
  formatGrowthLog,
  growthTextIsSafe,
  rollDailyCounter,
  sanitizeGrowthText,
} from '../src/core/persona-growth.mjs';

let passed = 0;
let total = 0;
function check(name, fn) {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name, '-', error?.message ?? error);
    process.exitCode = 1;
  }
}

check('sanitizeGrowthText 压平空白并去掉控制字符', () => {
  assert.equal(sanitizeGrowthText('  今天\n有点\t累  '), '今天 有点 累');
  assert.equal(sanitizeGrowthText('a\u0000b\u001fc'), 'abc');
  assert.equal(sanitizeGrowthText(''), '');
  assert.equal(sanitizeGrowthText(null), '');
});

check('sanitizeGrowthText 按上限截断', () => {
  const text = sanitizeGrowthText('长'.repeat(400), 20);
  assert.equal(text.length, 20);
});

check('growthTextIsSafe 挡网址/代码/HTML/命令行', () => {
  assert.equal(growthTextIsSafe('偶尔自嘲一下挺好'), true);
  assert.equal(growthTextIsSafe('看看 https://example.com 这个'), false);
  assert.equal(growthTextIsSafe('用 `rm` 删掉'), false);
  assert.equal(growthTextIsSafe('```js\nconsole.log(1)\n```'), false);
  assert.equal(growthTextIsSafe('<b>加粗</b>'), false);
  assert.equal(growthTextIsSafe('pwsh -Command "dir"'), false);
  assert.equal(growthTextIsSafe('abcdefghijklmnopqrstuvwxyz0123'), false);
});

check('decideAutoApprove 正常放行并返回清洗后的文本', () => {
  const now = Date.now();
  const result = decideAutoApprove({ text: ' 说话可以更随意一点 ', now });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'ok');
  assert.equal(result.text, '说话可以更随意一点');
});

check('decideAutoApprove 各道刹车', () => {
  const now = Date.now();
  assert.equal(decideAutoApprove({ text: '随便说点什么', options: { enabled: false } }).reason, 'growth-disabled');
  assert.equal(decideAutoApprove({ text: '随便说点什么', options: { autoApprove: false } }).reason, 'auto-approve-off');
  assert.equal(decideAutoApprove({ text: '' }).reason, 'empty');
  assert.equal(decideAutoApprove({ text: '嗯' }).reason, 'too-short');
  assert.equal(decideAutoApprove({ text: '去 https://a.b 看看' }).reason, 'unsafe-content');
  assert.equal(decideAutoApprove({ text: '说话可以更随意一点', approvedToday: 3 }).reason, 'daily-cap');
  assert.equal(
    decideAutoApprove({ text: '说话可以更随意一点', lastApprovedAt: now - 60_000, now }).reason,
    'cooldown',
  );
  assert.equal(
    decideAutoApprove({ text: '说话可以更随意一点', lastApprovedAt: now - GROWTH_DEFAULTS.minIntervalMs, now }).ok,
    true,
  );
});

check('rollDailyCounter 跨天归零', () => {
  const now = new Date('2026-11-22T10:00:00+08:00').getTime();
  const same = rollDailyCounter({ day: '2026-11-22', approvedToday: 2, lastApprovedAt: 123 }, now);
  assert.deepEqual(same, { day: '2026-11-22', approvedToday: 2, lastApprovedAt: 123 });
  const next = rollDailyCounter({ day: '2026-11-21', approvedToday: 2, lastApprovedAt: 123 }, now);
  assert.deepEqual(next, { day: '2026-11-22', approvedToday: 0, lastApprovedAt: 123 });
});

check('formatGrowthLog 单行摘要', () => {
  const line = formatGrowthLog({ kind: 'tone', decision: 'approved', text: '说话可以更随意一点' });
  assert.match(line, /tone approved/);
  assert.match(formatGrowthLog({ kind: 'persona', decision: 'skip', reason: 'cooldown' }), /cooldown/);
});

console.log(`\n${passed}/${total} checks passed`);
if (passed !== total) process.exitCode = 1;
