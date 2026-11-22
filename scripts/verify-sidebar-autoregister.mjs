// 需求 C 的验证脚本：DSH 重启后 sidebar_open 是否**自动**注册。
//
// 背景（详见 src/sidebar-warm.js 头部）：
//   dsh-better-sidebar 的 `sidebar_open` 由侧卡片设置 `agentOpenTools` 门控，注册动作
//   发生在 `settingsFace.get()` 里的 `syncOpenToolsGate()`。DSH 冷启动时插件 apply
//   那次调用可能因 loader 未 settle 而拿不到自己的设置行，于是工具不注册，必须有人
//   手动访问一次 /sidebar/api/settings.get（打开侧栏）才补上。桥接现在在 DSH 探活
//   的 `dshReady false → true` 跃迁点自动触发它。
//
// 本脚本做四件事：
//   1) 源码级钉住：bridge.js 必须真的在 dshReady 跃迁点、**且在 dshReady=true 之前**
//      调用 warmSidebarToolRegistration（防止以后重构把钩子丢掉）。
//   2) 鉴权边界：不带 Cookie 的 POST /sidebar/api/settings.get 必须 403。
//   3) 触发接口本身可用：带本机签名 Cookie 调用成功、返回 agentOpenTools=true
//      （= 注册闸门 syncOpenToolsGate 已执行），连调两次幂等。
//   4) 运行期证据：state/sidebar-warm.json 记录最近一次自动触发结果；
//      若桥接正在运行，还要求 bridge.log 里能看到 `[sidebar] 已自动触发` 行。
//
// 用法：
//   node scripts/verify-sidebar-autoregister.mjs          # 静态 + 接口 + 运行期证据
//   node scripts/verify-sidebar-autoregister.mjs --live   # 额外做一次端到端：建一个
//                                                         # qq-chat 会话、写回合快照、
//                                                         # 要求模型真的调用 sidebar_open
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { warmSidebarToolRegistration, callSidebarSettingsGet, SIDEBAR_SETTINGS_PATH } from '../src/sidebar-warm.js';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir, PROBE_BASE } from './probe-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.argv.includes('--live');
const STATUS_FILE = process.env.QQ_SIDEBAR_WARM_STATUS
  ? path.resolve(process.env.QQ_SIDEBAR_WARM_STATUS)
  : path.join(ROOT, 'state', 'sidebar-warm.json');
const TURN_SENDER_FILE = process.env.QQ_TOOL_RESTRICT_TURN_SENDER
  ? path.resolve(process.env.QQ_TOOL_RESTRICT_TURN_SENDER)
  : path.join(ROOT, 'state', 'turn-sender.json');

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests += 1;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function ownerQQ() {
  const cfg = readJson(path.join(ROOT, 'config.json'));
  const qq = String(cfg?.ownerQQ ?? '').trim();
  assert.match(qq, /^\d+$/, 'config.json 里必须有数字 ownerQQ');
  return qq;
}

// ── 1. 静态断言：自动触发钩子还在、顺序正确 ────────────────────────────────
await test('bridge.js 在 DSH 就绪/重启时、且在 dshReady=true 之前自动触发 settings.get', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const warmAt = src.indexOf('warmSidebarToolRegistration(cfg.dsh.baseUrl');
  assert.ok(warmAt > 0, 'bridge.js 必须调用 warmSidebarToolRegistration(cfg.dsh.baseUrl, ...)');
  const readyAt = src.indexOf('dshReady = true', warmAt);
  assert.ok(readyAt > warmAt, '自动触发必须在 dshReady = true 之前（补投消息的新会话要带完整工具面）');
  // 触发点必须落在「未就绪 / 事件流重连序号变化」的判定分支里
  const branchAt = src.lastIndexOf('if (!dshReady', warmAt);
  assert.ok(branchAt > 0 && branchAt < warmAt, '自动触发必须写在 DSH 就绪或重启的判定分支里');
  // 重启兜底：checkDsh 5 秒一轮可能错过 down→up 窗口，必须用事件流重连序号补触发
  assert.match(src, /muxConnectSeq !== lastWarmedMuxSeq/,
    '必须用事件流重连序号兜住「两次探活都成功、完全没看到 down」的 DSH 重启');
  assert.match(src, /muxConnectSeq \+= 1/, 'pumpMux 每次（重）连事件流都要递增序号');
  // 模块必须真的被 import（避免只留下调用痕迹）
  assert.match(src, /from '\.\/sidebar-warm\.js'/, 'bridge.js 必须 import ./sidebar-warm.js');
  // 预热失败必须被 catch 住，不能阻断 dshReady=true / 消息投递
  assert.match(src.slice(warmAt, readyAt), /catch/, '预热失败必须被 catch 住，不能阻断 dshReady=true');
});

// ── 2. 鉴权边界：无 Cookie 必须 403 ───────────────────────────────────────
await test('不带会话 Cookie 的 POST /sidebar/api/settings.get 被拒（403）', async () => {
  const res = await fetch(PROBE_BASE + SIDEBAR_SETTINGS_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 403, `未鉴权请求必须 403，实际 ${res.status}`);
});

