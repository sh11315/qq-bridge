// 记忆关键度（src/memory/salience.mjs）自检：纯函数、无网络、时间全显式。
// 覆盖：永久最高、承诺 > 闲聊、锚词加成、反复提起有上限、情绪只加一点点、
// 分级阈值、衰减倍数、pickAnchors 过滤与排序。
import assert from 'node:assert/strict';
import {
  SALIENCE_TIERS,
  salienceScore,
  salienceTier,
  adjustedDecayDays,
  pickAnchors,
} from '../src/memory/salience.mjs';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`❌ ${name}`);
    console.log(`   ${err && err.message ? err.message : err}`);
  }
}

const plain = {
  id: 'mem_plain',
  layer: 'short',
  category: 'topic',
  title: '随便聊聊',
  text: '今天吃了泡面',
  protection: 0,
  activationCount: 0,
};

check('分级阈值是 core 0.62 / important 0.15', () => {
  assert.equal(SALIENCE_TIERS.core.min, 0.62);
  assert.equal(SALIENCE_TIERS.important.min, 0.15);
  assert.equal(salienceTier(0.62), 'core');
  assert.equal(salienceTier(0.61), 'important');
  assert.equal(salienceTier(0.15), 'important');
  assert.equal(salienceTier(0.14), 'normal');
});

check('永久记忆一定进核心', () => {
  const score = salienceScore({ ...plain, protection: 1 });
  assert.ok(score >= 0.62, `score=${score}`);
  assert.equal(salienceTier(score), 'core');
});

check('承诺比普通闲聊重', () => {
  const promise = salienceScore({ ...plain, category: 'promise', text: '说定了，欠一根猫条' });
  const chat = salienceScore(plain);
  assert.ok(promise > chat, `${promise} 应 > ${chat}`);
});

check('显式锚词有加成', () => {
  const marked = salienceScore({ ...plain, text: '记住，别忘了他怕冷' });
  const unmarked = salienceScore(plain);
  assert.ok(marked > unmarked);
});

check('人物实体比孤立条目重', () => {
  const withPerson = salienceScore(plain, { entityTypes: { person: 1 } });
  const alone = salienceScore(plain);
  assert.ok(withPerson > alone);
});

check('反复提起有加成但有上限', () => {
  const once = salienceScore({ ...plain, activationCount: 1 });
  const many = salienceScore({ ...plain, activationCount: 64 });
  const base = salienceScore(plain);
  assert.ok(once > base);
  assert.ok(many > once);
  assert.ok(many - base <= 0.121, '上限 0.12');
});

check('情绪只在一天内加一点点，且不超过 0.05', () => {
  const now = Date.now();
  const fresh = salienceScore(plain, { emotionAt: now });
  const stale = salienceScore(plain, { emotionAt: now - 2 * 86_400_000 });
  const base = salienceScore(plain);
  assert.equal(fresh - base, 0.05);
  assert.equal(stale, base);
});

check('分数恒在 0~1 且三位小数', () => {
  const maxed = salienceScore(
    { protection: 1, category: 'promise', title: '记住', text: '一辈子别忘', activationCount: 999, layer: 'long' },
    { relations: 9, entityTypes: { person: 3 }, emotionAt: Date.now() }
  );
  assert.ok(maxed <= 1 && maxed >= 0);
  assert.equal(maxed, Math.round(maxed * 1000) / 1000);
});

check('衰减天数：永久不衰减，核心活 6 倍，普通按原样', () => {
  assert.equal(adjustedDecayDays({ ...plain, protection: 1 }, 30), Infinity);
  const core = adjustedDecayDays({ ...plain, protection: 1 }, 30);
  const normal = adjustedDecayDays(plain, 30);
  assert.equal(normal, 30);
  assert.equal(core, Infinity);
  const coreish = adjustedDecayDays({ ...plain, category: 'promise', text: '记住约定', entityTypes: {} }, 30);
  assert.ok(coreish === 30 || coreish === 60 || coreish === 180, `unexpected ${coreish}`);
});

check('pickAnchors 跳过归档并按时序兜底', () => {
  const list = [
    { ...plain, id: 'a', protection: 1 },
    { ...plain, id: 'b', status: 'archived', protection: 1 },
    { ...plain, id: 'c', category: 'promise', text: '答应明天吃两顿' },
    { ...plain, id: 'd' },
  ];
  const picked = pickAnchors(list, { limit: 2 });
  assert.equal(picked.length, 2);
  assert.equal(picked[0].memory.id, 'a');
  assert.ok(picked.every((item) => item.memory.id !== 'b'));
});

console.log(`\n通过 ${passed}，失败 ${failed}`);
if (failed) process.exit(1);
