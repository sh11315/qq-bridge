// 五套功能会话（chat / sticker / vision / voice / web）回归测试。
//
// 覆盖两层：
//  1) 纯逻辑：src/core/feature-sessions.mjs 的路由 / 模型档位 / 工具面 / 显式命令；
//  2) 真实 bridge：用 audit-bridge-harness 把 bridge.js 跑在临时目录 + 假 DSH 上，
//     发 5 条模拟消息，断言 5 套 DSH 会话各自独立、模型映射正确、停放/恢复正确、
//     历史（最近消息快照 + 记忆 + 时间/黑话注入）对每套都可见。
//
// 不碰生产 DSH、不连 QQ、不读真实 config.json。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  FEATURES,
  DEFAULT_FEATURE_TRIGGERS,
  normalizeFeatureSessions,
  normalizeVariant,
  featureOfVariant,
  levelOfVariant,
  routeFeature,
  parseFeatureCommand,
  featureAllowsFlag,
  resolveFeatureModel,
  mcpToolPolicySnapshot,
  buildFeatureHint,
} from '../src/core/feature-sessions.mjs';
import {
  apply as applyRestrictGuard,
  featureToolGate,
  featureSchemaDenyList,
  resetFeatureGateCache,
  FEATURE_TOOL_POLICY,
} from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const OWNER = 123;
const GROUP = 456;
const BOT = 999;

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests += 1;
  try {
    await run();
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

function groupEvent(userId, text, messageId = 1001) {
  return {
    self_id: BOT,
    group_id: GROUP,
    user_id: userId,
    message_id: messageId,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: userId, nickname: `u${userId}`, card: '' }
  };
}

function featureConfig(extra = {}) {
  return {
    authToken: 'fixture-only',
    provider: 'workbuddy',
    model: 'wb-model',
    reasoningEffort: 'auto',
    advanced: { enabled: true, provider: 'adv-provider', model: 'adv-model', reasoningEffort: 'high' },
    features: {
      enabled: true,
      explicitCommands: true,
      proactiveFeature: 'web',
      models: {
        chat: { group: 'basic', private: 'advanced' },
        sticker: 'basic', vision: 'advanced', voice: 'advanced', web: 'advanced'
      },
      ...extra
    }
  };
}

// ── 纯逻辑 ──────────────────────────────────────────────────────────────────

await test('routeFeature：媒体/关键词/冷场/显式/默认 chat', () => {
  const features = normalizeFeatureSessions(featureConfig().features);
  const base = { isGroup: true, features, routingMode: 'auto' };

  assert.deepEqual(
    { ...routeFeature({ ...base, mediaList: [{ kind: 'face' }] }) },
    { feature: 'sticker', level: 'basic', variant: 'sticker:basic', reason: 'media' }
  );
  assert.equal(routeFeature({ ...base, mediaList: [{ kind: 'image' }] }).feature, 'vision');
  // 2026-11-01：file 只有图片扩展名才算图，其余交回 chat（正文入站时已提成 fileText）。
  assert.equal(routeFeature({ ...base, mediaList: [{ kind: 'file', name: 'a.png' }] }).feature, 'vision');
  assert.equal(routeFeature({ ...base, mediaList: [{ kind: 'file' }] }).feature, 'chat');
  assert.equal(routeFeature({ ...base, text: '帮我看看这张图' }).feature, 'vision');
  assert.equal(routeFeature({ ...base, text: '发个表情包' }).feature, 'sticker');
  assert.equal(routeFeature({ ...base, text: '念一下这句' }).feature, 'voice');
  assert.equal(routeFeature({ ...base, text: '搜一下今天的新闻' }).feature, 'web');
  assert.equal(routeFeature({ ...base, text: 'https://example.com/x' }).feature, 'web');
  // 冷场主动冒泡默认走联网会话（要搜索热点）
  assert.equal(routeFeature({ ...base, wakeReason: 'proactiveCheck' }).feature, 'web');
  // 显式覆盖优先于一切自动判定
  assert.equal(routeFeature({ ...base, mediaList: [{ kind: 'image' }], forcedFeature: 'chat' }).feature, 'chat');
  // 默认 chat：群聊基础、私聊进阶
  assert.deepEqual(
    { ...routeFeature({ ...base, text: '今天吃什么' }) },
    { feature: 'chat', level: 'basic', variant: 'chat:basic', reason: 'default-chat' }
  );
  assert.equal(routeFeature({ ...base, isGroup: false, text: '今天吃什么' }).level, 'advanced');
});

await test('routeFeature：功能可单独关闭 / 全局回滚', () => {
  const noVision = normalizeFeatureSessions({ ...featureConfig().features, models: { ...featureConfig().features.models, vision: 'off' } });
  assert.equal(routeFeature({ isGroup: true, features: noVision, mediaList: [{ kind: 'image' }] }).feature, 'chat');
  const off = normalizeFeatureSessions({ enabled: false });
  const legacy = routeFeature({ isGroup: false, features: off, routingMode: 'advanced', text: '看图' });
  assert.deepEqual(legacy, { feature: 'chat', level: 'advanced', variant: 'chat:advanced', reason: 'features-disabled' });
});

