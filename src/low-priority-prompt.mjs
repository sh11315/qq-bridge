/**
 * 低优先级会话写入：DSH `writer-held` 写锁冲突的退避重试与「跳过本轮」。
 *
 * ── 为什么需要这一层（2026-10-26 实测）
 *
 * DSH 对**正在被活跃回合占用**的会话持有独占写句柄，此时：
 *   · `sessions.prompt` 返回 `session/writer-held: session "..." is already owned by an active write handle`
 *   · `sessions.selectModel` 也返回同一个错误
 * 实测日志里这两条都在刷：
 *   · 黑话提取（低优先级后台任务）被拒后直接打 ERROR 级日志；
 *   · 切模型（ensureChatModel / ensureTurnModelFor）两次重试都撞锁，最后只打一行 ERROR 就放弃。
 *
 * 这两类写入都不是「必须在本毫秒完成」的操作：
 *   · 黑话提取可以下一次再跑（消息窗口没消费，下次照样能提取）；
 *   · 模型切换可以延后到**当前回合结束后的下一回合**再切，绝不能因此丢消息或刷屏。
 *
 * 所以统一收口成这里：遇到 writer-held 就短退避重试，仍然撞锁就返回 `skipped`
 * 交给调用方排队/跳过；只有**非写锁**的错误才原样抛出（那些才是真故障）。
 *
 * 纯函数 + 注入 sleep，方便单测；不依赖 bridge 的全局状态。
 */

/** 默认退避阶梯（毫秒）：总等待约 6.8s，足够让一个正常回合收尾的写句柄释放。 */
export const WRITER_HELD_DELAYS = Object.freeze([800, 2000, 4000]);

/** 无 sleep 注入时的兜底实现。 */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 判断一个错误（或 prompt 返回的 error 对象）是不是 DSH 的 writer-held 写锁冲突。
 * 兼容三种形态：`{code:'session/writer-held'}`、`{message:'session/... writer-held ...'}`、
 * 以及 Error 实例。
 */
export function isWriterHeldError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = String(error.code ?? '').trim();
  if (code === 'session/writer-held') return true;
  const message = String(error.message ?? error.reason ?? '');
  return /writer-held|already owned by an active write handle/i.test(message);
}

/**
 * 对一次「低优先级会话写入」做 writer-held 退避重试。
 *
 * @template T
 * @param {() => Promise<{ok:true, value?:T}|{ok:false, error?:object}>} attempt
 *        执行一次写入；成功返回 `{ok:true}`，失败返回 `{ok:false, error}`（error 需带 code 或 message）。
 * @param {object} [options]
 * @param {number[]} [options.delays]           撞锁后的等待阶梯（毫秒），默认 `WRITER_HELD_DELAYS`
 * @param {(ms:number)=>Promise<void>} [options.sleep] 等待实现（测试注入假 sleep）
 * @param {(message:string)=>void} [options.logDebug] 调试日志（写锁冲突属于预期现象，只进 debug）
 * @param {string} [options.label]              日志前缀
 * @returns {Promise<{ok:true, attempts:number}|{ok:false, skipped:true, attempts:number, error:object|null}|{ok:false, attempts:number, error:object|null}>}
 *          - ok=true：最终写成功；
 *          - ok=false, skipped=true：写锁一直被占用，调用方应**跳过本轮**（不是故障）；
 *          - ok=false, skipped 不存在：非写锁错误，调用方按原逻辑上报/处理。
 */
export async function retryOnWriterHeld(attempt, {
  delays = WRITER_HELD_DELAYS,
  sleep = realSleep,
  logDebug = () => {},
  label = '低优先级会话写入',
} = {}) {
  if (typeof attempt !== 'function') throw new TypeError('retryOnWriterHeld: attempt 必须是函数');
  const plan = (Array.isArray(delays) ? delays : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const wait = typeof sleep === 'function' ? sleep : realSleep;

  let lastError = null;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let result;
    try {
      result = await attempt();
    } catch (error) {
      // 抛出来的 if 是写锁冲突也按同一节奏重试；其它异常原样抛出（真故障不能被吞）。
      if (!isWriterHeldError(error)) throw error;
      result = { ok: false, error };
    }
    if (result && result.ok) return { ok: true, attempts, value: result.value };

    const error = (result && result.error) || null;
    if (!isWriterHeldError(error)) {
      return { ok: false, attempts, error };
    }
    lastError = error;
    if (attempts > plan.length) break;
    const delayMs = plan[attempts - 1] ?? 0;
    logDebug(`${label}：DSH 会话写锁被占用，等待 ${delayMs}ms 后重试（第 ${attempts}/${plan.length + 1} 次）`);
    await wait(delayMs);
  }
  logDebug(`${label}：DSH 会话写锁持续被占用（重试 ${plan.length} 次后放弃），跳过本轮：${String(lastError?.message ?? lastError ?? '')}`);
  return { ok: false, skipped: true, attempts, error: lastError };
}
