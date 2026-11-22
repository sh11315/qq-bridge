#!/usr/bin/env node
// 记忆星系：把 state/memory/brain.json 画成一个能转的银河（单文件 HTML，无外部依赖）。
// 用法：node scripts/memory-3d.mjs [--open]
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { salienceScore, salienceTier } from '../src/memory/salience.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = process.env.MEM_BRAIN || path.join(REPO_ROOT, 'state', 'memory', 'brain.json');
const OUT = path.join(REPO_ROOT, 'state', 'memory-3d.html');

function loadBrain() {
  const raw = JSON.parse(fs.readFileSync(BRAIN, 'utf8'));
  const node = raw.memories ?? raw;
  const list = Array.isArray(node)
    ? node
    : Object.entries(node).map(([id, m]) => ({ id, ...(m || {}) }));
  return { raw, list };
}

function relationsOf(raw) {
  const rel = raw.relations ?? [];
  const degree = new Map();
  for (const r of rel) {
    const a = r.from ?? r.fromId;
    const b = r.to ?? r.toId;
    if (a) degree.set(a, (degree.get(a) || 0) + 1);
    if (b) degree.set(b, (degree.get(b) || 0) + 1);
  }
  return degree;
}

const ARMS = 4;
const TIER_COLORS = { core: [255, 198, 96], important: [126, 216, 255], normal: [168, 152, 255] };
// 按类别上色：不同类型的记忆给不同颜色，才看得出一眼区别
const CAT_COLORS = {
  profile: [255, 146, 182],
  fact: [120, 202, 255],
  preference: [186, 150, 255],
  promise: [255, 192, 112],
  event: [255, 138, 118],
  relationship: [130, 250, 200],
  topic: [150, 220, 255],
  other: [176, 176, 206],
};

const { raw, list } = loadBrain();
const degree = relationsOf(raw);

const nodes = [];
for (const m of list) {
  const status = String(m.status || 'active');
  if (status === 'archived' || status === 'faded') continue;
  const score = Number(salienceScore(m, { relations: degree.get(m.id) || 0 })) || 0;
  const tier = salienceTier(score);
  const layer = String(m.layer || 'short');
  let r;
  if (tier === 'core') r = 0.14 + Math.random() * 0.16;
  else if (layer === 'long') r = 0.34 + Math.random() * 0.32;
  else r = 0.62 + Math.random() * 0.38;
  const arm = Math.floor(Math.random() * ARMS);
  const th = (arm / ARMS) * Math.PI * 2 + 4.9 * Math.pow(r, 0.72) + (Math.random() - 0.5) * 0.16;
  const rnd = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  nodes.push({
    id: m.id,
    title: m.title || (m.text || '').slice(0, 20),
    text: (m.text || '').replace(/\s+/g, ' '),
    cat: m.category || 'other',
    layer,
    tier,
    pinned: Number(m.protection || 0) >= 1,
    score,
    entities: (m.entityIds || m.entities || []).slice(0, 6),
    r,
    th,
    y: rnd() * (0.05 + 0.12 * (1 - r)),
    color: tier === 'core' ? TIER_COLORS.core : (CAT_COLORS[m.category] || TIER_COLORS.normal),
  });
}

// 连线：共享实体优先，其次同层同类别按半径相邻
const edges = [];
const seen = new Set();
const keyOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const byEntity = new Map();
for (const n of nodes) {
  for (const e of n.entities) {
    const k = String(e);
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k).push(n.id);
  }
}
for (const [, ids] of byEntity) {
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const k = keyOf(ids[i], ids[j]);
      if (!seen.has(k) && edges.length < 900) {
        seen.add(k);
        edges.push([ids[i], ids[j]]);
      }
    }
  }
}
const byGroup = new Map();
for (const n of nodes) {
  const k = n.layer + ':' + n.cat;
  if (!byGroup.has(k)) byGroup.set(k, []);
  byGroup.get(k).push(n);
}
for (const [, group] of byGroup) {
  group.sort((a, b) => a.r - b.r);
  for (let i = 0; i < group.length - 1; i += 1) {
    const k = keyOf(group[i].id, group[i + 1].id);
    if (!seen.has(k)) {
      seen.add(k);
      edges.push([group[i].id, group[i + 1].id]);
    }
  }
}

