#!/usr/bin/env node
/**
 * 情绪动力学纯函数自测（v1.11）。
 * 覆盖：时段基线、PAD 归类、对话推力、群聊衰减、记忆回声、向基线回落、
 *       evaluateEmotionDynamics 的变化判定/上限/TTL，以及 selectEmotionMemories 的过滤。
 */
import assert from 'node:assert/strict';
import {
  baselineByHour,
  classifyPad,
  dialogImpulse,
  memoryEcho,
  decayTowardBaseline,
  evaluateEmotionDynamics,
  selectEmotionMemories,
  sleepDebtImpulse,
  burstImpulse,
  reunionImpulse,
  analyzeWakeHistory,
  analyzeRecentEmotions,
  computeBondWarmth,
  findSpecialDay,
  mealImpulse,
  toneImpulse,
  familiarityImpulse,
  conflictMemoryImpulse,
  achievementImpulse,
  EMOTION_TTL_MS,
} from '../src/memory/emotion-dynamics.mjs';
import { EMOTION_PAD, normalizeEmotion } from '../src/memory/emotion.mjs';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error?.message || error}`);
  }
}

const at = (hour) => {
  const d = new Date(2026, 9, 30, hour, 0, 0, 0);
  return d.getTime();
};

console.log('时段基线');
test('03 点基线是疲惫', () => {
  const b = baselineByHour(at(3));
  assert.equal(b.label, '疲惫');
  assert.ok(b.pad.p < 0);
});
test('10 点与 19 点偏轻快', () => {
  assert.equal(baselineByHour(at(10)).label, '开心');
  assert.equal(baselineByHour(at(19)).label, '开心');
});
test('13 点是平静', () => assert.equal(baselineByHour(at(13)).label, '平静'));
test('23 点回落疲惫', () => assert.equal(baselineByHour(at(23)).label, '疲惫'));

console.log('PAD 归类');
test('开心的 PAD 归到开心', () => assert.equal(classifyPad(EMOTION_PAD['开心']), '开心'));
test('委屈的 PAD 归到委屈或低落', () => {
  const label = classifyPad(EMOTION_PAD['委屈']);
  assert.ok(label === '委屈' || label === '低落');
});

console.log('对话推力');
test('夸奖 → 开心方向', () => {
  const d = dialogImpulse(['你今天好可爱，真棒'], { fromOwner: true });
  assert.ok(d.hits.includes('praise'));
  assert.ok(d.pad.p > 0);
  assert.ok(d.intensity > 0);
});
test('批评（私聊/主人）→ 委屈方向', () => {
  const d = dialogImpulse(['你好笨，不想理你了'], { fromOwner: true });
  assert.ok(d.hits.includes('criticism'));
  assert.ok(d.pad.p < 0);
  assert.ok(d.pad.d < 0);
});
test('群聊里同样的夸奖推力更小', () => {
  const priv = dialogImpulse(['你真棒，谢谢'], { isGroup: false });
  const group = dialogImpulse(['你真棒，谢谢'], { isGroup: true });
  assert.ok(group.intensity < priv.intensity);
});
test('道歉 → 缓和方向', () => {
  const d = dialogImpulse(['对不起，我错了']);
  assert.ok(d.hits.includes('apology'));
  assert.ok(d.pad.a < 0);
});
test('压力 → 紧张方向', () => {
  const d = dialogImpulse(['项目要崩了，来不及了']);
  assert.ok(d.hits.includes('stress'));
  assert.ok(d.pad.a > 0);
});
test('朋友难过 → 低落方向', () => {
  const d = dialogImpulse(['我今天好难过，想哭']);
  assert.ok(d.hits.includes('sad'));
  assert.ok(d.pad.p < 0);
});
test('空文本不给推力', () => {
  const d = dialogImpulse(['']);
  assert.equal(d.intensity, 0);
  assert.equal(d.hits.length, 0);
});

console.log('记忆回声');
test('带难过词的记忆给负向回声', () => {
  const e = memoryEcho(['那天被冷落了，很难过']);
  assert.ok(e.pad.p < 0);
  assert.equal(e.hits, 1);
});
test('无情绪词不给回声', () => {
  assert.equal(memoryEcho(['今天部署了 v1.9']).hits, 0);
});
test('回声强度有上限', () => {
  const e = memoryEcho(Array.from({ length: 10 }, () => '很难过'));
  assert.ok(e.intensity <= 0.2);
  assert.ok(e.hits <= 3);
});

console.log('向基线回落');
test('8 小时后保留约 1/4 偏差', () => {
  const now = at(12);
  const current = normalizeEmotion({ label: '烦躁', intensity: 0.9, at: now - 8 * 3600_000 }, now);
  const d = decayTowardBaseline(current, { now, baseline: baselineByHour(now) });
  assert.ok(Math.abs(d.factor - 0.25) < 0.03);
});
test('越久越接近基线', () => {
  const now = at(20);
  const cur = normalizeEmotion({ label: '烦躁', intensity: 0.9, at: now - 60 * 60_000 }, now);
  const a = decayTowardBaseline(cur, { now, baseline: baselineByHour(now) });
  const b = decayTowardBaseline(cur, { now: now + 8 * 3600_000, baseline: baselineByHour(now + 8 * 3600_000) });
  const targetA = baselineByHour(now).pad.p;
  const targetB = baselineByHour(now + 8 * 3600_000).pad.p;
  assert.ok(Math.abs(b.pad.p - targetB) <= Math.abs(a.pad.p - targetA) + 1e-9);
});

console.log('evaluateEmotionDynamics');
test('没有当前情绪时初始化时段情绪', () => {
  const r = evaluateEmotionDynamics({ texts: [], now: at(3) });
  assert.equal(r.emotion.source, 'auto');
  assert.equal(r.emotion.label, '疲惫');
  assert.ok(r.changed);
  assert.ok(r.reasons.some((x) => x.includes('初始化')));
});
test('被夸之后开心起来', () => {
  const now = at(13);
  const current = normalizeEmotion({ label: '平静', intensity: 0.45, at: now - 60_000 }, now);
  const r = evaluateEmotionDynamics({ current, texts: ['你真棒，好可爱'], fromOwner: true, now });
  assert.equal(r.emotion.label, '开心');
  assert.ok(r.emotion.pad.p > 0.3);
  assert.ok(r.reasons.some((x) => x.includes('对话·praise')));
});
test('同样输入短时间内不重复改', () => {
  const now = at(9.5);
  const first = evaluateEmotionDynamics({ current: null, texts: [], now });
  const second = evaluateEmotionDynamics({ current: first.emotion, texts: [], now });
  assert.equal(second.changed, false);
});
test('强度夹在 0.05~0.95 且 TTL 12 小时', () => {
  const now = at(13);
  let current = null;
  for (let i = 0; i < 6; i += 1) {
    const r = evaluateEmotionDynamics({ current, texts: ['你真棒好可爱，谢谢你'], fromOwner: true, now: now + i * 1000 });
    current = r.emotion;
  }
  assert.ok(current.intensity <= 0.95);
  assert.ok(current.intensity >= 0.05);
  assert.equal(current.expiresAt - current.at, EMOTION_TTL_MS);
});
test('记忆回声参与情绪计算', () => {
  const now = at(13);
  const current = normalizeEmotion({ label: '平静', intensity: 0.4, at: now - 60_000 }, now);
  const r = evaluateEmotionDynamics({ current, texts: [], memories: ['那次很难过，被冷落了'], now });
  assert.ok(r.impulses.memoryHits >= 1);
  assert.ok(r.emotion.pad.p < 0.2);
});

console.log('selectEmotionMemories');
test('过滤归档/日记，按 query 相关度挑', () => {
  const now = Date.now();
  const brain = {
    memories: {
      a: { id: 'a', title: '路由改造', text: '逐条路由和图文分路', status: 'active', strength: 0.9, updatedAt: now },
      b: { id: 'b', title: '旧事', text: '逐条路由失败很烦', status: 'archived', strength: 0.9, updatedAt: now },
      c: { id: 'c', title: '日记', text: '逐条路由日记', status: 'active', tags: ['diary'], strength: 0.9, updatedAt: now },
      d: { id: 'd', title: '无关', text: '晚饭吃了面', status: 'active', strength: 0.8, updatedAt: now },
    },
  };
  const rows = selectEmotionMemories(brain, { query: '逐条路由', limit: 5 });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes('逐条路由'));
});
test('没有 query 时退回最近更新', () => {
  const now = Date.now();
  const brain = {
    memories: {
      a: { id: 'a', title: 'A', text: 'a', status: 'active', strength: 0.9, updatedAt: now - 1000 },
      b: { id: 'b', title: 'B', text: 'b', status: 'active', strength: 0.9, updatedAt: now },
    },
  };
  const rows = selectEmotionMemories(brain, { limit: 1 });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes('B'));
});


/* ── v1.11 额外心情因子：睡眠债 / 连续消息 / 久别重逢 / 羁绊 / 纪念日 / 惯性 ── */

test('睡眠债：凌晨或连续熬夜会压低愉悦与唤起', () => {
  const now = new Date(2026, 9, 30, 3, 10).getTime();
  const debt = sleepDebtImpulse({ lateNight: 2 }, now);
  assert.ok(debt.pad.p < 0);
  assert.ok(debt.pad.a < 0);
  assert.ok(debt.reason.includes('睡眠债'));
});

test('睡眠债：白天且没有熬夜则不加成', () => {
  const now = new Date(2026, 9, 30, 15, 0).getTime();
  const debt = sleepDebtImpulse({ lateNight: 0 }, now);
  assert.equal(debt.pad.p, 0);
  assert.equal(debt.reason, '');
});

test('连续消息：四条以上抬高唤起，少量不生效', () => {
  const few = burstImpulse(2);
  const many = burstImpulse(6, false);
  assert.equal(few.pad.a, 0);
  assert.ok(many.pad.a > 0);
  assert.ok(many.reason.includes('连续消息'));
});

test('久别重逢：隔 6 小时与 24 小时有不同权重', () => {
  const shortGap = reunionImpulse(8);
  const longGap = reunionImpulse(30);
  assert.ok(shortGap.pad.p > 0);
  assert.ok(longGap.pad.d > shortGap.pad.d);
  assert.ok(longGap.reason.includes('一天以上'));
});

test('唤醒日志：24 小时唤醒数、凌晨数、距上次唤醒', () => {
  const now = new Date(2026, 9, 30, 3, 0).getTime();
  const at = (hour) => new Date(2026, 9, 30, hour, 0).getTime();
  const stats = analyzeWakeHistory([{ at: at(1) }, { at: at(2) }, { at: new Date(2026, 9, 29, 20, 0).getTime() }], now);
  assert.equal(stats.wakes24h, 3);
  assert.equal(stats.lateNight, 2);
  assert.ok(stats.gapHours >= 0.9 && stats.gapHours <= 1.1);
});

test('羁绊温度：关系/约定类记忆与自述会升温', () => {
  const brain = {
    memories: {
      a: { id: 'a', category: 'relationship', status: 'active', tags: [] },
      b: { id: 'b', category: 'fact', status: 'active', tags: ['约定'] },
      c: { id: 'c', category: 'fact', status: 'active', tags: [] },
    },
    self: { narratives: [{ text: '我' }, { text: '你' }] },
  };
  const bond = computeBondWarmth(brain);
  assert.ok(bond.warmth > 0);
  assert.equal(bond.hits, 2);
  assert.equal(bond.narratives, 2);
});

test('特别日子：记忆里出现今天日期才触发', () => {
  const now = new Date(2026, 9, 30, 12, 0).getTime();
  const hit = findSpecialDay(['10-30 是我们的纪念日'], now);
  const miss = findSpecialDay(['10-31 才是纪念日'], now);
  const hitCn = findSpecialDay(['10月30日 生日'], now);
  assert.equal(hit.hit, true);
  assert.equal(miss.hit, false);
  assert.equal(hitCn.hit, true);
});

test('情绪惯性：最近几条情绪会把新值往回拉一点', () => {
  const now = Date.now();
  const emotions = [
    { at: now - 2 * 3600 * 1000, pad: { p: -0.6, a: 0.3, d: -0.4 } },
    { at: now - 1 * 3600 * 1000, pad: { p: -0.5, a: 0.2, d: -0.3 } },
  ];
  const inertia = analyzeRecentEmotions(emotions, now);
  assert.ok(inertia.pad.p < 0);
  assert.ok(inertia.weight > 0);
  const result = evaluateEmotionDynamics({ current: null, emotions, now, texts: [] });
  assert.ok(result.impulses.inertia.p < 0);
});

test('扩展因子会写进原因：睡眠债 / 羁绊 / 特别日子 / 重逢', () => {
  const now = new Date(2026, 9, 30, 3, 10).getTime();
  const result = evaluateEmotionDynamics({
    current: null,
    texts: ['辛苦了', '今天好乖'],
    memories: ['10-30 是我们的纪念日'],
    emotions: [],
    wakeStats: { lateNight: 2, gapHours: 30 },
    bond: { warmth: 0.2 },
    specialDay: { hit: true, day: '10-30' },
    now,
  });
  const joined = result.reasons.join('；');
  assert.ok(joined.includes('睡眠债'));
  assert.ok(joined.includes('羁绊温度'));
  assert.ok(joined.includes('特别日子'));
  assert.ok(joined.includes('久别重逢'));
});

// ── v1.12 细分因子 ────────────────────────────────────────────────

test('v1.12 饭点：午饭时段轻微满足，饭后略困', () => {
  const lunch = mealImpulse(new Date(2026, 9, 30, 12, 20).getTime());
  assert.ok(lunch.pad.p > 0);
  assert.ok(lunch.reason.includes('饭点'));
  const after = mealImpulse(new Date(2026, 9, 30, 13, 40).getTime());
  assert.ok(after.pad.a < 0);
  const none = mealImpulse(new Date(2026, 9, 30, 9, 0).getTime());
  assert.equal(none.pad.p, 0);
});

test('v1.12 语气：感叹号/笑声抬唤起，省略号压低，连问抬警觉', () => {
  const hot = toneImpulse(['好耶！！！哈哈哈']);
  assert.ok(hot.pad.a > 0.1);
  assert.ok(hot.reason.includes('语气'));
  const flat = toneImpulse(['好吧……']);
  assert.ok(flat.pad.a < 0);
  const ask = toneImpulse(['你怎么这样？？']);
  assert.ok(ask.pad.a > 0);
  assert.ok(ask.pad.d < 0);
});

test('v1.12 熟悉度：陌生人收着，主人在场放松', () => {
  const stranger = familiarityImpulse({ knownSender: false });
  assert.ok(stranger.pad.a > 0);
  assert.ok(stranger.pad.d < 0);
  const owner = familiarityImpulse({ fromOwner: true });
  assert.ok(owner.pad.d > 0);
  const clean = familiarityImpulse({ knownSender: true, isGroup: false, fromOwner: false });
  assert.equal(clean.pad.p, 0);
});

test('v1.12 旧矛盾/暖记忆：语气比通用情绪词更具体', () => {
  const conflict = conflictMemoryImpulse(['上次吵架还没说开']);
  assert.ok(conflict.pad.p < 0);
  assert.ok(conflict.pad.a > 0);
  const warm = conflictMemoryImpulse(['谢谢你陪着我']);
  assert.ok(warm.pad.p > 0);
  assert.ok(warm.pad.d > 0);
});

test('v1.12 成就/挫败：刚做完事抬底气，刚碰壁抬急躁', () => {
  const done = achievementImpulse('修好了，部署通过');
  assert.ok(done.pad.p > 0);
  assert.ok(done.pad.d > 0);
  const broken = achievementImpulse('又报错了，卡住');
  assert.ok(broken.pad.a > 0);
  assert.ok(broken.pad.d < 0);
});

test('v1.12 evaluate 接入新因子并写进原因', () => {
  const now = new Date(2026, 9, 30, 12, 20).getTime();
  const result = evaluateEmotionDynamics({
    current: null,
    texts: ['谢谢你陪我，好耶！！'],
    memories: ['上次吵架还没说开'],
    knownSender: true,
    fromOwner: true,
    lastTurnText: '修好了，部署通过',
    now,
  });
  const joined = result.reasons.join('；');
  assert.ok(joined.includes('饭点'));
  assert.ok(joined.includes('语气'));
  assert.ok(joined.includes('熟人在场'));
  assert.ok(joined.includes('旧矛盾'));
  assert.ok(joined.includes('刚做完事'));
  assert.ok(result.impulses.meal.p > 0);
  assert.ok(result.impulses.tone.a > 0);
});

test('v1.12 陌生人进群会收着一点：原因与 impulses 都在', () => {
  const now = new Date(2026, 9, 30, 15, 0).getTime();
  const result = evaluateEmotionDynamics({
    current: null,
    texts: ['你好，第一次来'],
    isGroup: true,
    knownSender: false,
    now,
  });
  assert.ok(result.reasons.join('；').includes('陌生人'));
  assert.ok(result.impulses.familiar.a > 0);
});

console.log(`\n情绪动力学：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
