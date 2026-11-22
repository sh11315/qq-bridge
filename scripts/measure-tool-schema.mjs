#!/usr/bin/env node
// 量化每个功能会话实际暴露的工具 schema 体积（每次请求都会随 system prompt 重发）。
// 用法：node scripts/measure-tool-schema.mjs [另一个 MCP server 文件，用于前后对比]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FEATURE_TOOL_FLAGS, FLAG_TO_MCP_TOOLS, SCHEMA_ONLY_HIDDEN_MCP_TOOLS } from '../src/core/feature-sessions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadTools(script) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, script)],
    cwd: ROOT,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'schema-budget', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  const byName = new Map(tools.map((t) => [t.name, Buffer.byteLength(JSON.stringify(t), 'utf8')]));
  return byName;
}

function featureStats(byName, hideSchemaOnly = true) {
  const out = {};
  let sum = 0;
  for (const [feature, flags] of Object.entries(FEATURE_TOOL_FLAGS)) {
    const names = new Set();
    for (const flag of flags) for (const n of FLAG_TO_MCP_TOOLS[flag] || []) if (byName.has(n)) names.add(n);
    // schema-only 隐藏：执行期仍可用，但每次请求不再带它们的 schema。
    if (hideSchemaOnly) for (const hidden of SCHEMA_ONLY_HIDDEN_MCP_TOOLS) names.delete(hidden);
    const bytes = [...names].reduce((n, name) => n + byName.get(name), 0);
    out[feature] = { tools: names.size, bytes };
    sum += bytes;
  }
  return { features: out, avg: Math.round(sum / Math.max(1, Object.keys(out).length)) };
}

const now = await loadTools('src/mcp-snowluma-safe.js');
const totalNow = [...now.values()].reduce((n, b) => n + b, 0);
const statsNow = featureStats(now);

const args = process.argv.slice(2);
const before = args[0] ? await loadTools(args[0]) : null;
const statsBefore = before ? featureStats(before, false) : null;
const totalBefore = before ? [...before.values()].reduce((n, b) => n + b, 0) : 0;

console.log(`全部工具：${now.size} 个 / ${totalNow} 字节${before ? `（改前 ${before.size} 个 / ${totalBefore} 字节，省 ${totalBefore - totalNow}）` : ''}`);
const hiddenBytes = SCHEMA_ONLY_HIDDEN_MCP_TOOLS.reduce((n, name) => n + (now.get(name) || 0), 0);
console.log(`schema-only 隐藏：${SCHEMA_ONLY_HIDDEN_MCP_TOOLS.length} 个 / ${hiddenBytes} 字节（注册仍在，执行期可用）`);
console.log('\n功能会话\t工具数\t字节\t改前字节\t省');
for (const [feature, s] of Object.entries(statsNow.features)) {
  const b = statsBefore?.features?.[feature]?.bytes;
  console.log(`${feature}\t${s.tools}\t${s.bytes}\t${b ?? '-'}\t${b ? b - s.bytes : '-'}`);
}
console.log(`\n平均每域 ${statsNow.avg} 字节（约 ${Math.round(statsNow.avg / 3)} tokens）${statsBefore ? `，改前 ${statsBefore.avg} 字节（省 ${Math.round((statsBefore.avg - statsNow.avg) / 3)} tokens/次）` : ''}`);
console.log('注：实际请求只带当前域的工具（qq-tool-restrict 装配期隐藏其它域），所以按域看才接近真实成本。');