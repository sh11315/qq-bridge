#!/usr/bin/env node
// 工具调用可靠性回归：错误文本、网络失败翻译、等待冲突提示、基础会话工具说明。
// 用法：node scripts/test-tool-errors.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const { buildFeatureHint, FLAG_TO_MCP_TOOLS, SCHEMA_ONLY_HIDDEN_MCP_TOOLS } = await import('../src/core/feature-sessions.mjs');
const { featureSchemaDenyList, globalSchemaDenyList } = await import('../plugins/qq-agent-presets/qq-tool-restrict.mjs');

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

function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`未找到 ${name}`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let params = 0;
  let afterParams = -1;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '(') params += 1;
    else if (src[i] === ')') { params -= 1; if (params === 0) { afterParams = i; break; } }
  }
  if (afterParams < 0) throw new Error(`${name} 参数列表未闭合`);
  let depth = 0;
  for (let i = src.indexOf('{', afterParams); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 未闭合`);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${extractFunction(MCP, 'errorText')}\nthis.errorText = errorText;`, sandbox);

await test('errorText：对象错误不再退化成 [object Object]', () => {
  assert.equal(sandbox.errorText({ code: 500, message: '上游炸了' }), '{"code":500,"message":"上游炸了"}');
  assert.equal(sandbox.errorText(new Error('普通错误')), '普通错误');
  assert.equal(sandbox.errorText('字符串错误'), '字符串错误');
  assert.equal(sandbox.errorText(undefined, '兜底'), '兜底');
  assert.ok(!String(sandbox.errorText({})).includes('[object Object]'));
});

await test('MCP 工具错误拼接已统一走 errorText（无 error?.message ?? error）', () => {
  assert.equal((MCP.match(/error\?\.message \?\? error/g) || []).length, 0);
  assert.ok((MCP.match(/errorText\(error, '未知错误'\)/g) || []).length >= 40);
});

await test('onebot 网络失败有可读提示（连不上 NapCat + 原因 + 下一步）', () => {
  const fn = extractFunction(MCP, 'onebot');
  assert.match(fn, /连不上 NapCat/);
  assert.match(fn, /ECONNREFUSED/);
  assert.match(fn, /NapCat.{0,3}页|容器日志/);
});

await test('桥接发送失败同样翻译网络错误', () => {
  const fn = extractFunction(BRIDGE, 'onebotSend');
  assert.match(fn, /连不上 NapCat/);
  assert.match(fn, /消息未发出/);
});

await test('onebot 实际抛错可读（mock ECONNREFUSED）', async () => {
  const sb = { console };
  vm.createContext(sb);
  vm.runInContext(`${extractFunction(MCP, 'errorText')}\n${extractFunction(MCP, 'onebot')}\nthis.__fn = onebot;`, sb);
  sb.getOneBotConfig = () => ({ httpUrl: 'http://127.0.0.1:3000', token: '' });
  sb.AbortSignal = { timeout: () => null };
  sb.fetch = async () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  };
  await assert.rejects(() => sb.__fn('get_login_info'), (err) => {
    assert.match(err.message, /连不上 NapCat/);
    assert.match(err.message, /连接被拒绝/);
    assert.match(err.message, /容器日志/);
    return true;
  });
});

await test('等待冲突返回可操作提示（不要重复等待）', () => {
  assert.match(BRIDGE, /该会话已有一个等待中的 qq_wait_for_messages（可能正在做沉睡前观察）。不要重复等待/);
  assert.match(BRIDGE, /上次|上一次返回的 newMessages/);
});

await test('基础会话提示与真实工具面对齐（可自己发表情）', () => {
  const hint = buildFeatureHint('chat', 'basic');
  assert.match(hint, /qq_send_sticker/);
  assert.match(hint, /qq_collect_sticker/);
  assert.doesNotMatch(hint, /表情包发送、语音、联网由桥接/);
  // 既有约束不能回退
  assert.match(hint, /qq_get_message_images/);
  assert.match(hint, /引用 msgId/);
  assert.match(hint, /共享同一份/);
});

await test('进阶会话提示仍保留表情/只读看图约束', () => {
  const hint = buildFeatureHint('chat', 'advanced');
  assert.match(hint, /qq_send_sticker/);
  assert.match(hint, /qq_get_message_images/);
});

await test('桥接 401 返回可操作的令牌提示（不只 HTTP 401）', async () => {
  const sb = { console };
  vm.createContext(sb);
  vm.runInContext(`${extractFunction(MCP, 'errorText')}\n${extractFunction(MCP, 'agentApi')}\nthis.__fn = agentApi;`, sb);
  sb.agentHeaders = () => ({});
  sb.agentApiBase = () => 'http://127.0.0.1:3100';
  sb.AbortSignal = { timeout: () => null };
  sb.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });
  await assert.rejects(() => sb.__fn('/api/x'), (err) => {
    assert.match(err.message, /会话令牌无效/);
    assert.match(err.message, /qq_get_prompt/);
    return true;
  });
});

await test('qq_status 连续失败会要求停止试探', () => {
  assert.match(MCP, /statusFailure\.count >= 2/);
  assert.match(MCP, /停止调用 qq_status/);
  assert.match(MCP, /statusFailure\.count = 0/, '成功时要重置失败计数');
});

await test('工具描述总量受控（≤7000 字）且收尾三件套无重复长约束', () => {
  const tools = [...MCP.matchAll(/server\.tool\(\s*'([^']+)',\s*'((?:\\.|[^'])*)'/g)]
    .map((m) => ({ name: m[1], desc: m[2].replace(/\\'/g, "'") }));
  const total = tools.reduce((n, t) => n + t.desc.length, 0);
  assert.ok(total <= 7000, `描述总量 ${total} 字，超过预算`);
  const wait = tools.find((t) => t.name === 'qq_wait_for_messages');
  assert.ok(wait.desc.length <= 620, `wait 描述 ${wait.desc.length} 字`);
  const markRead = tools.find((t) => t.name === 'qq_mark_read');
  assert.doesNotMatch(markRead.desc, /5 分钟内没人说话可/, 'mark_read 不应重复整段观察规则');
  const wake = tools.find((t) => t.name === 'qq_set_wake_config');
  assert.doesNotMatch(wake.desc, /5 分钟内没人说话可/, 'set_wake_config 不应重复整段观察规则');
});

await test('低频工具只从 schema 隐藏，执行期映射仍保留', () => {
  const legacy = ['qq_send_group_message', 'qq_send_private_message', 'qq_memory_clear', 'qq_memory_remove'];
  assert.deepEqual([...SCHEMA_ONLY_HIDDEN_MCP_TOOLS], legacy);
  // 执行期 flag 仍映射这些工具：bridge 的 v2ToolEnabled/guard 不受影响，可显式调用
  const mapped = new Set(Object.values(FLAG_TO_MCP_TOOLS).flat());
  for (const name of legacy) assert.ok(mapped.has(name), `${name} 的执行期映射被误删`);
  for (const feature of ['chat', 'sticker', 'vision', 'voice', 'web']) {
    const deny = featureSchemaDenyList(feature);
    for (const name of legacy) assert.ok(deny.includes(`mcp__snowluma__${name}`), `${feature} 应隐藏 ${name}`);
  }
  const globalDeny = globalSchemaDenyList();
  for (const name of legacy) assert.ok(globalDeny.includes(`mcp__snowluma__${name}`), `全局名单应隐藏 ${name}`);
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部工具调用可靠性用例通过');
process.exit(failed ? 1 : 0);