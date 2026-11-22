// 收藏表情同步「启动时没连上 → 连上后补同步」的回归测试（2026-10-27）。
//
// 真实故障（已出现 3 次）：桥接启动时立刻同步收藏表情，此时 SnowLuma 还没起来 →
// WS 失败 → OneBot HTTP 兜底也失败（fetch failed）→ 旧实现**不再重试**，
// 表情包功能一直坏到下次重启；而且「同步收藏表情失败」被控制台判成 error，
// 每次重启都在「最近错误/告警」里留一条红字。
//
// 本文件覆盖：
//   1) 纯调度器：1s/2s/4s/8s/16s 退避、最多 5 次、用尽即停（假时钟，不真等 31 秒）；
//   2) 纯调度器：启动时失败 → SnowLuma 连上（onConnected）→ 立即补同步成功，
//      并取消待执行的退避重试；
//   3) 纯调度器：防重入（同步在跑时 start / onConnected 不会并发打两次网关）；
//   4) 失败文案中性化（不含控制台 classify() 会判成 error/warn 的关键词）；
//   5) 真实 bridge 接线（VM harness）：启动预热失败 → bot.emit('open') → 补同步走 WS，
//      日志出现「已同步 QQ 收藏表情 …（via ws）」，且不再出现旧的「同步收藏表情失败」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  createStickerSyncScheduler,
  describeStickerSyncFailure,
  DEFAULT_STICKER_RETRY_DELAYS
} from '../src/sticker-sync-retry.js';

let tests = 0;
let failures = 0;
async function test(name, run) {
  tests += 1;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

/** 假时钟：只实现调度器用到的 now/setTimer/clearTimer，并允许"快进"。 */
function createFakeClock() {
  let current = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: current + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    /** 待执行的定时器还剩多少毫秒（升序）。 */
    pending() {
      return [...timers.values()].map((t) => Math.max(0, t.at - current)).sort((a, b) => a - b);
    },
    /** 快进 ms 毫秒，按触发时间顺序执行定时器，并让异步同步跑完。 */
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        let nextId = null;
        let next = null;
        for (const [id, timer] of timers) {
          if (!next || timer.at < next.at) { next = timer; nextId = id; }
        }
        if (!next || next.at > target) break;
        timers.delete(nextId);
        current = next.at;
        next.fn();
        await tick(); // 等 run() 里的 await sync(...) 走完并安排下一个定时器
      }
      current = target;
    }
  };
}

// 控制台 classify() 判定 error/warn 时会用的关键词（见 console/server.mjs）。
const ALARM_WORDS = /失败|错误|异常|崩溃|无法连接|拒绝连接|ECONNREFUSED|EADDRINUSE|⚠️/;

await test('失败按 1s/2s/4s/8s/16s 退避，最多 5 次后停止', async () => {
  const clock = createFakeClock();
  const logs = [];
  const debugLogs = [];
  let calls = 0;
  const scheduler = createStickerSyncScheduler({
    sync: async () => { calls += 1; return null; },
    log: (message) => logs.push(message),
    logDebug: (message) => debugLogs.push(message),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now
  });

  await scheduler.start();
  assert.equal(calls, 1, '启动预热只尝试一次');
  assert.deepEqual(clock.pending(), [1000], '首次失败后安排 1s 后重试');

  const expected = [
    { wait: 1000, calls: 2, next: 2000 },
    { wait: 2000, calls: 3, next: 4000 },
    { wait: 4000, calls: 4, next: 8000 },
    { wait: 8000, calls: 5, next: 16000 },
    { wait: 16000, calls: 6, next: null }
  ];
  for (const step of expected) {
    await clock.advance(step.wait);
    assert.equal(calls, step.calls, `第 ${step.calls - 1} 次重试应已发生`);
    assert.deepEqual(clock.pending(), step.next === null ? [] : [step.next]);
  }

  const state = scheduler.getState();
  assert.equal(state.attempts, 6, '1 次启动 + 5 次重试');
  assert.equal(state.failures, 6);
  assert.equal(state.successes, 0);
  assert.equal(state.exhausted, true, '5 次重试用尽后应停止自动重试');
  assert.equal(state.retryPending, false);
  assert.equal(state.nextRetryInMs, null);
  assert.deepEqual(state.delays, [...DEFAULT_STICKER_RETRY_DELAYS]);

  // 可见日志只有「首次失败」和「用尽」两行，后续重试只进 debug（避免刷屏）
  assert.equal(logs.filter((line) => line.includes('收藏表情暂未同步')).length, 1);
  assert.equal(logs.filter((line) => line.includes('已重试 5 次仍未接上')).length, 1);
  assert.equal(debugLogs.length, 5, '第 2~6 次尝试的失败只进 debug');
  for (const line of logs) {
    assert.ok(!ALARM_WORDS.test(line), `可见日志不得触发控制台告警面板：${line}`);
  }
});

