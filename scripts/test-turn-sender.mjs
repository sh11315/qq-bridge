// 需求 B 的**桥接侧**回归：确认「本回合发送者」真的写进了 state/turn-sender.json。
//
// qq-tool-restrict 的守卫测试（scripts/test-tool-restrict-guard.mjs）只验证「拿到一份
// 快照后如何判定」；这份快照由桥接在投递 prompt 前写，如果桥接写错（例如永远写 owner、
// 或私聊/群聊混用 sessionId），守卫侧测试是发现不了的。所以这里用 audit-bridge-harness
// 把真实 bridge.js 跑在临时目录里，喂 owner / 群友两种消息，直接断言落盘内容。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const OWNER = 123;   // 与 bridgeHarness 的 config.ownerQQ 一致
const MEMBER = 111;
const GROUP = 456;
const BOT = 999;

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests += 1;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function groupEvent(userId, text, messageId = 1001) {
  return {
    self_id: BOT,
    group_id: GROUP,
    user_id: userId,
    message_id: messageId,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: userId, nickname: `u${userId}`, card: '' },
  };
}

function readTurnSender(h) {
  const file = path.join(h.temp, 'state', 'turn-sender.json');
  assert.ok(fs.existsSync(file), '投递 prompt 前必须写 state/turn-sender.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

await test('管理员群消息 → 快照 senderId=ownerQQ、isOwner=true', async () => {
  const h = await bridgeHarness({ config: { agentPreset: 'qq-chat' } });
  try {
    h.setMode('chat');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    const before = h.calls.prompts.length;
    await h.handleIncoming('group', GROUP, groupEvent(OWNER, '管理员说话'), h.cfg);
    assert.equal(h.calls.prompts.length, before + 1, 'chat 模式管理员群消息应直接投递');

    const store = readTurnSender(h);
    assert.equal(store.senderId, String(OWNER), '顶层 senderId 应是最近一条消息的发送者');
    assert.equal(store.isOwner, true, '管理员消息 isOwner 必须是布尔 true');
    assert.ok(Number.isFinite(store.ts), '必须有数字 ts');
    assert.ok(Math.abs(Date.now() - store.ts) < 60_000, 'ts 应是投递时刻');
    const sessionId = store.sessionId;
    assert.ok(sessionId, '顶层必须带 sessionId');
    assert.equal(store.sessions?.[sessionId]?.senderId, String(OWNER), 'sessions 索引必须能按 sessionId 取到');
    assert.equal(store.sessions?.[sessionId]?.sessionId, sessionId, '索引记录内也要带 sessionId');
  } finally {
    await h.close();
  }
});

await test('同一群里群友接话 → 同一 sessionId 被覆盖为群友、isOwner=false', async () => {
  const h = await bridgeHarness({ config: { agentPreset: 'qq-chat' } });
  try {
    h.setMode('chat');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    await h.handleIncoming('group', GROUP, groupEvent(OWNER, '管理员先说话', 1001), h.cfg);
    const afterOwner = readTurnSender(h);
    const sessionId = afterOwner.sessionId;
    assert.equal(afterOwner.senderId, String(OWNER));

    await h.handleIncoming('group', GROUP, groupEvent(MEMBER, '群友接话', 1002), h.cfg);
    const afterMember = readTurnSender(h);
    assert.equal(afterMember.sessionId, sessionId, '多人群共享同一个 DSH 会话');
    assert.equal(afterMember.senderId, String(MEMBER), '最新回合的发送者是群友');
    assert.equal(afterMember.isOwner, false, '群友回合必须 isOwner=false（守卫据此拒绝插件工具）');
    assert.equal(afterMember.sessions?.[sessionId]?.senderId, String(MEMBER), '索引也要覆盖成最新发送者');
  } finally {
    await h.close();
  }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
