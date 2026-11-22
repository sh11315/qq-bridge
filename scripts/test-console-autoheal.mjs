// 自愈守护测试：判定逻辑单测 + console/server.mjs 静态契约 + 配置开关口径。
//
// 为什么不启真实服务：拉起 DSH/NapCat 要几十秒且会动真进程；
// 真正容易写错的是「掉线 / 冷却 / 开关」的判定，所以把判定抽进
// console/autoheal.mjs 后用纯函数测，剩下的用静态契约钉住接线方式。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTOHEAL_COOLDOWN_MS,
  AUTOHEAL_INTERVAL_MS,
  AUTOHEAL_SERVICES,
  autoHealEnabled,
  decideHeal,
} from '../console/autoheal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'console', 'server.mjs'), 'utf8');
const healSrc = fs.readFileSync(path.join(ROOT, 'console', 'autoheal.mjs'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ---------------------------------------------------------------- 1. 常量
console.log('## 检查间隔 / 冷却');
ok(AUTOHEAL_INTERVAL_MS === 30_000, '检查间隔 30s', `${AUTOHEAL_INTERVAL_MS}ms`);
ok(AUTOHEAL_COOLDOWN_MS === 90_000, '同一服务冷却 90s', `${AUTOHEAL_COOLDOWN_MS}ms`);
ok(
  AUTOHEAL_SERVICES.map((s) => s.key).join(',') === 'dsh,napcat,bridge,workbuddy',
  '拉起顺序 DSH → NapCat → 桥接 → WorkBuddy LAN',
  AUTOHEAL_SERVICES.map((s) => `${s.key}/${s.label}`).join(' '),
);

// ---------------------------------------------------------------- 2. 开关
console.log('## unifiedConsole.autoHeal 开关（默认 true）');
ok(autoHealEnabled(undefined) === true, '没写 unifiedConsole → 默认开启');
ok(autoHealEnabled({}) === true, '没写 autoHeal → 默认开启');
ok(autoHealEnabled({ autoHeal: true }) === true, 'autoHeal:true → 开启');
ok(autoHealEnabled({ autoHeal: false }) === false, 'autoHeal:false → 关闭');
ok(autoHealEnabled({ autoHeal: 'false' }) === false, 'autoHeal:"false" → 关闭（容忍字符串）');
ok(autoHealEnabled({ autoHeal: 0 }) === false, 'autoHeal:0 → 关闭（容忍数字）');
ok(autoHealEnabled({ autoHeal: 'true' }) === true, 'autoHeal:"true" → 开启');

// ---------------------------------------------------------------- 3. 判定逻辑
console.log('## decideHeal 判定');
ok(decideHeal({ up: true }).heal === false && decideHeal({ up: true }).reason === 'up', '端口可连 → 不拉起');

const first = decideHeal({ up: false, lastAttemptAt: 0, now: 1_000_000 });
ok(first.heal === true && first.reason === 'down', '从未拉过且掉线 → 立刻拉起');

const cooling = decideHeal({ up: false, lastAttemptAt: 1_000_000, now: 1_000_000 + 30_000 });
ok(cooling.heal === false && cooling.reason === 'cooldown', '30s 前刚拉过且仍掉线 → 冷却，不重复拉起');
ok(cooling.waitMs === 60_000, '冷却剩余时间正确', `${cooling.waitMs}ms`);

const edge = decideHeal({ up: false, lastAttemptAt: 1_000_000, now: 1_000_000 + 89_999 });
ok(edge.heal === false && edge.waitMs === 1, '89.999s 仍在冷却（差 1ms）');
const after = decideHeal({ up: false, lastAttemptAt: 1_000_000, now: 1_000_000 + 90_000 });
ok(after.heal === true, '满 90s → 允许再拉');

const future = decideHeal({ up: false, lastAttemptAt: 1_000_000, now: 900_000 });
ok(future.heal === false && future.reason === 'cooldown', '时钟回拨（上次尝试在未来）也按冷却处理，绝不风暴');

// 时间线模拟：掉线 → 拉起 → 30s 后还掉线 → 跳过 → 90s 后重试
console.log('## 时间线模拟（失败风暴防护）');
{
  let lastAttemptAt = 0;
  const timeline = [];
  for (const t of [0, 30_000, 60_000, 89_000, 90_000, 120_000]) {
    const d = decideHeal({ up: false, lastAttemptAt, now: 1_000_000 + t });
    if (d.heal) { lastAttemptAt = 1_000_000 + t; timeline.push(`${t / 1000}s:拉`); }
    else timeline.push(`${t / 1000}s:跳过`);
  }
  ok(
    timeline.join(' ') === '0s:拉 30s:跳过 60s:跳过 89s:跳过 90s:拉 120s:跳过',
    '90s 内最多拉起一次（拉起失败后进入冷却）',
    timeline.join(' '),
  );
}

// ---------------------------------------------------------------- 4. 纯函数边界
console.log('## autoheal.mjs 是纯逻辑模块');
ok(!/from ['"]node:(fs|net|http|https|child_process)['"]/.test(healSrc), '不 import 任何 IO 模块（可单测）');
ok(!/process\.env/.test(healSrc), '不读环境变量（配置由调用方传入）');

// ---------------------------------------------------------------- 5. server.mjs 静态契约
console.log('## console/server.mjs 接线契约');
ok(/from '\.\/autoheal\.mjs'/.test(serverSrc), '从 ./autoheal.mjs 引入判定逻辑');
ok(/AUTOHEAL_INTERVAL_MS/.test(serverSrc) && /AUTOHEAL_COOLDOWN_MS/.test(serverSrc), '使用统一常量（30s / 90s）');
ok(/AUTOHEAL_SERVICES/.test(serverSrc), '守护服务清单来自模块，不在 server 里另写一份');

// 四个服务 → 端口 / start 函数必须一一对应
ok(
  /function autoHealPort\(key\) \{\s*if \(key === 'dsh'\) return paths\.dshPort;\s*if \(key === 'napcat'\) return paths\.napcatWsPort;\s*if \(key === 'workbuddy'\) return paths\.workbuddyPort;\s*return paths\.bridgePort;/.test(serverSrc),
  '端口映射：dsh→paths.dshPort / napcat→paths.napcatWsPort / workbuddy→paths.workbuddyPort / bridge→paths.bridgePort',
);
ok(
  /function autoHealStart\(key\) \{\s*if \(key === 'dsh'\) return startDsh\(\);\s*if \(key === 'napcat'\) return startNapcat\(\);\s*if \(key === 'workbuddy'\) return startWorkbuddy\(\);\s*return startBridge\(\);/.test(serverSrc),
  '拉起映射：dsh→startDsh / napcat→startNapcat / workbuddy→startWorkbuddy / bridge→startBridge',
);
ok(
  /key === 'workbuddy' && \(!paths\.workbuddyDir \|\| !paths\.workbuddyAutoStart\)\) continue;/.test(serverSrc),
  'WorkBuddy 未配置目录或未开自启时，自愈跳过它',
);
ok(/(?:const|let) up = await probe\(port\);/.test(serverSrc), '每个服务探活用 probe(port)');
ok(/decideHeal\(\{[\s\S]{0,220}cooldownMs: AUTOHEAL_COOLDOWN_MS,/.test(serverSrc), '判定走 decideHeal + 90s 冷却');
ok(/paths = runtimePaths\(\);[\s\S]{0,200}autoHealEnabled\(paths\.unified\)/.test(serverSrc), '每轮重读 config（autoHeal 改了下一轮生效）');
ok(/config\.json 解析失败，本轮跳过/.test(serverSrc), 'config.json 解析失败时不动（不按默认端口拉错实例）');
ok(/autoHealEnabledLogged/.test(serverSrc), '开关状态只在变化时打日志');

// 定时器：链式 setTimeout，防叠轮；不用 setInterval
ok(
  /autoHealTimer = setTimeout\(loop, AUTOHEAL_INTERVAL_MS\)/.test(serverSrc),
  '用 setTimeout 链式调度（拉起耗时长也不会叠轮）',
);
ok(!/setInterval\([^)]*autoHeal/i.test(serverSrc), '没有对自愈用 setInterval');

// 定时器只在 listen 成功后启动
{
  const listenAt = serverSrc.indexOf('server.listen(paths.port');
  const callAt = serverSrc.indexOf('startAutoHealGuard();');
  const defAt = serverSrc.indexOf('function startAutoHealGuard()');
  const occurrences = (serverSrc.match(/startAutoHealGuard\(\)/g) || []).length;
  ok(listenAt > 0 && callAt > listenAt, 'startAutoHealGuard() 调用在 server.listen 之后', `listen@${listenAt} call@${callAt}`);
  ok(defAt > 0 && defAt < listenAt, '先定义守护函数，后监听端口');
  ok(occurrences === 2, 'startAutoHealGuard() 只有「定义 + 一次调用」', `${occurrences} 处`);
  const listenBlock = serverSrc.slice(listenAt, serverSrc.indexOf('});', listenAt));
  ok(listenBlock.includes('startAutoHealGuard();'), '调用位于 listen 成功回调内部');
}

// 手动启停让路
ok(/lifecycleDepth > 0\) return;/.test(serverSrc), '手动启停进行中时自愈跳过本轮');
ok(/await withLifecycle\(startAll\)/.test(serverSrc) && /await withLifecycle\(stopAll\)/.test(serverSrc), '/api/start、/api/stop 走 withLifecycle');
ok(/withLifecycle\(async \(\) => \{[\s\S]{0,200}stopAll\(\)[\s\S]{0,200}startAll\(\)/.test(serverSrc), '/api/restart 走 withLifecycle');
ok(/withLifecycle\(async \(\) => \{[\s\S]{0,260}startNapcat\(\)/.test(serverSrc), '/api/service/* 走 withLifecycle');

// 日志文案（对外可见的契约）
ok(/自愈守护已启动（每 \$\{AUTOHEAL_INTERVAL_MS \/ 1000\}s 检查一次）/.test(serverSrc), '启动日志：自愈守护已启动（每 30s 检查一次）');
ok(/自愈：\$\{svc\.label\} 掉线（端口 \$\{port\} 无响应），自动拉起…/.test(serverSrc), '拉起日志：服务 掉线（端口 X 无响应），自动拉起…');
ok(/自愈：\$\{svc\.label\} 已恢复（端口 \$\{port\} 可连）/.test(serverSrc), '成功日志：服务 已恢复（端口 X 可连）');
ok(/自愈：\$\{svc\.label\} 拉起失败（端口 \$\{port\} 仍无响应/.test(serverSrc), '失败日志：服务 拉起失败（端口 X 仍无响应…）');
ok(/仍在冷却（剩余 \$\{Math\.ceil\(decision\.waitMs \/ 1000\)\}s），本轮跳过/.test(serverSrc), '冷却日志：仍在冷却（剩余 Ns）');
ok(/unifiedConsole\.autoHeal=false，守护已暂停/.test(serverSrc), '关闭日志：autoHeal=false，守护已暂停');
ok(/autoHeal: autoHealSnapshot\(\)/.test(serverSrc), '/api/status 暴露 autoHeal 快照（便于排查）');

// ---------------------------------------------------------------- 6. 配置文件同步
console.log('## 配置开关落盘');
const readCfg = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/^\uFEFF/, ''));
for (const name of ['config.json', 'config.example.json']) {
  const cfg = readCfg(name);
  ok(cfg.unifiedConsole?.autoHeal === true, `${name} 的 unifiedConsole.autoHeal 默认 true（布尔）`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
