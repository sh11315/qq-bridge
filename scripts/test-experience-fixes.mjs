// 3 个体验修复的回归 + 实测（真实 bridge 代码 + 假 DSH/OneBot，不碰生产 QQ）：
//   1) 分条发送间隔默认 ≤2 秒、长间隔默认关闭（config 默认值 + 真实 send-message 路由计时）；
//   2) 每轮唤醒快照的「最近消息」条数从 2 提到 5~8，并且 token 预算仍然生效；
//   3) 切功能会话时把上一轮结论（一行）带进新会话快照；同一功能内不重复注入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 456;
const PRIVATE = 123;
const CONSOLE = { 'x-console-token': 'fixture-console-token' };
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

function call(port, pathname, { method = 'GET', headers = {}, body, token } = {}) {
  const h = { 'content-type': 'application/json', ...CONSOLE, ...headers };
  if (token) h['x-agent-token'] = token;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, body: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function featureConfig() {
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
        sticker: 'basic', vision: 'advanced', voice: 'advanced', web: 'advanced',
      },
    },
  };
}

// ── 1. 发送间隔 ─────────────────────────────────────────────────────────────

await test('发送间隔默认值：条间 0.6~1.6 秒、硬上限 2 秒、长间隔关闭', async () => {
  const h = await bridgeHarness();
  try {
    const send = h.cfg.socialV2.send;
    assert.equal(send.burstIntervalMinMs, 600);
    assert.equal(send.burstIntervalMaxMs, 1600);
    assert.equal(send.longGapProbability, 0, '长间隔默认必须关闭（0）');
    assert.equal(send.maxGapMs, 2000, '默认硬上限 2 秒');
    assert.ok(send.burstIntervalMaxMs <= 2000);
    assert.equal(send.maxSendPerMinute, 12, '正常聊天不能被 8 条/分钟误伤');
    assert.equal(send.maxSendPerHour, 180, '正常私聊不能被 60 条/小时误伤');
    // 一代 social 默认值也同步（非 reserved2 的自动转发路径）。
    assert.equal(h.cfg.social.burstIntervalMinMs, 600);
    assert.equal(h.cfg.social.burstIntervalMaxMs, 1600);
    assert.equal(h.cfg.social.longGapProbability, 0);

    // auto 模式随机 200 轮，任何一次都不能超过 2 秒。
    for (let round = 0; round < 200; round += 1) {
      const delays = h.computeGapsV2(['a', 'b', 'c', 'd'], 'auto', undefined, undefined, send);
      assert.equal(delays.length, 3);
      for (const delay of delays) {
        assert.ok(Number.isFinite(delay), `间隔必须是数字，实际 ${delay}`);
        assert.ok(delay >= 600 && delay <= 2000, `间隔 ${delay}ms 超出 600~2000ms`);
      }
    }
    // 就算有人把长间隔概率打开、范围写成 5~10 秒，也会被 maxGapMs 压回 2 秒。
    const clamped = h.computeGapsV2(['a', 'b'], 'auto', undefined, undefined, {
      ...send,
      longGapProbability: 1,
      longGapMinMs: 5000,
      longGapMaxMs: 10000,
    });
    assert.equal(clamped[0], 2000);
    assert.equal(h.clampGapV2(9000, send), 2000);
    assert.equal(h.clampGapV2(100, send), 600, '不能低于配置下限');
  } finally {
    await h.close();
  }
});

await test('实测 send-message：3 条消息真实条间耗时全部 ≤2 秒', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(`group:${GROUP}`);
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-message', {
        method: 'POST',
        token: st.agentToken,
        body: { key: `group:${GROUP}`, messages: ['第一条', '第二条', '第三条'] },
      });
      assert.equal(res.status, 200, `发送应成功，实际 ${res.status} ${res.body}`);
      assert.equal(res.json?.sent, 3);
    });
    const sends = h.calls.http.filter((item) => String(item.url).endsWith('/send_group_msg'));
    assert.equal(sends.length, 3, '应真的发出 3 条');
    const gaps = [sends[1].at - sends[0].at, sends[2].at - sends[1].at];
    for (const gap of gaps) assert.ok(gap >= 400 && gap <= 2000, `实测条间 ${gaps.join('/')}ms 超界`);
    console.log(`   实测条间耗时：${gaps.join('ms / ')}ms`);
  } finally {
    await h.close();
  }
});

