#!/usr/bin/env node
// 校验 docs/操控台详细说明.md 与代码/配置是否一致。
// 用法：node scripts/check-console-doc.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', '操控台详细说明.md');
const UI = path.join(ROOT, 'console', 'ui.html');
const CONFIG = path.join(ROOT, 'config.json');
const CAP = path.join(ROOT, 'state', 'model-capabilities.json');
const COMPOSE = path.join(ROOT, 'napcat', 'docker', 'compose.yaml');

const errors = [];
const warns = [];
const pass = [];
const fail = (m) => errors.push(m);
const warn = (m) => warns.push(m);
const ok = (m) => pass.push(m);

const doc = fs.readFileSync(DOC, 'utf8');
const lines = doc.split(/\r?\n/);

// 1) 代码块配对
const fences = lines.filter((l) => /^\s*```/.test(l)).length;
fences % 2 === 0 ? ok(`代码块闭合（${fences} 个标记）`) : fail(`代码块未闭合：${fences} 个 \`\`\` 标记`);

// 2) 标题与引用
const headings = new Set();
let currentH3 = '';
for (const line of lines) {
  let m = /^###\s+(\d+\.\d+(?:\.\d+)?)\s/.exec(line);
  if (m) { currentH3 = m[1]; headings.add(m[1]); continue; }
  m = /^####\s+([①②③④⑤⑥⑦⑧⑨⑩])\s/.exec(line);
  if (m && currentH3) { headings.add(`${currentH3}-${m[1]}`); continue; }
  m = /^#{2,3}\s+(\d+(?:\.\d+)*)\s/.exec(line);
  if (m) { currentH3 = m[1]; headings.add(m[1]); }
}

const inFence = new Array(lines.length).fill(false);
{
  let inside = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence[i] = true; inside = !inside; return; }
    inFence[i] = inside;
  });
}
const refRe = /(?<![\d.])4\.\d+(?:-[①②③④⑤⑥⑦⑧⑨⑩])?|(?<![\d.])5\.\d+/g;
const missingRefs = new Set();
lines.forEach((line, i) => {
  if (inFence[i] || /https?:\/\//.test(line)) return;
  for (const ref of line.match(refRe) || []) {
    if (!headings.has(ref)) missingRefs.add(`${ref}（第 ${i + 1} 行）`);
  }
});
missingRefs.size
  ? fail(`引用了不存在的章节：${[...missingRefs].join('、')}`)
  : ok(`章节引用全部可解析（${headings.size} 个标题）`);

// 3) 表格列数一致
let tableBlock = [];
const badTables = [];
const flushTable = () => {
  if (tableBlock.length < 2) { tableBlock = []; return; }
  const counts = tableBlock.map((t) => (t.text.match(/\|/g) || []).length);
  if (new Set(counts).size > 1) badTables.push(`第 ${tableBlock[0].line} 行起的表格列数不一致：${[...new Set(counts)].join('/')}`);
  tableBlock = [];
};
lines.forEach((line, i) => {
  if (/^\s*\|/.test(line)) tableBlock.push({ line: i + 1, text: line });
  else flushTable();
});
flushTable();
badTables.length ? fail(`表格结构异常：${badTables.join('；')}`) : ok('表格列数一致');

// 3.1) 帮助页渲染器兼容（renderMarkdown 按 | 直接拆列，且先 esc 再处理反引号）
const escapedPipes = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /\\\|/.test(l));
escapedPipes.length
  ? fail(`表格里有 \\| 转义竖线（会被渲染器拆成多列）：第 ${escapedPipes.map(([n]) => n).join('、')} 行`)
  : ok('表格无 \\| 转义竖线');
const rawHtml = lines.map((l, i) => [i + 1, l]).filter(([i, l]) => !inFence[i] && /<(code|b|i|br|span|div|table|thead|tbody|tr|td|th)\b/i.test(l));
rawHtml.length
  ? warn(`正文/表格里有原生 HTML 标签（renderMarkdown 会转义成字面量）：第 ${rawHtml.map(([n]) => n).join('、')} 行`)
  : ok('无会被转义的原生 HTML 标签');

