#!/usr/bin/env node
// 活人感行为提示（纯规则）回归：开关、档位、场景、功能域、长度上限。
// 用法：node scripts/test-presence.mjs
import assert from 'node:assert';
import { buildPresenceHint, PRESENCE_DEFAULT_MAX_CHARS } from '../src/core/presence.mjs';

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

await test('默认（light/群聊）注入短句与反客服规则', () => {
  const hint = buildPresenceHint();
  assert.ok(hint.startsWith('【这一轮怎么说】'));
  assert.match(hint, /一两句为主/);
  assert.match(hint, /别列点、别总结/);
  assert.match(hint, /别复述对方刚说的/);
  assert.match(hint, /群里没被点到/);
  assert.doesNotMatch(hint, /qq_send_message/);
  assert.ok(hint.length <= PRESENCE_DEFAULT_MAX_CHARS);
});

await test('关闭开关 / off / 未知档位都不注入', () => {
  assert.equal(buildPresenceHint({ enabled: false }), '');
  assert.equal(buildPresenceHint({ level: 'off' }), '');
  assert.equal(buildPresenceHint({ level: 'turbo' }), '');
});

await test('非 chat 功能会话不注入（任务回合不该被短句约束）', () => {
  for (const feature of ['vision', 'voice', 'web', 'sticker']) {
    assert.equal(buildPresenceHint({ feature }), '', `${feature} 不应注入`);
  }
});

await test('私聊不出现“群里别接话”，主动冒泡强调 1~2 条', () => {
  const priv = buildPresenceHint({ scene: 'private' });
  assert.doesNotMatch(priv, /群里没被点到/);
  const pro = buildPresenceHint({ scene: 'private', proactive: true });
  assert.match(pro, /1~2 条/);
});

await test('standard 档追加分条与标点约束', () => {
  const hint = buildPresenceHint({ level: 'standard' });
  assert.match(hint, /qq_send_message/);
  assert.match(hint, /emoji/);
  assert.ok(hint.length <= PRESENCE_DEFAULT_MAX_CHARS);
});

await test('maxChars 硬上限生效（配置写大也会被夹住）', () => {
  const hint = buildPresenceHint({ level: 'standard', maxChars: 80 });
  assert.ok(hint.length <= 80);
  const big = buildPresenceHint({ level: 'standard', maxChars: 9999 });
  assert.ok(big.length <= 400, '默认文本本身应保持短');
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部活人感提示用例通过');
process.exit(failed ? 1 : 0);