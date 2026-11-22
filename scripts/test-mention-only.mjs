// 「仅@」模式（mention-only）回归测试。
//
// 覆盖三层：
//   ① src/mention-only.js 的纯函数（@ / 引用 / 叫名字 / 私聊 / 兜底别名）；
//   ② bridge 的接线：模式别名、preset（必须用 qq-chat，失败时绝不回退标准 preset）、
//      modeAllowed 白名单、handleIncoming 的 message-level 闸门、refreshMode 的本地降级；
//   ③ 控制台静态契约：CONSOLE_MODES / UI 下拉 / DSH 插件 schema 都认识 mention-only。
//
// 全部在 VM 夹具里跑，不连真实 QQ / DSH / 正在运行的 3100/7788。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FALLBACK_MENTION_ALIASES,
  buildMentionAliases,
  detectMention,
  evaluateMentionOnlyMessage
} from '../src/mention-only.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BOT_QQ = '100000002';

let failures = 0;
async function test(name, run) {
  try {
    await run();
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

// ── ① 纯函数 ─────────────────────────────────────────────────────────────

await test('别名：昵称/角色/配置/兜底合并，去空去重且大小写不敏感', () => {
  const aliases = buildMentionAliases({
    nickname: ' 星辰 ',
    roleName: '小鲸鱼',
    configured: ['小星星', '小星星', '  ', 'DeepSeek']
  });
  assert.equal(aliases[0], '星辰');
  assert.ok(aliases.includes('小鲸鱼'));
  assert.ok(aliases.includes('小星星'));
  assert.ok(aliases.includes('DeepSeek'));
  assert.equal(aliases.filter((a) => a === '小星星').length, 1, '重复别名只留一份');
  assert.ok(FALLBACK_MENTION_ALIASES.every((a) => aliases.includes(a)), '兜底别名必须在');
  assert.deepEqual(buildMentionAliases({}), [...FALLBACK_MENTION_ALIASES], '没有身份信息时只剩兜底');
});

await test('@ 判定：number/string 的 qq、at all、at 别人', () => {
  const aliases = ['星辰'];
  assert.equal(detectMention({
    message: [{ type: 'at', data: { qq: BOT_QQ } }], selfIds: [BOT_QQ], aliases
  }).reason, 'at');
  assert.equal(detectMention({
    message: [{ type: 'at', data: { qq: Number(BOT_QQ) } }], selfIds: [BOT_QQ], aliases
  }).reason, 'at');
  assert.equal(detectMention({
    message: [{ type: 'at', data: { qq: 'all' } }], selfIds: [BOT_QQ], aliases
  }).matched, false, '@全体成员不是 @机器人');
  assert.equal(detectMention({
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '你好' } }],
    selfIds: [BOT_QQ], aliases
  }).matched, false);
  // 少数网关只给 CQ 码字符串
  assert.equal(detectMention({
    message: `[CQ:at,qq=${BOT_QQ}] 在吗`, selfIds: [BOT_QQ], aliases
  }).reason, 'at');
});

await test('引用自己 / 叫名字 / 普通闲聊', () => {
  assert.equal(detectMention({
    message: [{ type: 'reply', data: { id: '9' } }], quoteTargetIsSelf: true, selfIds: [BOT_QQ], aliases: ['星辰']
  }).reason, 'quote');
  assert.equal(detectMention({
    message: [{ type: 'text', data: { text: '星辰在吗' } }], selfIds: [BOT_QQ], aliases: ['星辰']
  }).reason, 'name');
  assert.equal(detectMention({
    message: [{ type: 'text', data: { text: 'DEEPSEEK 来说说' } }], selfIds: [BOT_QQ], aliases: ['DeepSeek']
  }).reason, 'name', '英文别名必须大小写不敏感');
  assert.equal(detectMention({
    message: [{ type: 'text', data: { text: '今天天气不错' } }], selfIds: [BOT_QQ], aliases: ['星辰']
  }).matched, false);
  // 只 @ 别人、文字里也没有名字：不算叫机器人
  assert.equal(detectMention({
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 吃饭吗' } }],
    selfIds: [BOT_QQ], aliases: ['星辰']
  }).matched, false);
});

await test('evaluateMentionOnlyMessage：群聊要命中，私聊/其它模式直接放行', () => {
  const base = { message: [{ type: 'text', data: { text: '随便聊聊' } }], selfIds: [BOT_QQ], aliases: ['星辰'] };
  assert.equal(evaluateMentionOnlyMessage({ mode: 'mention-only', kind: 'group', ...base }).handle, false);
  assert.equal(evaluateMentionOnlyMessage({
    mode: 'mention-only', kind: 'group', ...base,
    message: [{ type: 'text', data: { text: '星辰' } }]
  }).handle, true);
  assert.equal(evaluateMentionOnlyMessage({ mode: 'mention-only', kind: 'private', ...base }).handle, true);
  assert.equal(evaluateMentionOnlyMessage({ mode: 'chat', kind: 'group', ...base }).handle, true);
});

// ── ② bridge 接线 ─────────────────────────────────────────────────────────

