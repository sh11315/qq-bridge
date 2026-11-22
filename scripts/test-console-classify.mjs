#!/usr/bin/env node
// 回归测试：console/server.mjs 的日志级别分类（classify）
//
// 背景（2026-10-28）：NapCat 的日志带 ANSI 颜色码，例如
//   [\x1b[33mwarn\x1b[39m] 小雪喵～ | 方法1查询失败，序号: 909, 消息数: 0
// 旧版 classify 的显式级别正则没剥 ANSI，导致匹配不到 warn，再被
// 「失败」关键词兜底误判成 error，控制台「最近错误/告警」出现假告警。
// 本测试从源码里抽出 classify 纯函数执行，锁定该行为，防止回归。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'console', 'server.mjs');
const ESC = '\u001b';

let fail = 0;
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const src = fs.readFileSync(SERVER, 'utf8');
const start = src.indexOf('function classify(text) {');
const end = src.indexOf('\nfunction pushLog(', start);
if (start < 0 || end < 0) {
  console.error('❌ 找不到 classify()：console/server.mjs 结构变了，请更新本测试的提取逻辑');
  process.exit(1);
}
const sandbox = {};
vm.runInNewContext(`${src.slice(start, end)}\nthis.classify = classify;`, sandbox);
const classify = sandbox.classify;

console.log('## ANSI 彩色级别不再被误判');
ok('彩色 warn + 「失败」→ warn',
  classify(`10-28 11:53:10 [${ESC}[33mwarn${ESC}[39m] 小雪喵～ | 方法1查询失败，序号: 402909, 消息数: 0`) === 'warn');
ok('彩色 error → error',
  classify(`10-28 11:53:10 [${ESC}[31merror${ESC}[39m] 连接失败`) === 'error');
ok('彩色 info + 聊天里带「失败」→ info',
  classify(`10-28 11:53:10 [${ESC}[32minfo${ESC}[39m] 接收 <- 群聊 这游戏真失败`) === 'info');
ok('无颜色 [warn] + 「失败」→ warn',
  classify('10-28 11:53:10 [warn] 方法1查询失败') === 'warn');
ok('无颜色 [error] → error',
  classify('10-28 11:53:10 [error] 方法1查询失败') === 'error');

console.log('## 原有兜底行为保持不变');
ok('QQ 消息收发里的「失败」不算错误',
  classify('接收 <- 群聊 这游戏真失败') === 'info');
ok('无级别关键词「连接失败」→ error',
  classify('普通一条没有级别的报错：连接失败') === 'error');
ok('已知良性 SnowLuma 断连 → debug',
  classify('SnowLuma 连接断开（code=1006），重连中…') === 'debug');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
