// 按会话（QQ key）解析模型 / 思考强度覆盖。
//
// 为什么要有：bridge 历史上只有一个全局模型。群聊和私聊、不同群之间想用不同
// 模型（例如私聊用 deepseek-flash、某个群用 hy3）时，只能改全局配置，影响所有
// 会话。这个模块把「某个会话该用哪个模型」抽成纯查表，持久化在
// state/session-policies.json，由 SessionRouter 做字段校验（模式/预设/模型/
// 强度），bridge 只消费 model / reasoningEffort 两项。
//
// 约定：
//   · model 写成 "provider/model"（如 "xdpool/hy3"）或只写 model（沿用全局 provider）。
//   · 没有覆盖、文件损坏、校验失败时一律回落到全局配置（fail-open 到默认，
//     而不是抛异常挡住消息）。
//   · 模式仍由进程全局决定；本模块不启用按会话 closed-agent，避免把权限模型
//     拆成两套。

import fs from 'node:fs';
import path from 'node:path';
import { SessionRouter, createInitialConversationState } from './session-router.mjs';

export const POLICY_VERSION = 1;
// SessionRouter 校验「预设必须属于该模式」，而它接受五套历史拼写，所以这里也必须
// 给齐：只写 simulation 会在记录 mode 还是遗留名（reserved2）时抛
// `Cannot read properties of undefined (reading 'includes')`。本模块不消费模式，
// 只消费 model / reasoningEffort，所以五套都映射到同一个 qq-chat-v2 预设。
const MODE_PRESETS = Object.freeze({
  simulation: Object.freeze(['qq-chat-v2']),
  chat: Object.freeze(['qq-chat-v2']),
  reserved: Object.freeze(['qq-chat-v2']),
  reserved2: Object.freeze(['qq-chat-v2']),
  'closed-agent': Object.freeze(['qq-chat-v2'])
});

function emptyState(ownerQQ = null) {
  return createInitialConversationState(ownerQQ, {
    defaultMode: 'reserved2',
    closedAgentEnabled: false,
    modePresets: MODE_PRESETS
  });
}

/**
 * @param {{file:string, ownerQQ?:string|null, now?:()=>number}} options
 */
export function createConversationPolicy({ file, ownerQQ = null, now = Date.now } = {}) {
  const filePath = String(file || '');
  let router = null;
  let lastError = '';

  function build(state) {
    return new SessionRouter({
      ownerQQ,
      defaultMode: 'reserved2',
      state,
      now,
      modePresets: MODE_PRESETS
    });
  }

  function ensure() {
    if (router) return router;
    let state;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      state = parsed && parsed.version === POLICY_VERSION && parsed.defaults && parsed.conversations
        ? parsed
        : emptyState(ownerQQ);
    } catch (error) {
      if (error?.code !== 'ENOENT') lastError = String(error?.message || error);
      state = emptyState(ownerQQ);
    }
    try {
      router = build(state);
    } catch (error) {
      lastError = String(error?.message || error);
      router = build(emptyState(ownerQQ));
    }
    return router;
  }

  function reload() {
    router = null;
    return ensure();
  }

  function persist() {
    const state = ensure().snapshot();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, version: POLICY_VERSION }, null, 2) + '\n');
    fs.renameSync(tmp, filePath);
  }

  /**
   * 解析后的策略；没有覆盖时也返回一条有效记录，但 `hasOverride === false`
   * （调用方要用 model/强度时必须同时看 hasOverride，否则会把默认值当成覆盖）。
   * 非法 key / 校验失败返回 null。
   */
  function policyFor(key) {
    if (!key) return null;
    try {
      const p = ensure().policyFor(key);
      if (!p) return null;
      const model = p.model ? String(p.model) : '';
      const [provider, ...rest] = model.includes('/') ? model.split('/') : ['', model];
      return {
        key: p.key,
        mode: p.canonicalMode,
        provider: provider || '',
        model: rest.join('/') || '',
        reasoningEffort: p.reasoningEffort ? String(p.reasoningEffort) : '',
        hasOverride: p.hasOverride === true
      };
    } catch (error) {
      lastError = String(error?.message || error);
      return null;
    }
  }

  /**
   * 写入/更新一个会话的模型覆盖。
   * @param {string} key group:123 / private:123
   * @param {{provider?:string, model?:string, reasoningEffort?:string, updatedBy?:string}} patch
   */
  function setPolicy(key, patch = {}) {
    const provider = String(patch.provider || '').trim();
    const model = String(patch.model || '').trim();
    const effort = String(patch.reasoningEffort || '').trim();
    const fullModel = model ? (provider ? `${provider}/${model}` : model) : null;
    // 默认值是 'console' 而不是 'owner'：SessionRouter 只接受 'console' 或
    // `command:<ownerKey>`，'owner' 会在 setConversation/deleteConversation 里直接
    // 抛 TypeError。调用方（bridge 的 HTTP API）已经用控制台令牌鉴权过。
    const updatedBy = String(patch.updatedBy || 'console');
    const r = ensure();
    const current = r.overrideFor(key);
    const record = {
      // 遗留记录里可能是 reserved2/chat 等旧拼写，原样保留；新建时用规范名。
      mode: current?.mode || 'simulation',
      preset: current?.preset || 'qq-chat-v2',
      model: fullModel,
      reasoningEffort: effort || null,
      updatedBy
    };
    const result = r.setConversation(key, record);
    persist();
    return { ok: true, key: result.key, changed: result.changedKeys.length > 0, policy: policyFor(key) };
  }

  function deletePolicy(key) {
    const r = ensure();
    // 同 setPolicy：SessionRouter 只认 'console' / command:<ownerKey>。
    const result = r.deleteConversation(key, { updatedBy: 'console' });
    persist();
    return { ok: true, key: result.key, changed: result.changedKeys.length > 0, policy: policyFor(key) };
  }

  function snapshot() {
    const state = ensure().snapshot();
    return {
      ok: true,
      version: POLICY_VERSION,
      file: filePath,
      defaults: state.defaults,
      conversations: state.conversations,
      lastError
    };
  }

  return { policyFor, setPolicy, deletePolicy, snapshot, reload };
}

/** 把策略里的 model 拆成 {provider, model}（provider 为空时沿用 fallbackProvider）。 */
export function resolveModelTarget(policy, fallbackProvider = '') {
  const provider = String(policy?.provider || fallbackProvider || '').trim();
  const model = String(policy?.model || '').trim();
  return { provider, model };
}