await test('模式别名 / valid modes / 白名单 / preset', async () => {
  const h = await bridgeHarness({ config: { agentPreset: 'qq-chat' } });
  try {
    assert.equal(h.normalizeModeInput('mention-only'), 'mention-only');
    assert.equal(h.normalizeModeInput(' simulation '), 'reserved2', '旧别名不能被这次改动带走');
    for (const mode of ['chat', 'mention-only', 'reserved', 'reserved2', 'closed-agent']) {
      assert.ok(h.VALID_MODES.includes(mode), `${mode} 应在 VALID_MODES`);
    }

    h.setMode('mention-only');
    assert.equal(h.getMode(), 'mention-only');

    assert.equal(h.modeAllowed('group:456', 'group', 456, h.cfg, 'mention-only'), true);
    assert.equal(h.modeAllowed('group:999', 'group', 999, h.cfg, 'mention-only'), false);
    assert.equal(h.modeAllowed('private:123', 'private', 123, h.cfg, 'mention-only'), true);
    assert.equal(h.modeAllowed('private:999', 'private', 999, h.cfg, 'mention-only'), false);
    // 不破坏 closed-agent
    assert.equal(h.modeAllowed('private:123', 'private', 123, h.cfg, 'closed-agent'), true);
    assert.equal(h.modeAllowed('group:456', 'group', 456, h.cfg, 'closed-agent'), false);

    // preset 必须是 chat 的 qq-chat；清单里没有时必须 fail-closed（undefined），
    // 绝不能回退到 DSH 默认 preset（standard 含本地工具）。
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    assert.equal(h.modePreset('group:456', 'mention-only', h.cfg), 'qq-chat');
    h.setPresets(['standard']);
    assert.equal(h.modePreset('group:456', 'mention-only', h.cfg), undefined, '不得回退 standard');
  } finally {
    await h.close();
  }
});

await test('refreshMode：DSH 旧 schema 拒绝 mention-only 时按本地保留，外部改 DSH 则让位', async () => {
  const h = await bridgeHarness({
    config: { agentPreset: 'qq-chat' },
    files: {
      'state/mode.json': { mode: 'mention-only', dshSynced: false, dshSeenMode: 'closed-agent' }
    }
  });
  try {
    const describe = (mode) => ({
      result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode }, user: {} }] } }
    });
    h.api.settings.describe = async () => describe('closed-agent');
    await h.refreshMode();
    assert.equal(h.getMode(), 'mention-only', 'DSH 仍是写穿失败时的旧值 ⇒ 本地 mention-only 不能被改回去');

    // 有人在 DSH 设置里明确改成了 chat ⇒ DSH 是更新的意图，必须让位。
    h.api.settings.describe = async () => describe('chat');
    await h.refreshMode();
    assert.equal(h.getMode(), 'chat', 'DSH 值变了 ⇒ 以 DSH 为准');
    const local = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/mode.json'), 'utf8'));
    assert.equal(local.mode, 'chat', '让位后应把本地 mode.json 同步成 DSH 值');
    assert.equal(local.dshSynced, true);
  } finally {
    await h.close();
  }
});

await test('启动即按本地 mode.json 生效：DSH 未就绪窗口不能回落到 chat', async () => {
  const h = await bridgeHarness({
    config: { agentPreset: 'qq-chat' },
    files: {
      'state/mode.json': { mode: 'mention-only', dshSynced: true, dshSeenMode: 'mention-only' }
    }
  });
  try {
    // 进程刚起来、第一次连 DSH 之前：必须已经是 mention-only，而不是默认 chat。
    assert.equal(h.getMode(), 'mention-only', '启动初始化必须读本地 mode.json');
    // 模拟 DSH 不可用时的轮询分支：checkDsh 失败也应回落到同一个本地模式。
    h.setMode('chat');
    h.applyLocalModeFallback();
    assert.equal(h.getMode(), 'mention-only', 'DSH 不可用时必须按本地 mode.json 回退');
  } finally {
    await h.close();
  }
});

