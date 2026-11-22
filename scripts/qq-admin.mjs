#!/usr/bin/env node
/**
 * qq-admin — 给「小雪喵」用的运维小工具（主人授权后，可在管理员回合通过 pwsh 调用）。
 *
 * 设计原则：
 *  1) 只调控制台已有的 HTTP API（7788），不直接改文件、不碰桥接内部状态；
 *     控制台自己会做备份、热更新、日志记录，出问题也有迹可循。
 *  2) 配置写入走白名单：只允许改 dsh / unifiedConsole / socialV2 / allow / deny /
 *     allowAllWhenEmpty / api / mentionOnly / slang / social / napcat / features
 *     这几棵子树里的非敏感项；token、密码、密钥一律拒绝（避免把凭据写坏）。
 *     刻意不开放：ownerQQ、adminTurnTools（权限本身）、consoleToken/consolePort、
 *     security、pricing、imageGen/webSearch（树里带 apiKey，整树写会把掩码写回）。
 *  3) 所有子命令都支持 --json 便于机读；失败返回非 0 退出码。
 *
 * 用法（在仓库根目录）：
 *   node scripts/qq-admin.mjs status
 *   node scripts/qq-admin.mjs verify
 *   node scripts/qq-admin.mjs config get [dsh.model]
 *   node scripts/qq-admin.mjs config set socialV2.proactive.privateEnabled=true
 *   node scripts/qq-admin.mjs whitelist get
 *   node scripts/qq-admin.mjs whitelist add-group 100000003
 *   node scripts/qq-admin.mjs whitelist rm-group 100000003
 *   node scripts/qq-admin.mjs whitelist add-private 100000001
 *   node scripts/qq-admin.mjs model list
 *   node scripts/qq-admin.mjs model set private:100000001 deepseek-account/deepseek-flash high
 *   node scripts/qq-admin.mjs model clear private:100000001
 *   node scripts/qq-admin.mjs restart dsh|bridge|napcat|workbuddy
 *   node scripts/qq-admin.mjs plugin list|add|remove [包名]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONSOLE_BASE = process.env.QQB_CONSOLE_BASE || 'http://127.0.0.1:7788';

// 允许改的配置子树（不含凭据类字段）。准入应成对：allow/deny/allowAllWhenEmpty 都能改，
// 否则只有「能加白」没有「能拉黑」。纯行为开关（mentionOnly/slang/social）也放开。
export const CONFIG_ROOTS = Object.freeze([
  'dsh',
  'unifiedConsole',
  'socialV2',
  'allow',
  'deny',
  'allowAllWhenEmpty',
  'api',
  'mentionOnly',
  'slang',
  'social',
  'napcat',
  'features',
]);
const SECRET_RE = /token|secret|passw|apikey|api_key|credential|authorization|cookie/i;

export function readConsoleToken(root = ROOT) {
  if (process.env.QQB_CONSOLE_TOKEN) return process.env.QQB_CONSOLE_TOKEN.trim();
  for (const file of ['state/console-token', '.console-token']) {
    try {
      const t = fs.readFileSync(path.join(root, file), 'utf8').trim();
      if (t) return t;
    } catch { /* 继续尝试 */ }
  }
  return '';
}

/** 配置路径是否允许写：只认白名单根，且路径/值里不能出现凭据类字眼。 */
export function isAllowedConfigPath(dotted) {
  const p = String(dotted || '').trim();
  if (!p) return false;
  const parts = p.split('.');
  if (!CONFIG_ROOTS.includes(parts[0])) return false;
  if (SECRET_RE.test(p)) return false;
  return parts.every((seg) => seg && !/[{}[\]]/.test(seg));
}

/** 把 `a.b.c=JSON值` 解析成 [['a.b.c', value]]；值按 JSON 解析，失败则当字符串。 */
export function parseConfigSetArgs(args) {
  const out = [];
  for (const raw of args) {
    const i = String(raw).indexOf('=');
    if (i <= 0) throw new Error(`参数格式应为 path=value：${raw}`);
    const key = raw.slice(0, i).trim();
    if (!isAllowedConfigPath(key)) throw new Error(`不允许修改这个配置项：${key}`);
    const tail = raw.slice(i + 1);
    let value;
    try { value = JSON.parse(tail); } catch { value = tail; }
    out.push([key, value]);
  }
  return out;
}

export function deepSet(target, dotted, value) {
  const parts = dotted.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return target;
}

