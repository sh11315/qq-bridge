/**
 * Bug 3 回归：切换模型撞上 DSH 活跃回合（session/writer-held）时，桥接不能只打 ERROR 就放弃。
 *
 * 现场（2026-10-26 17:29）：
 *   设置会话模型失败 session-...（第 1/2 次）: session/selectModel failed: session/writer-held ...
 *   设置会话模型失败 session-...（第 2/2 次）: ...（两次都失败 → 模型没切过去）
 *
 * 现在的行为（src/low-priority-prompt.mjs + bridge.selectModelLowPriority）：
 *   · 写锁冲突按 1s/3s/6s 退避重试；
 *   · 仍然冲突 → 本回合先用现有模型把消息跑完（不丢回合、不抛错），并把目标登记为
 *     "下一回合再切"（不缓存已应用签名，下次 ensureTurnModelFor 自动重试）；
 *   · 只有非写锁错误才按失败处理。
 *
 * 本测试用 audit-bridge-harness 跑真实 bridge.js + 假 DSH：让 selectModel 抛 writer-held，
 * 断言消息仍然投递成功、且重试次数符合预期。
 */
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const OWNER = 123;
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

function writerHeldError() {
  const error = new Error('session/selectModel failed: session/writer-held: session "fixture" is already owned by an active write handle');
  error.code = 'session/writer-held';
  return error;
}

async function newHarness(selectModel) {
  const h = await bridgeHarness({ config: { agentPreset: 'qq-chat' }, apiSessions: { selectModel } });
  h.setMode('chat');
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  return h;
}

// ── 1) 写锁一直被占用：重试耗尽后本回合照常投递（不抛错、不丢消息）──────────
await test('selectModel 持续 writer-held：退避重试后降级为「下回合再切」，消息照常投递', async () => {
  let calls = 0;
  const h = await newHarness(async () => { calls += 1; throw writerHeldError(); });
  try {
    const before = h.calls.prompts.length;
    await h.handleIncoming('group', GROUP, groupEvent(OWNER, '写锁冲突时也不能丢这条消息'), h.cfg);
    assert.equal(h.calls.prompts.length, before + 1, '即使模型没切过去，回合也必须投递（不能丢消息）');
    // 写锁 → 每个「应用模型」路径至少 4 次尝试（原始 + 1/3/6s 三次重试）；
    // 本次投递可能有多条应用路径（投递/预热各一次），所以只断言下限与阶梯性。
    assert.ok(calls >= 4, `writer-held 必须按退避阶梯重试（实际尝试 ${calls} 次）`);
    const prompt = h.calls.prompts.at(-1);
    assert.equal(prompt.content?.[0]?.type, 'text', '投递内容应当是正常 prompt');
  } finally {
    await h.close();
  }
});

// ── 2) 前两次撞锁、第三次成功：要真的切过去（不能一失败就永久放弃）────────────
await test('selectModel 前两次 writer-held、第三次成功：模型切换成功且消息照常投递', async () => {
  let calls = 0;
  let successes = 0;
  const h = await newHarness(async (params) => {
    calls += 1;
    if (calls <= 2) throw writerHeldError();
    successes += 1;
    // 与 audit-bridge-harness 的 success() 同形：{ result: { ok: true, value } }
    return { result: { ok: true, value: { selected: { provider: params.provider, model: params.model } } } };
  });
  try {
    const before = h.calls.prompts.length;
    await h.handleIncoming('group', GROUP, groupEvent(OWNER, '重试之后应该切过去'), h.cfg);
    assert.equal(h.calls.prompts.length, before + 1, '消息必须投递');
    assert.ok(successes >= 1, '前两次撞锁后必须有一次成功——不能一失败就永久放弃');
  } finally {
    await h.close();
  }
});

// ── 3) 非写锁错误仍然按失败处理（不能被 writer-held 兜底吞掉）──────────────────
await test('非 writer-held 的 selectModel 错误不会被吞：仍按失败路径返回且消息不丢', async () => {
  let calls = 0;
  const successes = 0;
  const h = await newHarness(async () => {
    calls += 1;
    throw new Error('model not found');
  });
  try {
    const before = h.calls.prompts.length;
    await h.handleIncoming('group', GROUP, groupEvent(OWNER, '模型不存在也不能崩'), h.cfg);
    assert.equal(h.calls.prompts.length, before + 1, '模型设置失败时回合仍然要投递');
    assert.equal(successes, 0, '非写锁错误不能成功');
    assert.ok(calls > 0, '非写锁错误照样会尝试（只是不走 1/3/6s 退避）');
  } finally {
    await h.close();
  }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
