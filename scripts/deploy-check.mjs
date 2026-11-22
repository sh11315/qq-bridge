#!/usr/bin/env node
/**
 * deploy-check — 部署前置条件自检（只读，不改任何文件/配置）。
 *
 * 给「另一个 DSH 实例」执行部署 playbook 用的机器可读闸门：
 *   node scripts/deploy-check.mjs           # 人类可读
 *   node scripts/deploy-check.mjs --json    # 机读 JSON
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL；2 = 脚本自身异常。
 * 约定：每个检查项都有 id / ok / detail；FAIL 时 detail 里给下一步该做什么。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const JSON_OUT = process.argv.includes('--json');

const checks = [];
const add = (id, ok, detail, hint = '') => checks.push({ id, ok, detail, ...(hint ? { hint } : {}) });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function httpGet(url, timeoutMs = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return { status: res.status, ok: res.ok };
  } catch (e) {
    return { error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  // 1. Node 版本
  const [maj, min] = process.versions.node.split('.').map(Number);
  add('node.version', maj > 22 || (maj === 22 && min >= 13),
    `node ${process.versions.node}`, '升级到 Node.js >= 22.13.0');

  // 2. 仓库根与 package.json
  const pkg = readJson(path.join(ROOT, 'package.json'));
  add('repo.package', Boolean(pkg?.name === 'qq-bridge'),
    pkg ? `package ${pkg.name}@${pkg.version}` : 'package.json 读不到',
    '确认当前目录是 qq-bridge 仓库根');

  // 3. config.json
  const cfgPath = path.join(ROOT, 'config.json');
  const cfg = readJson(cfgPath);
  add('config.exists', Boolean(cfg), cfg ? 'config.json 可解析' : 'config.json 缺失或不是合法 JSON',
    'cp config.example.json config.json 后填写');

  // 4. ownerQQ
  const owner = String(cfg?.ownerQQ || '').trim();
  add('config.ownerQQ', /^\d{5,12}$/.test(owner), owner ? `ownerQQ=${owner}` : 'ownerQQ 未设置',
    '只允许数字 QQ 号；只有 owner 回合有本地工具权限');

  // 5. 白名单
  const allow = cfg?.allow || {};
  const allowCount = (allow.private?.length || 0) + (allow.groups?.length || 0);
  const allowAll = cfg?.allowAllWhenEmpty === true;
  add('config.allow', allowCount > 0 || allowAll,
    `private=${allow.private?.length || 0} groups=${allow.groups?.length || 0} allowAllWhenEmpty=${allowAll}`,
    '白名单为空且 allowAllWhenEmpty=false 时桥接谁都不理；用 qq-admin whitelist add-* 添加');

  // 6. DSH Web API
  const dshBase = String(cfg?.dsh?.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const dsh = await httpGet(dshBase + '/');
  add('dsh.reachable', Boolean(dsh.status) && dsh.status < 500,
    dsh.error ? `连接失败: ${dsh.error}` : `HTTP ${dsh.status}`,
    '先启动 DeepSeek Harness（默认 127.0.0.1:3080）');

  // 7. SnowLuma 网关（HTTP + WS 端口）
  const sl = cfg?.snowluma || {};
  const httpUrl = String(sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const napcat = await httpGet(httpUrl + '/');
  add('snowluma.http', Boolean(napcat.status) && napcat.status < 500,
    napcat.error ? `连接失败: ${napcat.error}` : `HTTP ${napcat.status}`,
    '启动 SnowLuma / NapCat，确认 OneBot HTTP 端口');

  // 8. 控制台
  const consolePort = cfg?.unifiedConsole?.port || 7788;
  const consoleBase = process.env.QQB_CONSOLE_BASE || `http://127.0.0.1:${consolePort}`;
  const health = await httpGet(consoleBase + '/api/health');
  add('console.health', Boolean(health.status) && health.status < 500,
    health.error ? `连接失败: ${health.error}` : `HTTP ${health.status} (${consoleBase})`,
    '起统一控制台（start-console.bat / npm run console）');

  // 9. state 目录可写
  const stateDir = path.join(ROOT, 'state');
  let writable = false;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const probe = path.join(stateDir, '.deploy-check.tmp');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    writable = true;
  } catch { /* 保持 false */ }
  add('state.writable', writable, stateDir, '检查目录权限，或跑 npm run harden-acl');

  // 10. 记忆 vault
  const vault = path.join(stateDir, 'memory-vault');
  add('memory.vault', fs.existsSync(vault) || fs.existsSync(path.join(stateDir, 'agents')),
    fs.existsSync(vault) ? 'memory-vault 存在' : 'memory-vault 未创建（首次运行会自动建）',
    '首次启动桥接即可生成');

  const failed = checks.filter((c) => !c.ok);
  const out = {
    ok: failed.length === 0,
    root: ROOT,
    node: process.versions.node,
    failed: failed.map((c) => c.id),
    checks,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`deploy-check @ ${ROOT}`);
    for (const c of checks) {
      console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(18)} ${c.detail}${c.ok ? '' : `\n      → ${c.hint || '需人工检查'}`}`);
    }
    console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED: ${failed.map((c) => c.id).join(', ')}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('deploy-check 内部错误:', e?.message || e);
  process.exit(2);
});