await test('模型映射：chat 群聊基础/私聊进阶，sticker 基础，其余进阶', () => {
  const features = normalizeFeatureSessions(featureConfig().features);
  const dsh = featureConfig();
  const basic = resolveFeatureModel({ dsh, level: 'basic' });
  const advanced = resolveFeatureModel({ dsh, level: 'advanced' });
  assert.equal(basic.provider, 'workbuddy');
  assert.equal(basic.model, 'wb-model');
  assert.equal(advanced.provider, 'adv-provider');
  assert.equal(advanced.model, 'adv-model');
  assert.equal(routeFeature({ isGroup: true, features }).level, 'basic');
  assert.equal(routeFeature({ isGroup: false, features }).level, 'advanced');
  // advanced 关闭时进阶档回退基础模型，但仍是独立的进阶上下文
  const noAdv = { ...dsh, advanced: { enabled: false } };
  assert.equal(resolveFeatureModel({ dsh: noAdv, level: 'advanced' }).provider, 'workbuddy');
});

await test('variant 归一化与非法值回退', () => {
  assert.equal(normalizeVariant('basic'), 'chat:basic');
  assert.equal(normalizeVariant('advanced'), 'chat:advanced');
  assert.equal(normalizeVariant('vision:advanced'), 'vision:advanced');
  assert.equal(normalizeVariant('sticker:advanced'), 'sticker:advanced');
  assert.equal(normalizeVariant('nonsense'), 'chat:basic');
  assert.equal(featureOfVariant('web:advanced'), 'web');
  assert.equal(levelOfVariant('sticker:advanced'), 'advanced');
});

await test('工具面：chat 有只读看图口子但无表情/语音/转发；sticker 只有表情包+最小收尾；vision/voice/web 有各自能力', () => {
  // 2026-10-30：chat 多开「配表情」小口子（sendSticker/listStickers/getStickerImage/stickerNote）。
  assert.equal(featureAllowsFlag('chat', 'sendSticker'), true);
  assert.equal(featureAllowsFlag('chat', 'listStickers'), true);
  // 2026-10-30 晚：owner 要「自己能收藏喜欢的表情」，收藏也放进 chat。
  assert.equal(featureAllowsFlag('chat', 'collectSticker'), true);
  // 改官方备注仍然只在 sticker。
  assert.equal(featureAllowsFlag('chat', 'setStickerRemark'), false);
  // 2026-10-26：chat 只多给 qq_get_message_images（只读看一张图），不给转发/表情/语音。
  assert.equal(featureAllowsFlag('chat', 'getImages'), true);
  assert.equal(featureAllowsFlag('chat', 'getForwardMsg'), false);
  assert.equal(featureAllowsFlag('chat', 'sendVoice'), false);
  assert.equal(featureAllowsFlag('chat', 'sendMessage'), true);
  assert.equal(featureAllowsFlag('chat', 'memory'), true);

  assert.equal(featureAllowsFlag('sticker', 'sendSticker'), true);
  assert.equal(featureAllowsFlag('sticker', 'markRead'), true);
  assert.equal(featureAllowsFlag('sticker', 'memory'), false);
  assert.equal(featureAllowsFlag('sticker', 'getImages'), false);
  assert.equal(featureAllowsFlag('sticker', 'mcp__web-search-safe__web_search'), false);

  assert.equal(featureAllowsFlag('vision', 'getImages'), true);
  assert.equal(featureAllowsFlag('vision', 'getForwardMsg'), true);
  assert.equal(featureAllowsFlag('vision', 'sendVoice'), false);
  assert.equal(featureAllowsFlag('voice', 'sendVoice'), true);
  assert.equal(featureAllowsFlag('voice', 'listVoices'), true);
  assert.equal(featureAllowsFlag('voice', 'getImages'), false);
  // 2026-11-01：冷场主动冒泡默认落 web，那一路也得能看见对方甩回来的图。
  assert.equal(featureAllowsFlag('web', 'getImages'), true);
  assert.equal(featureAllowsFlag('vision', 'sendSticker'), false);
  // 2026-10-28：vision/voice/web 也收窄到 CORE_FLAGS —— 不再带成员列表/历史消息/
  // 详情/社交状态这些读取工具；各自能力（看图/语音/联网）仍保留。
  for (const feature of ['vision', 'voice', 'web']) {
    for (const flag of ['getRecent', 'socialState', 'getMessageDetail', 'getActiveMembers', 'getGroupMembers', 'getMyRecent']) {
      assert.equal(featureAllowsFlag(feature, flag), false, `${feature} 不应包含 ${flag}`);
    }
    assert.equal(featureAllowsFlag(feature, 'sendMessage'), true, `${feature} 仍要能发消息`);
    assert.equal(featureAllowsFlag(feature, 'markRead'), true, `${feature} 仍要能收尾`);
  }
  // 2026-11-01：联网会话（主动冒泡常落这路）也得在提示词里写清只读看图怎么用。
  {
    const webHint = buildFeatureHint('web', 'advanced');
    assert.match(webHint, /qq_get_message_images/);
    assert.match(webHint, /只读/);
  }
  // 聊天会话的提示词必须告诉模型「可以只读看当前这张图、且不会切会话」。
  for (const level of ['basic', 'advanced']) {
    const hint = buildFeatureHint('chat', level);
    assert.match(hint, /qq_get_message_images/);
    assert.match(hint, /只读/);
    assert.doesNotMatch(hint, /没有表情包、看图/);
  }
  // 五个功能域都必须有关闭回合的能力
  for (const feature of FEATURES) {
    assert.equal(featureAllowsFlag(feature, 'markRead'), true, `${feature} 必须有 markRead`);
    assert.equal(featureAllowsFlag(feature, 'setWakeConfig'), true, `${feature} 必须有 setWakeConfig`);
  }
  // 所有提示都明确写了"历史共享"
  for (const feature of FEATURES) {
    const hint = buildFeatureHint(feature, feature === 'chat' ? 'basic' : 'advanced');
    assert.match(hint, /共享同一份/);
  }
});

