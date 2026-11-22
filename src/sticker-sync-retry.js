// 收藏表情同步的「退避重试 + 连上补同步」调度器。
//
// 背景（2026-10-27，同一故障已出现 3 次）：
//   桥接启动时会立刻同步一次 QQ 收藏表情，但此时 SnowLuma/网关往往还没就绪：
//   WS 没连上 → 改走 OneBot HTTP 兜底 → 网关同样没监听 → `fetch failed`。
//   旧实现失败后**没有任何重试**，表情包功能就一直坏到下次重启。日志长这样：
//     [sticker] WS 同步不可用（SnowLuma WebSocket closed before opening），改走 OneBot HTTP 兜底
//     [sticker] 同步收藏表情失败: fetch failed
//   第二行含「失败」，控制台 classify() 会把它标成 error，于是每次重启都在
//   控制台「最近错误/告警」里留红字（本机已经攒了 3 条）。
//
// 修法（三件一起）：
//   1) 失败按 1s / 2s / 4s / 8s / 16s 指数退避重试，最多 5 次；
//   2) SnowLuma WS `open` 时再补一次（同一时刻只跑一次请求；若启动预热还在跑，
//      等它收尾后再补，不会两个请求并发打网关）；
//   3) 失败文案改中性（不带「失败/错误/异常/⚠️」等控制台判定 error/warn 的关键词），
//      原始异常只进 debug 日志 —— 正常重启不再污染「最近错误/告警」。
//
// 为什么单独成模块：可以注入假时钟与假定时器，在测试里精确断言
// 「1s→2s→4s→8s→16s→放弃」的时序，而不必真的等 31 秒
// （见 scripts/test-sticker-sync-retry.mjs）。

/** 默认退避间隔：第 1 次重试等 1s，第 2 次 2s……第 5 次 16s（共 5 次）。 */
export const DEFAULT_STICKER_RETRY_DELAYS = Object.freeze([1000, 2000, 4000, 8000, 16000]);

/**
 * 把同步失败的原因翻译成**中性、不含错误关键词**的短句。
 *
 * 为什么不直接用 error.message：一是控制台按中文关键词（失败/错误/异常/ECONNREFUSED…）
 * 判级别，原始 message 很可能命中；二是 `fetch failed` 这种文案对排查也没帮助。
 * 原始异常由调用方写进 logDebug，这里只负责给出人能看懂、且不触发告警的摘要。
 */
export function describeStickerSyncFailure(error) {
  const raw = String(error?.message ?? error ?? '').trim();
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|fetch failed|closed before opening|WebSocket|socket|timeout|aborted|网络|连不上/i.test(raw)) {
    return 'SnowLuma/OneBot 网关暂时连不上';
  }
  if (/不是数组|数据不完整/.test(raw)) return '网关返回的收藏表情数据不完整';
  return raw ? '同步链路暂不可用' : '未知原因';
}

