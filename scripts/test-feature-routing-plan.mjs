#!/usr/bin/env node
/**
 * 逐条路由（v1.2）单元测试：planMessageRoutes / mediaKindsOf。
 *
 * 目标：每条消息单独判定功能域，而不是整批共用一个会话。
 * 运行：node scripts/test-feature-routing-plan.mjs
 */

import {
  planMessageRoutes,
  mediaKindsOf,
  partitionDeliveredSeqs,
  chunkMessagesForDelivery,
  normalizeFeatureSessions,
} from '../src/core/feature-sessions.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

const features = normalizeFeatureSessions({});
const baseOptions = {
  features,
  isGroup: false,
  routingMode: 'auto',
  wakeReason: '',
};

function media(kind, extra = {}) {
  return { kind, ...extra };
}

function msg(seq, text, mediaList = [], extra = {}) {
  return { seq, messageId: seq * 10, isSelf: false, text, media: mediaList, sender: 'owner', ...extra };
}

// 1) 单张图片 → vision
{
  const routes = planMessageRoutes([msg(101, '', [media('image')])], baseOptions);
  check('单张图片→vision', [routes.length, routes[0]?.feature, routes[0]?.level, routes[0]?.variant], [1, 'vision', 'advanced', 'vision:advanced']);
  check('单张图片 mediaKinds', routes[0]?.mediaKinds, ['image']);
}

// 2) 纯文字 → chat（私聊 advanced）
{
  const routes = planMessageRoutes([msg(102, '嗯？')], baseOptions);
  check('纯文字→chat', [routes[0]?.feature, routes[0]?.level], ['chat', 'advanced']);
}

// 3) 群聊纯文字 → chat basic
{
  const routes = planMessageRoutes([msg(103, '在吗')], { ...baseOptions, isGroup: true });
  check('群聊纯文字→chat:basic', [routes[0]?.feature, routes[0]?.level], ['chat', 'basic']);
}

// 4) 文字关键词 → web
{
  const routes = planMessageRoutes([msg(104, '帮我搜一下这个新版本')], baseOptions);
  check('搜索关键词→web', routes[0]?.feature, 'web');
}

// 5) 文字提到看图 → vision
{
  const routes = planMessageRoutes([msg(105, '你看看这张图')], baseOptions);
  check('看图关键词→vision', routes[0]?.feature, 'vision');
}

// 6) 表情包媒体 → sticker
{
  const routes = planMessageRoutes([msg(106, '', [media('sticker')])], baseOptions);
  check('表情→sticker', routes[0]?.feature, 'sticker');
}

// 7) 混合批次：图片→vision、文字→chat，互不污染
{
  const routes = planMessageRoutes([
    msg(107, '', [media('image')]),
    msg(108, '这张图是啥'),
    msg(109, '哦'),
  ], baseOptions);
  check('混合批次逐条判定', routes.map((r) => [r.seq, r.feature]), [
    [107, 'vision'],
    [108, 'vision'],
    [109, 'chat'],
  ]);
}

// 8) forcedFeature 只作用于 forcedSeq（显式 /vision 只改最新那条）
{
  const routes = planMessageRoutes([
    msg(110, '先说一句'),
    msg(111, '再看这个'),
  ], { ...baseOptions, forcedFeature: 'vision', forcedSeq: 111 });
  check('forced 只作用于指定 seq', routes.map((r) => [r.seq, r.feature]), [
    [110, 'chat'],
    [111, 'vision'],
  ]);
  check('forced reason 标记', routes[1]?.reason, 'explicit');
}

// 9) features 关闭 → 全部回退 chat（features-disabled）
{
  const off = normalizeFeatureSessions({ enabled: false });
  const routes = planMessageRoutes([msg(112, '', [media('image')])], { ...baseOptions, features: off });
  check('features 关闭回退 chat', [routes[0]?.feature, routes[0]?.reason], ['chat', 'features-disabled']);
}

