/**
 * 语音入站模块测试：语音媒体识别 / 转写文本清洗 / 注记格式化 / 转写计划 / 请求体。
 * 跑法：node scripts/test-voice-inbound.mjs
 */

import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_TRANSCRIBE_PER_TURN,
  PTT_NOTE_PREFIX,
  PTT_TEXT_MAX,
  PTT_UNAVAILABLE_NOTE,
  VOICE_MEDIA_KINDS,
  buildTranscribeBody,
  formatVoiceNote,
  isVoiceMedia,
  normalizePttText,
  planInboundVoice,
} from '../src/core/voice-inbound.mjs';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
  }
}

console.log('语音入站');

check('导出齐全且常量符合约定', () => {
  for (const fn of [
    isVoiceMedia,
    normalizePttText,
    formatVoiceNote,
    planInboundVoice,
    buildTranscribeBody,
  ]) {
    assert.equal(typeof fn, 'function');
  }
  assert.deepEqual(VOICE_MEDIA_KINDS, ['record', 'voice', 'audio', 'ptt']);
  assert.equal(PTT_TEXT_MAX, 2000);
  assert.equal(PTT_NOTE_PREFIX, '[语音转写]');
  assert.equal(PTT_UNAVAILABLE_NOTE, '[语音，转写不可用]');
  assert.equal(DEFAULT_MAX_TRANSCRIBE_PER_TURN, 3);
});

check('isVoiceMedia 认 record/voice/audio/ptt（字符串与对象都认）', () => {
  for (const kind of VOICE_MEDIA_KINDS) {
    assert.equal(isVoiceMedia(kind), true, kind);
    assert.equal(isVoiceMedia(kind.toUpperCase()), true, kind);
    assert.equal(isVoiceMedia({ kind }), true, kind);
    assert.equal(isVoiceMedia({ type: kind }), true, kind);
  }
  assert.equal(isVoiceMedia(' voice '), true);
  assert.equal(isVoiceMedia({ mediaType: 'audio' }), true);
  assert.equal(isVoiceMedia({ segType: 'record' }), true);
  assert.equal(isVoiceMedia({ msgType: 'ptt' }), true);
});

check('isVoiceMedia 拒绝非语音与脏输入', () => {
  for (const value of [
    'image',
    'text',
    'file',
    '',
    {},
    { kind: 'image' },
    { type: 'text' },
    null,
    undefined,
    42,
    [],
    true,
  ]) {
    assert.equal(isVoiceMedia(value), false, String(value));
  }
});

check('isVoiceMedia 遇到会抛异常的 getter 不炸', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('boom');
      },
    },
  );
  assert.equal(isVoiceMedia(hostile), false);
});

check('normalizePttText 支持裸字符串 / {text} / {data:{text}} 三种形状', () => {
  assert.equal(normalizePttText('今天降温了'), '今天降温了');
  assert.equal(normalizePttText({ text: '今天降温了' }), '今天降温了');
  assert.equal(
    normalizePttText({ status: 'ok', retcode: 0, data: { text: '今天降温了' } }),
    '今天降温了',
  );
  assert.equal(normalizePttText({ data: { text: 123 } }), '123');
});

check('normalizePttText 压平换行/制表并压缩空格', () => {
  assert.equal(normalizePttText('  你好\n世界  '), '你好 世界');
  assert.equal(normalizePttText('a\r\nb\tc\u2028d'), 'a b c d');
  assert.equal(normalizePttText('多  个   空格'), '多 个 空格');
});

check('normalizePttText 空值与垃圾输入返回空串', () => {
  for (const value of [
    null,
    undefined,
    '',
    '   ',
    '\n\t',
    {},
    { data: {} },
    { data: { text: null } },
    [],
    42,
    true,
  ]) {
    assert.equal(normalizePttText(value), '', JSON.stringify(value));
  }
});

check('normalizePttText 截断超长文本到 2000 字', () => {
  const long = normalizePttText('a'.repeat(5000));
  assert.equal(long.length, PTT_TEXT_MAX);
  assert.ok(long.endsWith('…'));
  const justRight = normalizePttText('b'.repeat(PTT_TEXT_MAX));
  assert.equal(justRight.length, PTT_TEXT_MAX);
  assert.ok(!justRight.endsWith('…'));
});

check('formatVoiceNote 有转写时带注记前缀', () => {
  assert.equal(formatVoiceNote({ text: '晚上一起吃饭吗' }), `${PTT_NOTE_PREFIX} 晚上一起吃饭吗`);
  assert.equal(formatVoiceNote('裸字符串'), `${PTT_NOTE_PREFIX} 裸字符串`);
  assert.equal(
    formatVoiceNote({ text: '  你\n说啥  ', duration: 4 }),
    `${PTT_NOTE_PREFIX} 你 说啥`,
  );
});

check('formatVoiceNote 没转写时用不可用文案', () => {
  for (const value of [
    { text: '' },
    { text: '   ' },
    { duration: 3 },
    null,
    undefined,
    '',
    {},
    { text: null },
  ]) {
    assert.equal(formatVoiceNote(value), PTT_UNAVAILABLE_NOTE, String(value));
  }
});

check('formatVoiceNote 转写文本同样受 2000 字上限', () => {
  const note = formatVoiceNote({ text: 'x'.repeat(5000) });
  assert.ok(note.startsWith(`${PTT_NOTE_PREFIX} `));
  assert.equal(note.length, PTT_NOTE_PREFIX.length + 1 + PTT_TEXT_MAX);
});

