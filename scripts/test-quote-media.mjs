// 引用消息里的图：回归测试。
//
// 背景（2026-10-27 实测）：owner 引用了一张图发「这个」，桥接渲染出
// `[引用 Aurora-Star：[图片]]这个`，模型看不到被引用消息的 messageId，
// 只能回「引用里的图我摸不着」。
//
// 这里锁住四件事：
// 1. 引用段渲染必须带 `msgId=…` 与 `含图N`（模型才有 id 可传给看图工具）；
// 2. resolveReplyInfo 解析网关消息时把媒体元数据缓存进 messageMediaStore；
// 3. 网关 get_msg 已取不到旧消息时，用本地 recentMessages/unread 兜底；
// 4. 引用媒体能通过 findMessageMedia(messageId) 找到（qq_get_message_images 的查询口径）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { buildFeatureHint } from '../src/core/feature-sessions.mjs';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests += 1;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const h = await bridgeHarness();
try {
  h.setMode('reserved2');

  await test('引用段渲染带 msgId + 含图N，且原文/发送者不丢', async () => {
    const text = await h.segmentsToText(
      [{ type: 'reply', data: { id: '456522839' } }, { type: 'text', data: { text: '这个' } }],
      { resolveReply: async () => ({ sender: 'Aurora-Star', text: '[图片]', messageId: '456522839', visualMediaCount: 1 }) }
    );
    assert.equal(text, '[引用 msgId=456522839 含图1 Aurora-Star：[图片]]这个');
  });

  await test('没有媒体的引用也带 msgId（可用于确认引用目标）', async () => {
    const text = await h.segmentsToText(
      [{ type: 'reply', data: { id: '888' } }],
      { resolveReply: async () => ({ sender: '小明', text: '原话', messageId: '888' }) }
    );
    assert.equal(text, '[引用 msgId=888 小明：原话]');
  });

  h.bot.getMessage = async (id) => {
    if (String(id) === '456522839') {
      return {
        group_id: 456,
        user_id: 111,
        message_id: 456522839,
        message_seq: 456522839,
        sender: { user_id: 111, nickname: '小明', card: '小明' },
        message: [{ type: 'image', data: { file: 'a.jpg', url: 'https://example.invalid/a.jpg', sub_type: 0 } }]
      };
    }
    return null;
  };

  await test('resolveReplyInfo 解析网关消息后缓存引用图元数据', async () => {
    const info = await h.resolveReplyInfo('group', 456, '456522839', 999);
    assert.ok(info, '应解析出引用信息');
    assert.equal(info.messageId, '456522839');
    assert.equal(info.sender, '小明');
    assert.equal(info.text, '[图片]');
    assert.equal(info.mediaCount, 1);
    assert.equal(info.visualMediaCount, 1);
    const media = h.findMessageMedia('group:456', '456522839');
    assert.equal(media.length, 1, '图片工具必须能按引用 msgId 找到媒体');
    assert.equal(media[0].url, 'https://example.invalid/a.jpg');
  });

  await test('网关取不到旧消息时用本地最近消息兜底', async () => {
    h.bot.getMessage = async () => { throw new Error('消息不存在'); };
    h.appendSocialV2Message(
      'group:456', '雪橙', '[图片]', '[图片]', false, false, '999888',
      [{ kind: 'image', file: 'b.jpg', url: 'https://example.invalid/b.jpg', summary: '[动画表情]', subType: '1' }],
      '3452211511'
    );
    const info = await h.resolveReplyInfo('group', 456, '999888', 999);
    assert.ok(info, '本地兜底应返回引用信息');
    assert.equal(info.fromLocal, true);
    assert.equal(info.messageId, '999888');
    assert.equal(info.sender, '雪橙');
    assert.equal(info.text, '[图片]');
    assert.equal(info.mediaCount, 1);
    assert.equal(info.visualMediaCount, 1);
    const media = h.findMessageMedia('group:456', '999888');
    assert.equal(media.length, 1, '兜底后图片工具也必须能按 msgId 找到媒体');
  });

  await test('真实 inbound 事件的未读文本里带可用的 msgId + 含图标记', async () => {
    h.socialV2.paused = true; // 只验证入库/渲染，不真的排队唤醒
    h.bot.getMessage = async (id) => {
      if (String(id) !== '456522839') return null;
      return {
        group_id: 456,
        user_id: 111,
        message_id: 456522839,
        message_seq: 456522839,
        sender: { user_id: 111, nickname: '小明', card: '小明' },
        message: [{ type: 'image', data: { file: 'a.jpg', url: 'https://example.invalid/a.jpg', sub_type: 0 } }]
      };
    };
    await h.handleIncoming('group', '456', {
      self_id: 999,
      user_id: 111,
      group_id: 456,
      message_id: 777001,
      message_seq: 777001,
      sender: { user_id: 111, nickname: '小明', card: '小明' },
      message: [{ type: 'reply', data: { id: '456522839' } }, { type: 'text', data: { text: '这个' } }]
    }, h.cfg);
    const st = h.getSocialV2State('group:456');
    const msg = st.unread[st.unread.length - 1];
    assert.ok(msg, '消息应进入未读');
    assert.match(msg.text, /^\[引用 msgId=456522839 含图1 小明：\[图片\]\]这个$/);
    // 未读对象本身没有 media（当前消息没图），图片工具靠引用缓存读：
    assert.equal(msg.hasMedia, false);
    assert.equal(h.findMessageMedia('group:456', '456522839').length, 1);
  });

  await test('唤醒快照与 chat/vision 功能提示都带上「引用 msgId」用法', async () => {
    const snapshot = h.buildWakeSnapshotV2('group:456');
    assert.ok(snapshot, '应有唤醒快照');
    assert.match(JSON.stringify(snapshot), /引用 msgId=456522839 含图1/);
    for (const [feature, level] of [['chat', 'basic'], ['chat', 'advanced'], ['vision', 'advanced']]) {
      const hint = buildFeatureHint(feature, level);
      assert.match(hint, /引用 msgId/, `${feature}:${level} 提示应说明引用图怎么读`);
      assert.match(hint, /qq_get_message_images/);
    }
  });

  await test('跨群消息 id 不得借引用解析读取（归属校验仍在）', async () => {
    h.bot.getMessage = async () => ({
      group_id: 999,
      user_id: 222,
      sender: { user_id: 222, nickname: '别的群的人' },
      message: [{ type: 'image', data: { file: 'c.jpg', url: 'https://example.invalid/c.jpg' } }]
    });
    const info = await h.resolveReplyInfo('group', 456, '111222', 999);
    assert.equal(info, null, '不同群的消息应被拒绝');
    assert.equal(h.findMessageMedia('group:456', '111222').length, 0);
  });
} finally {
  await h.close();
}

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