// 10) 跳过自己发的、非法 seq
{
  const routes = planMessageRoutes([
    msg(113, '自己说的', [], { isSelf: true }),
    msg(114, '正常', [], { isSelf: false }),
    { seq: 'x', text: '非法' },
  ], baseOptions);
  check('跳过 isSelf/非法 seq', routes.map((r) => r.seq), [114]);
}

// 11) mediaKindsOf 大小写与缺失字段
{
  check('mediaKindsOf 归一化', mediaKindsOf([media('IMAGE'), { type: 'Video' }, null, {}]), ['image', 'video']);
}

// 12) 返回字段完整、可直接落日志
{
  const routes = planMessageRoutes([msg(115, '你好')], baseOptions);
  check('返回字段', Object.keys(routes[0]).sort(), [
    'feature', 'level', 'mediaKinds', 'messageId', 'reason', 'sender', 'seq', 'text', 'variant',
  ].sort());
}

// 13) 防重复投递：已投过的 seq 从本轮剔掉，剩下的照常逐条判定
{
  const batch = [msg(116, '', [media('image')]), msg(117, '', [media('file')]), msg(118, '', [media('image')]), msg(119, '这么多')];
  const { live, dupes } = partitionDeliveredSeqs(batch, [117, 118]);
  check('已投递的 seq 被挑出', dupes.map((m) => m.seq), [117, 118]);
  check('剩下的仍按序', live.map((m) => m.seq), [116, 119]);
  const routes = planMessageRoutes(live, baseOptions);
  check('复活尾巴不会再被拖进看图路', routes.map((r) => [r.seq, r.feature]), [[116, 'vision'], [119, 'chat']]);
  check('全都投过时 live 为空', partitionDeliveredSeqs(batch, new Set([116, 117, 118, 119])).live.length, 0);
  check('没投过的批次原样返回', partitionDeliveredSeqs(batch, []).live.map((m) => m.seq), [116, 117, 118, 119]);
}

// 14) 文件段：图片类扩展名才算图，普通文件（正文已提取）留 chat
{
  const md = planMessageRoutes([msg(120, '[文件] 说明.md', [media('file', { name: '说明.md' })])], baseOptions);
  check('md 文件留 chat', md[0]?.feature, 'chat');
  const png = planMessageRoutes([msg(121, '[文件] 截图.png', [media('file', { name: '截图.png' })])], baseOptions);
  check('png 文件进看图', png[0]?.feature, 'vision');
  const noName = planMessageRoutes([msg(122, '[文件]', [media('file')])], baseOptions);
  check('无文件名不硬塞看图', noName[0]?.feature, 'chat');
  const mixed = planMessageRoutes([msg(123, '', [media('file', { name: 'a.txt' }), media('image')])], baseOptions);
  check('图 + 文件仍进看图', mixed[0]?.feature, 'vision');
  const zip = planMessageRoutes([msg(124, '[文件] 备份.zip', [media('file', { name: '备份.ZIP' })])], baseOptions);
  check('大写扩展名不吃图', zip[0]?.feature, 'chat');
}

// 15) 超量按块投：每块单独逐条判定，别整批回退
{
  const flood = [msg(130, '', [media('image')]), msg(131, '第二句'), msg(132, ''), msg(133, '第三句'), msg(134, '第四句')];
  const { batches, dropped } = chunkMessagesForDelivery(flood, 2, 3);
  check('按 2 条切块', batches.map((b) => b.map((m) => m.seq)), [[130, 131], [132, 133], [134]]);
  check('没被丢', dropped, 0);
  const capped = chunkMessagesForDelivery(flood, 2, 2);
  check('超过块数上限时余下留到下一轮', [capped.batches.length, capped.dropped], [2, 1]);
  const routes = planMessageRoutes(chunkMessagesForDelivery(flood, 2, 3).batches[0], baseOptions);
  check('块内仍逐条判', routes.map((r) => r.feature), ['vision', 'chat']);
  check('空输入不炸', chunkMessagesForDelivery([], 10).batches.length, 0);
}

console.log(`\n逐条路由单测：${pass} 通过，${fail} 失败`);
if (failures.length) {
  console.log('\n失败详情：');
  for (const item of failures) console.log(`- ${item}`);
  process.exit(1);
}