await test('发送限流：默认 12/180，超限返回剩余秒数而不是空白 429', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(`group:${GROUP}`);
    const now = Date.now();
    // 180 条/小时已经满了：再发 1 条应 429，并明确告诉模型差多少秒、先等待。
    st.sendTimes = Array.from({ length: 180 }, (_, i) => now - i * 20000);
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-message', {
        method: 'POST',
        token: st.agentToken,
        body: { key: `group:${GROUP}`, messages: ['超出额度测试'] },
      });
      assert.equal(res.status, 429);
      assert.match(String(res.json?.error), /发送频率超限/);
      assert.match(String(res.json?.error), /每小时最多 180 条/);
      assert.match(String(res.json?.error), /秒后可再试/);
      assert.match(String(res.json?.error), /qq_wait_for_messages/, '要告诉模型先等待而不是连续重试');
      assert.ok(Number(res.json?.retryAfterMs) > 0 && Number(res.json?.retryAfterMs) <= 3600000);
    });
    // 179 条时最后 1 个名额必须可用（旧上限 60 时这里正是被误伤的场景）。
    st.sendTimes = Array.from({ length: 179 }, (_, i) => now - i * 20000);
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-message', {
        method: 'POST',
        token: st.agentToken,
        body: { key: `group:${GROUP}`, messages: ['最后一格测试'] },
      });
      assert.equal(res.status, 200, `最后一格应允许发送，实际 ${res.status} ${res.body}`);
    });
  } finally {
    await h.close();
  }
});

await test('qq_reply 误用于私聊时给出明确换工具提示（而不是笼统的"目标不允许"）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(`group:${GROUP}`);
    await withServer(h, async (port) => {
      // 123 是私聊白名单里的 QQ，不是群；qq_reply 只收 groupId，必然命中不了群白名单。
      const res = await call(port, '/api/send/reply', {
        method: 'POST',
        token: st.agentToken,
        body: { groupId: String(PRIVATE), replyToMessageId: '1', message: '在吗', token: st.agentToken },
      });
      assert.equal(res.status, 403);
      assert.match(String(res.json?.error), /qq_reply 只能用于群聊/);
      assert.match(String(res.json?.error), /qq_send_message/);
      assert.doesNotMatch(String(res.json?.error), /^目标不在当前模式允许范围内$/);
    });
  } finally {
    await h.close();
  }
});

// ── 2. 快照条数 ─────────────────────────────────────────────────────────────
async function snapshotWithRecent({ provider, key }) {
  const h = await bridgeHarness({
    config: provider === 'workbuddy'
      ? { dsh: { provider: 'workbuddy', model: 'wb-model', authToken: 'fixture-only' } }
      : {},
  });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(key);
    for (let i = 0; i < 12; i += 1) {
      h.appendSocialV2Message(key, `群友${i}`, `历史消息 ${i}：今天聊点什么`, `历史消息 ${i}：今天聊点什么`, false, false, `fixture-${i}`);
    }
    // 这些消息已经"处理过"：只留在 recentMessages，不占未读，专门验证 recent 条数。
    st.unread = [];
    assert.equal(h.buildWakeSnapshotV2(key).previousTurn, undefined);
    const packet = h.buildWakeSnapshotV2(key);
    return { h, packet };
  } catch (error) {
    await h.close();
    throw error;
  }
}

await test('快照 recent 默认 5~8 条（普通 provider / 群聊）', async () => {
  const { h, packet } = await snapshotWithRecent({ key: `group:${GROUP}` });
  try {
    assert.ok(packet.recent.length >= 5 && packet.recent.length <= 8, `recent=${packet.recent.length}，期望 5~8`);
    assert.ok(JSON.stringify(packet).length <= h.cfg.socialV2.context.wakeMaxChars);
  } finally { await h.close(); }
});

await test('快照 recent 在 WorkBuddy + 群聊双重压缩下仍保底 5 条（原实现只有 1~2 条）', async () => {
  const { h, packet } = await snapshotWithRecent({ provider: 'workbuddy', key: `group:${GROUP}` });
  try {
    assert.equal(packet.recent.length, 5, `WorkBuddy 群聊 recent=${packet.recent.length}，期望保底 5`);
    assert.ok(JSON.stringify(packet).length <= 1800, '不能因为多带几条就爆掉 wakeMaxChars 预算');
  } finally { await h.close(); }
});

await test('快照 recent 在 WorkBuddy 私聊为 6 条（原实现正好 2 条）', async () => {
  const { h, packet } = await snapshotWithRecent({ provider: 'workbuddy', key: `private:${PRIVATE}` });
  try {
    assert.equal(packet.recent.length, 6, `WorkBuddy 私聊 recent=${packet.recent.length}，期望 6`);
  } finally { await h.close(); }
});

