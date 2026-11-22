// ③ 群会话 → owner 私聊 的安全边界回归。
//
// 覆盖两层：
//   1. owner-dm-guard 的纯解析（turn-sender.json 的几种形态 / 过期 / 缺失）。
//   2. /api/send/private 的真实 HTTP 判定：
//      · 群会话 + owner 本回合触发 + 目标 owner → 放行；
//      · 群会话 + 群友触发 / 目标不是 owner / 没有快照 → 403 + tool-restrict.log；
//      · owner 私聊、控制台管理端原有行为不变。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  decideOwnerDmSend,
  readTurnSenderSnapshot,
  collectTurnSenderEntries,
  TURN_SENDER_TTL_MS
} from '../src/owner-dm-guard.js';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests += 1;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, error?.stack || error); }
}

const OWNER = '123';
const GROUP = '456';
const OTHER = '999';

function turnSnapshot(sessionId, senderId, ts = Date.now()) {
  return {
    sessionId,
    senderId,
    isOwner: String(senderId) === OWNER,
    ts,
    sessions: {
      [sessionId]: { sessionId, senderId, isOwner: String(senderId) === OWNER, ts }
    }
  };
}

// ── 纯函数：turn-sender.json 解析 ────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-owner-dm-'));
const tmpFile = path.join(tmp, 'turn-sender.json');

await test('parses the sessions-index shape written by the bridge', async () => {
  fs.writeFileSync(tmpFile, JSON.stringify(turnSnapshot('s1', OWNER)), 'utf8');
  const snap = readTurnSenderSnapshot(tmpFile, { key: 'group:456', sessionId: 's1' });
  assert.equal(snap.ok, true);
  assert.equal(snap.senderId, OWNER);
});

await test('parses a flat group-key map and bare sender values', async () => {
  fs.writeFileSync(tmpFile, JSON.stringify({ 'group:456': { senderId: OWNER, ts: Date.now() }, 'group:789': OTHER }), 'utf8');
  const byKey = readTurnSenderSnapshot(tmpFile, { key: 'group:456', sessionId: 'nope' });
  assert.equal(byKey.ok, true);
  assert.equal(byKey.senderId, OWNER);
  const byGroup789 = readTurnSenderSnapshot(tmpFile, { key: 'group:789', sessionId: 'nope' });
  assert.equal(byGroup789.senderId, OTHER);
});

await test('reads a single-record file, but only when it has no session owner', async () => {
  fs.writeFileSync(tmpFile, JSON.stringify({ senderId: OWNER, isOwner: true, ts: Date.now() }), 'utf8');
  const snap = readTurnSenderSnapshot(tmpFile, { key: 'group:456', sessionId: 's1' });
  assert.equal(snap.ok, true, '无归属的单条全局记录应可兜底');
  assert.equal(snap.senderId, OWNER);
});

await test('never borrows another session record', async () => {
  fs.writeFileSync(tmpFile, JSON.stringify(turnSnapshot('other-session', OWNER)), 'utf8');
  const snap = readTurnSenderSnapshot(tmpFile, { key: 'group:456', sessionId: 's1' });
  assert.equal(snap.ok, false);
  assert.match(snap.reason, /没有本会话/);
});

await test('expired / missing / malformed snapshots are rejected', async () => {
  fs.writeFileSync(tmpFile, JSON.stringify(turnSnapshot('s1', OWNER, Date.now() - TURN_SENDER_TTL_MS - 1000)), 'utf8');
  assert.match(readTurnSenderSnapshot(tmpFile, { key: 'group:456', sessionId: 's1' }).reason, /过期/);
  fs.rmSync(tmpFile);
  assert.match(readTurnSenderSnapshot(tmpFile, { key: 'group:456', sessionId: 's1' }).reason, /缺少/);
  fs.writeFileSync(tmpFile, '{not json', 'utf8');
  assert.match(readTurnSenderSnapshot(tmpFile, { key: 'group:456', sessionId: 's1' }).reason, /不是合法 JSON/);
});

await test('decideOwnerDmSend: non-group callers bypass, group callers obey all three rules', async () => {
  fs.writeFileSync(tmpFile, JSON.stringify(turnSnapshot('s1', OWNER)), 'utf8');
  assert.equal(decideOwnerDmSend({ callerKey: 'private:123', targetId: OWNER, ownerQQ: OWNER, turnFile: tmpFile }).ok, true);
  assert.equal(decideOwnerDmSend({ callerKey: 'group:456', targetId: OWNER, ownerQQ: OWNER, turnFile: tmpFile, sessionId: 's1' }).ok, true);
  for (const bad of [
    { callerKey: 'group:456', targetId: OTHER, ownerQQ: OWNER, turnFile: tmpFile, sessionId: 's1' },
    { callerKey: 'group:456', targetId: OWNER, ownerQQ: OWNER, turnFile: path.join(tmp, 'missing.json'), sessionId: 's1' }
  ]) {
    const result = decideOwnerDmSend(bad);
    assert.equal(result.ok, false);
    assert.ok(result.log && result.error);
  }
  fs.writeFileSync(tmpFile, JSON.stringify(turnSnapshot('s1', OTHER)), 'utf8');
  const notOwnerTurn = decideOwnerDmSend({ callerKey: 'group:456', targetId: OWNER, ownerQQ: OWNER, turnFile: tmpFile, sessionId: 's1' });
  assert.equal(notOwnerTurn.ok, false);
  assert.match(notOwnerTurn.error, /仅限 owner 本回合触发/);
});