check('planInboundVoice 挑语音，跳过无语音/非法 id/已有注记/自己发的', () => {
  const messages = [
    { seq: 101, messageId: 1111, media: [{ kind: 'record' }] },
    { seq: 102, messageId: '2222', message: [{ type: 'text' }, { type: 'record' }] },
    { seq: 103, messageId: 3333, media: [{ kind: 'image' }] },
    { seq: 104, messageId: 4444, media: [{ kind: 'record' }], text: '[语音转写] 已经转好了' },
    { seq: 105, messageId: 'abc', media: [{ kind: 'record' }] },
    { seq: 106, messageId: 0, media: [{ kind: 'record' }] },
    { seq: 107, media: [{ kind: 'record' }] },
    { seq: 108, messageId: 5555, media: [{ kind: 'record' }], voiceText: '已有转写' },
    { seq: 109, messageId: 6666, media: [{ kind: 'record' }], isSelf: true },
    { seq: 110, messageId: 7777, media: [{ kind: 'record' }], text: '[语音，转写不可用]' },
  ];
  assert.deepEqual(planInboundVoice(messages), [
    { seq: 101, messageId: '1111', mediaIndex: 0 },
    { seq: 102, messageId: '2222', mediaIndex: 1 },
  ]);
});

check('planInboundVoice 默认最多 3 条，maxPerTurn 可覆盖', () => {
  const many = Array.from({ length: 5 }, (_, index) => ({
    seq: index + 1,
    messageId: 9000 + index,
    media: [{ kind: 'record' }],
  }));
  assert.equal(planInboundVoice(many).length, 3);
  assert.equal(planInboundVoice(many, { maxPerTurn: 2 }).length, 2);
  assert.equal(planInboundVoice(many, { maxPerTurn: 1 })[0].messageId, '9000');
  assert.equal(planInboundVoice(many, { maxPerTurn: 0 }).length, 0);
  assert.equal(planInboundVoice(many, { maxPerTurn: -2 }).length, 0);
  assert.equal(planInboundVoice(many, { maxPerTurn: 1.5 }).length, 3);
});

check('planInboundVoice enabled=false 或非数组返回空', () => {
  const one = [{ messageId: 1, media: [{ kind: 'record' }] }];
  assert.deepEqual(planInboundVoice(one, { enabled: false }), []);
  for (const value of [null, undefined, 'x', 42, {}, true]) {
    assert.deepEqual(planInboundVoice(value), [], String(value));
  }
  assert.deepEqual(planInboundVoice([]), []);
});

check('planInboundVoice seq 缺省用下标、支持 message_seq 字符串', () => {
  const plan = planInboundVoice([
    { messageId: 1, media: [{ kind: 'record' }] },
    { message_seq: '42', messageId: 2, media: [{ kind: 'record' }] },
    { seq: 77, messageId: 3, media: [{ kind: 'record' }] },
  ]);
  assert.deepEqual(plan, [
    { seq: 0, messageId: '1', mediaIndex: 0 },
    { seq: 42, messageId: '2', mediaIndex: 0 },
    { seq: 77, messageId: '3', mediaIndex: 0 },
  ]);
});

check('planInboundVoice media 里没有语音时回退到 OneBot 段数组', () => {
  const plan = planInboundVoice([
    { messageId: 11, media: [{ kind: 'image' }], message: [{ type: 'text' }, { type: 'voice' }] },
  ]);
  assert.deepEqual(plan, [{ seq: 0, messageId: '11', mediaIndex: 1 }]);
});

check('buildTranscribeBody 合法 id 一律转成字符串', () => {
  assert.deepEqual(buildTranscribeBody(12345), { message_id: '12345' });
  assert.deepEqual(buildTranscribeBody('9876543210123'), { message_id: '9876543210123' });
  assert.deepEqual(buildTranscribeBody(-42), { message_id: '-42' });
  assert.deepEqual(buildTranscribeBody(' 777 '), { message_id: '777' });
});

check('buildTranscribeBody 非法 id 返回 null', () => {
  for (const value of [
    null,
    undefined,
    0,
    '0',
    '',
    '  ',
    'abc',
    12.5,
    NaN,
    Infinity,
    {},
    true,
    [],
  ]) {
    assert.equal(buildTranscribeBody(value), null, String(value));
  }
});

check('所有导出面对极端输入都不抛异常', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('boom');
      },
    },
  );
  const samples = [
    undefined,
    null,
    0,
    NaN,
    Symbol('x'),
    hostile,
    [],
    {},
    new Date(),
    () => {},
    'x',
    true,
    -1,
  ];
  for (const sample of samples) {
    assert.doesNotThrow(() => isVoiceMedia(sample));
    assert.doesNotThrow(() => normalizePttText(sample));
    assert.doesNotThrow(() => formatVoiceNote(sample));
    assert.doesNotThrow(() => planInboundVoice(sample));
    assert.doesNotThrow(() => buildTranscribeBody(sample));
  }
});

if (failures.length) {
  console.error(`\n失败 ${failures.length} 项：`);
  for (const { name, error } of failures) console.error(`- ${name}: ${error?.stack ?? error}`);
  process.exit(1);
}
console.log(`\n${passed} 项全过`);
