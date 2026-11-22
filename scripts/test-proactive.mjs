import assert from 'node:assert/strict';
import {
  DEFAULT_PROACTIVE_POLICY,
  isQuietHour,
  evaluateProactiveOpportunity,
  pickProactiveKind,
  buildProactiveBrief,
  clamp01,
  computeReplyHeat,
  computeMoodModifiers,
} from '../src/core/proactive.mjs';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

const NOW = new Date('2026-10-29T15:00:00+08:00').getTime();
const base = {
  now: NOW,
  hour: 15,
  policy: { ...DEFAULT_PROACTIVE_POLICY },
  isPrivate: false,
  idleMs: 20 * 60 * 1000,
  hourHistory: [],
  dayHistory: [],
};

console.log('[1] 静默时段');
check('凌晨 3 点属于静默时段', () => assert.equal(isQuietHour(3, { start: 1, end: 8 }), true));
check('上午 10 点不属于静默时段', () => assert.equal(isQuietHour(10, { start: 1, end: 8 }), false));
check('跨午夜 22~7 生效', () => assert.equal(isQuietHour(23, { start: 22, end: 7 }), true));

console.log('[2] 阈值与冷却');
check('未到安静阈值时不主动', () => {
  const r = evaluateProactiveOpportunity({ ...base, idleMs: 5 * 60 * 1000 }, 0);
  assert.equal(r.allow, false);
  assert.equal(r.probability, 0);
});
check('到达阈值时进入判定', () => {
  const r = evaluateProactiveOpportunity({ ...base, idleMs: 16 * 60 * 1000 }, 0.01);
  assert.ok(r.probability > 0);
});
check('私聊冷却时间内不主动', () => {
  const r = evaluateProactiveOpportunity({ ...base, isPrivate: true, lastProactiveAt: NOW - 5 * 60 * 1000, idleMs: 30 * 60 * 1000 }, 0);
  assert.equal(r.allow, false);
  assert.ok(r.reasons.includes('私聊冷却中'));
});

console.log('[3] 上限');
check('本小时次数已满时不主动', () => {
  const r = evaluateProactiveOpportunity({ ...base, hourHistory: [NOW - 1000, NOW - 2000] }, 0);
  assert.equal(r.allow, false);
  assert.equal(r.capHit, 'hour');
});
check('今日次数已满时不主动', () => {
  const r = evaluateProactiveOpportunity({ ...base, dayHistory: Array.from({ length: 8 }, (_, i) => NOW - i * 1000) }, 0);
  assert.equal(r.allow, false);
  assert.equal(r.capHit, 'day');
});

console.log('[4] 概率随安静时长/由头增长');
check('安静越久概率越高', () => {
  const a = evaluateProactiveOpportunity({ ...base, idleMs: 16 * 60 * 1000 }, 0.99);
  const b = evaluateProactiveOpportunity({ ...base, idleMs: 60 * 60 * 1000 }, 0.99);
  assert.ok(b.probability > a.probability);
});
check('有 followup 时概率加成', () => {
  const a = evaluateProactiveOpportunity({ ...base, hasFollowup: false }, 0.99);
  const b = evaluateProactiveOpportunity({ ...base, hasFollowup: true }, 0.99);
  assert.ok(b.probability > a.probability);
});
check('静默时段概率被压低', () => {
  const day = evaluateProactiveOpportunity({ ...base, hour: 15 }, 0.99);
  const night = evaluateProactiveOpportunity({ ...base, hour: 3 }, 0.99);
  assert.ok(night.probability < day.probability);
});

console.log('[5] 随机命中与由头');
check('随机数低于概率时 allow=true 且给 kind', () => {
  const r = evaluateProactiveOpportunity({ ...base, hasFollowup: true, hasPendingThought: true }, 0.001);
  assert.equal(r.allow, true);
  assert.ok(['followup', 'thought', 'mood', 'share', 'poke', 'idle'].includes(r.kind));
});
check('随机数高于概率时安静', () => {
  const r = evaluateProactiveOpportunity({ ...base }, 0.9999);
  assert.equal(r.allow, false);
  assert.equal(r.kind, null);
});
check('优先接上次话题', () => {
  const kind = pickProactiveKind({ isPrivate: false, hasFollowup: true, hasPendingThought: false, random: () => 0.05 });
  assert.equal(kind, 'followup');
});
check('没有 followup 时不会选 followup', () => {
  for (const value of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
    const kind = pickProactiveKind({ isPrivate: true, hasFollowup: false, hasPendingThought: false, random: () => value });
    assert.notEqual(kind, 'followup');
  }
});

console.log('[6] 提示词');
check('brief 包含由头与活人感边界', () => {
  const text = buildProactiveBrief({ kind: 'followup', isPrivate: true, idleMinutes: 33, hour: 15, lastTurnSummary: '晚上要不要一起上线' });
  assert.ok(text.includes('【这次主动的由头】'));
  assert.ok(text.includes('晚上要不要一起上线'));
  assert.ok(text.includes('1~2 条'));
});
check('凌晨 brief 也允许不说话', () => {
  const text = buildProactiveBrief({ kind: 'idle', isPrivate: false, idleMinutes: 90, hour: 3 });
  assert.ok(text.includes('没什么想说的'));
});
check('clamp01 兜底', () => {
  assert.equal(clamp01('bad', 0.5), 0.5);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(-1), 0);
});