await test('collectTurnSenderEntries tolerates unknown extra keys without inventing senders', () => {
  const entries = collectTurnSenderEntries({ version: 1, 'group:1': { senderId: '1' }, note: 'x', sessions: {} });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].senderId, '1');
});

// ── HTTP 端到端：/api/send/private 的真实闸门 ────────────────────────────────
const h = await bridgeHarness({
  config: {
    consolePort: 0,
    ownerQQ: Number(OWNER),
    allow: { private: [OWNER, OTHER], groups: [GROUP] }
  }
});
let server = null;
try {
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  h.setReady(true);
  h.setMode('reserved2');
  const sessionId = await h.ensureSession(`group:${GROUP}`);
  const groupState = h.getSocialV2State(`group:${GROUP}`);
  const groupToken = groupState.agentToken;
  const ownerState = h.getSocialV2State(`private:${OWNER}`);
  const ownerToken = ownerState.agentToken;
  const turnFile = path.join(h.temp, 'state', 'turn-sender.json');
  const restrictLog = path.join(h.temp, 'state', 'tool-restrict.log');

  const writeTurn = (senderId) => {
    fs.mkdirSync(path.dirname(turnFile), { recursive: true });
    fs.writeFileSync(turnFile, JSON.stringify(turnSnapshot(sessionId, senderId)), 'utf8');
  };

  server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const sendPrivate = async ({ token, userId, message = '你好', consoleOnly = false }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/send/private`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-console-token': 'fixture-console-token',
        'x-agent-call': '1',
        ...(token ? { 'x-agent-token': token } : {})
      },
      body: JSON.stringify({ userId: String(userId), message, token: consoleOnly ? undefined : token })
    });
    return { status: response.status, body: await response.json() };
  };

  const privateSends = () => h.calls.http
    .filter((call) => /\/send_private_msg$/.test(call.url))
    .map((call) => ({ id: call.body?.user_id, text: call.body?.message?.[0]?.data?.text }));

  await test('group + owner-triggered turn → owner DM is allowed', async () => {
    writeTurn(OWNER);
    h.calls.http.length = 0;
    const result = await sendPrivate({ token: groupToken, userId: OWNER, message: '私聊内容' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    const sent = privateSends();
    assert.ok(sent.some((item) => String(item.id) === OWNER && item.text === '私聊内容'), JSON.stringify(sent));
  });

  await test('group + non-owner turn → owner DM rejected and logged', async () => {
    writeTurn(OTHER);
    const result = await sendPrivate({ token: groupToken, userId: OWNER });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /仅限 owner 本回合触发|发送者/);
    const log = fs.readFileSync(restrictLog, 'utf8');
    assert.match(log, /\[owner-dm\].*给 owner 发私聊被拒/);
  });

  await test('group + owner turn → private DM to another member rejected and logged', async () => {
    writeTurn(OWNER);
    const result = await sendPrivate({ token: groupToken, userId: OTHER });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /只能给 owner 发私聊/);
    const log = fs.readFileSync(restrictLog, 'utf8');
    assert.match(log, /试图私聊非 owner/);
  });

  await test('group + missing turn-sender.json → owner DM rejected (fail-closed)', async () => {
    fs.rmSync(turnFile, { force: true });
    const result = await sendPrivate({ token: groupToken, userId: OWNER });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /turn-sender\.json|本回合/);
  });

  await test('owner private-session token keeps its existing private-send behavior', async () => {
    h.calls.http.length = 0;
    const result = await sendPrivate({ token: ownerToken, userId: OTHER, message: '原有私聊' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(privateSends().some((item) => String(item.id) === OTHER), JSON.stringify(privateSends()));
  });

  await test('console/admin path (no agent token) is unchanged', async () => {
    // 管理端在 reserved2 下也必须带 token（既有约束）；切到 closed-agent 验证
    // 「控制台不带 agent token 直接发私聊」这条老路径没有被群会话闸门误伤。
    h.setMode('closed-agent');
    h.calls.http.length = 0;
    const result = await sendPrivate({ token: null, userId: OWNER, message: '管理端私聊', consoleOnly: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(privateSends().some((item) => String(item.id) === OWNER), JSON.stringify(privateSends()));
  });
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await h.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'} tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
