// 控制台静态校验：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构契约。
//
// ⚠ 校验对象是 **console/ui.html**（7788 统一控制台真正 serve 的页面，见 console/server.mjs 的 UI_PATH）。
// 历史遗留的 public/console.html 是旧版控制台页面，server.mjs 已经不 serve 它，
// 只保留作参考（文件头标了 LEGACY），不再参与断言——否则 UI 改动会完全没有静态回归覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_PATH = path.join(ROOT, 'console', 'ui.html');
const SERVER_PATH = path.join(ROOT, 'console', 'server.mjs');
const html = fs.readFileSync(UI_PATH, 'utf8');
const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 元素 ID');
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
ok(dups.length === 0, 'ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
// 核心面板必须存在（页面没了导航就是死链）
for (const id of ['nav', 'serviceGrid', 'overviewKv', 'logBox', 'logTabs', 'sessBody', 'tokenStats', 'tokenFeatureBody',
  'diagAlerts', 'diagChecks', 'napcatKv', 'napcatHistBody', 'roleList', 'wlPanes', 'apiModel', 'setTheme', 'testOut', 'helpDoc']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `核心面板元素 ${id}`, `${n} 处`);
}

console.log('## 页面 / 导航契约');
const pageIds = [...html.matchAll(/^\s*\{ id: '([a-z0-9-]+)', group:/gm)].map((m) => m[1]);
const sections = [...html.matchAll(/id="page-([a-z0-9-]+)"/g)].map((m) => m[1]);
ok(pageIds.length === 20, 'PAGES 有 20 个页面', pageIds.join(', '));
ok(new Set(pageIds).size === pageIds.length, 'PAGES 无重复');
const missingSections = pageIds.filter((p) => !sections.includes(p));
ok(missingSections.length === 0, '每个页面都有对应 <section id="page-*">', missingSections.length ? `缺：${missingSections.join(', ')}` : '');
const orphanSections = sections.filter((s) => !pageIds.includes(s));
ok(orphanSections.length === 0, '没有孤儿 section', orphanSections.length ? orphanSections.join(', ') : '');
const pageTargets = [...new Set([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]))];
const badTargets = pageTargets.filter((p) => !pageIds.includes(p));
ok(badTargets.length === 0, 'data-page 跳转目标都存在', badTargets.length ? badTargets.join(', ') : `${pageTargets.length} 个跳转目标`);
ok(/function renderNav\(/.test(html) && /data-act="nav" data-page=/.test(html), '侧边栏由 PAGES 动态渲染');

console.log('## 交互 handler 契约');
const acts = [...new Set([...html.matchAll(/data-act="([a-z0-9-]+)"/g)].map((m) => m[1]))];
const actionsBlock = html.slice(html.indexOf('const ACTIONS = {'));
const actionKeys = [...actionsBlock.matchAll(/^ {2}(?:'([a-z0-9-]+)'|([A-Za-z0-9_-]+))\s*:/gm)].map((m) => m[1] || m[2]);
const unhandled = acts.filter((a) => !actionKeys.includes(a));
ok(unhandled.length === 0, '每个 data-act 都有 ACTIONS 处理器', unhandled.length ? `缺：${unhandled.join(', ')}` : `${acts.length} 个动作`);
ok(/document\.addEventListener\('click'/.test(html) && /closest\('\[data-act\]'\)/.test(html), '点击委托到 data-act');

console.log('## 前后端接口契约');
const norm = (s) => String(s).replace(/\\\//g, '/');
const srvNorm = norm(serverSrc);
const uiUrls = [...new Set([...html.matchAll(/\/api\/[a-zA-Z0-9_/.-]+/g)].map((m) => m[0].split('?')[0]))]
  .filter((u) => !u.includes('$'));
const missingRoutes = uiUrls.filter((u) => !srvNorm.includes(u));
ok(missingRoutes.length === 0, 'UI 用到的 /api 路径在 server.mjs 都有对应路由', missingRoutes.length ? `缺：${missingRoutes.join(', ')}` : `${uiUrls.length} 个路径`);
ok(/UI_PATH = path\.join\(CONSOLE_DIR, 'ui\.html'\)/.test(serverSrc), 'server.mjs 确实 serve console/ui.html');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }

console.log('## 关键机制回归钉（这些行为修过，别再退回去）');
const pins = [
  ['winPath', /const winPath = \(p\) =>/, 'path 双反斜杠折叠'],
  ['stripAnsi', /const stripAnsi = \(s\) =>/, 'ANSI 颜色码清理'],
  ['mergeLogs', /function mergeLogs\(/, '日志 SSE+全量按 seq 合并'],
  ['logCounts 口径', /state\.logCounts\?\.byService\?\.all/, '日志条数用后端总数'],
  ['autoHeal 展示', /ah\.enabled \? '已开启'/, '自愈守护状态行'],
  ['余额双形状', /const balInfo = bal\?\.infos\?\.\[0\]/, '余额卡兼容 infos/flat 两种形状'],
  ['余额明细降级', /const costKnown = !degraded/, '离线降级不把花费显示成 ¥0'],
  ['掉线历史去重', /function collapseNapcatEvents\(/, '掉线历史同类事件合并'],
  ['角色上限双口径', /保存上限 60,000 字 · 注入上限 \$\{num\(injectLimit\)\} 字/, '角色页两个上限文案'],
  ['按功能分账', /function renderFeatureStats\(/, 'Token 按功能区块'],
  ['功能轮次 0 显示 —', /桥接当前只按功能累计 token/, 'features turns=0 显示 —'],
  ['pushState 回退', /history\.pushState\(\{ page \}, '', `#\$\{page\}`\)/, '浏览器后退可逐页回退'],
  ['hashchange 不重复入栈', /setPage\(id, \{ push: false \}\)/, 'hashchange 回放不 push'],
  ['诊断提示口径', /必需检查通过 ✅/, 'info 级提示不再静默'],
  ['WorkBuddy 密钥守卫', /function requireWbKey\(/, '缺 key 时复制动作给提示'],
  ['WorkBuddy hasKey', /wb\.hasKey !== false/, '卡片按 hasKey 决定颜色'],
];
for (const [label, re, why] of pins) ok(re.test(html), `回归钉：${label}`, why);

console.log('## 离线 / 安全');
const external = [...html.matchAll(/<(?:script|img|link)[^>]+(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
ok(external.length === 0, '页面不依赖外链资源（离线可用）', external.join(', '));
ok(!/<script>[\s\S]*?eval\(/.test(big), '主脚本没有 eval(');

console.log('## 旧文件定位');
const legacy = path.join(ROOT, 'public', 'console.html');
if (fs.existsSync(legacy)) {
  const legacyHtml = fs.readFileSync(legacy, 'utf8');
  ok(legacyHtml.includes('LEGACY'), 'public/console.html 带 LEGACY 标记（不再被 serve，避免误改）');
} else {
  ok(true, 'public/console.html 已移除（旧版页面不再存在）');
}

console.log('## 语音图形界面的音量控件');
if (!hasVoiceTool()) {
  // 这一整段查的是独立工具自己的页面（voice.html），仓库里没有它。
  skipVoiceTool('voice.html 的音量控件断言（volRange/volLabel/volReset/normBox/loudnessSel/previewBtn、滑块范围、事件绑定、前端 JS 可解析）');
} else {
  const voice = fs.readFileSync(voiceToolPath('public', 'voice.html'), 'utf8');
  const vids = [...voice.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const vdups = [...new Set(vids.filter((v, i) => vids.indexOf(v) !== i))];
  ok(vdups.length === 0, 'voice.html ID 唯一', vdups.length ? `重复：${vdups.join(', ')}` : `共 ${vids.length} 个`);
  for (const id of ['volRange', 'volLabel', 'volReset', 'normBox', 'loudnessSel', 'previewBtn']) {
    ok(vids.includes(id), `音量控件 ${id}`);
  }
  ok(/id="volRange"[^>]*min="10"[^>]*max="400"/.test(voice), '滑块范围 10%~400%');
  ok(/volRange'\)\.addEventListener\('input'/.test(voice), '滑块 input 事件已绑定');
  ok(/previewBtn'\)\.addEventListener/.test(voice), '试听按钮已绑定');
  ok(/api\/preview/.test(voice), '试听调 /api/preview（听处理后的效果）');
  ok(/body\.normalize = true/.test(voice) && /body\.volume = volValue\(\)/.test(voice), '发送时带上音量设置');
  const vscripts = [...voice.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { new Function(vscripts[0]); ok(true, 'voice.html 前端 JS 可解析'); }
  catch (e) { ok(false, 'voice.html 前端 JS 可解析', e.message); }
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