await test('显式命令解析：/vision、/表情、/auto、非命令', () => {
  assert.deepEqual(parseFeatureCommand('/vision'), { feature: 'vision', command: 'vision', rest: '', standalone: true });
  assert.deepEqual(parseFeatureCommand('/vision 这张图里是什么'), { feature: 'vision', command: 'vision', rest: '这张图里是什么', standalone: false });
  assert.equal(parseFeatureCommand('/表情').feature, 'sticker');
  assert.equal(parseFeatureCommand('/联网').feature, 'web');
  assert.equal(parseFeatureCommand('/auto').feature, '');
  assert.equal(parseFeatureCommand('/reset'), null);
  assert.equal(parseFeatureCommand('看看 /vision'), null);
});

await test('守卫工具政策与 bridge 同源（不出现两份漂移名单）', () => {
  assert.deepEqual(FEATURE_TOOL_POLICY, mcpToolPolicySnapshot());
  assert.equal(FEATURE_TOOL_POLICY.vision.includes('qq_get_message_images'), true);
  assert.equal(FEATURE_TOOL_POLICY.vision.includes('qq_get_forward_msg'), true);
  // chat 只开「读一张图」，不开合并转发。
  assert.equal(FEATURE_TOOL_POLICY.chat.includes('qq_get_message_images'), true);
  assert.equal(FEATURE_TOOL_POLICY.chat.includes('qq_get_forward_msg'), false);
  assert.equal(FEATURE_TOOL_POLICY.sticker.includes('qq_get_message_images'), false);
  assert.equal(FEATURE_TOOL_POLICY.voice.includes('qq_get_message_images'), false);
  assert.equal(FEATURE_TOOL_POLICY.web.includes('qq_get_message_images'), true);
  assert.equal(FEATURE_TOOL_POLICY.sticker.includes('qq_send_sticker'), true);
  // 2026-10-30：chat 也能自己发表情（配表情小口子）+ 自己收藏喜欢的表情；改备注仍只留 sticker。
  assert.equal(FEATURE_TOOL_POLICY.chat.includes('qq_send_sticker'), true);
  assert.equal(FEATURE_TOOL_POLICY.chat.includes('qq_list_stickers'), true);
  assert.equal(FEATURE_TOOL_POLICY.chat.includes('qq_collect_sticker'), true);
  assert.equal(FEATURE_TOOL_POLICY.chat.includes('qq_set_sticker_remark'), false);
  // 2026-10-28：chat 工具面收窄 —— 成员列表/历史消息/详情/社交状态不再算基础工具。
  for (const tool of [
    'qq_get_group_members', 'qq_get_active_members', 'qq_get_recent_messages',
    'qq_get_my_recent_messages', 'qq_get_message_detail', 'qq_social_state',
  ]) {
    assert.equal(FEATURE_TOOL_POLICY.chat.includes(tool), false, `chat 不应包含 ${tool}`);
  }
  // 但仍保留回合收尾必需的读取/发送/等待工具。
  for (const tool of ['qq_get_unread_messages', 'qq_send_message', 'qq_wait_for_messages']) {
    assert.equal(FEATURE_TOOL_POLICY.chat.includes(tool), true, `chat 应保留 ${tool}`);
  }
  // 2026-10-28：sticker/vision/voice/web 与 chat 一样，不再包含"读取型"成员/历史工具。
  for (const feature of ['sticker', 'vision', 'voice', 'web']) {
    for (const tool of [
      'qq_get_group_members', 'qq_get_active_members', 'qq_get_recent_messages',
      'qq_get_my_recent_messages', 'qq_get_message_detail', 'qq_social_state',
    ]) {
      assert.equal(FEATURE_TOOL_POLICY[feature].includes(tool), false, `${feature} 不应包含 ${tool}`);
    }
    for (const tool of ['qq_send_message', 'qq_wait_for_messages', 'qq_mark_read']) {
      assert.equal(FEATURE_TOOL_POLICY[feature].includes(tool), true, `${feature} 应保留 ${tool}`);
    }
  }
  assert.equal(FEATURE_TOOL_POLICY.voice.includes('qq_send_tts'), true);
  assert.equal(FEATURE_TOOL_POLICY.web.includes('qq_get_prompt'), true);
});

