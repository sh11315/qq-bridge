#!/usr/bin/env node
// 按 UTF-8 读取 state/bridge.log 尾部，避免 git-bash / cmd 按 GBK 显示成乱码。
// 用法：
//   npm run log:tail                 最近 40 行
//   npm run log:tail -- 100          最近 100 行
//   npm run log:tail -- 200 唤醒      最近 200 行里过滤“唤醒”
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('state', 'bridge.log');
const args = process.argv.slice(2);
const tailCount = Math.max(1, Number(args.find((a) => /^\d+$/.test(a))) || 40);
const keyword = args.find((a) => !/^\d+$/.test(a)) || '';

if (!fs.existsSync(file)) {
  console.error(`找不到日志文件：${file}`);
  process.exit(1);
}
const text = fs.readFileSync(file, 'utf8');
let rows = text.split(/\r?\n/).filter((line) => line.length > 0);
if (keyword) rows = rows.filter((line) => line.includes(keyword));
const out = rows.slice(-tailCount);
process.stdout.write(out.join('\n'));
process.stdout.write('\n');
console.error(`\n[log:tail] 文件 ${file}，共 ${rows.length} 行${keyword ? `（过滤“${keyword}”）` : ''}，显示最后 ${out.length} 行`);