await test('启动时没连上 → 连上后补同步成功，并取消待执行的退避重试', async () => {
  const clock = createFakeClock();
  const logs = [];
  let up = false;
  const forceArgs = [];
  const scheduler = createStickerSyncScheduler({
    sync: async (force) => {
      forceArgs.push(force);
      if (!up) return null;
      return { entries: [{ id: 'late-sticker' }], syncedAt: 1, fromCache: false, via: 'ws' };
    },
    log: (message) => logs.push(message),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now
  });

  // 1) 启动预热：SnowLuma 还没起来，WS/HTTP 都失败
  await scheduler.start();
  assert.deepEqual(clock.pending(), [1000], '失败后应有待执行的退避重试');
  assert.equal(scheduler.getState().successes, 0);
  assert.ok(logs.some((line) => line.includes('收藏表情暂未同步')), '应有一条中性失败日志');

  // 2) SnowLuma 连上：立刻补同步，不等 1s 的退避
  up = true;
  const result = await scheduler.onConnected();
  assert.ok(result && result.via === 'ws', '连上后补同步应走 WS', String(result));
  assert.deepEqual(forceArgs, [true, true], '启动与连上补同步都应强制刷新');
  assert.deepEqual(clock.pending(), [], '补同步成功后必须取消待执行的退避重试');

  const state = scheduler.getState();
  assert.equal(state.successes, 1);
  assert.equal(state.lastVia, 'ws');
  assert.equal(state.retryCount, 0);
  assert.equal(state.exhausted, false);
  assert.equal(state.retryPending, false);
  assert.equal(state.catchUps, 1, 'onConnected 应被记一次补同步');
  assert.ok(logs.some((line) => line.includes('收藏表情补同步已恢复')), '恢复时应有一条可见日志');
});

await test('连上时若启动同步还在跑（HTTP），等它收尾后补一次 WS 同步', async () => {
  const clock = createFakeClock();
  let call = 0;
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const scheduler = createStickerSyncScheduler({
    sync: () => {
      call += 1;
      if (call === 1) return first; // 启动预热：模拟 HTTP 请求正在慢慢返回
      return Promise.resolve({ entries: [], syncedAt: call, fromCache: false, via: 'ws' });
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now
  });

  const startup = scheduler.start();       // 第 1 次：挂起中（HTTP）
  await tick();
  const catchUp = scheduler.onConnected(); // 恰好这时 WS 连上
  await tick();
  assert.equal(call, 1, '启动同步没结束前不得并发第二次请求');

  releaseFirst({ entries: [], syncedAt: 1, fromCache: false, via: 'http' });
  await startup;
  const result = await catchUp;
  assert.equal(call, 2, '启动那次 HTTP 同步收尾后，应再补一次走 WS 的同步');
  assert.equal(result?.via, 'ws', '补同步必须走 WS 主链路，而不是并进 HTTP 那次');
  const state = scheduler.getState();
  assert.equal(state.attempts, 2);
  assert.equal(state.lastVia, 'ws');
  assert.equal(state.catchUps, 1);
});

await test('防重入：同步在跑时 start/onConnected 共用同一次请求', async () => {
  const clock = createFakeClock();
  const forceArgs = [];
  let release;
  const scheduler = createStickerSyncScheduler({
    sync: (force) => {
      forceArgs.push(force);
      return new Promise((resolve) => { release = resolve; });
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now
  });

  const first = scheduler.start();
  await tick(); // 让第一次真正进入 sync（此时 inFlight 已置位）
  const catchUp = scheduler.onConnected();
  const again = scheduler.start();
  assert.equal(forceArgs.length, 1, '同步进行中不应再打一次网关');

  release({ entries: [], syncedAt: 1, fromCache: false, via: 'ws' });
  await Promise.all([first, catchUp, again]);
  const state = scheduler.getState();
  assert.equal(state.attempts, 1);
  assert.equal(state.successes, 1);
  assert.equal(state.catchUps, 1);
});

await test('表情包体系关闭时不重试', async () => {
  let calls = 0;
  const scheduler = createStickerSyncScheduler({
    sync: async () => { calls += 1; return null; },
    isEnabled: () => false
  });
  const result = await scheduler.start();
  assert.equal(result, null);
  assert.equal(calls, 0, '关闭时不该发请求');
  assert.equal(scheduler.getState().status, 'disabled');
});

await test('失败原因翻译成中性文案（不触发控制台错误/告警）', async () => {
  const cases = [
    new Error('fetch failed'),
    new Error('SnowLuma WebSocket closed before opening'),
    new Error('OneBot HTTP fetch_custom_face_detail 失败: 0'),
    new Error('connect ECONNREFUSED 127.0.0.1:3000'),
    new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步')
  ];
  for (const error of cases) {
    const text = describeStickerSyncFailure(error);
    assert.ok(text.length > 0, '必须给出可读原因');
    assert.ok(!ALARM_WORDS.test(text), `中性文案不得带告警关键词：${text}`);
  }
  assert.equal(describeStickerSyncFailure(new Error('fetch failed')), 'SnowLuma/OneBot 网关暂时连不上');
});

// ── 真实 bridge 接线：启动预热失败 → bot.on('open') → 补同步走 WS ─────────────
const lateSticker = {
  emoji_id: 'late-sticker',
  resId: 'late-sticker',
  url: 'https://public.invalid/late-sticker',
  md5: '00112233445566778899AABBCCDDEEFF',
  desc: '晚到的收藏表情'
};
const gateway = { up: false };

/** 模拟 SnowLuma 尚未就绪：WS request 抛「closed before opening」，HTTP fetch 抛 fetch failed。 */
class LateBot {
  onPrivateMessage() {}
  onGroupMessage() {}
  onNotice() {}
  onEvent() {}
  async request(action) {
    if (!gateway.up) throw new Error('SnowLuma WebSocket closed before opening');
    if (action === 'fetch_custom_face_detail') {
      return { status: 'ok', retcode: 0, data: [lateSticker] };
    }
    return { status: 'ok', retcode: 0, data: {} };
  }
  async getImage() { return null; }
  async fetchFaceEntity() { return null; }
  async sendPrivateMessage() {}
  async sendGroupMessage() {}
  async connect() {}
  close() {}
}

const stickerHttpCalls = [];
async function lateFetch(url) {
  const action = String(url).split('/').pop();
  if (!gateway.up) {
    // 记录「启动时 HTTP 兜底也失败」的那一次尝试；连上之后就不该再出现。
    if (action === 'fetch_custom_face_detail') stickerHttpCalls.push(action);
    throw new Error('fetch failed');
  }
  if (action === 'fetch_custom_face_detail') {
    stickerHttpCalls.push(action);
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', retcode: 0, data: [lateSticker] })
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 'ok', retcode: 0, data: { online: true, good: true, user_id: 123, nickname: 'late-bot' } })
  };
}

