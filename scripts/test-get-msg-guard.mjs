// get_msg 护栏：回归测试。
//
// 背景（2026-10-27 实测）：NapCat WebUI 日志反复刷
//   [ERROR] 发生错误 Error: 消息不存在
//   at _handle (napcat.mjs:75283)
//   at _httpRequest (napcat.mjs:65105)
// 根因是桥接把 0 / 空串 / 非数字的 message_id 发给了 OneBot 的 get_msg。
// 这种请求注定失败，而 ERROR 是 **NapCat 自己写的日志**，桥接这边 catch 不掉：
// 唯一干净的修法是入口就判废、根本不发请求。
//
// 这里锁住三件事：
// 1. 引用解析（resolveReplyInfo）遇到 0/空/非法 id 不调用 bot.getMessage，
//    合法 id 照常只调一次（护栏不能误伤）；
// 2. 网关失败只降级、不重试（调用次数必须恰好 1 次，绝不能刷 NapCat）；
// 3. 引用目标判定（isQuoteTargetSelf）与语音落地校验（get_msg 回读）同样不发 0 id 请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests += 1;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 记录每一次真正发往网关的 get_msg（bot.getMessage 即 OneBot get_msg）。
function spyGetMessage(h) {
  const calls = [];
  h.bot.getMessage = async (id) => { calls.push(id); return null; };
  return calls;
}

// 语音路径走的是**直接 fetch 网关**，所以用 globals.fetch 覆盖 harness 的桩。
function makeGateway({ sendMessageId = 9001 } = {}) {
  const getMsgIds = [];
  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return {}; } })();
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data }) });
    if (u.endsWith('/get_msg')) {
      getMsgIds.push(body.message_id);
      return ok({ message_id: body.message_id, message: [{ type: 'record', data: { file: 'fixture.amr', duration: 2 } }] });
    }
    if (u.endsWith('/send_group_msg')) return ok({ message_id: sendMessageId });
    return ok({ message_id: sendMessageId });
  };
  return { fetchStub, getMsgIds };
}

const h = await bridgeHarness();
try {
  const getMsgCalls = spyGetMessage(h);
  const badIds = [0, '0', '000', '', '   ', 'abc', 'undefined', 'null', '1e3', '99999999999999999999', null, undefined];

  await test('引用解析：0/空/非法 message_id 不发起 get_msg', async () => {
    for (const bad of badIds) {
      const info = await h.resolveReplyInfo('group', 456, bad, 999);
      assert.equal(info, null, `id=${JSON.stringify(bad)} 不应解析出引用信息`);
    }
    assert.deepEqual(getMsgCalls, [], `非法 id 一次都不该调用 get_msg，实际: ${JSON.stringify(getMsgCalls)}`);
  });

  await test('引用解析：合法 id 仍只调用一次 get_msg（护栏不误伤）', async () => {
    getMsgCalls.length = 0;
    await h.resolveReplyInfo('group', 456, '456522839', 999);
    assert.deepEqual(getMsgCalls, [456522839], '合法 id 必须照常解析');
  });

  await test('引用解析：网关失败只降级一次，绝不重试', async () => {
    getMsgCalls.length = 0;
    h.bot.getMessage = async (id) => { getMsgCalls.push(id); throw new Error('消息不存在'); };
    const info = await h.resolveReplyInfo('group', 456, '777001', 999);
    assert.equal(info, null, '失败时必须降级（本地也没有该消息）');
    assert.deepEqual(getMsgCalls, [777001], `失败后只能调用 1 次，实际: ${JSON.stringify(getMsgCalls)}`);
  });

  await test('引用目标判定：引用段 id=0 不发起 get_msg，也不影响正常消息处理', async () => {
    h.setMode('reserved2');
    h.socialV2.paused = true;
    getMsgCalls.length = 0;
    h.bot.getMessage = async (id) => { getMsgCalls.push(id); return null; };
    await h.handleIncoming('group', '456', {
      self_id: 999,
      user_id: 111,
      group_id: 456,
      message_id: 777002,
      message_seq: 777002,
      sender: { user_id: 111, nickname: '小明', card: '小明' },
      message: [{ type: 'reply', data: { id: '0' } }, { type: 'text', data: { text: '嗯' } }]
    }, h.cfg);
    assert.deepEqual(getMsgCalls, [], `引用 id=0 不得触发 get_msg，实际: ${JSON.stringify(getMsgCalls)}`);
    const st = h.getSocialV2State('group:456');
    const msg = st.unread[st.unread.length - 1];
    assert.ok(msg, '消息仍应进入未读');
    assert.equal(String(msg.text).includes('嗯'), true, '正文照常入库');
  });

  await test('引用目标判定：引用机器人自己的消息仍被识别（合法 id 行为不变）', async () => {
    getMsgCalls.length = 0;
    h.bot.getMessage = async (id) => {
      getMsgCalls.push(id);
      return {
        group_id: 456,
        user_id: 999,
        message_id: Number(id),
        sender: { user_id: 999, nickname: '机器人', card: '' },
        message: [{ type: 'text', data: { text: '我自己说的话' } }]
      };
    };
    await h.handleIncoming('group', '456', {
      self_id: 999,
      user_id: 111,
      group_id: 456,
      message_id: 777003,
      message_seq: 777003,
      sender: { user_id: 111, nickname: '小明', card: '小明' },
      message: [{ type: 'reply', data: { id: '556000111' } }, { type: 'text', data: { text: '你说啥' } }]
    }, h.cfg);
    // 换个没被前面用例缓存过的合法 id（resolveReplyInfo 有 5 秒负缓存）。
    assert.deepEqual(getMsgCalls, [556000111], '合法引用 id 仍应解析一次');
    const st = h.getSocialV2State('group:456');
    const msg = st.unread[st.unread.length - 1];
    assert.equal(msg.quoteTargetIsSelf, true, '引用自己必须标记为 quoteTargetIsSelf');
  });
} finally {
  await h.close();
}

await test('语音落地校验：网关返回 message_id=0 时不发起 get_msg', async () => {
  const { fetchStub, getMsgIds } = makeGateway({ sendMessageId: 0 });
  const hv = await bridgeHarness({ config: { socialV2: { voice: { enabled: true } } }, globals: { fetch: fetchStub } });
  try {
    const dir = path.join(hv.temp, 'audio');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'v.mp3'), Buffer.alloc(512, 1));
    const sent = await hv.sendVoiceForV2('group:456', 'v.mp3', { readback: false });
    assert.equal(sent.messageId, 0, '发送结果应如实保留网关返回的 0');
    assert.equal(sent.verification, null, '拿不到合法 id 时校验结果为空');
    assert.deepEqual(getMsgIds, [], `message_id=0 不得发起 get_msg，实际: ${JSON.stringify(getMsgIds)}`);
  } finally { await hv.close(); }
});

await test('语音落地校验：合法 message_id 仍会 get_msg 回读（功能未被削弱）', async () => {
  const { fetchStub, getMsgIds } = makeGateway({ sendMessageId: 9001 });
  const hv = await bridgeHarness({ config: { socialV2: { voice: { enabled: true } } }, globals: { fetch: fetchStub } });
  try {
    const dir = path.join(hv.temp, 'audio');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'v.mp3'), Buffer.alloc(512, 1));
    const sent = await hv.sendVoiceForV2('group:456', 'v.mp3', { readback: false });
    assert.equal(sent.verification?.confirmed, true, '合法 id 仍应回读到 record 段');
    assert.deepEqual(getMsgIds, [9001], `合法 id 必须回读一次，实际: ${JSON.stringify(getMsgIds)}`);
  } finally { await hv.close(); }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