// 4) 页面数 vs ui.html PAGES
const ui = fs.readFileSync(UI, 'utf8');
const pageIds = [...ui.matchAll(/\{\s*id:\s*'([a-z0-9-]+)',\s*group:/g)].map((m) => m[1]);
const pageCount = pageIds.length;
const docCount = Number(/页面详解（(\d+) 个页面）/.exec(doc)?.[1] || 0);
docCount === pageCount
  ? ok(`页面数一致：${pageCount}`)
  : fail(`页面数不一致：ui.html=${pageCount}，文档=${docCount}`);
for (const id of pageIds) {
  if (!doc.includes(`#page-${id}`) && !doc.includes(` ${id}（`) && !doc.includes(`（${id}）`) && !doc.includes(`（${id}`) && !doc.includes(`\`${id}\``)) {
    warn(`文档可能未介绍页面 id：${id}`);
  }
}

// 5) 关键数值断言
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const pro = cfg.socialV2?.proactive ?? {};
const tun = cfg.socialV2?.tuning ?? {};
const chain = cfg.dsh?.chain ?? {};
const restartPolicy = fs.readFileSync(COMPOSE, 'utf8').match(/restart:\s*(\S+)/)?.[1] ?? '';
const cap = JSON.parse(fs.readFileSync(CAP, 'utf8'));

const expect = (cond, label) => cond ? ok(label) : fail(label);
const minutes = (ms) => Math.round(Number(ms) / 60000);

expect(doc.includes(`${minutes(pro.checkIntervalMinMs)}~${minutes(pro.checkIntervalMaxMs)} 分钟`), `主动判定间隔 ${minutes(pro.checkIntervalMinMs)}~${minutes(pro.checkIntervalMaxMs)} 分钟`);
expect(doc.includes(`群聊概率 **${pro.probability}**`), `群聊主动概率 ${pro.probability}`);
expect(doc.includes(`私聊概率 **${pro.privateProbability}**`), `私聊主动概率 ${pro.privateProbability}`);
expect(doc.includes(`群 ${pro.maxPerHourGroup} / 私聊 ${pro.maxPerHourPrivate}`), `每小时上限 ${pro.maxPerHourGroup}/${pro.maxPerHourPrivate}`);
expect(doc.includes(`私聊冷却 **${minutes(pro.privateCooldownMs)} 分钟**`), `私聊冷却 ${minutes(pro.privateCooldownMs)} 分钟`);
expect(tun.groupRotateTokens === 0 && doc.includes('群聊轮换 = `0`'), `群聊轮换当前值 ${tun.groupRotateTokens}（关闭）`);
expect(tun.autoInterrupt === false && doc.includes('autoInterrupt:false'), `自动中断当前值 ${tun.autoInterrupt}`);
expect(doc.includes(`${cfg.socialV2.wait.reserved2MaxMs / 1000} 秒`), `reserved2 等待上限 ${cfg.socialV2.wait.reserved2MaxMs / 1000} 秒`);
expect(doc.includes(`冷却 ${minutes(chain.recoverMs)} 分钟`), `路由链冷却 ${minutes(chain.recoverMs)} 分钟`);
expect(restartPolicy && doc.includes(restartPolicy), `Docker 重启策略 ${restartPolicy}`);
expect(doc.includes(`${cap.stats.toolOk} 个`), `工具可用 ${cap.stats.toolOk}`);
expect(doc.includes(`${cap.stats.visionOk} 个能看`) && doc.includes(`${cap.stats.visionNo} 个不行`), `看图 ${cap.stats.visionOk} 能看 / ${cap.stats.visionNo} 不行`);
expect(doc.includes('15 项'), '基础工具面 15 项');
expect(doc.includes('23 项'), '功能会话 chat 面 23 项开关');
expect(chain.entries.length === 4 && doc.includes('① `deepseek-account/deepseek-flash`'), `路由链条数 ${chain.entries.length}`);

// 6) 旧表述残留
for (const legacy of ['30~90 分钟', '私聊 0.35', '基础 14 项', '19 项页面', '19 个页面', '使用说明 | 本文件（页面内渲染，可搜索） | 4.18']) {
  if (doc.includes(legacy)) fail(`仍存在旧表述：${legacy}`);
}
ok('旧表述残留检查完成');

// 汇总
console.log(`\n文档：${DOC}`);
console.log(`行数：${lines.length}　页面：${pageCount}\n`);
for (const m of pass) console.log(`  ✓ ${m}`);
for (const m of warns) console.log(`  ! ${m}`);
for (const m of errors) console.log(`  ✗ ${m}`);
console.log(`\n结果：${errors.length ? 'FAIL' : 'PASS'}（✓ ${pass.length} / ! ${warns.length} / ✗ ${errors.length}）`);
process.exit(errors.length ? 1 : 0);