export function deepGet(target, dotted) {
  const parts = dotted.split('.');
  let cur = target;
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

async function call(pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  const tk = token === undefined ? readConsoleToken() : token;
  if (tk) headers['x-console-token'] = tk;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(CONSOLE_BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 400) }; }
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}：${data?.error || data?.message || text.slice(0, 200)}`);
  return data;
}

function print(title, payload, jsonMode) {
  if (jsonMode) { console.log(JSON.stringify(payload, null, 2)); return; }
  console.log(title ? `== ${title}` : '');
  console.log(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
}

function fail(message, jsonMode) {
  if (jsonMode) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`✗ ${message}`);
  process.exit(1);
}

async function cmdStatus(jsonMode) {
  const st = await call('/api/status');
  const out = {
    ok: Boolean(st?.console?.pid || st?.ok),
    console: st?.console,
    services: st?.services,
    autoHeal: st?.autoHeal,
  };
  print('控制台状态', out, jsonMode);
  if (!jsonMode) {
    const svc = st?.services || {};
    for (const [name, v] of Object.entries(svc)) {
      console.log(`  ${v?.up ? '●' : '○'} ${name}${v?.pid ? ` pid=${v.pid}` : ''}`);
    }
  }
}

async function verify(jsonMode) {
  const st = await call('/api/status');
  let bridge = null;
  try {
    const token = readConsoleToken();
    const res = await fetch('http://127.0.0.1:3100/api/status', { headers: token ? { 'x-console-token': token } : {}, signal: AbortSignal.timeout(8000) });
    bridge = await res.json();
  } catch { bridge = null; }
  const checks = {
    console: Boolean(st?.console?.pid || st?.ok),
    bridgeHttp: Boolean(bridge),
    dshReady: Boolean(bridge?.dshReady),
    mode: bridge?.mode || '',
    snowluma: Boolean(bridge?.snowluma?.good),
  };
  const ok = checks.console && checks.bridgeHttp && checks.dshReady && checks.snowluma;
  print('自检', { ok, checks }, jsonMode);
  if (!ok) process.exit(1);
}

async function configGet(dotted, jsonMode) {
  const { raw } = await call('/api/config/raw');
  const cfg = JSON.parse(raw);
  const value = dotted ? deepGet(cfg, dotted) : cfg;
  print(dotted || 'config', value === undefined ? { ok: false, error: `没有这个配置项：${dotted}` } : value, jsonMode);
  if (value === undefined) process.exit(1);
}

async function configSet(pairs, jsonMode) {
  const parsed = parseConfigSetArgs(pairs);
  const { raw } = await call('/api/config/raw');
  const cfg = JSON.parse(raw);
  const before = {};
  for (const [key, value] of parsed) {
    before[key] = deepGet(cfg, key);
    deepSet(cfg, key, value);
  }
  const saved = await call('/api/config/raw', { method: 'POST', body: { raw: JSON.stringify(cfg, null, 4) } });
  print('配置已保存', { ok: true, changed: parsed.map(([k, v]) => ({ path: k, from: before[k], to: v })), backup: saved?.backup ?? null, note: '部分配置需要重启桥接/DSH 才完全生效' }, jsonMode);
}

async function whitelistGet(jsonMode) {
  const wl = await call('/api/whitelist');
  print('白名单', wl, jsonMode);
}

/** GET 返回嵌套 {allow:{private,groups},deny:{...}}；POST 只认扁平字段，这里做一次转换。 */
export function whitelistPostBody(wl, { action, kind, ids }) {
  const pick = (arr) => (Array.isArray(arr) ? arr.map(String) : []);
  const state = {
    allowPrivate: pick(wl?.allow?.private),
    allowGroups: pick(wl?.allow?.groups),
    denyPrivate: pick(wl?.deny?.private),
    denyGroups: pick(wl?.deny?.groups),
    ownerQQ: String(wl?.ownerQQ ?? ''),
    allowAllWhenEmpty: Boolean(wl?.allowAllWhenEmpty),
  };
  const listKey = kind === 'group' ? 'allowGroups' : 'allowPrivate';
  const set = new Set(state[listKey]);
  for (const id of ids) {
    const s = String(id).trim();
    if (!/^\d{4,12}$/.test(s)) throw new Error(`QQ/群号不合法：${s}`);
    if (action === 'add') set.add(s); else set.delete(s);
  }
  state[listKey] = [...set];
  return state;
}

async function whitelistMutate(action, kind, ids, jsonMode) {
  const wl = await call('/api/whitelist');
  const state = whitelistPostBody(wl, { action, kind, ids });
  const saved = await call('/api/whitelist', { method: 'POST', body: state });
  print(`白名单已更新（${action === 'add' ? '加入' : '移出'}${kind === 'group' ? '群' : '私聊'} ${ids.join(',')}）`, { ok: true, saved: saved?.ok ?? saved, now: state }, jsonMode);
}

async function modelList(jsonMode) {
  const pol = await call('/api/session-policy');
  print('模型与会话覆盖', { globals: pol?.globals, conversations: pol?.conversations, defaults: pol?.defaults }, jsonMode);
}

async function modelSet(key, model, effort, jsonMode) {
  if (!/^(group|private):\d{4,12}$/.test(String(key || ''))) throw new Error('key 应为 group:群号 或 private:QQ号');
  let body = { key };
  if (model) {
    const slash = model.indexOf('/');
    if (slash > 0) { body.provider = model.slice(0, slash); body.model = model.slice(slash + 1); }
    else body.model = model;
  }
  if (effort) body.reasoningEffort = effort;
  const r = await call('/api/session-policy', { method: 'POST', body });
  print('会话模型覆盖已保存（只作用于基础回合；进阶回合仍按内容自动切）', { ok: true, policy: r?.policy ?? r }, jsonMode);
}

async function modelClear(key, jsonMode) {
  const r = await call('/api/session-policy/delete', { method: 'POST', body: { key } });
  print('已清除该会话的模型覆盖', { ok: true, result: r }, jsonMode);
}

async function restart(name, jsonMode) {
  if (!['dsh', 'bridge', 'napcat', 'workbuddy'].includes(name)) throw new Error('只能重启 dsh / bridge / napcat / workbuddy');
  const r = await call(`/api/service/${name}/restart`, { method: 'POST', body: {} });
  print(`已请求重启 ${name}`, { ok: true, result: r }, jsonMode);
}

function plugin(cmd, pkg, jsonMode) {
  const dshCmd = process.env.QQB_DSH_CMD || 'dsh';
  const base = [dshCmd, 'plugin', '--profile', 'web'];
  let out = '';
  try {
    if (cmd === 'list') out = execFileSync(base[0], [...base.slice(1), 'list'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    else if (cmd === 'add' && pkg) out = execFileSync(base[0], [...base.slice(1), 'add', pkg], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
    else if (cmd === 'remove' && pkg) out = execFileSync(base[0], [...base.slice(1), 'remove', pkg], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
    else throw new Error('用法：plugin list | plugin add <包名> | plugin remove <包名>');
  } catch (err) {
    throw new Error(`dsh plugin ${cmd} 失败：${(err.stdout || err.message || '').toString().slice(0, 1200)}`);
  }
  print(`插件 ${cmd}`, out.slice(-4000), jsonMode);
}

async function main(argv) {
  const jsonMode = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const [cmd, sub, ...rest] = args;
  try {
    if (cmd === 'status') return await cmdStatus(jsonMode);
    if (cmd === 'verify') return await verify(jsonMode);
    if (cmd === 'config' && sub === 'get') return await configGet(rest[0], jsonMode);
    if (cmd === 'config' && sub === 'set') return await configSet(rest, jsonMode);
    if (cmd === 'whitelist' && sub === 'get') return await whitelistGet(jsonMode);
    if (cmd === 'whitelist' && (sub === 'add-group' || sub === 'rm-group')) return await whitelistMutate(sub === 'add-group' ? 'add' : 'rm', 'group', rest, jsonMode);
    if (cmd === 'whitelist' && (sub === 'add-private' || sub === 'rm-private')) return await whitelistMutate(sub === 'add-private' ? 'add' : 'rm', 'private', rest, jsonMode);
    if (cmd === 'model' && sub === 'list') return await modelList(jsonMode);
    if (cmd === 'model' && sub === 'set') return await modelSet(rest[0], rest[1], rest[2], jsonMode);
    if (cmd === 'model' && sub === 'clear') return await modelClear(rest[0], jsonMode);
    if (cmd === 'restart') return await restart(String(sub || ''), jsonMode);
    if (cmd === 'plugin') return plugin(sub, rest[0], jsonMode);
    fail('用法：status | verify | config get/set | whitelist ... | model ... | restart <服务> | plugin ...', jsonMode);
  } catch (err) {
    fail(err?.message || String(err), jsonMode);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.argv.slice(2));
