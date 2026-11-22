// 直连 OpenAI 兼容后端的聊天实现（「自定义版」并入教程版的产物）。
//
// 背景与定位：
//   教程版（qq-bridge-full）默认把每条 QQ 消息都投给 DSH Agent（带工具/技能），
//   自定义版（WorkBuddy 那个目录）则支持「直连 OpenAI 兼容接口」的轻量聊天。
//   合并后两条路并存，路由规则在 bridge.js 的调用点（handleIncoming 开头），
//   本文件只负责「怎么调接口、怎么记日志、怎么存会话」：
//     · owner / 白名单命中 → 仍然走 DSH Agent（原行为，一点没动）
//     · 其余会话且 config.api.enabled=true → 走这里，直接 POST {baseUrl}/chat/completions
//
// 能力（对齐自定义版的对应项）：
//   ① 直连 OpenAI 兼容接口（DeepSeek / Moonshot / 智谱 / 通义 / 自建 vLLM 都行）
//   ④ 失败重试：429 / 5xx / 网络抖动 / 超时按指数退避重试（其余 4xx 不重试，重试也没用）
//   ⑤ 思考过程：把 reasoning_content 完整写进桥接日志（控制台 7788 的日志页可见）
//   ⑥ 人格：api.systemPrompt（可在 7788 控制台里改），并可选叠加角色扮演注入
//
// 设计约束：
//   · 不打印/落盘真实 API Key（日志里只出现掩码）
//   · 只用 Node 内置能力（全局 fetch / AbortSignal.timeout / node:fs），零新依赖
//   · 路由与触发判断拆成纯函数导出，方便 scripts/test-api-backend.mjs 离线测
import fs from 'node:fs';
import path from 'node:path';

/** config.api 的默认值。所有字段都可以在 config.json / 7788 控制台里覆盖。 */
export const API_DEFAULTS = Object.freeze({
  enabled: false,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  // 空字符串 => 用内置默认人格（纯文本、短句、像人聊天）
  systemPrompt: '',
  temperature: 0.7,
  maxRetries: 2,
  // 重试退避基数（毫秒），按 2 的幂递增
  retryBackoffMs: 800,
  timeoutMs: 60000,
  // 每个会话保留多少条历史（一问一答算 2 条）
  maxHistory: 12,
  // 会话空闲多久清空（毫秒）
  ttlMs: 30 * 60 * 1000,
  // 推理等级 / 思考开关：留空则不带该参数，交给服务端默认
  reasoningEffort: '',
  thinkingType: '',
  thinkingBudget: 0,
  // 群聊触发方式：at=只在被 @ / 叫唤醒词时回；all=每条都回（吵，慎用）
  groupTrigger: 'at',
  wakeWords: [],
  // 是否把图片以 image_url 形式发给模型（服务端不支持视觉时请保持 false）
  allowImages: false,
  // 单条回复字数上限（防止模型失控刷屏）
  maxReplyChars: 1000,
  // 是否把教程版「角色扮演」的人格提示一起注入（保持两套人格一致）
  useRoleHint: true,
});

/** 内置默认人格：QQ 不用 Markdown，句子要短。 */
export const DEFAULT_SYSTEM_PROMPT =
  '你是 QQ 群里的助手。回答要简短直接，像人聊天一样，不要长篇大论。'
  + '只能用纯文本，不要使用 Markdown 语法（不要加粗、标题、列表符号、代码块）。';