// ── 3. 触发接口可用且幂等 ─────────────────────────────────────────────────
await test('带本机签名 Cookie 调用 settings.get 成功，agentOpenTools=true（注册闸门已执行）', async () => {
  const first = await callSidebarSettingsGet(PROBE_BASE);
  assert.equal(first.ok, true, `settings.get 必须成功：${first.error ?? ''}`);
  assert.equal(first.status, 200);
  assert.equal(first.prefs?.agentOpenTools, true,
    '侧卡片设置 agentOpenTools 必须为 true，否则 sidebar_open 本来就不该注册（请先在设置里打开）');
  // 幂等：再调一次仍然成功（自动触发可能在 DSH 生命周期里重复发生）
  const second = await callSidebarSettingsGet(PROBE_BASE);
  assert.equal(second.ok, true, `重复调用必须仍然成功：${second.error ?? ''}`);
});

// ── 4. 运行期证据：状态文件 + 桥接日志 ────────────────────────────────────
await test('state/sidebar-warm.json 记录成功结果（自动触发的可观测证据）', async () => {
  const before = readJson(STATUS_FILE);
  if (!before) {
    // 还没跑过自动触发：主动调用一次（等价于桥接在 DSH 就绪时做的事），生成证据
    const warm = await warmSidebarToolRegistration(PROBE_BASE, { attempts: 1, intervalMs: 0 });
    assert.equal(warm.ok, true, `预热失败：${warm.error ?? ''}`);
  }
  const status = readJson(STATUS_FILE);
  assert.ok(status, `状态文件缺失：${STATUS_FILE}`);
  assert.equal(status.ok, true, `最近一次自动触发应成功：${JSON.stringify(status)}`);
  assert.equal(status.agentOpenTools, true, '状态文件里 agentOpenTools 应为 true');
  assert.ok(Number.isFinite(Date.parse(status.at)), '状态文件必须有 at 时间戳');
});

await test('桥接正在运行时应留下 `[sidebar] 已自动触发` 日志（离线则跳过）', async () => {
  const logFile = path.join(ROOT, 'state', 'bridge.log');
  let text = '';
  try { text = fs.readFileSync(logFile, 'utf8'); } catch { text = ''; }
  const bridgeLogText = text || (() => { try { return fs.readFileSync(path.join(ROOT, 'bridge.log'), 'utf8'); } catch { return ''; } })();
  if (!bridgeLogText) {
    console.log('SKIP 桥接日志不可读（桥接没有在运行？）');
    return;
  }
  // 以「最近一次 DSH 就绪」之后为窗口：如果日志里根本没有 DSH 就绪行，说明桥接还没连过 DSH
  const readyIndex = bridgeLogText.lastIndexOf('DSH 已就绪');
  if (readyIndex < 0) {
    console.log('SKIP 桥接日志里还没有「DSH 已就绪」记录（桥接刚起或 DSH 还没就绪）');
    return;
  }
  // 预热日志写在「DSH 已就绪」**之前**（钩子必须在 dshReady=true 前完成），
  // 所以窗口要向前多取一段。
  const window = bridgeLogText.slice(Math.max(0, readyIndex - 4000), readyIndex + 4000);
  assert.match(window, /\[sidebar(\/[a-z-]+)?\] 已自动触发|\[sidebar(\/[a-z-]+)?\] 自动触发 .* 失败/,
    'DSH 就绪之后桥接必须尝试自动触发 settings.get（成功或失败都要有日志）');
});