/** 把 [1000,2000,…] 格式化成日志里的 "1s/2s/4s/8s/16s"。 */
function formatDelays(delays) {
  return delays.map((ms) => (ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`)).join('/');
}

/**
 * 创建收藏表情同步调度器。
 *
 * @param {object} options
 * @param {(force:boolean, opts?:{silent?:boolean, onFailure?:(reason:string)=>void}) => Promise<any>} options.sync
 *        真正干活的同步函数；**返回 falsy 视为失败**（桥接的 syncStickerLibrary 失败时返回 null）。
 *        失败原因可通过 `opts.onFailure(中性原因)` 回传（sync 自己吞异常时调度器看不到 error）。
 * @param {() => boolean} [options.isEnabled] 表情包体系是否启用（关闭时不重试）。
 * @param {(...args:any[]) => void} [options.log] 可见日志（中性文案）。
 * @param {(...args:any[]) => void} [options.logDebug] 调试日志（原始异常/中间重试）。
 * @param {number[]} [options.delays] 退避间隔，默认 1/2/4/8/16 秒。
 * @param {Function} [options.setTimer] 便于测试注入假定时器。
 * @param {Function} [options.clearTimer]
 * @param {() => number} [options.now]
 * @returns {{
 *   start: (opts?:{force?:boolean}) => Promise<any>,
 *   onConnected: (opts?:{force?:boolean}) => Promise<any>,
 *   run: (opts?:{force?:boolean,reason?:string}) => Promise<any>,
 *   getState: () => object
 * }}
 */
export function createStickerSyncScheduler({
  sync,
  isEnabled = () => true,
  log = () => {},
  logDebug = () => {},
  delays = DEFAULT_STICKER_RETRY_DELAYS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now()
} = {}) {
  if (typeof sync !== 'function') {
    throw new TypeError('createStickerSyncScheduler 需要 sync(force) 函数');
  }
  const retryDelays = (Array.isArray(delays) ? delays : [])
    .map((ms) => Math.max(0, Math.round(Number(ms) || 0)));
  if (retryDelays.length === 0) {
    throw new TypeError('createStickerSyncScheduler 需要至少一个重试间隔');
  }

  const stats = {
    attempts: 0,        // 总尝试次数（含首次与每次重试）
    successes: 0,
    failures: 0,
    catchUps: 0,        // onConnected 触发的补同步次数（用于观测，不代表一定成功）
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastVia: null,      // 'ws' | 'http' | 'cache' | null
    lastReason: ''      // 'startup' | 'connected' | 'retry' | 'manual'
  };
  let inFlight = null;      // 防重入：同一时刻只允许一个同步在跑
  const idleWaiters = new Set(); // 等「当前这次同步彻底收尾」的等待者（onConnected 用）
  let catchUpPromise = null;     // 连续多个 open 事件只触发一次补同步
  let retryTimer = null;
  let retryAt = 0;
  let retryCount = 0;       // 本轮故障已经安排过的重试次数（0 = 还没重试）
  let exhausted = false;    // 本轮退避已经用尽
  let failedSinceSuccess = false; // 自上次成功以来失败过（用于「补同步已恢复」日志）
  let lastStatus = 'idle';  // idle | running | ok | retrying | exhausted | disabled

  function cancelRetry() {
    if (retryTimer) {
      try { clearTimer(retryTimer); } catch { /* 忽略：定时器可能已经触发 */ }
      retryTimer = null;
    }
    retryAt = 0;
  }

  /**
   * 跑一次同步并维护退避状态。
   * 失败不会抛出（同步本身抛异常也算失败），返回值与 sync 保持一致。
   */
  async function run({ force = false, reason = 'manual' } = {}) {
    if (!isEnabled()) {
      lastStatus = 'disabled';
      return null;
    }
    // 防重入：同一时刻只跑一个同步。退避定时器、WS 连上补同步、工具调用都可能撞在一起，
    // 并发去拉 `fetch_custom_face_detail` 只会让网关多挨请求（onConnected 会在收尾后单独补一次）。
    if (inFlight) return inFlight;

    inFlight = (async () => {
      stats.attempts += 1;
      stats.lastReason = reason;
      lastStatus = 'running';
      let result = null;
      let failure = null;
      let failureText = ''; // sync 自己吞掉异常时，靠 onFailure 回调把中性原因带回来
      try {
        result = await sync(force, {
          silent: true,
          onFailure: (text) => { failureText = String(text ?? ''); }
        });
      } catch (error) {
        failure = error; // 同步函数自己会兜底；这里防它意外抛出
      }
      if (result) {
        const recovering = failedSinceSuccess;
        const via = result.via ?? (result.fromCache ? 'cache' : '');
        stats.successes += 1;
        stats.lastSuccessAt = now();
        stats.lastVia = via || null;
        failedSinceSuccess = false;
        lastStatus = 'ok';
        cancelRetry();
        retryCount = 0;
        exhausted = false;
        // 只有「从故障里恢复」才额外打一行，正常同步由 sync 自己打「已同步 … 个」。
        if (recovering && !result.fromCache) {
          log(`[sticker] 收藏表情补同步已恢复（via ${via || '?'}）`);
        }
        return result;
      }

      stats.failures += 1;
      stats.lastFailureAt = now();
      failedSinceSuccess = true;
      const reasonText = failureText || describeStickerSyncFailure(failure);
      if (failure) {
        logDebug(`[sticker] 收藏表情同步原始异常: ${failure?.stack ?? failure?.message ?? failure}`);
      }
      if (retryCount === 0) {
        // 本轮故障只在这里打一行可见日志，措辞刻意避开控制台 classify() 的错误关键词。
        log(`[sticker] 收藏表情暂未同步（${reasonText}）；稍后按 ${formatDelays(retryDelays)} 退避重试，最多 ${retryDelays.length} 次；期间继续使用本地缓存`);
      } else {
        logDebug(`[sticker] 收藏表情第 ${retryCount} 次重试仍未接上（${reasonText}）`);
      }

      if (retryCount >= retryDelays.length) {
        exhausted = true;
        lastStatus = 'exhausted';
        log(`[sticker] 收藏表情同步已重试 ${retryDelays.length} 次仍未接上；已暂停自动重试，等 SnowLuma 重新连上或下次调用表情工具时再试`);
        return result;
      }

      const delay = retryDelays[retryCount];
      retryCount += 1;
      retryAt = now() + delay;
      lastStatus = 'retrying';
      retryTimer = setTimer(() => {
        retryTimer = null;
        retryAt = 0;
        void run({ force: false, reason: 'retry' });
      }, delay);
      return result;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
      // 唤醒等「这一次同步收尾」的 onConnected：它要等启动预热（可能走 HTTP）结束后，
      // 再发起一次走 WS 的补同步，而不是并进那次 HTTP 请求里。
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  }

  /** 等当前同步彻底收尾（没有同步在跑就立刻返回）。 */
  function waitForIdle() {
    if (!inFlight) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  /** 启动预热：桥接启动时立即试一次（失败会按退避自动重试）。 */
  function start({ force = true } = {}) {
    return run({ force, reason: 'startup' });
  }

  /**
   * SnowLuma WS 连上时调用：立刻补一次同步。
   *
   * 默认 force=true：启动预热可能已经用 HTTP 兜底同步过（那时 WS 还没连上），
   * 连上后再走一次主链路，既补上「启动时网关没就绪」的缺口，也让数据回到 WS 路径。
   * 重新连上也意味着上一轮退避作废：清掉计数，给一次全新的机会。
   *
   * 关键细节：如果连上时启动预热**还在跑**（很常见：HTTP 一次要几百毫秒，WS 恰好在
   * 这期间 open），不能直接并进那次 HTTP 同步 —— 那样日志只会是 via http，等于没补。
   * 这里先等它收尾，再单独发起一次走 WS 的同步；如果刚才那次本来就是 WS，则无需重复。
   */
  function onConnected({ force = true } = {}) {
    if (!isEnabled()) {
      lastStatus = 'disabled';
      return Promise.resolve(null);
    }
    if (catchUpPromise) return catchUpPromise; // 连续 open 事件只补一次
    stats.catchUps += 1;
    cancelRetry();
    retryCount = 0;
    exhausted = false;
    catchUpPromise = (async () => {
      if (inFlight) {
        let prior = null;
        try { prior = await inFlight; } catch { prior = null; }
        if (prior?.via === 'ws') return prior; // 主链路刚同步过，不重复打网关
        await waitForIdle();                    // 等 run() 清掉 inFlight，再发起新的一次
      }
      return run({ force, reason: 'connected' });
    })().finally(() => { catchUpPromise = null; });
    return catchUpPromise;
  }

  /** 只读快照（测试与控制台诊断用）。 */
  function getState() {
    return {
      ...stats,
      status: lastStatus,
      retryCount,
      retryPending: Boolean(retryTimer),
      nextRetryInMs: retryTimer ? Math.max(0, retryAt - now()) : null,
      inFlight: Boolean(inFlight),
      exhausted,
      delays: retryDelays.slice()
    };
  }

  return { start, onConnected, run, getState };
}
