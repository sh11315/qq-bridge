import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_DEFAULT_MAX,
  BOARD_DEFAULT_TTL_MS,
  appendBoardEntry,
  boardSourceLabel,
  boardTimeLabel,
  clipBoardText,
  formatBoardForPrompt,
  normalizeBoardStore,
  pruneBoardEntries,
  removeBoardEntry,
} from './board.mjs';

const NOW = Date.parse('2026-10-29T12:00:00+08:00');

test('clipBoardText 压平换行并截断', () => {
  assert.equal(clipBoardText('  外面\n下雪了\t很冷  '), '外面 下雪了 很冷');
  assert.equal(clipBoardText(''), '');
  const long = 'a'.repeat(500);
  const out = clipBoardText(long);
  assert.equal(out.length, 200);
  assert.ok(out.endsWith('…'));
});

test('boardSourceLabel 归一功能名与中文', () => {
  assert.equal(boardSourceLabel('vision'), '看图');
  assert.equal(boardSourceLabel('vision:advanced'), '看图');
  assert.equal(boardSourceLabel('聊天'), '聊天');
  assert.equal(boardSourceLabel(''), '未知');
});

test('normalizeBoardStore 丢弃脏数据', () => {
  const store = normalizeBoardStore({
    version: 1,
    boards: {
      'group:1': [{ at: 1, by: 'vision', text: '下雪' }, { at: 2, text: '   ' }, null, 'x'],
      '': [{ at: 1, text: 'y' }],
      'private:2': 'oops',
    },
  });
  assert.deepEqual(Object.keys(store.boards), ['group:1']);
  assert.equal(store.boards['group:1'].length, 1);
  // 旧条目没有时间戳：视为新写入
  assert.equal(store.boards['group:1'][0].at, 1);
});

test('pruneBoardEntries 过期淘汰 + 只保留最新 N 条', () => {
  const old = NOW - BOARD_DEFAULT_TTL_MS - 1000;
  const list = [
    { at: old, by: 'chat', text: '很久以前' },
    { at: NOW - 1000, by: 'chat', text: '刚刚' },
  ];
  const kept = pruneBoardEntries(list, { now: NOW });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, '刚刚');

  const many = Array.from({ length: BOARD_DEFAULT_MAX + 5 }, (_, i) => ({ at: NOW - (100 - i) * 1000, by: 'chat', text: `第${i}条` }));
  const capped = pruneBoardEntries(many, { now: NOW });
  assert.equal(capped.length, BOARD_DEFAULT_MAX);
  assert.equal(capped.at(-1).text, `第${BOARD_DEFAULT_MAX + 4}条`);
});

test('appendBoardEntry 追加并去空白', () => {
  const next = appendBoardEntry([], { text: '  外面 3 度，下雪 ', by: 'vision', at: NOW }, { now: NOW });
  assert.equal(next.length, 1);
  assert.equal(next[0].text, '外面 3 度，下雪');
  assert.equal(next[0].by, 'vision');
  // 空文本不追加
  assert.equal(appendBoardEntry(next, { text: '   ', at: NOW }, { now: NOW }).length, 1);
});

test('removeBoardEntry 按展示下标删除', () => {
  const list = [
    { at: NOW - 2000, by: 'chat', text: 'a' },
    { at: NOW - 1000, by: 'vision', text: 'b' },
  ];
  const next = removeBoardEntry(list, 0, { now: NOW });
  assert.equal(next.length, 1);
  assert.equal(next[0].text, 'b');
  // 下标非法：原样返回
  assert.equal(removeBoardEntry(list, 9, { now: NOW }).length, 2);
});

test('formatBoardForPrompt 空板给写入引导，有内容带时间与来源', () => {
  const empty = formatBoardForPrompt([], { now: NOW });
  assert.match(empty, /共用小黑板/);
  assert.match(empty, /qq_board_write/);

  const text = formatBoardForPrompt(
    [
      { at: NOW - 60_000, by: 'vision', text: '外面下雪，3 度' },
      { at: NOW - 30_000, by: 'chat', text: '对方说今晚加班' },
    ],
    { now: NOW },
  );
  // 时间标签按本机时区渲染，只断言「来源 + 内容」，时间另测
  assert.match(text, /- \d{2}:\d{2} 看图｜外面下雪，3 度/);
  assert.match(text, /- \d{2}:\d{2} 聊天｜对方说今晚加班/);
  assert.match(text, /qq_board_forget/);
});

test('formatBoardForPrompt 只展示最近 N 条', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ at: NOW - (12 - i) * 1000, by: 'chat', text: `第${i}条` }));
  const text = formatBoardForPrompt(list, { now: NOW, maxEntries: 3 });
  const lines = text.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 3);
  assert.match(lines.at(-1), /第11条/);
});

test('boardTimeLabel 今天 HH:MM、跨天带昨天', () => {
  const noon = new Date(2026, 9, 29, 12, 0, 0, 0).getTime();
  assert.equal(boardTimeLabel(noon, noon), '12:00');
  const lastNight = new Date(2026, 9, 28, 23, 10, 0, 0).getTime();
  assert.equal(boardTimeLabel(lastNight, noon), '昨天 23:10');
  assert.equal(boardTimeLabel(0, noon), '--:--');
});
