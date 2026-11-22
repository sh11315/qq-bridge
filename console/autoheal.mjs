/**
 * 自愈守护的纯逻辑（零 IO、零副作用，方便单测）。
 *
 * server.mjs 负责真正的事情（probe 探活 / 调 startXxx 拉起 / 打日志），
 * 这里只回答两个问题：
 *   1. config.json 的 unifiedConsole.autoHeal 算不算开启？（默认 true）
 *   2. 某个服务此刻「该不该拉起」？在冷却期还剩多少毫秒？
 *
 * 之所以抽出来：拉起逻辑一碰端口/子进程就很难在测试里稳定复现，
 * 而「掉线 + 冷却」的判定恰恰是最容易写错（失败风暴）的部分。
 */

/** 检查间隔：每 30 秒探活一次三个端口。 */
export const AUTOHEAL_INTERVAL_MS = 30_000;

/** 同一服务的拉起冷却：90 秒内最多尝试一次，失败也不马上重试。 */
export const AUTOHEAL_COOLDOWN_MS = 90_000;

/**
 * 被守护的服务（顺序即拉起顺序：先 DSH，再 NapCat，最后桥接）。
 * 桥接依赖 NapCat/DSH，倒过来会在依赖没起来时白拉一次。
 * WorkBuddy LAN 是独立网关（把本机 WorkBuddy 模型转成 OpenAI 兼容 API），
 * 与控制台同机、无依赖关系，放最后拉起即可。
 */
export const AUTOHEAL_SERVICES = [
  { key: 'dsh', label: 'DSH Web' },
  { key: 'napcat', label: 'NapCat' },
  { key: 'bridge', label: '桥接' },
  { key: 'workbuddy', label: 'WorkBuddy LAN' },
];

/**
 * 读 unifiedConsole.autoHeal：缺省（没写）视为开启。
 * 容忍手改配置时写成字符串 / 数字：false、"false"、"0"、"off"、"no" 都算关闭。
 */
export function autoHealEnabled(unified) {
  const v = unified?.autoHeal;
  if (v === undefined || v === null || v === '') return true;
  if (typeof v === 'string') return !['false', '0', 'off', 'no'].includes(v.trim().toLowerCase());
  if (typeof v === 'number') return v !== 0;
  return v !== false;
}

/**
 * 判定单个服务这一轮该做什么（纯函数）。
 *
 * @param {object} input
 * @param {boolean} input.up          探活结果：端口是否可连
 * @param {number} [input.lastAttemptAt] 上次拉起尝试的时间戳（0/缺省 = 从没拉过）
 * @param {number} [input.now]        当前时间戳（测试可注入）
 * @param {number} [input.cooldownMs] 冷却毫秒数
 * @returns {{ heal: boolean, reason: 'up'|'cooldown'|'down', waitMs: number }}
 *   heal=true  → 该拉起；
 *   reason=up  → 服务正常，什么都不用做；
 *   reason=cooldown → 掉线但还在冷却期，waitMs 是剩余毫秒。
 */
export function decideHeal({
  up,
  lastAttemptAt = 0,
  now = Date.now(),
  cooldownMs = AUTOHEAL_COOLDOWN_MS,
} = {}) {
  if (up) return { heal: false, reason: 'up', waitMs: 0 };
  const last = Number(lastAttemptAt) || 0;
  const at = Number(now) || 0;
  const cooldown = Number(cooldownMs) > 0 ? Number(cooldownMs) : AUTOHEAL_COOLDOWN_MS;
  // 上次尝试在未来（时钟回拨）时也按「刚拉过」处理，宁可不拉也不风暴
  if (last > 0 && at - last < cooldown) {
    return { heal: false, reason: 'cooldown', waitMs: Math.max(0, cooldown - (at - last)) };
  }
  return { heal: true, reason: 'down', waitMs: 0 };
}