const counts = nodes.reduce((acc, n) => {
  acc[n.tier] = (acc[n.tier] || 0) + 1;
  return acc;
}, {});

const payload = {
  nodes,
  edges,
  counts,
  generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
};

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>小雪喵 · 记忆星系</title>
<style>
  html, body { margin:0; height:100%; background:#04050b; overflow:hidden; font-family:"Microsoft YaHei",system-ui,sans-serif; color:#dfe6ff; }
  #c { position:absolute; inset:0; width:100%; height:100%; display:block; cursor:grab; }
  #c:active { cursor:grabbing; }
  .hud { position:absolute; left:22px; top:18px; z-index:4; pointer-events:none; }
  .hud h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:.16em; color:#eaf0ff; }
  .hud .sub { margin-top:6px; font-size:11px; color:#8b93b5; letter-spacing:.06em; }
  .hud .sub b { color:#ffc45c; font-weight:600; }
  .hud .sub i { color:#78d6ff; font-style:normal; }
  .panel { position:absolute; z-index:5; right:18px; top:18px; width:272px; max-height:calc(100% - 120px);
           overflow:auto; box-sizing:border-box; padding:14px 16px; border-radius:12px;
           background:rgba(16,22,42,.92); border:1px solid rgba(140,170,255,.35);
           box-shadow:0 12px 40px rgba(0,0,0,.45); font-size:12px; line-height:1.7; }
  .panel .ttl { font-size:13px; color:#eef2ff; margin-bottom:8px; word-break:break-word; }
  .panel .meta { color:#8b93b5; font-size:11px; }
  .panel .tag { display:inline-block; margin:2px 4px 2px 0; padding:1px 7px; border-radius:99px;
                background:rgba(120,150,255,.12); color:#a9b8ff; font-size:10px; }
  .panel .body { margin-top:8px; color:#c6cdec; word-break:break-word; }
  .legend { position:absolute; left:22px; bottom:20px; z-index:4; font-size:11px; color:#8b93b5; line-height:1.9; }
  .legend .dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:7px; vertical-align:1px; }
  #q { position:absolute; right:18px; bottom:18px; z-index:5; width:238px; box-sizing:border-box; padding:8px 12px;
       border-radius:9px; border:1px solid rgba(120,150,255,.22); background:rgba(10,14,28,.8);
       color:#dfe6ff; font-size:12px; outline:none; }
  .hint { position:absolute; left:0; right:0; bottom:22px; text-align:center; font-size:11px; color:#5f6787; z-index:3; pointer-events:none; }
</style></head>
<body>
<canvas id="c"></canvas>
<div class="hud">
  <h1>小雪喵 · 记忆星系</h1>
  <div class="sub">${nodes.length} 颗记忆 · 核心 <b>${counts.core || 0}</b> · 重要 <i>${counts.important || 0}</i> · 普通 ${counts.normal || 0}</div>
  <div class="sub">拖拽旋转 · 滚轮缩放 · 悬停看细节</div>
</div>
<aside class="panel" id="panel"></aside>
<div class="legend">
  <div><span class="dot" style="background:#ffc45c"></span>核心（衰减慢六倍）· 越大越亮越靠近银心</div>
  <div><span class="dot" style="background:#78a0ff"></span>事实</div>
  <div><span class="dot" style="background:#ff92b6"></span>身份</div>
  <div><span class="dot" style="background:#ba96ff"></span>偏好</div>
  <div><span class="dot" style="background:#ffc070"></span>承诺</div>
  <div><span class="dot" style="background:#ff8a76"></span>事件</div>
  <div><span class="dot" style="background:#82fac8"></span>关系</div>
  <div><span class="dot" style="background:#b0b0ce"></span>其他</div>
</div>
<div class="hint">越靠中心越靠近「现在」 · 越靠外越久远</div>
<input id="q" placeholder="搜标题 / 正文 / 实体" />
<script>
const DATA = ${JSON.stringify(payload)};
const ARMS = ${ARMS};
const cv = document.getElementById('c');
const outCtx = cv.getContext('2d');
const scene = document.createElement('canvas');
const ctx = scene.getContext('2d');
const panel = document.getElementById('panel');
const qInput = document.getElementById('q');
const DPR = Math.min(2, window.devicePixelRatio || 1);
let W = 0, H = 0;
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  scene.width = W * DPR; scene.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize); resize();

const FOV = 3.4;
const byId = new Map(DATA.nodes.map(n => [n.id, n]));
const nodes = DATA.nodes.map(n => ({
  ...n,
  x: Math.cos(n.th) * n.r,
  z: Math.sin(n.th) * n.r,
}));
const edges = DATA.edges.map(([a, b]) => [byId.get(a), byId.get(b)]).filter(e => e[0] && e[1]);

// 星尘：沿旋臂结团铺开，凝结核周围再撒一层稀的，才不像均匀噪点
const DUST_PAL = [[255, 226, 172], [204, 230, 255], [158, 190, 255]];
const KNOTS = [];
for (let i = 0; i < 108; i += 1) {
  const arm = i % ARMS;
  const r = 0.15 + Math.pow(Math.random(), 0.85) * 0.9;
  const th = (arm / ARMS) * Math.PI * 2 + 4.9 * Math.pow(r, 0.72) + (Math.random() - 0.5) * 0.22;
  KNOTS.push({
    x: Math.cos(th) * r,
    z: Math.sin(th) * r,
    y: (Math.random() - 0.5) * 0.05,
    rad: 0.010 + Math.random() * 0.030,
  });
}
function palOf(r) { return r < 0.26 ? 0 : r < 0.58 ? 1 : 2; }
const DUST_N = 62000;
const dust = [];
for (let i = 0; i < DUST_N; i += 1) {
  let x, z, y, r;
  if (Math.random() < 0.5) {
    const k = KNOTS[(Math.random() * KNOTS.length) | 0];
    const g = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    x = k.x + g() * k.rad * 2.6;
    z = k.z + g() * k.rad * 2.6;
    y = k.y + g() * 0.02;
    r = Math.hypot(x, z);
  } else {
    const arm = i % ARMS;
    r = Math.pow(Math.random(), 0.62) * 1.0 + 0.04;
    const wid = Math.random() < 0.55 ? (0.030 + r * 0.055) : (0.09 + r * 0.24);
    const th = (arm / ARMS) * Math.PI * 2 + 4.9 * Math.pow(r, 0.72) + (Math.random() + Math.random() - 1) * wid;
    const rr = r + (Math.random() - 0.5) * 0.06;
    x = Math.cos(th) * rr;
    z = Math.sin(th) * rr;
    y = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5 * (0.025 + 0.10 * (1 - r));
  }
  dust.push({
    x, z, y,
    s: 0.5 + Math.random() * 1.35,
    a: (0.03 + Math.random() * 0.26) * (0.32 + 0.68 * (1 - Math.min(1, r))),
    c: palOf(r),
    tw: Math.random() * 6.28,
  });
}

// 星云团：旋臂上大块柔光，内圈偏暖、外圈偏冷
const CLOUD_PAL = [[255, 224, 176], [150, 198, 255], [140, 176, 255]];
const clouds = [];
for (let i = 0; i < 190; i += 1) {
  const arm = i % ARMS;
  const r = 0.16 + Math.pow(Math.random(), 0.7) * 0.94;
  const th = (arm / ARMS) * Math.PI * 2 + 4.9 * Math.pow(r, 0.72) + (Math.random() - 0.5) * 0.55;
  clouds.push({
    x: Math.cos(th) * r,
    z: Math.sin(th) * r,
    y: (Math.random() - 0.5) * 0.09,
    rad: 0.03 + Math.random() * 0.085,
    a: 0.018 + Math.random() * 0.045,
    c: palOf(r),
  });
}

// 远处背景星：给一点纵深，免得整块是空的
const BG_N = 1100;
const bgStars = [];
for (let i = 0; i < BG_N; i += 1) {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const rr = Math.sqrt(1 - u * u);
  bgStars.push({ x: rr * Math.cos(a), y: u, z: rr * Math.sin(a), s: 0.4 + Math.random() * 1.0, a: 0.05 + Math.random() * 0.22, tw: Math.random() * 6.28 });
}
// 暗尘带：沿旋臂内侧压的深色颗粒，靠它把光「挖」出层次
const LANE = [];
for (let i = 0; i < 980; i += 1) {
  const arm = i % ARMS;
  const r = 0.22 + Math.pow(Math.random(), 0.75) * 0.86;
  const th = (arm / ARMS) * Math.PI * 2 + 4.9 * Math.pow(r, 0.72) - 0.13 + (Math.random() - 0.5) * 0.12;
  LANE.push({
    x: Math.cos(th) * r,
    z: Math.sin(th) * r,
    y: (Math.random() - 0.5) * 0.03,
    rad: 0.006 + Math.random() * 0.016,
    a: 0.06 + Math.random() * 0.18,
  });
}
// 电离氢区：粉红的一簇簇亮结，真银河里最好认的那点颜色
const PINK = [];
for (let i = 0; i < 120; i += 1) {
  const arm = i % ARMS;
  const r = 0.3 + Math.pow(Math.random(), 0.6) * 0.76;
  const th = (arm / ARMS) * Math.PI * 2 + 4.9 * Math.pow(r, 0.72) + (Math.random() - 0.5) * 0.18;
  PINK.push({
    x: Math.cos(th) * r,
    z: Math.sin(th) * r,
    y: (Math.random() - 0.5) * 0.04,
    rad: 0.004 + Math.random() * 0.012,
    a: 0.12 + Math.random() * 0.24,
  });
}
// 球状星团：银晕里稀稀拉拉的亮点
const HALO = [];
for (let i = 0; i < 170; i += 1) {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const rr = Math.sqrt(1 - u * u);
  const dist = 0.72 + Math.random() * 0.6;
  HALO.push({ x: rr * Math.cos(a) * dist, z: rr * Math.sin(a) * dist, y: u * 0.33, s: 0.7 + Math.random() * 1.1, a: 0.12 + Math.random() * 0.34 });
}
let rotX = -0.46, rotY = 0.2, zoom = 1.0;
let vRotX = 0, vRotY = 0.0016;
let drag = null;
let hover = null;

cv.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY }; vRotX = 0; vRotY = 0; });
window.addEventListener('mouseup', () => { drag = null; });
window.addEventListener('mousemove', e => {
  if (drag) {
    const dx = (e.clientX - drag.x) * 0.005;
    const dy = (e.clientY - drag.y) * 0.005;
    rotY += dx; rotX += dy;
    vRotY = dx; vRotX = dy;
    drag = { x: e.clientX, y: e.clientY };
  }
  const h = pick(e.clientX, e.clientY);
  if ((h && h.id) !== (hover && hover.id)) { hover = h; renderPanel(); }
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  zoom = Math.min(2.6, Math.max(0.45, zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
}, { passive: false });
qInput.addEventListener('input', () => { renderPanel(); });

function project(n, cx, cy, scale, cosX, sinX, cosY, sinY) {
  const z = n.z * cosY - n.x * sinY;
  const x0 = n.x * cosY + n.z * sinY;
  const y = n.y * cosX - z * sinX;
  const zz = n.y * sinX + z * cosX;
  const z2 = zz + 2.2;
  const k = FOV / Math.max(0.35, FOV + z2);
  return { sx: cx + x0 * scale * k, sy: cy + y * scale * k, k, z: z2 };
}

function pick(mx, my) {
  let best = null, bestD = 14;
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

function drawFrame() {
  const cx = W * 0.44, cy = H * 0.52;
  const scale = Math.min(W, H) * 0.78 * zoom;
  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);

  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.75);
  bg.addColorStop(0, '#0a1024');
  bg.addColorStop(0.45, '#06080f');
  bg.addColorStop(1, '#03040a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // 远处背景星
  ctx.globalCompositeOperation = 'lighter';
  const t0 = performance.now() / 1000;
  for (const b of bgStars) {
    const px = cx + b.x * W * 0.62 + Math.sin(rotY) * 26 * b.z;
    const py = cy + b.y * W * 0.62 + Math.cos(rotY) * 18 * b.z;
    const tw = 0.72 + 0.28 * Math.sin(t0 * 1.7 + b.tw);
    ctx.fillStyle = 'rgba(210,224,255,' + (b.a * tw).toFixed(3) + ')';
    ctx.fillRect(px, py, b.s, b.s);
  }
  // 核球：拉长的暖黄一团，银河中央那个「棒」
  const bulgeX = Math.max(46, scale * 0.30);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.42);
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, bulgeX);
  cg.addColorStop(0, 'rgba(255,246,220,.92)');
  cg.addColorStop(0.08, 'rgba(255,232,180,.62)');
  cg.addColorStop(0.26, 'rgba(255,204,140,.28)');
  cg.addColorStop(0.6, 'rgba(220,160,120,.07)');
  cg.addColorStop(1, 'rgba(160,120,255,0)');
  ctx.scale(1, 0.58);
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(0, 0, bulgeX, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  for (const cl of clouds) {
    const p = project(cl, cx, cy, scale, cosX, sinX, cosY, sinY);
    const rad = Math.max(6, cl.rad * scale * p.k * 2.4);
    const cc = CLOUD_PAL[cl.c] || CLOUD_PAL[1];
    const col = cc[0] + ',' + cc[1] + ',' + cc[2];
    const gr = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, rad);
    gr.addColorStop(0, 'rgba(' + col + ',' + (cl.a * 1.1).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(' + col + ',0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rad, 0, Math.PI * 2); ctx.fill();
  }
  for (const d of dust) {
    const p = project(d, cx, cy, scale, cosX, sinX, cosY, sinY);
    const a = d.a * 1.15 * Math.min(1, 1.35 / p.z);
    if (a < 0.01) continue;
    const dc = DUST_PAL[d.c] || DUST_PAL[1];
    const col = dc[0] + ',' + dc[1] + ',' + dc[2];
    const tw = 0.78 + 0.22 * Math.sin(t0 * 2.1 + d.tw);
    ctx.fillStyle = 'rgba(' + col + ',' + (a * tw).toFixed(3) + ')';
    const s = Math.max(0.6, d.s * p.k * 0.9);
    ctx.fillRect(p.sx, p.sy, s, s);
  }

  // 暗尘带：把旋臂内侧压暗，光才有层次
  ctx.globalCompositeOperation = 'source-over';
  for (const k of LANE) {
    const p = project(k, cx, cy, scale, cosX, sinX, cosY, sinY);
    const rad = Math.max(2, k.rad * scale * p.k * 2.2);
    const gr = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, rad);
    gr.addColorStop(0, 'rgba(2,4,10,' + (k.a * Math.min(1, 1.4 / p.z)).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(2,4,10,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rad, 0, Math.PI * 2); ctx.fill();
  }
  // 电离氢区：粉红的小亮结
  ctx.globalCompositeOperation = 'lighter';
  for (const k of PINK) {
    const p = project(k, cx, cy, scale, cosX, sinX, cosY, sinY);
    const rad = Math.max(3, k.rad * scale * p.k * 2.6);
    const gr = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, rad);
    gr.addColorStop(0, 'rgba(255,150,180,' + (k.a * 0.9).toFixed(3) + ')');
    gr.addColorStop(0.4, 'rgba(255,110,150,' + (k.a * 0.32).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(255,90,140,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rad, 0, Math.PI * 2); ctx.fill();
  }
  // 球状星团：银晕里那点稀疏的亮
  for (const h of HALO) {
    const p = project(h, cx, cy, scale, cosX, sinX, cosY, sinY);
    if (p.z < 0.6) continue;
    ctx.fillStyle = 'rgba(222,232,255,' + (h.a * 0.7 * Math.min(1, 1.3 / p.z)).toFixed(3) + ')';
    const s = Math.max(0.7, h.s * p.k * 0.9);
    ctx.fillRect(p.sx, p.sy, s, s);
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth = 1;
  for (const [a, b] of edges) {
    const pa = project(a, cx, cy, scale, cosX, sinX, cosY, sinY);
    const pb = project(b, cx, cy, scale, cosX, sinX, cosY, sinY);
    const alpha = 0.055 + 0.05 * Math.min(1, Math.min(pa.k, pb.k));
    ctx.strokeStyle = 'rgba(150,180,255,' + alpha.toFixed(3) + ')';
    ctx.beginPath(); ctx.moveTo(pa.sx, pa.sy); ctx.lineTo(pb.sx, pb.sy); ctx.stroke();
  }

  const query = qInput.value.trim().toLowerCase();
  const sorted = nodes.slice().sort((a, b) => b.z - a.z);
  for (const n of sorted) {
    const p = project(n, cx, cy, scale, cosX, sinX, cosY, sinY);
    n._p = p;
    const dim = (query ? (matchQuery(n, query) ? 1 : 0.16) : 1) * Math.min(1, 1.5 / p.z);
    const [r, g, b] = n.color;
    const rad = Math.max(1.4, (n.tier === 'core' ? 2.6 : n.tier === 'important' ? 2.0 : 1.6) * p.k * 1.5);
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, rad * 6);
    glow.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.3 * dim).toFixed(3) + ')');
    glow.addColorStop(0.35, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.06 * dim).toFixed(3) + ')');
    glow.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rad * 6, 0, Math.PI * 2); ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + (0.95 * dim).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rad, 0, Math.PI * 2); ctx.fill();
    if (n.pinned) {
      ctx.strokeStyle = 'rgba(255,240,200,' + (0.55 * dim).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(p.sx, p.sy, rad + 3.2, 0, Math.PI * 2); ctx.stroke();
    }
    if (n === hover) {
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.beginPath(); ctx.arc(p.sx, p.sy, rad + 5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  ctx.font = '11px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  for (const n of nodes) {
    if (!n._p) continue;
    const show = n === hover || (n.tier === 'core' && n._p.k > 0.85);
    if (!show) continue;
    ctx.fillStyle = n === hover ? 'rgba(255,255,255,.96)' : 'rgba(240,226,196,.78)';
    ctx.strokeStyle = 'rgba(3,5,12,.85)';
    ctx.lineWidth = 3;
    ctx.strokeText((n.title || '').slice(0, 14), n._p.sx, n._p.sy - 10);
    ctx.fillText((n.title || '').slice(0, 14), n._p.sx, n._p.sy - 10);
  }

  if (!drag) {
    rotY += vRotY;
    rotX += vRotX;
    vRotY = Math.abs(vRotY) > 0.0005 ? vRotY * 0.986 : vRotY + (0.0016 - vRotY) * 0.05;
    vRotX *= 0.9;
    rotX = Math.max(-1.15, Math.min(0.25, rotX + (-0.46 - rotX) * 0.004));
  }

  // 最后叠一层模糊曝光：照片那种柔光靠它，不然看着太「画」
  outCtx.setTransform(1, 0, 0, 1, 0, 0);
  outCtx.globalCompositeOperation = 'source-over';
  outCtx.globalAlpha = 1;
  outCtx.drawImage(scene, 0, 0);
  outCtx.globalCompositeOperation = 'lighter';
  outCtx.globalAlpha = 0.33;
  outCtx.filter = 'blur(5px)';
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
      '<div class="meta">' + tierName + ' · ' + esc(n.layer) + ' · ' + esc(n.cat) +
      ' · 关键度 ' + n.score.toFixed(2) + (n.pinned ? ' · 永久' : '') + '</div>' +
      (n.entities.length ? '<div style="margin-top:6px">' + n.entities.map(e => '<span class="tag">' + esc(String(e)) + '</span>').join('') + '</div>' : '') +
      '<div class="body">' + esc((n.text || '').slice(0, 260)) + '</div>';
    return;
  }
  if (q) {
    const hit = nodes.filter(x => matchQuery(x, q.toLowerCase()));
    panel.innerHTML = '<div class="ttl">搜索结果</div><div class="meta">' + hit.length + ' 条命中</div>' +
      '<div class="body">' + hit.slice(0, 8).map(x => '· ' + esc(x.title)).join('<br>') + '</div>';
    return;
  }
  const c = DATA.counts || {};
  panel.innerHTML =
    '<div class="ttl">总览</div>' +
    '<div class="meta">共 ' + nodes.length + ' 颗 · 连线 ' + edges.length + ' 条</div>' +
    '<div class="body">核心 ' + (c.core || 0) + ' · 重要 ' + (c.important || 0) + ' · 普通 ' + (c.normal || 0) + '<br>' +
    '生成于 ' + esc(DATA.generatedAt) + '<br>悬停任意一颗看细节。</div>';
}

renderPanel();
drawFrame();
</script>
</body></html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log(`[memory-3d] ${nodes.length} 颗 · ${edges.length} 条连线 → ${path.relative(REPO_ROOT, OUT)}`);
console.log(`[memory-3d] 分层：核心 ${counts.core || 0} / 重要 ${counts.important || 0} / 普通 ${counts.normal || 0}`);

if (process.argv.includes('--open')) {
  execFile('cmd', ['/c', 'start', '', OUT], { windowsHide: true }, () => {});
}
















