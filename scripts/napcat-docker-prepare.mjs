#!/usr/bin/env node
/**
 * napcat-docker-prepare.mjs —— 生成 NapCat Docker 的挂载目录与配置副本（幂等，可重复跑）。
 *
 * 为什么要复制一份配置、而不是直接把 framework 的 config 挂进容器：
 *   1) 宿主机 Framework 模式与容器模式要能随时来回切，两边配置互不污染；
 *   2) 容器里 NapCat 只监听 127.0.0.1 的话，宿主机的 `-p 127.0.0.1:3000:3000`
 *      端口映射是转发到容器 IP 的，连不上 → 必须把 OneBot HTTP/WS 与 WebUI 的
 *      host 改成 0.0.0.0（容器内网卡），映射才能通；
 *   3) 同时写一份不带 uin 的 `onebot11.json`：NapCat 首次登录前还不知道 uin，
 *      会用默认配置兜底；登录后读 `onebot11_<uin>.json`。
 *
 * 产出：
 *   napcat/docker/config/    ← 挂到容器 /app/napcat/config
 *   napcat/docker/qq/        ← 挂到容器 /app/.config/QQ（登录态/设备指纹，保登录）
 *   napcat/docker/plugins/   ← 挂到容器 /app/napcat/plugins
 *
 * 用法：node scripts/napcat-docker-prepare.mjs
 * 选项：--from <dir>  指定源配置目录（默认 napcat/framework/config，回退 napcat/shell-4.18.38/napcat/config）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKER_DIR = path.join(ROOT, 'napcat', 'docker');
const DEST_CONFIG = path.join(DOCKER_DIR, 'config');

function resolveUin() {
  const env = String(process.env.QQB_NAPCAT_QQ || '').trim();
  if (/^\d{5,12}$/.test(env)) return env;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    const uin = String(JSON.parse(raw)?.unifiedConsole?.napcatQQ || '').trim();
    if (/^\d{5,12}$/.test(uin)) return uin;
  } catch {}
  return '';
}

const UIN = resolveUin();
if (!UIN) {
  console.error('[prepare][x] 找不到机器人 QQ：先把 config.example.json 复制为 config.json 并填 unifiedConsole.napcatQQ，或设置环境变量 QQB_NAPCAT_QQ');
  process.exit(1);
}

const FILES = [
  `onebot11_${UIN}.json`,
  'napcat.json',
  `napcat_${UIN}.json`,
  'webui.json',
  'plugins.json',
  `napcat_protocol_${UIN}.json`,
  'passkey.json',
];

function log(msg) { console.log(`[prepare] ${msg}`); }
function fail(msg) { console.error(`[prepare][x] ${msg}`); process.exit(1); }

function pickSourceDir() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--from');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const candidates = [
    path.join(ROOT, 'napcat', 'framework', 'config'),
    path.join(ROOT, 'napcat', 'shell-4.18.38', 'napcat', 'config'),
  ];
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, `onebot11_${UIN}.json`)));
  if (!found) fail(`找不到现有 OneBot 配置（试过：${candidates.join(' / ')}）`);
  return found;
}

/** 深拷贝并改写监听地址：容器内必须监听 0.0.0.0。 */
function bindAll(obj) {
  const out = structuredClone(obj);
  const net = out.network ?? {};
  for (const key of ['httpServers', 'httpSseServers', 'websocketServers']) {
    for (const item of net[key] ?? []) {
      if (typeof item.host === 'string' && /^(127\.0\.0\.1|localhost|::1)$/i.test(item.host)) item.host = '0.0.0.0';
    }
  }
  return out;
}

function readJson(file) {
  try {
    // 老配置是 PowerShell 5.1 写的，可能带 UTF-8 BOM；JSON.parse 不接受 BOM
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (err) { fail(`${file} 解析失败：${err.message}`); }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
}

function main() {
  const srcDir = pickSourceDir();
  log(`源配置目录：${srcDir}`);

  fs.mkdirSync(DEST_CONFIG, { recursive: true });
  fs.mkdirSync(path.join(DOCKER_DIR, 'qq'), { recursive: true });
  fs.mkdirSync(path.join(DOCKER_DIR, 'plugins'), { recursive: true });

  for (const name of FILES) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) { log(`跳过（源里没有）：${name}`); continue; }
    const dest = path.join(DEST_CONFIG, name);
    if (name.startsWith('onebot11')) {
      writeJson(dest, bindAll(readJson(src)));
      // 不带 uin 的默认配置：登录前 NapCat 用它兜底（内容与带 uin 的一致）
      if (name === `onebot11_${UIN}.json`) writeJson(path.join(DEST_CONFIG, 'onebot11.json'), bindAll(readJson(src)));
    } else if (name === 'webui.json') {
      const cfg = readJson(src);
      cfg.host = '0.0.0.0'; // 容器内监听全部网卡，宿主机 127.0.0.1:6099 映射才能进来
      if (!cfg.token) log('注意：webui.json 里没有 token，容器 WebUI 将无鉴权（建议补上）');
      writeJson(dest, cfg);
    } else {
      fs.copyFileSync(src, dest);
    }
    log(`写入：${path.relative(ROOT, dest)}`);
  }

  // 把容器需要的固定信息落到一个可读的说明文件，方便排障
  const onebotFile = path.join(DEST_CONFIG, `onebot11_${UIN}.json`);
  if (fs.existsSync(onebotFile)) {
    const cfg = JSON.parse(fs.readFileSync(onebotFile, 'utf8'));
    const net = cfg.network ?? {};
    const http = (net.httpServers ?? []).find((s) => s.enable);
    const ws = (net.websocketServers ?? []).find((s) => s.enable);
    log(`OneBot HTTP ${http ? `${http.host}:${http.port}` : '(未配置)'} / WS ${ws ? `${ws.host}:${ws.port}` : '(未配置)'}`);
  }
  log('完成。下一步：装好 Docker 后执行 scripts\\napcat-docker-start.ps1');
}

main();