async function waitFor(predicate, { timeoutMs = 3000, label = '条件' } = {}) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

await test('真实接线：启动预热失败 → SnowLuma 连上后补同步（via ws）', async () => {
  gateway.up = false;
  stickerHttpCalls.length = 0;
  const h = await bridgeHarness({
    globals: { SnowLumaWebSocketClient: LateBot, fetch: lateFetch }
  });
  try {
    h.setMode('reserved2');
    const scheduler = h.stickerSyncScheduler;
    assert.ok(scheduler, 'harness 应暴露 stickerSyncScheduler');
    assert.equal(scheduler.getState().attempts, 0, 'harness 在启动预热之前返回，这里手动触发');

    // 1) 启动预热：WS 没连上（snowlumaHealth.connected=false）+ HTTP 也抛 fetch failed
    await scheduler.start();
    let state = scheduler.getState();
    assert.equal(state.successes, 0, '网关没起来时同步必然失败');
    assert.equal(state.retryPending, true, '失败后应安排退避重试');
    assert.ok(state.nextRetryInMs > 0 && state.nextRetryInMs <= 1000, `首次退避应约 1s，实际 ${state.nextRetryInMs}`);

    const logPath = path.join(h.temp, 'state', 'bridge.log');
    const readLogs = () => fs.readFileSync(logPath, 'utf8');
    const failureLine = readLogs().split(/\r?\n/).find((line) => line.includes('收藏表情暂未同步'));
    assert.ok(failureLine, '应有中性的失败日志');
    assert.ok(!ALARM_WORDS.test(failureLine), `失败日志已降级，不应进「最近错误/告警」：${failureLine}`);
    assert.ok(failureLine.includes('网关暂时连不上'), `失败日志应带可读原因（sync 内部吞异常后要靠 onFailure 回传）：${failureLine}`);
    assert.ok(!readLogs().includes('同步收藏表情失败'), '旧的「同步收藏表情失败」文案不应再出现');

    // 2) SnowLuma 就绪：触发真实注册的 bot.on('open')
    gateway.up = true;
    h.bot.emit('open');
    await waitFor(() => scheduler.getState().successes >= 1, { label: '连上后的补同步' });

    state = scheduler.getState();
    assert.equal(state.lastVia, 'ws', '连上后补同步应走 WS 主链路');
    assert.equal(state.retryPending, false, '补同步成功后应取消待执行的退避重试');
    assert.equal(stickerHttpCalls.length, 1, 'HTTP 兜底只在启动时尝试过一次；WS 连上后不应再走 HTTP');

    const logs = readLogs();
    assert.ok(/已同步 QQ 收藏表情 1 个（本地库 \d+ 条，via ws）/.test(logs), `日志应出现 via ws 的同步成功行：\n${logs}`);
    assert.ok(!/\[sticker\] 失败/.test(logs), '不应出现 sticker 失败日志');

    // 3) 表情库真的可用（TTL 内直接读缓存，不再打网关）
    const list = await h.listStickersForV2('', 10, false);
    assert.ok(list.total >= 1, '补同步后表情库应可用');
    assert.ok(list.stickers.some((item) => item.id === 'late-sticker'), '新收藏的表情应已入库');
  } finally {
    await h.close();
  }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