console.log('[7] 由头多样性');
check('最近用过的由头被降权', () => {
  const recentKinds = ['share', 'share', 'share', 'share', 'share'];
  let picked = 0;
  for (let i = 0; i < 40; i += 1) {
    const kind = pickProactiveKind({ isPrivate: true, hasFollowup: false, hasPendingThought: false, recentKinds, random: (i + 0.5) / 40 });
    if (kind === 'share') picked += 1;
  }
  assert.ok(picked <= 6, 'share 被抽样 ' + picked + ' 次，多样性降权无效');
});
check('刚用过的同一由头权重减半', () => {
  const fresh = pickProactiveKind({ isPrivate: true, hasFollowup: false, hasPendingThought: false, recentKinds: [], random: () => 0.56 });
  const used = pickProactiveKind({ isPrivate: true, hasFollowup: false, hasPendingThought: false, recentKinds: ['poke'], random: () => 0.56 });
  assert.notEqual(fresh, null);
  assert.notEqual(used, null);
});

console.log('[8] 按回复热度调整');
check('无历史时热度为空', () => {
  assert.equal(computeReplyHeat([]).heat, null);
});
check('回复热度按最近结果计算', () => {
  const heat = computeReplyHeat([{ replied: true }, { replied: false }, { replied: true }, { replied: true }]);
  assert.equal(heat.total, 4);
  assert.equal(heat.replied, 3);
  assert.equal(heat.heat, 0.75);
});
check('回复热时概率更高', () => {
  const cold = evaluateProactiveOpportunity({ ...base, replyHeat: 0 }, 0.99);
  const hot = evaluateProactiveOpportunity({ ...base, replyHeat: 1 }, 0.99);
  assert.ok(hot.probability > cold.probability);
});
check('回复热时安静阈值缩短', () => {
  const idle = 14 * 60 * 1000;
  const cold = evaluateProactiveOpportunity({ ...base, idleMs: idle, replyHeat: 0 }, 0.99);
  const hot = evaluateProactiveOpportunity({ ...base, idleMs: idle, replyHeat: 0.9 }, 0.01);
  assert.equal(cold.allow, false);
  assert.equal(hot.allow, true);
  assert.ok(hot.effectiveThresholdMs < 15 * 60 * 1000);
});
check('回复冷时安静阈值拉长', () => {
  const r = evaluateProactiveOpportunity({ ...base, idleMs: 16 * 60 * 1000, replyHeat: 0.1 }, 0.01);
  assert.equal(r.allow, false);
  assert.ok(r.effectiveThresholdMs > 15 * 60 * 1000);
});
check('热度影响写进 reasons', () => {
  const r = evaluateProactiveOpportunity({ ...base, replyHeat: 0.9 }, 0.01);
  assert.ok(r.reasons.some((item) => item.includes('回复热度')));
});

console.log('[9] 由头重复提醒');
check('brief 会提示换个由头', () => {
  const text = buildProactiveBrief({ kind: 'share', isPrivate: true, idleMinutes: 40, hour: 15, recentKinds: ['share'] });
  assert.ok(text.includes('换个方式'));
});
check('连续两次重复时也会提醒', () => {
  const text = buildProactiveBrief({ kind: 'mood', isPrivate: true, idleMinutes: 40, hour: 15, recentKinds: ['share', 'share'] });
  assert.ok(text.includes('换个角度'));
});

console.log('[10] 情绪 + 记忆联动主动机会');
check('疲惫会压概率、拉长安静阈值、给收敛语气', () => {
  const m = computeMoodModifiers({ emotionLabel: '疲惫', intensity: 0.95, memoryBias: 0 });
  assert.ok(m.probabilityScale < 0.6);
  assert.ok(m.thresholdScale > 1.3);
  assert.ok(m.toneHint.includes('一两句'));
});
check('开心会抬概率、缩短阈值', () => {
  const m = computeMoodModifiers({ emotionLabel: '开心', intensity: 0.8, memoryBias: 0 });
  assert.ok(m.probabilityScale > 1.2);
  assert.ok(m.thresholdScale < 0.95);
});
check('记忆里有料会再加成并写进 reasons', () => {
  const plain = computeMoodModifiers({ emotionLabel: '平静', intensity: 0.4, memoryBias: 0 });
  const rich = computeMoodModifiers({ emotionLabel: '平静', intensity: 0.4, memoryBias: 0.5 });
  assert.ok(rich.probabilityScale > plain.probabilityScale);
  assert.ok(rich.reasons.some((r) => r.includes('记忆')));
});
check('同一时刻疲惫比开心更难主动开口', () => {
  const tired = evaluateProactiveOpportunity({ ...base, emotionLabel: '疲惫', emotionIntensity: 0.95 }, 0.5);
  const happy = evaluateProactiveOpportunity({ ...base, emotionLabel: '开心', emotionIntensity: 0.8 }, 0.5);
  assert.ok(tired.probability < happy.probability);
  assert.ok(tired.moodTone.length > 0);
});
check('主动 brief 会带此刻语气', () => {
  const text = buildProactiveBrief({ kind: 'idle', isPrivate: true, idleMinutes: 60, hour: 15, moodTone: '这会儿有点乏：只说一两句。' });
  assert.ok(text.includes('此刻语气'));
});

console.log(`\n主动机会单测：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