/** 日志里给 API Key 打码：只留前 4 位。 */
export function maskKey(key) {
  const value = String(key ?? '');
  if (!value) return '(未设置)';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(8, value.length - 4))}`;
}

/** 把 config.json 的 api 段归一成运行时对象（容忍缺字段 / 类型错误）。 */
export function normalizeApiConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // 数字字段统一「夹取」而不是「回退」：越界的用户输入应该被拉到最近合法值，
  // 否则 maxRetries:-1 会静默变回默认的 2 次重试，和用户写的不一样。
  const clamp = (value, fallback, min, max = Infinity) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const allowed = (value, set, fallback) => {
    const v = String(value ?? '').trim();
    return set.includes(v) ? v : fallback;
  };

  return {
    enabled: src.enabled === true,
    baseUrl: String(src.baseUrl || API_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    apiKey: String(src.apiKey ?? '').trim(),
    model: String(src.model || API_DEFAULTS.model).trim() || API_DEFAULTS.model,
    systemPrompt: typeof src.systemPrompt === 'string' ? src.systemPrompt : '',
    temperature: clamp(src.temperature, API_DEFAULTS.temperature, 0, 2),
    maxRetries: Math.floor(clamp(src.maxRetries, API_DEFAULTS.maxRetries, 0)),
    retryBackoffMs: clamp(src.retryBackoffMs, API_DEFAULTS.retryBackoffMs, 1),
    timeoutMs: clamp(src.timeoutMs, API_DEFAULTS.timeoutMs, 1000),
    maxHistory: Math.floor(clamp(src.maxHistory, API_DEFAULTS.maxHistory, 2)),
    ttlMs: clamp(src.ttlMs, API_DEFAULTS.ttlMs, 60000),
    reasoningEffort: String(src.reasoningEffort ?? '').trim(),
    thinkingType: allowed(src.thinkingType, ['', 'adaptive', 'enabled', 'disabled'], ''),
    // 思考预算（token）：下限 0（负数归零），上限 32000（推理模型公开文档里的常见上限；
    // 不设上限时把预算填成 999999 这种数会让服务端直接回 400）。
    // 注意 clamp 的签名是 (value, fallback, min, max)，上限必须显式传第四个参数。
    thinkingBudget: Math.floor(clamp(src.thinkingBudget, 0, 0, 32000)),
    groupTrigger: allowed(src.groupTrigger, ['at', 'all'], API_DEFAULTS.groupTrigger),
    wakeWords: Array.isArray(src.wakeWords)
      ? src.wakeWords.map((w) => String(w ?? '').trim()).filter(Boolean)
      : String(src.wakeWords ?? '').split(',').map((w) => w.trim()).filter(Boolean),
    allowImages: src.allowImages === true,
    maxReplyChars: Math.floor(clamp(src.maxReplyChars, API_DEFAULTS.maxReplyChars, 100)),
    useRoleHint: src.useRoleHint !== false,
  };
}

/** 这个错误值不值得重试（429 / 5xx / 网络抖动 / 超时值得，其余 4xx 不值得）。 */
export function isRetryableError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  if (typeof err.status === 'number') return err.status === 429 || err.status >= 500;
  return (
    err.name === 'TypeError'
    || err.name === 'FetchError'
    || /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket|terminated/i.test(err.message || '')
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 路由判定（纯函数）。
 *
 * 合并后的语义：**白名单/管理员优先走 DSH Agent**，其余会话才落到直连 api。
 *   · 管理员（ownerQQ）           → agent（工具权限最高，保持原样）
 *   · 命中 allow.private/groups   → agent（原行为）
 *   · closed-agent 模式           → 只认管理员私聊，不给直连 api 开口子
 *   · 其余 + api.enabled          → api
 *   · 其余 + api 未开启            → null（忽略，和教程版原来一样）
 *
 * @param {{isOwner: boolean, whitelisted: boolean, apiEnabled: boolean, mode: string}} input
 * @returns {'agent'|'api'|null}
 */
export function resolveReplyRoute({ isOwner, whitelisted, apiEnabled, mode }) {
  if (isOwner || whitelisted) return 'agent';
  if (mode === 'closed-agent') return null;
  if (apiEnabled) return 'api';
  return null;
}

/** 消息里有没有 @ 机器人自己（OneBot 的 at 段）。 */
export function isAtSelf(segments, selfId) {
  if (!Array.isArray(segments) || !selfId) return false;
  const self = String(selfId);
  return segments.some((seg) => seg?.type === 'at' && String(seg?.data?.qq ?? '') === self);
}

/** 消息里有没有 @全体成员（群聊里直连 api 不应回这种广播消息）。 */
export function isAtAll(segments) {
  if (!Array.isArray(segments)) return false;
  return segments.some((seg) => seg?.type === 'at' && String(seg?.data?.qq ?? '') === 'all');
}

/**
 * 直连 api 会话要不要接这句话（纯函数）。
 *
 * 教程版的群白名单语义是「这个群整体交给 AI」，而直连 api 面向的是**非白名单**会话，
 * 如果群里每条消息都回就成了刷屏机器人。默认只在被叫到时回：
 *   · 私聊：必回
 *   · 群聊：groupTrigger=all 时必回；否则要求 @自己 / 引用自己 / 以唤醒词开头
 */
export function shouldRespond({ kind, segments, text, selfId, quoteTargetIsSelf, trigger, wakeWords }) {
  if (kind === 'private') return true;
  if (trigger === 'all') return true;
  if (isAtSelf(segments, selfId)) return true;
  if (quoteTargetIsSelf) return true;
  if (isAtAll(segments)) return false;
  const plain = String(text ?? '').replace(/^\[引用[^\]]*\]/, '').trim();
  if (!plain) return false;
  const words = Array.isArray(wakeWords) ? wakeWords : [];
  return words.some((w) => w && plain.startsWith(w));
}

/** 直连 OpenAI 兼容接口的客户端。一个实例对应一份 api 配置。 */
export class ApiChatClient {
  constructor({
    baseUrl = API_DEFAULTS.baseUrl,
    apiKey = '',
    model = API_DEFAULTS.model,
    systemPrompt = '',
    temperature = API_DEFAULTS.temperature,
    maxRetries = API_DEFAULTS.maxRetries,
    retryBackoffMs = API_DEFAULTS.retryBackoffMs,
    timeoutMs = API_DEFAULTS.timeoutMs,
    reasoningEffort = '',
    thinkingType = '',
    thinkingBudget = 0,
    logger = null,
    fetchImpl = null,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.temperature = temperature;
    this.maxRetries = maxRetries;
    this.retryBackoffMs = retryBackoffMs;
    this.timeoutMs = timeoutMs;
    this.reasoningEffort = reasoningEffort;
    this.thinkingType = thinkingType;
    this.thinkingBudget = thinkingBudget;
    this.log = logger || { info() {}, warn() {}, error() {}, debug() {} };
    // 测试里可以注入假 fetch；生产不传，用全局 fetch
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
  }

  get endpoint() {
    return `${this.baseUrl}/chat/completions`;
  }

  /** 从运行时配置重建一个等价的客户端（控制台热切换时用）。 */
  static fromConfig(cfg, logger, fetchImpl = null) {
    return new ApiChatClient({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      systemPrompt: cfg.systemPrompt,
      temperature: cfg.temperature,
      maxRetries: cfg.maxRetries,
      retryBackoffMs: cfg.retryBackoffMs,
      timeoutMs: cfg.timeoutMs,
      reasoningEffort: cfg.reasoningEffort,
      thinkingType: cfg.thinkingType,
      thinkingBudget: cfg.thinkingBudget,
      logger,
      fetchImpl,
    });
  }

  /** 组装请求体（单独抽出来，方便离线测试断言参数形状）。 */
  buildBody(history) {
    const messages = [{ role: 'system', content: this.systemPrompt }];
    for (const item of history ?? []) {
      if (!item) continue;
      // 普通文本是字符串；带图片时是 OpenAI 的 content 数组（text + image_url）
      if (typeof item.content !== 'string' && !Array.isArray(item.content)) continue;
      if (!['user', 'assistant', 'system'].includes(item.role)) continue;
      messages.push({ role: item.role, content: item.content });
    }
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      stream: false,
    };
    // 只有显式配置时才带，避免把不认识的参数发给服务商
    if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;
    if (this.thinkingType) {
      body.thinking = { type: this.thinkingType };
      if (this.thinkingBudget > 0) body.thinking.budget_tokens = this.thinkingBudget;
    }
    return body;
  }

  /**
   * 发一次对话（含重试）。
   * @param {Array<{role: string, content: string}>} history
   * @param {{onReasoning?: (text: string) => void, onUsage?: (usage: object) => void}} [hooks]
   * @returns {Promise<string>}
   */
  async chat(history, hooks = {}) {
    const body = this.buildBody(history);
    const attempts = this.maxRetries + 1;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#requestOnce(body, hooks);
      } catch (err) {
        lastError = err;
        const canRetry = attempt < attempts && isRetryableError(err);
        if (!canRetry) break;
        // 指数退避 + 少量抖动，避免多个会话同时重试造成尖峰
        const delay = this.retryBackoffMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        this.log.warn(`[api] 模型调用失败（${err.message}），${delay}ms 后重试（第 ${attempt}/${this.maxRetries} 次）`);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  async #requestOnce(body, hooks) {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();

    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        detail = parsed.error?.message || parsed.message || detail;
      } catch {
        /* 保留原始文本 */
      }
      const err = new Error(`模型接口返回 ${res.status}：${detail}`);
      err.status = res.status;
      throw err;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('模型接口返回的不是 JSON');
    }

    const choice = data.choices?.[0];

    // 思考过程：DeepSeek 等推理模型放在 message.reasoning_content，
    // 有的中转放 reasoning / reasoning_details，能读到就都写进日志。
    const reasoning = choice?.message?.reasoning_content
      ?? choice?.message?.reasoning
      ?? choice?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim()) {
      const trimmed = reasoning.trim();
      this.log.info(`[api] 思考过程：${trimmed}`);
      try { hooks.onReasoning?.(trimmed); } catch { /* 钩子自己吞错 */ }
    }

    if (data.usage) {
      this.log.info(
        `[api] token 用量：prompt=${data.usage.prompt_tokens ?? '?'}`
        + ` completion=${data.usage.completion_tokens ?? '?'} total=${data.usage.total_tokens ?? '?'}`,
      );
      try { hooks.onUsage?.(data.usage); } catch { /* 同上 */ }
    }

    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      const reason = choice?.finish_reason ? `（finish_reason=${choice.finish_reason}）` : '';
      throw new Error(`模型没有返回内容${reason}`);
    }
    return content.trim();
  }
}

/** 每个会话的最近若干轮对话（内存 + 可选落盘）。 */
export class ApiHistoryStore {
  constructor({ maxHistory = API_DEFAULTS.maxHistory, ttlMs = API_DEFAULTS.ttlMs, persistFile = '', logger = null } = {}) {
    this.maxHistory = maxHistory;
    this.ttlMs = ttlMs;
    this.persistFile = persistFile;
    this.map = new Map();
    this.log = logger || { info() {}, warn() {} };
    if (this.persistFile) this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.persistFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.persistFile, 'utf8'));
      for (const [key, item] of Object.entries(raw ?? {})) {
        if (item && Array.isArray(item.messages)) {
          this.map.set(key, {
            messages: item.messages.filter((m) => m && typeof m.content === 'string'),
            updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
          });
        }
      }
      this.log.info(`[api] 已载入 ${this.map.size} 条会话历史：${this.persistFile}`);
    } catch (err) {
      this.log.warn(`[api] 会话历史读取失败：${err.message}`);
    }
  }

  #save() {
    if (!this.persistFile) return;
    try {
      fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
      const data = {};
      for (const [key, item] of this.map) data[key] = item;
      fs.writeFileSync(this.persistFile, JSON.stringify(data), 'utf8');
    } catch {
      /* 持久化失败不应影响正常回复 */
    }
  }

  get(key) {
    const item = this.map.get(key);
    if (!item) return [];
    if (Date.now() - item.updatedAt > this.ttlMs) {
      this.map.delete(key);
      this.#save();
      return [];
    }
    return item.messages;
  }

  append(key, role, content) {
    let item = this.map.get(key);
    if (!item) {
      item = { messages: [], updatedAt: Date.now() };
      this.map.set(key, item);
    }
    item.messages.push({ role, content });
    item.updatedAt = Date.now();
    if (item.messages.length > this.maxHistory) {
      item.messages = item.messages.slice(-this.maxHistory);
      // 保证历史从 user 开始，避免把 assistant 的半句话当上下文
      while (item.messages.length && item.messages[0].role !== 'user') item.messages.shift();
    }
    this.#save();
    return item.messages;
  }

  reset(key) {
    this.map.delete(key);
    this.#save();
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [key, item] of this.map) {
      if (now - item.updatedAt > this.ttlMs) {
        this.map.delete(key);
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  get size() {
    return this.map.size;
  }
}

/**
 * 把直连后端装配成一个可热更新的门面，供 bridge.js 调用。
 *
 * @param {object} opts
 * @param {object} opts.config        已归一的 api 配置（normalizeApiConfig 的结果）
 * @param {(key: string, text: string) => Promise<boolean>} opts.sendReply 出站（走桥接的审计+分条+发送队列）
 * @param {object} [opts.logger]      桥接的日志函数（log(...args)）
 * @param {(line: string) => void} [opts.appendActivity]
 * @param {string} [opts.persistFile] 会话历史落盘路径；空=只放内存
 * @param {Function} [opts.fetchImpl] 测试注入
 */
export function createApiChatBackend({
  config,
  sendReply,
  logger = null,
  appendActivity = () => {},
  persistFile = '',
  fetchImpl = null,
  onUsage = null,
} = {}) {
  // logger 可能是「带 info/warn/error 的对象」（bridge 里传的适配器），
  // 也可能是函数（测试里传的）。统一成一行的 logFn，避免把对象当函数直接调用。
  const logFn = typeof logger === 'function' ? logger : (...args) => logger?.info?.(args.join(' '));
  const loggerObj = typeof logger === 'function'
    ? { info: logger, warn: logger, error: logger, debug: logger }
    : (logger || { info() {}, warn() {}, error() {}, debug() {} });
  let cfg = normalizeApiConfig(config);
  let client = ApiChatClient.fromConfig(cfg, loggerObj, fetchImpl);
  const history = new ApiHistoryStore({
    maxHistory: cfg.maxHistory,
    ttlMs: cfg.ttlMs,
    persistFile,
    logger: loggerObj,
  });
  // 同一会话串行处理，避免两条消息同时进来把上下文交错
  const chains = new Map();
  let handledCount = 0;
  let errorCount = 0;
  let lastError = '';

  function serialize(key, task) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(task, task);
    const guard = next.then(() => {}, () => {});
    chains.set(key, guard);
    guard.then(() => { if (chains.get(key) === guard) chains.delete(key); });
    return next;
  }

  /** 热更新配置（控制台切换后端/改模型时调用，不需要重启桥接）。 */
  function updateConfig(next) {
    cfg = normalizeApiConfig(next);
    client = ApiChatClient.fromConfig(cfg, loggerObj, fetchImpl);
    history.maxHistory = cfg.maxHistory;
    history.ttlMs = cfg.ttlMs;
    logFn(`[api] 配置已更新：enabled=${cfg.enabled} model=${cfg.model} baseUrl=${cfg.baseUrl} key=${maskKey(cfg.apiKey)}`);
    return cfg;
  }

  /** 这次消息该不该由直连 api 处理（供 bridge.js 在入口处判断）。 */
  function routeFor({ isOwner, whitelisted, mode }) {
    const route = resolveReplyRoute({ isOwner, whitelisted, apiEnabled: cfg.enabled, mode });
    return route;
  }

  async function handleIncoming({ kind, id, event, text, plainText, quoteTargetIsSelf = false, isOwner = false, roleHint = '', userName = '', imageParts = null }) {
    const key = `${kind}:${id}`;
    const selfId = event?.self_id;
    if (String(event?.user_id ?? '') === String(selfId ?? '')) return false; // 忽略自己发的消息

    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
      logFn('[api] 直连后端未配置完整（apiKey/baseUrl/model），本条消息忽略');
      return false;
    }

    if (kind === 'group') {
      const respond = shouldRespond({
        kind,
        segments: event?.message ?? [],
        text: plainText,
        selfId,
        quoteTargetIsSelf,
        trigger: cfg.groupTrigger,
        wakeWords: cfg.wakeWords,
      });
      if (!respond) {
        logFn(`[api] 群聊未被叫到，忽略（${key}）：${String(plainText ?? '').slice(0, 40)}`);
        return false;
      }
    }

    // 群聊里 /reset /help /status 是通用命令，不泄露任何管理信息
    const command = String(plainText ?? '').trim();
    if (command === '/reset' || command === '/new') {
      history.reset(key);
      await sendReply(key, '好的，之前的对话记忆清空了，我们重新开始。');
      return true;
    }
    if (command === '/help' || command === '帮助') {
      await sendReply(key, '直连模式：@我或在群里说唤醒词即可聊天。/reset 清空记忆，/status 看当前模型。');
      return true;
    }
    if (command === '/status') {
      await sendReply(key, `模型：${cfg.model}（直连 api 后端）；历史：${history.get(key).length} 条消息`);
      return true;
    }
    if (command.startsWith('/')) {
      // 其余斜杠命令不属于直连用户，直接忽略（管理命令只给管理员）
      await sendReply(key, '直连模式不支持该命令，管理命令仅管理员可用。');
      return true;
    }

    const userLine = kind === 'group' && userName ? `${userName}：${text}` : text;
    if (!String(userLine ?? '').trim()) return false;

    const systemPrompt = [
      cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      cfg.useRoleHint && roleHint ? `\n\n${roleHint}` : '',
    ].join('').trim();
    client.systemPrompt = systemPrompt;

    await serialize(key, async () => {
      const startedAt = Date.now();
      // 图片按 OpenAI 的 content 数组发；服务端不支持视觉时把 api.allowImages 关掉即可
      const userContent = Array.isArray(imageParts) && imageParts.length
        ? [{ type: 'text', text: userLine }, ...imageParts]
        : userLine;
      const messages = [...history.get(key), { role: 'user', content: userContent }];
      appendActivity(`[api] ${key} ${isOwner ? '管理员' : '群友'}：${String(text ?? '').slice(0, 80)}`);
      try {
        const answer = await client.chat(messages, {
          onReasoning: (reasoning) => appendActivity(`[api] ${key} 思考过程：${reasoning.slice(0, 200)}`),
          onUsage: (usage) => {
            // 直连调用不经过 DSH 会话事件，用量只能从这里交给账本（否则是成本报表盲区）。
            try { onUsage?.({ key, kind, model: cfg.model, usage }); } catch { /* 统计失败不影响回复 */ }
          },
        });
        history.append(key, 'user', userLine);
        history.append(key, 'assistant', answer);
        const reply = answer.length > cfg.maxReplyChars
          ? `${answer.slice(0, cfg.maxReplyChars)}…（内容过长，已截断）`
          : answer;
        handledCount += 1;
        logFn(`[api] ${key} 模型回复 ${answer.length} 字，耗时 ${Date.now() - startedAt}ms`);
        await sendReply(key, reply);
      } catch (err) {
        errorCount += 1;
        lastError = String(err?.message ?? err);
        loggerObj.error?.(`[api] ${key} 调用失败：${lastError}`);
        const hint = /timeout|Timeout|aborted/i.test(lastError)
          ? '这次想太久了，稍等一会儿再问一次吧。'
          : '我这边出了点问题，稍后再试一次吧。';
        try { await sendReply(key, hint); } catch { /* 兜底回复失败只能记日志 */ }
      }
    });
    return true;
  }

  return {
    get config() { return cfg; },
    get stats() {
      return { handled: handledCount, errors: errorCount, lastError, sessions: history.size };
    },
    client: () => client,
    updateConfig,
    routeFor,
    handleIncoming,
    reset: (key) => history.reset(key),
    prune: () => history.prune(),
  };
}
