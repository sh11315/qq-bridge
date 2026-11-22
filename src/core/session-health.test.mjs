import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SESSION_HEALTH_LIMITS,
  decideSessionRotation,
  normalizeSessionHealthLimits,
} from './session-health.mjs';

const NOW = 1_790_000_000_000;
const limits = { emptyTurnsBeforeRotate: 2, maxPromptTokens: 300000, rotateCooldownMs: 600000 };

test('healthy session is left alone', () => {
  const r = decideSessionRotation({ emptyTurnStreak: 0, promptTokens: 62000, lastRotateAt: 0, now: NOW, limits });
  assert.equal(r.rotate, false);
  assert.equal(r.reason, 'healthy');
});

test('one empty turn is not enough, two is', () => {
  const one = decideSessionRotation({ emptyTurnStreak: 1, promptTokens: 1000, now: NOW, limits });
  assert.equal(one.rotate, false, '单个空回合可能只是 AI 决定潜水，不能轮换');
  const two = decideSessionRotation({ emptyTurnStreak: 2, promptTokens: 1000, now: NOW, limits });
  assert.equal(two.rotate, true);
  assert.equal(two.reason, 'empty-turns');
});

test('oversized prompt rotates even when every turn called tools', () => {
  const r = decideSessionRotation({ emptyTurnStreak: 0, promptTokens: 300000, now: NOW, limits });
  assert.equal(r.rotate, true);
  assert.equal(r.reason, 'prompt-tokens');
});

test('empty turns win over prompt size when both trip', () => {
  const r = decideSessionRotation({ emptyTurnStreak: 5, promptTokens: 999999, now: NOW, limits });
  assert.equal(r.reason, 'empty-turns');
});

test('cooldown blocks the rotation but keeps the streak', () => {
  const recent = NOW - 60_000;
  const blocked = decideSessionRotation({ emptyTurnStreak: 9, promptTokens: 999999, lastRotateAt: recent, now: NOW, limits });
  assert.equal(blocked.rotate, false);
  assert.equal(blocked.reason, 'cooldown');
  assert.equal(blocked.streak, 9, '冷却不能把计数清零，否则反复坏的会话永远等不到下一次轮换');

  const later = NOW + limits.rotateCooldownMs;
  const allowed = decideSessionRotation({ emptyTurnStreak: 9, promptTokens: 1000, lastRotateAt: recent, now: later, limits });
  assert.equal(allowed.rotate, true);
});

test('zero disables each rule independently', () => {
  const off = { emptyTurnsBeforeRotate: 0, maxPromptTokens: 0, rotateCooldownMs: 0 };
  const r = decideSessionRotation({ emptyTurnStreak: 99, promptTokens: 9_999_999, now: NOW, limits: off });
  assert.equal(r.rotate, false);
  assert.equal(r.reason, 'healthy');

  const onlyTokens = decideSessionRotation({ emptyTurnStreak: 99, promptTokens: 300000, now: NOW, limits: { ...off, maxPromptTokens: 300000 } });
  assert.equal(onlyTokens.reason, 'prompt-tokens', '空回合阈值关掉时，token 判据仍然要生效');
});

test('garbage input never triggers a rotation', () => {
  for (const input of [undefined, null, {}, { emptyTurnStreak: NaN, promptTokens: NaN },
    { emptyTurnStreak: -5, promptTokens: -1 }, { emptyTurnStreak: 'abc', promptTokens: 'def' }]) {
    const r = decideSessionRotation(input);
    assert.equal(r.rotate, false, JSON.stringify(input));
    assert.equal(r.reason, 'healthy', JSON.stringify(input));
  }
});

test('limits accept strings and reject negatives', () => {
  assert.deepEqual(
    normalizeSessionHealthLimits({ emptyTurnsBeforeRotate: '3', maxPromptTokens: '250000', rotateCooldownMs: '1000' }),
    { emptyTurnsBeforeRotate: 3, maxPromptTokens: 250000, rotateCooldownMs: 1000 },
  );
  assert.deepEqual(normalizeSessionHealthLimits({ emptyTurnsBeforeRotate: -1, maxPromptTokens: -1 }),
    { ...DEFAULT_SESSION_HEALTH_LIMITS, rotateCooldownMs: DEFAULT_SESSION_HEALTH_LIMITS.rotateCooldownMs },
  );
  assert.deepEqual(normalizeSessionHealthLimits(null), { ...DEFAULT_SESSION_HEALTH_LIMITS });
  assert.deepEqual(normalizeSessionHealthLimits([1, 2, 3]), { ...DEFAULT_SESSION_HEALTH_LIMITS });
});
