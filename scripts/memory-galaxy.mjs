#!/usr/bin/env node
// 记忆银河：拿一张真星系照片当底，把记忆点悬在盘面上。单文件 HTML，无外部依赖。
// 用法：node scripts/memory-galaxy.mjs [--open]
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { salienceScore, salienceTier } from '../src/memory/salience.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = process.env.MEM_BRAIN || path.join(REPO_ROOT, 'state', 'memory', 'brain.json');
const PHOTO = process.env.MEM_GALAXY_IMG || path.join(REPO_ROOT, 'state', 'assets', 'galaxy-m51.jpg');
const OUT = path.join(REPO_ROOT, 'state', 'memory-galaxy.html');

const raw = JSON.parse(fs.readFileSync(BRAIN, 'utf8'));
const node = raw.memories ?? raw;
const list = Array.isArray(node) ? node : Object.entries(node).map(([id, m]) => ({ id, ...(m || {}) }));

const degree = new Map();
for (const rel of raw.relations ?? []) {
  const a = rel.from ?? rel.fromId;
  const b = rel.to ?? rel.toId;
  if (a) degree.set(a, (degree.get(a) || 0) + 1);
  if (b) degree.set(b, (degree.get(b) || 0) + 1);
}

const CAT_COLORS = {
  profile: [255, 158, 192],
  fact: [130, 206, 255],
  preference: [190, 160, 255],
  promise: [255, 200, 120],
  event: [255, 150, 130],
  relationship: [140, 255, 205],
  topic: [160, 225, 255],
  other: [188, 190, 214],
};
const CORE_COLOR = [255, 216, 140];

const ARMS = 2;
const nodes = [];
let seed = 20261031;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;

for (const m of list) {
  const status = String(m.status || 'active');
  if (status === 'archived' || status === 'faded') continue;
  const score = Number(salienceScore(m, { relations: degree.get(m.id) || 0 })) || 0;
  const tier = salienceTier(score);
  const layer = String(m.layer || 'short');
  let r;
  if (tier === 'core') r = 0.05 + rnd() * 0.16;
  else if (layer === 'long') r = 0.24 + rnd() * 0.40;
  else r = 0.45 + rnd() * 0.55;
  const arm = Math.floor(rnd() * ARMS);
  const th = (arm / ARMS) * Math.PI * 2 + 4.6 * Math.pow(r, 0.62) + gauss() * (0.08 + r * 0.10);
  nodes.push({
    id: m.id,
    title: m.title || (m.text || '').slice(0, 20),
    text: (m.text || '').replace(/\s+/g, ' '),
    cat: m.category || 'other',
    layer,
    tier,
    pinned: Number(m.protection || 0) >= 1,
    score,
    entities: (m.entityIds || m.entities || []).slice(0, 6).map(String),
    r,
    th,
    color: tier === 'core' ? CORE_COLOR : (CAT_COLORS[m.category] || CAT_COLORS.other),
  });
}

const counts = nodes.reduce((acc, n) => { acc[n.tier] = (acc[n.tier] || 0) + 1; return acc; }, {});
const photoB64 = fs.readFileSync(PHOTO).toString('base64');

