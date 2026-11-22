import assert from 'node:assert/strict';
import {
  categoryOfProcess,
  summarizeSamples,
  formatLifeHint,
  SAMPLE_INTERVAL_MS,
} from '../src/core/life-log.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ❌ ${name} — ${err.message}`);
  }
}

const at = (h, m, day = 31) => Date.UTC(2026, 9, day, h - 8, m, 0); // 东八区
const s = (h, m, cat, idle = 0, day = 31) => ({ at: at(h, m, day), cat, idle });

console.log('日常采样（life-log）单测');

check('进程归类：编辑器→写代码，浏览器→逛网页，游戏→打游戏', () => {
  assert.equal(categoryOfProcess('Code.exe'), 'code');
  assert.equal(categoryOfProcess('chrome.exe'), 'browser');
  assert.equal(categoryOfProcess('steam.exe'), 'game');
  assert.equal(categoryOfProcess('unknownapp.exe'), 'other');
});

check('密码管理器→私事（只按进程名，不读标题）', () => {
  assert.equal(categoryOfProcess('1Password.exe'), 'private');
  assert.equal(categoryOfProcess('KeePass.exe'), 'private');
});

check('连续同类采样合并成一段，时长按 5 分钟/样本', () => {
  const sum = summarizeSamples([
    s(9, 0, 'code'), s(9, 5, 'code'), s(9, 10, 'code'),
    s(9, 15, 'browser'), s(9, 20, 'browser'),
  ]);
  assert.equal(sum.segments.length, 2);
  assert.equal(sum.segments[0].cat, 'code');
  assert.equal(sum.segments[0].minutes, 15);
  assert.equal(sum.segments[1].cat, 'browser');
  assert.equal(sum.segments[1].minutes, 10);
});

check('中间断档超过容差就切成两段（不会假装一直在）', () => {
  const sum = summarizeSamples([s(9, 0, 'code'), s(9, 5, 'code'), s(10, 30, 'code')]);
  assert.equal(sum.segments.length, 2);
});

check('idle ≥ 5 分钟按「不在电脑前」算', () => {
  const sum = summarizeSamples([s(12, 0, 'code', 900)]);
  assert.equal(sum.segments[0].cat, 'away');
  assert.equal(sum.byCat.away, 1);
});

check('提示语只给大体时段，不出现窗口标题/私事', () => {
  const sum = summarizeSamples([
    s(9, 0, 'code'), s(9, 5, 'code'),
    s(10, 0, 'private'),
    s(11, 0, 'browser'), s(11, 5, 'browser'),
  ]);
  const hint = formatLifeHint(sum, { maxChars: 200 });
  assert.match(hint, /09:00–09:10 写代码/);
  assert.match(hint, /11:00–11:10 逛网页/);
  assert.ok(!hint.includes('私事'));
  assert.ok(hint.length <= 200);
});

check('空样本不报错，返回空提示', () => {
  const sum = summarizeSamples([]);
  assert.equal(sum.segments.length, 0);
  assert.equal(formatLifeHint(sum), '');
});

check('采样间隔常量为 5 分钟', () => {
  assert.equal(SAMPLE_INTERVAL_MS, 5 * 60 * 1000);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
