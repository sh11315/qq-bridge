// 跨功能会话「上轮结论」纯逻辑测试（不碰 DSH / QQ / 生产配置）。
import assert from 'node:assert/strict';
import {
  TURN_SUMMARY_MAX_CHARS,
  TURN_SUMMARY_MARKER,
  normalizeTurnSummaryText,
  summarizeToolNames,
  buildTurnSummary,
  buildCrossSessionLine,
} from '../src/core/turn-summary.mjs';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests += 1;
  try {
    await run();
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

await test('normalizeTurnSummaryText：去 SILENT / Markdown / 换行，保持一行', () => {
  const out = normalizeTurnSummaryText('  [SILENT]\n\n**结论**：这张图是`柯基`\n第二行  ');
  assert.equal(out, '结论：这张图是柯基 第二行');
  assert.ok(!out.includes('\n'));
});

await test('normalizeTurnSummaryText：超长按码点截断，不切半个 emoji，总长不超上限', () => {
  const raw = '🐳'.repeat(200);
  const out = normalizeTurnSummaryText(raw, 10);
  const chars = Array.from(out);
  assert.equal(chars.length, 10);
  assert.equal(chars.at(-1), '…');
  assert.ok(chars.slice(0, -1).every((ch) => ch === '🐳'));
});

await test('normalizeTurnSummaryText：已有「上轮结论：」前缀时去重', () => {
  assert.equal(normalizeTurnSummaryText(`${TURN_SUMMARY_MARKER}已经查过是 42`), '已经查过是 42');
  assert.equal(normalizeTurnSummaryText('上轮结论：'), '');
  assert.equal(normalizeTurnSummaryText('   '), '');
});

await test('summarizeToolNames：去掉 MCP 前缀、去重、按数量截断', () => {
  assert.equal(
    summarizeToolNames(['mcp__snowluma__qq_get_message_images', 'mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_get_message_images']),
    'qq_get_message_images、qq_send_message',
  );
  assert.equal(summarizeToolNames(['a', 'b', 'c'], 2), 'a、b 等 3 个工具');
  assert.equal(summarizeToolNames([]), '');
});

await test('buildTurnSummary：正文 > 发出的消息 > 工具名', () => {
  assert.equal(buildTurnSummary({ text: '正文结论', sentText: '发出的消息', toolNames: ['x'] }), '正文结论');
  assert.equal(buildTurnSummary({ text: '   ', sentText: '发出的消息', toolNames: ['x'] }), '发出的消息');
  assert.equal(buildTurnSummary({ sentText: '', toolNames: ['mcp__snowluma__qq_get_message_images'] }), '本轮调用了 qq_get_message_images');
  assert.equal(buildTurnSummary({}), '');
});

await test('buildTurnSummary：受 maxChars 约束（不把整段回复塞进新 prompt）', () => {
  const out = buildTurnSummary({ text: '啊'.repeat(1000), maxChars: 20 });
  assert.equal(Array.from(out).length, 20);
  assert.equal(TURN_SUMMARY_MAX_CHARS, 160);
});

await test('buildCrossSessionLine：只在功能域变化时返回一行，带中文标记', () => {
  const prev = { feature: 'vision', text: '图里是只柯基，趴在沙发上' };
  const line = buildCrossSessionLine(prev, 'chat', { vision: '看图' });
  assert.equal(line, '【上轮结论 · 来自看图会话】图里是只柯基，趴在沙发上');

  assert.equal(buildCrossSessionLine(prev, 'vision', { vision: '看图' }), '', '同功能会话不重复注入');
  assert.equal(buildCrossSessionLine({ feature: 'vision', text: '' }, 'chat', {}), '', '空摘要不注入');
  assert.equal(buildCrossSessionLine(null, 'chat', {}), '', '没有上一轮不注入');
  assert.equal(buildCrossSessionLine({ feature: 'vision', text: 'x' }, '', {}), '', '目标功能未知不注入');
});

await test('buildCrossSessionLine：标签缺失时回退功能名，长摘要按上限截断', () => {
  assert.equal(buildCrossSessionLine({ feature: 'web', text: '最新价 42' }, 'chat', {}), '【上轮结论 · 来自web会话】最新价 42');
  const line = buildCrossSessionLine({ feature: 'web', text: '好'.repeat(500) }, 'chat', { web: '联网' }, 30);
  assert.ok(Array.from(line).length <= '【上轮结论 · 来自联网会话】'.length + 30);
});

if (failures) {
  console.error(`\n${failures}/${tests} 个用例失败`);
  process.exit(1);
}
console.log(`\n全部 ${tests} 个用例通过`);