await test('handleIncoming：mention-only 群聊只处理 @ / 引用 / 名字，私聊与 chat 不受影响', async () => {
  const h = await bridgeHarness({ config: { agentPreset: 'qq-chat' } });
  try {
    h.setMode('mention-only');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    const event = (message, extra = {}) => ({
      self_id: BOT_QQ,
      group_id: 456,
      user_id: 111,
      message_id: 1001,
      message,
      sender: { user_id: 111, nickname: '路人', card: '' },
      ...extra
    });
    const promptCount = () => h.calls.prompts.length;

    const before = promptCount();
    await h.handleIncoming('group', 456, event([{ type: 'text', data: { text: '今天天气不错' } }]), h.cfg);
    assert.equal(promptCount(), before, '非 @ 群消息必须静默忽略');

    await h.handleIncoming('group', 456, event([
      { type: 'at', data: { qq: BOT_QQ } },
      { type: 'text', data: { text: ' 你好' } }
    ]), h.cfg);
    assert.equal(promptCount(), before + 1, '@ 机器人必须处理');

    await h.handleIncoming('group', 456, event([{ type: 'text', data: { text: '星辰在吗' } }]), h.cfg);
    assert.equal(promptCount(), before + 2, '叫昵称必须处理');

    h.cfg.mentionOnly = { aliases: ['小星星'] };
    await h.handleIncoming('group', 456, event([{ type: 'text', data: { text: '小星星出来' } }]), h.cfg);
    assert.equal(promptCount(), before + 3, '配置里的别名必须处理');

    // 引用机器人自己：解析 get_msg 时 sender 的 user_id 等于 self_id。
    h.bot.getMessage = async () => ({
      group_id: 456,
      sender: { user_id: BOT_QQ, nickname: '星辰' },
      message: [{ type: 'text', data: { text: '上一条' } }]
    });
    await h.handleIncoming('group', 456, event([
      { type: 'reply', data: { id: '9001' } },
      { type: 'text', data: { text: '接着说' } }
    ]), h.cfg);
    assert.equal(promptCount(), before + 4, '引用机器人自己的消息必须处理');

    // 非白名单群：即使 @ 了也不能越过 modeAllowed。
    await h.handleIncoming('group', 999, event([
      { type: 'at', data: { qq: BOT_QQ } },
      { type: 'text', data: { text: ' 你好' } }
    ], { group_id: 999 }), h.cfg);
    assert.equal(promptCount(), before + 4, '非白名单群必须被 modeAllowed 拦下');

    // 私聊：同一模式下照常处理。
    await h.handleIncoming('private', 123, {
      self_id: BOT_QQ, user_id: 123, message_id: 2002,
      message: [{ type: 'text', data: { text: '私聊随便说' } }],
      sender: { user_id: 123, nickname: '管理员' }
    }, h.cfg);
    assert.equal(promptCount(), before + 5, '私聊不受 mention-only 影响');

    // 回归：chat 下普通群消息照旧处理。
    h.setMode('chat');
    await h.handleIncoming('group', 456, event([{ type: 'text', data: { text: 'chat 模式普通消息' } }]), h.cfg);
    assert.equal(promptCount(), before + 6, 'chat 模式不能被这次改动影响');
  } finally {
    await h.close();
  }
});

await test('POST /api/mode 接受 mention-only；DSH 旧 schema 拒绝时 refreshMode 仍保留', async () => {
  const h = await bridgeHarness({ config: { consolePort: 0, agentPreset: 'qq-chat' } });
  let server = null;
  try {
    const closedAgentDescribe = async () => ({
      result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'closed-agent' }, user: {} }] } }
    });
    // 先让桥接知道 DSH 里的基线（正常情况下 refreshMode 每 5 秒都会跑一次）。
    h.api.settings.describe = closedAgentDescribe;
    await h.refreshMode();
    assert.equal(h.getMode(), 'closed-agent');

    // 模拟「DSH 插件 schema 较旧」：settings.update 被拒。
    h.api.settings.update = async () => ({
      result: { ok: false, error: { code: 'invalid-config', message: 'mode: expected union value' } }
    });

    server = h.startConsoleServer();
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
      body: JSON.stringify({ mode: 'mention-only' })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, 'mention-only');
    assert.equal(payload.dshSynced, false, '写穿被拒必须如实回报');
    assert.equal(h.getMode(), 'mention-only', '写穿失败也要立刻生效');

    const local = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/mode.json'), 'utf8'));
    assert.equal(local.mode, 'mention-only');
    assert.equal(local.dshSynced, false);
    assert.equal(local.dshSeenMode, null, '写穿失败时不猜 DSH 基线，交给第一次 refreshMode 补记');

    // 5 秒后的轮询：DSH 仍返回旧值（没人在 DSH 侧改过）⇒ 本地 mention-only 保留，
    // 并把真实的 DSH 基线补记下来。
    h.api.settings.describe = closedAgentDescribe;
    await h.refreshMode();
    assert.equal(h.getMode(), 'mention-only');
    const reconciled = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/mode.json'), 'utf8'));
    assert.equal(reconciled.dshSeenMode, 'closed-agent', 'refreshMode 必须补记真实的 DSH 基线');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

// ── ③ 控制台 / 插件静态契约 ───────────────────────────────────────────────

await test('控制台 CONSOLE_MODES、UI 下拉、DSH 插件 schema 都包含 mention-only', async () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'console/server.mjs'), 'utf8');
  assert.match(serverSrc, /const CONSOLE_MODES = \[[^\]]*'mention-only'[^\]]*\]/s);
  const uiSrc = fs.readFileSync(path.join(ROOT, 'console/ui.html'), 'utf8');
  assert.match(uiSrc, /<option value="mention-only">仅@（只被@时回）<\/option>/);

  const plugin = await import(pathToFileURL(path.join(ROOT, 'plugins/qq-mode-console/lib/index.js')).href);
  assert.equal(plugin.Config({ mode: 'mention-only' }).mode, 'mention-only', 'DSH 插件 schema 必须接受 mention-only');
  assert.equal(plugin.QqModeSchema({ mode: 'mention-only' }).mode, 'mention-only');
});

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部 mention-only 用例通过');