await test('schema 隐藏名单：每个 feature 只留本域 MCP 工具', () => {
  const chatDeny = featureSchemaDenyList('chat');
  assert.ok(chatDeny.includes('mcp__snowluma__qq_get_group_members'));
  assert.ok(chatDeny.includes('mcp__snowluma__qq_get_recent_messages'));
  assert.ok(!chatDeny.includes('mcp__snowluma__qq_collect_sticker'));
  assert.ok(!chatDeny.includes('mcp__snowluma__qq_send_sticker'));
  assert.ok(!chatDeny.includes('mcp__snowluma__qq_get_message_images'));
  assert.ok(!chatDeny.includes('mcp__snowluma__qq_send_message'));
  assert.ok(chatDeny.includes('mcp__web-search-safe__web_search'));

  const visionDeny = featureSchemaDenyList('vision');
  assert.ok(visionDeny.includes('mcp__snowluma__qq_send_sticker'));
  assert.ok(!visionDeny.includes('mcp__snowluma__qq_get_forward_msg'));
  assert.ok(visionDeny.includes('mcp__web-search-safe__web_search'));
  // 2026-10-28：vision/voice/web 也不再允许翻成员列表/拉历史。
  for (const feature of ['vision', 'voice', 'web']) {
    const deny = featureSchemaDenyList(feature);
    for (const tool of [
      'mcp__snowluma__qq_get_group_members', 'mcp__snowluma__qq_get_active_members',
      'mcp__snowluma__qq_get_recent_messages', 'mcp__snowluma__qq_get_my_recent_messages',
      'mcp__snowluma__qq_get_message_detail', 'mcp__snowluma__qq_social_state',
    ]) {
      assert.ok(deny.includes(tool), `${feature} 应隐藏 ${tool}`);
    }
    assert.ok(!deny.includes('mcp__snowluma__qq_send_message'), `${feature} 不应隐藏 qq_send_message`);
  }

  const webDeny = featureSchemaDenyList('web');
  assert.ok(!webDeny.includes('mcp__web-search-safe__web_search'));
  assert.ok(!webDeny.includes('mcp__web-search-safe__web_fetch'));
  assert.ok(webDeny.includes('mcp__snowluma__qq_send_sticker'));

  const stickerDeny = featureSchemaDenyList('sticker');
  assert.ok(!stickerDeny.includes('mcp__snowluma__qq_send_sticker'));
  assert.ok(stickerDeny.includes('mcp__snowluma__qq_get_message_images'));
});

