#!/usr/bin/env node
// 任务清单还有没有活（2026-10-31）。
//
// 背景：管理员定规矩——「自动唤醒只给任务清单服务；清单里没活就不用醒」，
// 随后补一条：「清单空了就只在早上 7 点到晚上 11 点这段自动唤醒」。
// 光靠自觉容易醒着空转，所以给一个可执行的判定：读 state/backlog.md，
// 按 `## N. 标题` 切块；块里出现 ✅ 视为已完成，否则算未完成。
//
// 用法：
//   node scripts/backlog-open.mjs          # 人读：未完成条数 + 建议
//   node scripts/backlog-open.mjs --json   # 机读：{"open":2,"done":7,"window":true,"verdict":"work","items":[...]}
//   node scripts/backlog-open.mjs --hour 3 # 指定小时（测试用，默认本机当前小时）
// 退出码：
//   0 = 清单里有活，可以醒着干活
//   3 = 清单空了且不在 07:00–23:00，别醒（夜里不折腾）
//   4 = 清单空了但在 07:00–23:00，醒了只能自检/找点小事，不硬开工
//   2 = 读不到清单
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.QQ_BACKLOG_FILE || path.join(ROOT, 'state', 'backlog.md');
const asJson = process.argv.includes('--json');

// 清单空了以后允许自动唤醒的时段：早 7 点到晚 11 点（含 7，不含 23）。
const WINDOW_START = 7;
const WINDOW_END = 23;

function argHour() {
  const idx = process.argv.indexOf('--hour');
  if (idx === -1) return null;
  const hour = Number(process.argv[idx + 1]);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

let text = '';
try {
  text = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
} catch (error) {
  console.error(`读不到任务清单：${FILE}（${error?.message ?? error}）`);
  process.exit(2);
}

const items = [];
const lines = text.split(/\r?\n/);
let current = null;
for (const line of lines) {
  const head = line.match(/^##\s+(?:第)?\s*(\d+)\s*[.、]\s*(.+)$/);
  if (head) {
    if (current) items.push(current);
    current = { no: Number(head[1]), title: head[2].trim(), body: [] };
    continue;
  }
  if (current) current.body.push(line);
}
if (current) items.push(current);

const result = items.map((item) => {
  const body = item.body.join('\n');
  const done = /✅/.test(body) || /✅/.test(item.title);
  return { no: item.no, title: item.title, done };
});
const open = result.filter((item) => !item.done);

const hour = argHour() ?? new Date().getHours();
const inWindow = hour >= WINDOW_START && hour < WINDOW_END;
const verdict = open.length ? 'work' : inWindow ? 'idle-window' : 'sleep';
const exitCode = { work: 0, 'idle-window': 4, sleep: 3 }[verdict];
const windowText = `${String(WINDOW_START).padStart(2, '0')}:00–${String(WINDOW_END).padStart(2, '0')}:00`;

if (asJson) {
  console.log(
    JSON.stringify({
      open: open.length,
      done: result.length - open.length,
      hour,
      inWindow,
      verdict,
      window: windowText,
      items: result,
    })
  );
} else if (verdict === 'work') {
  console.log(`未完成 ${open.length} 条（共 ${result.length} 条）——醒了就挑一条干：`);
  for (const item of open) console.log(`  ${item.no}. ${item.title}`);
} else if (verdict === 'idle-window') {
  console.log(`清单空着（${result.length} 条全 ✅），现在 ${hour} 点在 ${windowText} 里——可以醒，但别硬开工，自检一下就行。`);
} else {
  console.log(`清单空着（${result.length} 条全 ✅），现在 ${hour} 点不在 ${windowText}——按约定别醒，夜里不折腾。`);
}
process.exit(exitCode);