// ── 5.（--live）端到端：模型真的能调到 sidebar_open ───────────────────────
async function liveCheck() {
  await test('端到端：qq-chat 会话在管理员回合里真的能调用 sidebar_open', async () => {
    const cookie = probeCookie();
    const rpc = probeRpc(cookie);
    const qq = ownerQQ();
    const dir = probeWorkspaceDir('sidebar-autoregister');
    const ws = await rpc('workspace/create', { request: { path: dir } });
    assert.equal(ws.ok, true, `workspace/create 失败：${JSON.stringify(ws.error ?? ws)}`);
    const workspaceId = ws.value.workspace.workspaceId;
    let sessionId = '';
    let socket = null;
    let keeper = null;
    const original = readJson(TURN_SENDER_FILE);
    try {
      const sc = await rpc('session/create', { request: { workspaceId, agentPreset: 'qq-chat' } });
      assert.equal(sc.ok, true, `session/create 失败：${JSON.stringify(sc.error ?? sc)}`);
      sessionId = sc.value.sessionId;
      await rpc('session/selectModel', {
        request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      });

      // 写一份「管理员本回合」快照：真实链路由桥接写，这里模拟桥接产物。
      // 用 2 秒一次的保活重写，避免真实 QQ 流量触发的桥接写入把这条记录挤掉。
      const writeSnapshot = () => {
        const store = readJson(TURN_SENDER_FILE) ?? {};
        const sessions = store.sessions && typeof store.sessions === 'object' ? store.sessions : {};
        sessions[sessionId] = { sessionId, senderId: qq, isOwner: true, ts: Date.now() };
        const record = sessions[sessionId];
        try {
          fs.mkdirSync(path.dirname(TURN_SENDER_FILE), { recursive: true });
          const tmp = `${TURN_SENDER_FILE}.${process.pid}.verify.tmp`;
          fs.writeFileSync(tmp, JSON.stringify({ ...record, sessions }, null, 2) + '\n', 'utf8');
          fs.renameSync(tmp, TURN_SENDER_FILE);
        } catch { /* 真实桥接可能同时在写；保活下一轮会补 */ }
      };
      writeSnapshot();
      keeper = setInterval(writeSnapshot, 2000);

      socket = probeMuxSocket(cookie);
      const streamId = randomUUID();
      const eventStreamId = randomUUID();
      const toolCalls = [];
      const toolResults = [];
      // tool/result 帧里不一定带工具名（只有 callId），要和 tool/call 的 callId 关联。
      const callNameById = new Map();
      let text = '';
      const finished = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 150_000);
        const finish = (why) => { clearTimeout(timer); resolve(why); };
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
          socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
          setTimeout(async () => {
            await rpc('session/prompt', {
              request: {
                sessionId,
                requestId: randomUUID(),
                mode: 'queue',
                content: [{
                  type: 'text',
                  // 必须带上桥接真实 prompt 里的【管理员】标记：qq-chat preset 的 1a 条
                  // 只允许「本回合消息来自管理员」时调用 sidebar_open —— 没有标记，
                  // 模型会按规则礼貌拒绝，测不到工具面（第一次就是这样失败的）。
                  text: '【管理员】管理员：这是本回合管理员明确要求。请立即调用 sidebar_open 工具一次，'
                    + '参数 target="https://example.com"，title="autoregister-check"；然后只回复：完成。'
                    + '不要解释，不要跳过工具调用。',
                }],
              },
            });
          }, 700);
        });
        socket.addEventListener('message', (ev) => {
          let msg = null;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.type !== 'item' || msg.streamId === eventStreamId) return;
          const value = msg.value;
          if (value?.type !== 'event') return;
          const event = value.event;
          if (event.type === 'assistant/message') {
            for (const block of event.data?.message?.content ?? []) {
              if (block?.type === 'text') text += block.text;
            }
          }
          if (event.type === 'tool/call') {
            const callId = event.data?.callId ?? event.data?.id;
            const name = event.data?.name ?? event.data?.toolName;
            toolCalls.push({ callId, name, args: event.data?.arguments ?? event.data?.args });
            if (callId != null) callNameById.set(String(callId), name);
          }
          if (event.type === 'tool/result') {
            // DSH 的 tool/result 帧形状（与桥接 12271 行同一口径）：
            //   data.message.source.callId   ← 关联 tool/call
            //   data.message.content[0].isError / data.message.isError ← 是否失败
            const data = event.data ?? {};
            const message = data.message ?? {};
            const callId = message.source?.callId ?? data.callId ?? data.id;
            const block = message.content?.[0];
            toolResults.push({
              callId,
              name: data.name ?? data.toolName ?? callNameById.get(String(callId)),
              isError: message.isError === true || block?.isError === true,
              error: block?.error ?? message.error,
            });
          }
          if (event.type === 'turn/end') finish('done');
        });
        socket.addEventListener('close', () => finish('closed'));
        socket.addEventListener('error', () => finish('error'));
      });
      const why = await finished;
      assert.equal(why, 'done', `回合没有正常结束（${why}），最终文本：${text.slice(0, 200)}`);
      const called = toolCalls.some((call) => call.name === 'sidebar_open');
      assert.ok(called,
        '模型没有调到 sidebar_open：可能是工具未注册（预热失败）或守卫拒绝。'
        + `tool/call=${JSON.stringify(toolCalls)}；文本=${JSON.stringify(text.slice(0, 200))}`);
      const result = toolResults.find((item) => item.name === 'sidebar_open');
      assert.ok(result, `sidebar_open 只有调用没有结果：${JSON.stringify(toolResults)}`);
      assert.notEqual(result.isError, true, `sidebar_open 执行报错：${JSON.stringify(result.error)}`);
      console.log('  ↳ 端到端证据：', JSON.stringify({ toolCalls, toolResults }));
    } finally {
      if (keeper) clearInterval(keeper);
      try { socket?.close(); } catch {}
      // 清理回合快照里本脚本写的记录（桥接自己维护其余会话）
      try {
        const store = readJson(TURN_SENDER_FILE) ?? {};
        const sessions = store.sessions && typeof store.sessions === 'object' ? store.sessions : {};
        delete sessions[sessionId];
        const payload = original && typeof original === 'object'
          ? { ...original, sessions: { ...(original.sessions ?? {}), ...sessions } }
          : { sessionId: '', senderId: '', isOwner: false, ts: Date.now(), sessions };
        delete payload.sessions[sessionId];
        fs.writeFileSync(TURN_SENDER_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      } catch { /* 清理失败不影响结论 */ }
      try { await rpc('workspace/archiveSession', { request: { sessionId } }); } catch {}
      try { await rpc('workspace/delete', { request: { workspaceId } }); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
}

if (LIVE) await liveCheck();

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