await test('apply：所有 feature 共有的"无用读取工具"在装配期就从 schema 隐藏', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-schema-restrict-'));
  const saved = { ...process.env };
  try {
    fs.mkdirSync(path.join(temp, 'state'), { recursive: true });
    const configFile = path.join(temp, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({
      ownerQQ: OWNER,
      dsh: { features: { enabled: true } },
    }));
    fs.writeFileSync(path.join(temp, 'state', 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
    fs.writeFileSync(path.join(temp, 'state', 'sessions.json'), JSON.stringify({
      sessions: { [`group:${GROUP}`]: 'sid-chat' },
      sessionVariants: { [`group:${GROUP}`]: 'chat:advanced' },
      parkedSessions: {},
    }));
    process.env.QQ_TOOL_RESTRICT_CONFIG = configFile;
    process.env.QQ_TOOL_RESTRICT_SESSIONS = path.join(temp, 'state', 'sessions.json');
    process.env.QQ_TOOL_RESTRICT_MODE = path.join(temp, 'state', 'mode.json');
    process.env.QQ_TOOL_RESTRICT_LOG = path.join(temp, 'tool-restrict.log');
    resetFeatureGateCache();

    const restricted = [];
    let guard = null;
    let preStep = null;
    const ctx = {
      tools: {
        restrict: (filter) => { restricted.push(filter) },
        guard: (fn) => { guard = fn },
      },
      on: (event, fn) => { if (event === 'agent/pre-step') preStep = fn },
    };
    applyRestrictGuard(ctx);
    assert.ok(typeof guard === 'function', 'apply 应注册 guard');
    assert.ok(typeof preStep === 'function', 'apply 应注册 agent/pre-step 监听');

    // 2026-10-28：schema 收窄在 agent/pre-step（模型第一回合前）做一次「全局无用工具」隐藏；
    // 不再按 session/feature 做 apply 期收窄（实测跨会话泄漏）。
    await preStep({ agent: { id: 'sid-chat' } }, async () => {});
    const deniedNames = restricted.flatMap((filter) => filter.deny || []);
    for (const tool of [
      'mcp__snowluma__qq_get_group_members',
      'mcp__snowluma__qq_get_active_members',
      'mcp__snowluma__qq_get_recent_messages',
      'mcp__snowluma__qq_get_my_recent_messages',
      'mcp__snowluma__qq_get_message_detail',
      'mcp__snowluma__qq_social_state',
    ]) {
      assert.ok(deniedNames.includes(tool), `apply 期应隐藏 ${tool}`);
    }
    // 这些工具属于个别 feature 的能力，不应在 apply 期被全局隐藏。
    for (const tool of [
      'mcp__snowluma__qq_get_prompt',
      'mcp__snowluma__qq_get_message_images',
      'mcp__snowluma__qq_get_forward_msg',
      'mcp__snowluma__qq_send_sticker',
      'mcp__snowluma__qq_send_message',
    ]) {
      assert.ok(!deniedNames.includes(tool), `apply 期不应隐藏 ${tool}`);
    }
    // apply 期不再有按会话的惰性收窄：guard 第一次执行不应追加 restrict。
    const callsAfterApply = restricted.length;
    assert.ok(callsAfterApply > 0, 'apply 期应调用 restrict');
    assert.equal(guard({ name: 'mcp__snowluma__qq_get_prompt', agent: { id: 'sid-chat' } }), undefined);
    assert.equal(restricted.length, callsAfterApply, 'guard 首次执行不应再追加 restrict');

    // 执行期越界仍被拒绝（双保险）。
    const verdict = guard({ name: 'mcp__snowluma__qq_get_group_members', agent: { id: 'sid-chat' } });
    assert.equal(typeof verdict, 'string');
    assert.match(verdict, /feature-tool-out-of-scope/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    resetFeatureGateCache();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// ── 守卫（执行期硬边界）────────────────────────────────────────────────────

await test('qq-tool-restrict：按 sessionId → feature 拒绝越界工具 / 放行本域工具', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-feature-guard-'));
  try {
    fs.mkdirSync(path.join(temp, 'state'), { recursive: true });
    const configFile = path.join(temp, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({
      ownerQQ: OWNER,
      dsh: { features: { enabled: true } }
    }));
    fs.writeFileSync(path.join(temp, 'state', 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
    fs.writeFileSync(path.join(temp, 'state', 'sessions.json'), JSON.stringify({
      sessions: { [`group:${GROUP}`]: 'sid-web' },
      sessionVariants: { [`group:${GROUP}`]: 'web:advanced' },
      parkedSessions: {
        [`group:${GROUP}`]: {
          'chat:basic': 'sid-chat',
          'sticker:basic': 'sid-sticker',
          'vision:advanced': 'sid-vision',
          'voice:advanced': 'sid-voice'
        }
      }
    }));
    process.env.QQ_TOOL_RESTRICT_CONFIG = configFile;
    process.env.QQ_TOOL_RESTRICT_SESSIONS = path.join(temp, 'state', 'sessions.json');
    process.env.QQ_TOOL_RESTRICT_MODE = path.join(temp, 'state', 'mode.json');
    resetFeatureGateCache();

    // 联网会话：可以搜，但不能发表情/看图
    assert.equal(featureToolGate('mcp__web-search-safe__web_search', 'sid-web'), null);
    assert.notEqual(featureToolGate('mcp__snowluma__qq_send_sticker', 'sid-web'), null);
    // 表情包会话：可以发表情，不能搜/看图
    assert.equal(featureToolGate('mcp__snowluma__qq_send_sticker', 'sid-sticker'), null);
    assert.notEqual(featureToolGate('mcp__web-search-safe__web_search', 'sid-sticker'), null);
    assert.notEqual(featureToolGate('mcp__snowluma__qq_get_message_images', 'sid-sticker'), null);
    // 看图会话：可以取图/看转发，不能发表情
    assert.equal(featureToolGate('mcp__snowluma__qq_get_message_images', 'sid-vision'), null);
    assert.equal(featureToolGate('mcp__snowluma__qq_get_forward_msg', 'sid-vision'), null);
    assert.notEqual(featureToolGate('mcp__snowluma__qq_send_sticker', 'sid-vision'), null);
    // 聊天会话：只读看图放行；合并转发/联网仍拒绝，正常对话工具全放行
    assert.equal(featureToolGate('mcp__snowluma__qq_get_message_images', 'sid-chat'), null);
    assert.notEqual(featureToolGate('mcp__snowluma__qq_get_forward_msg', 'sid-chat'), null);
    assert.notEqual(featureToolGate('mcp__web-search-safe__web_search', 'sid-chat'), null);
    // 2026-10-30：chat 也能配表情（文字+表情掺着发）和自己收藏；改备注仍拒绝。
    assert.equal(featureToolGate('mcp__snowluma__qq_send_sticker', 'sid-chat'), null);
    assert.equal(featureToolGate('mcp__snowluma__qq_collect_sticker', 'sid-chat'), null);
    assert.notEqual(featureToolGate('mcp__snowluma__qq_set_sticker_remark', 'sid-chat'), null);
    assert.equal(featureToolGate('mcp__snowluma__qq_send_message', 'sid-chat'), null);
    // 2026-10-28：chat 不再放行成员列表/历史消息/详情/社交状态。
    for (const tool of [
      'qq_get_group_members', 'qq_get_active_members', 'qq_get_recent_messages',
      'qq_get_my_recent_messages', 'qq_get_message_detail', 'qq_social_state',
    ]) {
      assert.notEqual(featureToolGate(`mcp__snowluma__${tool}`, 'sid-chat'), null, `chat 应拒绝 ${tool}`);
    }
    // 未知会话（非 QQ 会话）不拦，保持旧行为
    assert.equal(featureToolGate('mcp__web-search-safe__web_search', 'unknown-session'), null);
  } finally {
    delete process.env.QQ_TOOL_RESTRICT_CONFIG;
    delete process.env.QQ_TOOL_RESTRICT_SESSIONS;
    delete process.env.QQ_TOOL_RESTRICT_MODE;
    resetFeatureGateCache();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// ── 真实 bridge + 假 DSH：5 条模拟消息各走一套会话 ─────────────────────────

function appendIncoming(h, key, text, { media = [], isOwner = false } = {}) {
  const seqText = text || (media.length ? '[图片]' : '');
  h.appendSocialV2Message(key, isOwner ? '管理员' : 'u111', seqText, seqText, false, isOwner, Date.now(), media, 111, [], '');
}

async function deliver(h, key) {
  const before = h.calls.prompts.length;
  await h.deliverPromptNow(key, 'fixture', { wakeReason: 'atMention@1' });
  assert.equal(h.calls.prompts.length, before + 1, `${key} 应该投递一条 prompt`);
  return h.calls.prompts.at(-1);
}

await test('真实 bridge：5 条模拟消息 → 5 套独立会话、模型映射、历史共享、工具面', async () => {
  const h = await bridgeHarness({ config: { dsh: featureConfig(), socialV2: { agentPreset: 'qq-chat-v2', tools: { sendVoice: true } } } });
  const key = `group:${GROUP}`;
  try {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    const st = h.getSocialV2State(key);
    st.activeTopics = [{ text: '周末去爬山', lastMentionAt: Date.now() }]; // 记忆：每套会话都要看到

    const cases = [
      { name: 'chat', text: '今天吃什么', media: [], variant: 'chat:basic' },
      { name: 'sticker', text: '', media: [{ kind: 'face', faceId: '14', summary: '表情' }], variant: 'sticker:basic' },
      { name: 'vision', text: '', media: [{ kind: 'image', url: 'https://public.invalid/x.png', summary: '图片' }], variant: 'vision:advanced' },
      { name: 'voice', text: '发条语音来听听', media: [], variant: 'voice:advanced' },
      { name: 'web', text: '搜一下今天有什么新闻', media: [], variant: 'web:advanced' }
    ];
    const seen = new Map();
    for (const item of cases) {
      appendIncoming(h, key, item.text, { media: item.media });
      const prompt = await deliver(h, key);
      assert.equal(h.state.sessionVariants[key], item.variant, `${item.name} 应走 ${item.variant}`);
      const sid = h.state.sessions[key];
      assert.ok(sid, `${item.name} 应该有 sessionId`);
      assert.equal(seen.has(sid), false, `${item.name} 必须是独立会话（不能复用其它功能的 sessionId）`);
      seen.set(sid, item.name);
      // 历史共享：每条功能会话的 prompt 都带最近消息快照 + 记忆 + 时间/黑话注入。
      const text = prompt.content.find((p) => p.type === 'text')?.text || '';
      assert.match(text, /【本次消息快照】/, `${item.name} 应注入最近消息快照`);
      assert.match(text, /周末去爬山/, `${item.name} 应注入共享记忆`);
      assert.match(text, /【当前时间】/, `${item.name} 应注入时间/黑话上下文`);
      assert.match(text, new RegExp(`【${({ chat: '聊天', sticker: '表情包', vision: '看图', voice: '语音', web: '联网' })[item.name]}会话`), `${item.name} 应有功能提示`);
      // 工具面（当前激活 variant 决定）
      assert.equal(h.activeFeatureOfKey(key), item.name);
      // chat/vision/web 都能读图（web 是主动冒泡默认落脚处）；sticker/voice 不行。
      assert.equal(h.v2ToolEnabled('getImages', key), item.name === 'vision' || item.name === 'chat' || item.name === 'web');
      // 合并转发只留给 vision。
      assert.equal(h.v2ToolEnabled('getForwardMsg', key), item.name === 'vision');
      // 2026-10-30：表情发送在 chat/sticker 都开（chat 要能"文字+表情"掺着发）。
      assert.equal(h.v2ToolEnabled('sendSticker', key), item.name === 'sticker' || item.name === 'chat');
      assert.equal(h.v2ToolEnabled('sendVoice', key), item.name === 'voice');
      assert.equal(h.v2ToolEnabled('sendMessage', key), true);
      assert.equal(h.v2ToolEnabled('memory', key), item.name !== 'sticker');
    }
    // 模型映射：群聊 chat / sticker 基础，vision/voice/web 进阶
    const selected = h.calls.selectedModels;
    const bySession = (name) => {
      const sid = [...seen.entries()].find(([, n]) => n === name)?.[0];
      return selected.filter((p) => p.sessionId === sid).at(-1);
    };
    assert.equal(bySession('chat').provider, 'workbuddy');
    assert.equal(bySession('chat').model, 'wb-model');
    assert.equal(bySession('sticker').provider, 'workbuddy');
    assert.equal(bySession('vision').provider, 'adv-provider');
    assert.equal(bySession('vision').model, 'adv-model');
    assert.equal(bySession('voice').provider, 'adv-provider');
    assert.equal(bySession('web').provider, 'adv-provider');
    // DSH 上确实有 5 个不同 session
    const allSessions = new Set([h.state.sessions[key], ...Object.values(h.state.parkedSessions[key] || {})]);
    assert.equal(allSessions.size, 5, '5 套功能会话必须对应 5 个不同 DSH sessionId');
  } finally {
    await h.close();
  }
});

await test('真实 bridge：切回原功能时恢复原 DSH 会话（上下文停放/恢复）', async () => {
  const h = await bridgeHarness({ config: { dsh: featureConfig(), socialV2: { agentPreset: 'qq-chat-v2', tools: { sendVoice: true } } } });
  const key = `group:${GROUP}`;
  try {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    appendIncoming(h, key, '看看这张图', { media: [{ kind: 'image', url: 'https://public.invalid/a.png' }] });
    await deliver(h, key);
    const visionSid = h.state.sessions[key];
    assert.equal(h.state.sessionVariants[key], 'vision:advanced');

    appendIncoming(h, key, '今天吃什么');
    await deliver(h, key);
    const chatSid = h.state.sessions[key];
    assert.equal(h.state.sessionVariants[key], 'chat:basic');
    assert.notEqual(chatSid, visionSid);
    assert.equal(h.state.parkedSessions[key]['vision:advanced'], visionSid, '看图会话应被停放');

    appendIncoming(h, key, '还有这张图', { media: [{ kind: 'image', url: 'https://public.invalid/b.png' }] });
    await deliver(h, key);
    assert.equal(h.state.sessionVariants[key], 'vision:advanced');
    assert.equal(h.state.sessions[key], visionSid, '切回看图必须复用原会话，而不是新建');
    assert.equal(h.state.parkedSessions[key]['chat:basic'], chatSid, '聊天会话应被停放');
    // sessions.json 已落盘，桥接重启后能恢复
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'sessions.json'), 'utf8'));
    assert.equal(saved.parkedSessions[key]['chat:basic'], chatSid);
    assert.equal(saved.sessionVariants[key], 'vision:advanced');
  } finally {
    await h.close();
  }
});

await test('真实 bridge：chat 会话收到图片时只给「只读看图」提示（不内联、不切 vision）', async () => {
  const h = await bridgeHarness({ config: { dsh: featureConfig(), socialV2: { agentPreset: 'qq-chat-v2' } } });
  const key = `group:${GROUP}`;
  try {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    // 先有一条文字消息，让 chat 成为当前会话
    appendIncoming(h, key, '今天吃什么');
    await deliver(h, key);
    assert.equal(h.state.sessionVariants[key], 'chat:basic');

    // 再收到一张图：管理员 /chat 覆盖下应留在 chat，并且只给只读看图工具，
    // 不把图片附件直接塞进 prompt（这正是"小口子、不切整个视觉会话"的语义）。
    h.setFeatureOverride(key, 'chat');
    appendIncoming(h, key, '', { media: [{ kind: 'image', url: 'https://public.invalid/x.png' }] });
    const prompt = await deliver(h, key);
    assert.equal(h.state.sessionVariants[key], 'chat:basic', 'chat 覆盖下图片不能切到 vision');
    assert.equal(h.v2ToolEnabled('getImages', key), true, 'chat 必须能调用 qq_get_message_images');
    assert.equal(h.v2ToolEnabled('getForwardMsg', key), false, 'chat 不应拿到合并转发工具');
    const text = prompt.content.find((p) => p.type === 'text')?.text || '';
    assert.match(text, /qq_get_message_images/, '提示词要告诉模型可以只读看图');
    assert.match(text, /只读/, '提示要明确只读');
    assert.doesNotMatch(text, /当前功能会话没有看图工具/, '不能再声称 chat 看不了图');
    assert.equal(prompt.content.some((p) => p.type === 'image'), false, 'chat 不内联图片，按需用工具读');
  } finally {
    await h.close();
  }
});

await test('真实 bridge：显式 /vision 命令（带内容与单独发送）', async () => {
  const h = await bridgeHarness({ config: { dsh: featureConfig(), socialV2: { agentPreset: 'qq-chat-v2', tools: { sendVoice: true } } } });
  const key = `group:${GROUP}`;
  try {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    // 单独发 /vision：登记覆盖 + 回执，不进入未读/唤醒
    await h.handleIncoming('group', GROUP, groupEvent(OWNER, '/vision', 3001), h.cfg);
    assert.equal(h.peekFeatureOverride(key), 'vision');
    assert.ok(h.calls.sent.some((s) => /下一条消息走/.test(s.text)), '应回复覆盖已登记');
    // 下一条消息（内容本身不含"看图"关键词）也应走 vision
    appendIncoming(h, key, '这个是什么');
    await deliver(h, key);
    assert.equal(h.state.sessionVariants[key], 'vision:advanced', '显式 /vision 覆盖应生效');
    assert.equal(h.peekFeatureOverride(key), '', '覆盖应被本回合消费');
    // /auto 清除覆盖
    await h.handleIncoming('group', GROUP, groupEvent(OWNER, '/auto', 3002), h.cfg);
    assert.equal(h.peekFeatureOverride(key), '');
  } finally {
    await h.close();
  }
});

await test('真实 bridge：features.enabled=false 时回滚为单会话/旧路由', async () => {
  const h = await bridgeHarness({
    config: { dsh: { ...featureConfig(), features: { enabled: false } }, socialV2: { agentPreset: 'qq-chat-v2' } }
  });
  const key = `group:${GROUP}`;
  try {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    appendIncoming(h, key, '', { media: [{ kind: 'image', url: 'https://public.invalid/a.png' }] });
    await deliver(h, key);
    assert.equal(h.state.sessionVariants[key], 'chat:basic', '回滚后不允许出现功能会话 variant');
    assert.deepEqual(h.state.parkedSessions[key] || {}, {}, '回滚后不应有停放的功能会话');
  } finally {
    await h.close();
  }
});

await test('真实 bridge：chat / mention-only 模式不启用功能会话（只 reserved2）', async () => {
  const h = await bridgeHarness({ config: { dsh: featureConfig(), socialV2: { agentPreset: 'qq-chat-v2', tools: { sendVoice: true } } } });
  const key = `group:${GROUP}`;
  try {
    h.setMode('chat');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    const decision = h.routeTurn(key, [{ kind: 'image', url: 'https://public.invalid/a.png' }], { wake: true });
    assert.equal(decision.feature, 'chat');
    assert.equal(decision.variant, 'chat:basic');
    assert.equal(decision.reason, 'features-inactive');
  } finally {
    await h.close();
  }
});

await test('真实 bridge：runFeatureSelftest 创建 5 套会话并核对模型/工具面/历史', async () => {
  const h = await bridgeHarness({ config: { dsh: featureConfig(), socialV2: { agentPreset: 'qq-chat-v2', tools: { sendVoice: true } } } });
  const key = `group:${GROUP}`;
  try {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    h.getSocialV2State(key).activeTopics = [{ text: '周末去爬山', lastMentionAt: Date.now() }];
    appendIncoming(h, key, '先有一句话');
    await deliver(h, key); // 建出原 chat 会话，验证"恢复原上下文"
    const originalSid = h.state.sessions[key];
    const report = await h.runFeatureSelftest(key);
    assert.equal(report.results.length, 5);
    assert.equal(report.allSessionsDistinct, true, '5 套会话 sessionId 必须互不相同');
    assert.equal(report.restoredVariant, 'chat:basic');
    assert.equal(report.activeSessionId, originalSid, '自检结束应恢复到原 chat 会话');
    for (const row of report.results) {
      assert.equal(row.history.snapshot, true, `${row.feature} 应有最近消息快照`);
      assert.ok(row.history.memoryChars > 0, `${row.feature} 应有记忆注入`);
      assert.equal(row.toolChecks.conversation, true);
      assert.equal(row.toolChecks.webSearchExpected, row.feature === 'web');
    }
    const byFeature = Object.fromEntries(report.results.map((r) => [r.feature, r]));
    assert.equal(byFeature.sticker.toolChecks.stickers, true);
    assert.equal(byFeature.vision.toolChecks.images, true);
    assert.equal(byFeature.voice.toolChecks.voice, true);
    // chat 也有只读看图能力（小口子），2026-10-30 起也能自己发表情。
    assert.equal(byFeature.chat.toolChecks.images, true);
    assert.equal(byFeature.chat.toolChecks.stickers, true);
  } finally {
    await h.close();
  }
});

console.log(`\n${failures === 0 ? '全部功能会话用例通过' : `${failures} 个用例失败`}  tests=${tests} failures=${failures}`);
if (failures > 0) process.exit(1);