const payload = {
  nodes: nodes.map(n => ({
    id: n.id, title: n.title, text: n.text.slice(0, 400), cat: n.cat, layer: n.layer,
    tier: n.tier, pinned: n.pinned, score: Number(n.score.toFixed(2)), entities: n.entities,
    r: n.r, th: n.th, color: n.color,
  })),
  counts,
  generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
};

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>小雪喵 · 记忆银河</title>
<style>
  html,body{margin:0;height:100%;background:#02030a;overflow:hidden;color:#dfe6ff;
    font-family:"Microsoft YaHei",system-ui,sans-serif;}
  #c{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;}
  #c:active{cursor:grabbing;}
  .hud{position:absolute;left:22px;top:18px;z-index:4;pointer-events:none;}
  .hud h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.16em;color:#eef3ff;}
  .hud .sub{margin-top:6px;font-size:11px;color:#8b93b5;letter-spacing:.05em;}
  .hud .sub b{color:#ffd48a;}
  .panel{position:absolute;z-index:5;right:18px;top:18px;width:280px;max-height:calc(100% - 130px);
    overflow:auto;box-sizing:border-box;padding:14px 16px;border-radius:12px;
    background:rgba(12,16,34,.9);border:1px solid rgba(150,180,255,.28);
    box-shadow:0 14px 44px rgba(0,0,0,.5);font-size:12px;line-height:1.7;}
  .panel .ttl{font-size:13px;color:#f0f4ff;margin-bottom:6px;word-break:break-word;}
  .panel .meta{color:#8b93b5;font-size:11px;}
  .panel .tag{display:inline-block;margin:2px 4px 2px 0;padding:1px 7px;border-radius:99px;
    background:rgba(130,160,255,.12);color:#a9b8ff;font-size:10px;}
  .panel .body{margin-top:8px;color:#c6cdec;word-break:break-word;}
  .legend{position:absolute;left:22px;bottom:18px;z-index:4;font-size:11px;color:#8b93b5;line-height:1.85;}
  .legend .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;}
  #q{position:absolute;right:18px;bottom:18px;z-index:5;width:240px;box-sizing:border-box;padding:8px 12px;
    border-radius:9px;border:1px solid rgba(120,150,255,.22);background:rgba(8,12,24,.82);
    color:#dfe6ff;font-size:12px;outline:none;}
  .hint{position:absolute;left:0;right:0;bottom:20px;text-align:center;font-size:11px;color:#5f6787;
    z-index:3;pointer-events:none;}
</style></head>
<body>
<canvas id="c"></canvas>
<div class="hud">
  <h1>小雪喵 · 记忆银河</h1>
  <div class="sub">${nodes.length} 颗记忆 · 核心 <b>${counts.core || 0}</b> · 重要 ${counts.important || 0} · 普通 ${counts.normal || 0}</div>
  <div class="sub">拖拽转盘 · 滚轮缩放 · 悬停看细节</div>
</div>
<aside class="panel" id="panel"></aside>
<div class="legend">
  <div><span class="dot" style="background:#ffd48c"></span>核心 · 越亮越靠银心</div>
  <div><span class="dot" style="background:#82ceff"></span>事实 · <span class="dot" style="background:#ff9ec0"></span>身份 · <span class="dot" style="background:#bea0ff"></span>偏好</div>
  <div><span class="dot" style="background:#ffc878"></span>承诺 · <span class="dot" style="background:#ff9682"></span>事件 · <span class="dot" style="background:#8cffcd"></span>关系</div>
</div>
<div class="hint">越靠银心越靠近「现在」 · 越靠外越久远</div>
<input id="q" placeholder="搜标题 / 正文 / 实体" />
<script>
const DATA = ${JSON.stringify(payload)};
const IMG = new Image();
IMG.src = 'data:image/jpeg;base64,${photoB64}';
const cv = document.getElementById('c');
const outCtx = cv.getContext('2d');
const scene = document.createElement('canvas');
const ctx = scene.getContext('2d');
const imgLayer = document.createElement('canvas');
const lctx = imgLayer.getContext('2d');
const panel = document.getElementById('panel');
const qInput = document.getElementById('q');
const DPR = Math.min(2, window.devicePixelRatio || 1);
const PROC = document.createElement('canvas');
let procReady = false;
function buildProc() {
  if (!IMG.naturalWidth) return;
  PROC.width = IMG.naturalWidth; PROC.height = IMG.naturalHeight;
  const p2 = PROC.getContext('2d');
  p2.drawImage(IMG, 0, 0);
  const imgData = p2.getImageData(0, 0, PROC.width, PROC.height);
  const d = imgData.data;
  const w = PROC.width, h = PROC.height;
  const cx0 = w * 0.42, cy0 = h * 0.47, R = w * 0.52;
  for (let i = 0; i < d.length; i += 4) {
    const px = (i / 4) % w;
    const py = Math.floor((i / 4) / w);
    const v = Math.max(d[i], d[i + 1], d[i + 2]);
    const a = (v - 28) / 54;
    let alpha = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a);
    // 越靠图片边缘越透，免得剩下一个方框
    const dist = Math.hypot((px - cx0) / R, (py - cy0) / (R * 0.86));
    let edge = dist >= 1.0 ? 0 : dist <= 0.7 ? 1 : 1 - (dist - 0.7) / 0.3;
    edge = edge * edge * (3 - 2 * edge);
    d[i + 3] = Math.round(alpha * edge * 255);
  }
  p2.putImageData(imgData, 0, 0);
  procReady = true;
}
let W = 0, H = 0;
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  scene.width = W * DPR; scene.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize); resize();

const nodes = DATA.nodes.map(n => ({
  ...n,
  x: Math.cos(n.th) * n.r,
  z: Math.sin(n.th) * n.r,
}));
let spin = 0.55, tilt = 0.52, zoom = 1;
let vSpin = 0.0009, vTilt = 0;
let drag = null, hover = null;

cv.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY }; vSpin = 0; vTilt = 0; });
window.addEventListener('mouseup', () => { drag = null; });
window.addEventListener('mousemove', e => {
  if (drag) {
    const dx = (e.clientX - drag.x) * 0.0055;
    const dy = (e.clientY - drag.y) * 0.0045;
    spin += dx; tilt = Math.max(0.06, Math.min(1.32, tilt + dy));
    vSpin = dx; vTilt = dy;
    drag = { x: e.clientX, y: e.clientY };
  }
  const h = pick(e.clientX, e.clientY);
  if ((h && h.id) !== (hover && hover.id)) { hover = h; renderPanel(); }
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  zoom = Math.min(3.2, Math.max(0.55, zoom * (e.deltaY > 0 ? 0.93 : 1.075)));
}, { passive: false });
qInput.addEventListener('input', renderPanel);

const GAL_D = 3.0;
function project(n, cx, cy, scale, cs, sn, sq) {
  const x0 = n.x * cs - n.z * sn;
  const z0 = n.x * sn + n.z * cs;
  return { sx: cx + x0 * scale, sy: cy + z0 * scale * sq };
}
function pick(mx, my) {
  let best = null, bestD = 16;
  for (const n of nodes) {
    if (!n._p) continue;
    const d = Math.hypot(n._p.sx - mx, n._p.sy - my);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}
function matchQuery(n, q) {
  if (!q) return true;
  return (n.title + ' ' + n.text + ' ' + n.entities.join(' ')).toLowerCase().includes(q);
}

const bgStars = [];
for (let i = 0; i < 420; i += 1) {
  bgStars.push({ x: Math.random(), y: Math.random(), a: 0.05 + Math.random() * 0.35, s: 0.5 + Math.random() * 1.1 });
}

function drawFrame() {
  const cx = W * 0.45, cy = H * 0.5;
  const base = Math.min(W, H) * 0.40 * zoom;
  const cs = Math.cos(spin), sn = Math.sin(spin);
  const sq = Math.max(0.12, Math.cos(tilt - 0.52) * 0.55 + 0.45);

  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.8);
  bg.addColorStop(0, '#050814');
  bg.addColorStop(0.5, '#03050d');
  bg.addColorStop(1, '#010208');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  for (const b of bgStars) {
    ctx.fillStyle = 'rgba(190,208,255,' + b.a.toFixed(3) + ')';
    ctx.fillRect(b.x * W, b.y * H, b.s, b.s);
  }

  // 真星系照片：按盘面倾角压扁，再跟着拖拽转；边缘用径向渐变淡出，不留方框
  if (IMG.complete && IMG.naturalWidth) {
    const d = base * GAL_D;
    if (imgLayer.width !== scene.width || imgLayer.height !== scene.height) {
      imgLayer.width = scene.width; imgLayer.height = scene.height;
    }
    lctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    lctx.clearRect(0, 0, W, H);
    lctx.globalCompositeOperation = 'source-over';
    lctx.save();
    lctx.translate(cx, cy);
    lctx.rotate(spin * 0.55);
    lctx.scale(1, sq);
    const ih = d * (IMG.naturalHeight / IMG.naturalWidth);
    lctx.imageSmoothingQuality = 'high';
    lctx.filter = 'saturate(1.28) contrast(1.07) brightness(1.06)';
    lctx.drawImage(procReady ? PROC : IMG, -0.42 * d, -0.47 * ih, d, ih);
    lctx.filter = 'none';
    lctx.restore();
    lctx.globalCompositeOperation = 'destination-in';
    lctx.save();
    lctx.translate(cx, cy);
    lctx.scale(1, sq);
    const mask = lctx.createRadialGradient(0, 0, base * 0.62, 0, 0, base * 1.02);
    mask.addColorStop(0, 'rgba(255,255,255,1)');
    mask.addColorStop(0.78, 'rgba(255,255,255,0.97)');
    mask.addColorStop(0.92, 'rgba(255,255,255,0.45)');
    mask.addColorStop(1, 'rgba(255,255,255,0)');
    lctx.fillStyle = mask;
    lctx.fillRect(-W * 2, -H * 2, W * 4, H * 4);
    lctx.restore();
    lctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(imgLayer, 0, 0);
    ctx.restore();
  }

  const query = qInput.value.trim().toLowerCase();
  for (const n of nodes) {
    const p = project(n, cx, cy, base * 0.9, cs, sn, sq);
    n._p = p;
  }
  const sorted = nodes.slice().sort((a, b) => a.r - b.r);
  for (const n of sorted) {
    const p = n._p;
    const dim = (query ? (matchQuery(n, query) ? 1 : 0.14) : 1) * (0.78 + 0.22 * (1 - n.r)) * (0.75 + 0.25 * sq);
    const [r, g, b] = n.color;
    const rad = (n.tier === 'core' ? 4.0 : n.tier === 'important' ? 2.9 : 2.1) * (0.8 + 0.4 * zoom);
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, rad * 5.2);
    glow.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.3 * dim).toFixed(3) + ')');
    glow.addColorStop(0.3, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.06 * dim).toFixed(3) + ')');
    glow.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rad * 5.2, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + (0.95 * dim).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rad, 0, Math.PI * 2); ctx.fill();
    if (n.pinned) {
      ctx.strokeStyle = 'rgba(255,244,214,' + (0.5 * dim).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(p.sx, p.sy, rad + 3.4, 0, Math.PI * 2); ctx.stroke();
    }
    if (n === hover) {
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.arc(p.sx, p.sy, rad + 5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  ctx.font = '11px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  for (const n of nodes) {
    if (!n._p) continue;
    const show = n === hover || (n.tier === 'core' && n.r < 0.12 && zoom > 1.1);
    if (!show) continue;
    const t = (n.title || '').slice(0, 14);
    ctx.strokeStyle = 'rgba(2,4,10,.85)';
    ctx.strokeText(t, n._p.sx, n._p.sy - 11);
    ctx.fillStyle = n === hover ? 'rgba(255,255,255,.97)' : 'rgba(255,236,206,.82)';
    ctx.fillText(t, n._p.sx, n._p.sy - 11);
  }

  if (!drag) {
    spin += vSpin;
    tilt = Math.max(0.06, Math.min(1.32, tilt + vTilt * 0.6));
    vSpin = Math.abs(vSpin) > 0.0004 ? vSpin * 0.988 : 0.0009;
    vTilt *= 0.9;
  }

  outCtx.setTransform(1, 0, 0, 1, 0, 0);
  outCtx.globalCompositeOperation = 'source-over';
  outCtx.globalAlpha = 1;
  outCtx.drawImage(scene, 0, 0);
  outCtx.globalCompositeOperation = 'lighter';
  outCtx.globalAlpha = 0.34;
  outCtx.filter = 'blur(6px)';
  outCtx.drawImage(scene, 0, 0);
  outCtx.filter = 'none';
  outCtx.globalAlpha = 1;
  requestAnimationFrame(drawFrame);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function renderPanel() {
  const q = qInput.value.trim();
  const n = hover;
  if (n) {
    const tierName = n.tier === 'core' ? '核心' : n.tier === 'important' ? '重要' : '普通';
    panel.innerHTML =
      '<div class="ttl">' + esc(n.title) + '</div>' +
      '<div class="meta">' + tierName + ' · ' + esc(n.layer) + ' · ' + esc(n.cat) + ' · 关键度 ' + n.score + (n.pinned ? ' · 永久' : '') + '</div>' +
      (n.entities.length ? '<div style="margin-top:6px">' + n.entities.map(e => '<span class="tag">' + esc(e) + '</span>').join('') + '</div>' : '') +
      '<div class="body">' + esc((n.text || '').slice(0, 280)) + '</div>';
    return;
  }
  if (q) {
    const hit = nodes.filter(x => matchQuery(x, q.toLowerCase()));
    panel.innerHTML = '<div class="ttl">搜索结果</div><div class="meta">' + hit.length + ' 条命中</div>' +
      '<div class="body">' + hit.slice(0, 9).map(x => '· ' + esc(x.title)).join('<br>') + '</div>';
    return;
  }
  const c = DATA.counts || {};
  panel.innerHTML = '<div class="ttl">总览</div>' +
    '<div class="meta">共 ' + nodes.length + ' 颗记忆</div>' +
    '<div class="body">核心 ' + (c.core || 0) + ' · 重要 ' + (c.important || 0) + ' · 普通 ' + (c.normal || 0) + '<br>' +
    '生成于 ' + esc(DATA.generatedAt) + '<br>悬停任意一颗看细节。</div>';
}

IMG.addEventListener('load', () => { buildProc(); renderPanel(); drawFrame(); });
renderPanel();
if (IMG.complete) drawFrame();
</script>
</body></html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log(`[memory-galaxy] ${nodes.length} 颗 · 核心 ${counts.core || 0} / 重要 ${counts.important || 0} / 普通 ${counts.normal || 0} → ${path.relative(REPO_ROOT, OUT)}`);
console.log(`[memory-galaxy] 底图 ${path.basename(PHOTO)} ${(fs.statSync(PHOTO).size / 1024).toFixed(0)}KB`);

if (process.argv.includes('--open')) {
  execFile('cmd', ['/c', 'start', '', OUT], { windowsHide: true }, () => {});
}