// ── 3. 跨会话结论 ───────────────────────────────────────────────────────────

await test('跨会话：切到另一套功能会话时快照带一行「上轮结论」，同功能不重复注入', async () => {
  const h = await bridgeHarness({ config: { dsh: featureConfig(), socialV2: { agentPreset: 'qq-chat-v2' } } });
  const key = `group:${GROUP}`;
  try {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    h.appendSocialV2Message(key, 'u111', '这张图里是什么？', '这张图里是什么？', false, false, 'fixture-img');
    const st = h.getSocialV2State(key);

    // 模拟上一轮在「看图会话」里跑完：发出了结论，turn/end 收尾记账。
    st.currentTurnFeature = 'vision';
    h.recordSentMessagesV2(key, ['图里是一只柯基，趴在沙发上']);
    h.recordTurnSummaryV2(key, 'fixture-turn-vision', {
      reason: { kind: 'completed' },
      text: '**图里是一只柯基**，趴在沙发上\n它看起来很困。',
    });
    assert.equal(st.lastTurnSummary?.feature, 'vision');
    assert.match(st.lastTurnSummary.text, /柯基/);
    assert.ok(!st.lastTurnSummary.text.includes('\n'), '结论必须压成一行');

    // 切到 chat 会话：snapshot 里应出现上轮结论（来自看图会话）。
    h.setFeatureOverride(key, 'chat');
    await h.deliverPromptNow(key, 'fixture', { wakeReason: 'admin' });
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.match(prompt, /【本次消息快照】/);
    assert.match(prompt, /上轮结论/);
    assert.match(prompt, /来自看图会话/);
    assert.match(prompt, /柯基/);
    assert.match(prompt, /"previousTurn":"【上轮结论/);
    // 可观测字段：本轮快照实际条数 + 上轮摘要。
    assert.ok(st.lastSnapshotStats, '应记录 lastSnapshot 统计');
    assert.equal(typeof st.lastSnapshotStats.recent, 'number');
    assert.equal(st.lastSnapshotStats.feature, 'chat');

    // 本轮 chat 结束后会记录 chat 结论；下一次同是 chat 的唤醒不得再注入。
    st.currentTurnFeature = 'chat';
    h.recordTurnSummaryV2(key, 'fixture-turn-chat', {
      reason: { kind: 'completed' },
      text: '这轮在聊晚饭吃什么。',
    });
    assert.equal(st.lastTurnSummary.feature, 'chat');
    h.setFeatureOverride(key, 'chat');
    await h.deliverPromptNow(key, 'fixture', { wakeReason: 'admin' });
    const prompt2 = h.calls.prompts.at(-1).content[0].text;
    assert.doesNotMatch(prompt2, /【上轮结论/);
    assert.doesNotMatch(prompt2, /previousTurn/);

    // 摘要已落盘（重启后切功能仍能带过去）。
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
    assert.equal(saved.conversations[key].lastTurnSummary.feature, 'chat');
    assert.match(saved.conversations[key].lastTurnSummary.text, /晚饭/);
  } finally {
    await h.close();
  }
});

await test('跨会话：旧状态文件没有 lastTurnSummary 时正常加载，切会话不注入空行', async () => {
  const key = `group:${GROUP}`;
  const h = await bridgeHarness({
    config: { dsh: featureConfig(), socialV2: { agentPreset: 'qq-chat-v2' } },
    files: {
      'state/social-v2.json': {
        conversations: {
          [key]: {
            recentMessages: [],
            unread: [],
            agentToken: 'fixture-token-0123456789abcdef',
            wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true } },
          },
        },
      },
    },
  });
  try {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    const st = h.getSocialV2State(key);
    assert.equal(st.lastTurnSummary, null, '旧状态没有字段应为 null，而不是 undefined 崩溃');
    h.appendSocialV2Message(key, 'u111', '在吗', '在吗', false, false, 'fixture-old');
    await h.deliverPromptNow(key, 'fixture', { wakeReason: 'admin' });
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.doesNotMatch(prompt, /【上轮结论/);
    assert.doesNotMatch(prompt, /previousTurn/);
  } finally {
    await h.close();
  }
});

if (failures) {
  console.error(`\n${failures}/${tests} 个用例失败`);
  process.exit(1);
}
console.log(`\n全部 ${tests} 个用例通过`);
