// 情绪运行时（src/memory/emotion.mjs）自检：纯函数、无网络、now 全部显式传入。
// 覆盖：常量契约、normalize 非法 label/intensity、id 稳定性、active/latest 过滤、
// emotionPrompt 三档措辞与过期返回 null、prune 剪枝结果。
import assert from 'node:assert/strict';
import {
  EMOTION_LABELS,
  DEFAULT_EMOTION_TTL_MS,
  normalizeEmotion,
  activeEmotions,
  latestEmotion,
  emotionPrompt,
  pruneEmotions,
} from '../src/memory/emotion.mjs';

// 固定时间锚点，保证测试可复现（不依赖真实时间/网络）。
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

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

// 1. 常量契约
check('EMOTION_LABELS / DEFAULT_EMOTION_TTL_MS 精确', () => {
  assert.deepEqual([...EMOTION_LABELS], ['烦躁', '低落', '平静', '开心', '疲惫', '紧张', '兴奋', '委屈']);
  assert.ok(Object.isFrozen(EMOTION_LABELS), 'EMOTION_LABELS 应冻结');
  assert.equal(DEFAULT_EMOTION_TTL_MS, 24 * 3600 * 1000);
  assert.equal(DEFAULT_EMOTION_TTL_MS, 86_400_000);
});

// 2. 非法 label 归"平静"；合法 label 去空白保留
check('normalizeEmotion 非法 label 归"平静"', () => {
  assert.equal(normalizeEmotion({ label: '暴躁', at: NOW }, NOW).label, '平静');
  assert.equal(normalizeEmotion({ label: '', at: NOW }, NOW).label, '平静');
  assert.equal(normalizeEmotion({ at: NOW }, NOW).label, '平静');
  assert.equal(normalizeEmotion(null, NOW).label, '平静');
  assert.equal(normalizeEmotion([], NOW).label, '平静');
  assert.equal(normalizeEmotion({ label: ' 开心 ', at: NOW }, NOW).label, '开心');
  assert.equal(normalizeEmotion('疲惫', NOW).label, '疲惫');
});

// 3. intensity clamp 0..1，缺省/非数值走默认 0.5
check('normalizeEmotion intensity clamp 与默认值', () => {
  const intensityOf = (value) => normalizeEmotion({ label: '开心', at: NOW, intensity: value }, NOW).intensity;
  assert.equal(intensityOf(1.7), 1);
  assert.equal(intensityOf(-0.2), 0);
  assert.equal(intensityOf(0.42), 0.42);
  assert.equal(intensityOf(0.12345), 0.12);
  assert.equal(intensityOf('abc'), 0.5);
  assert.equal(intensityOf(undefined), 0.5);
  assert.equal(intensityOf(null), 0.5);
  assert.equal(intensityOf(''), 0.5);
});

// 4. 时间字段：at 缺省取 now、expiresAt 缺省 at+24h、自定义 expiresAt 保留
check('normalizeEmotion at / expiresAt 缺省与自定义', () => {
  const e = normalizeEmotion({ label: '开心' }, NOW);
  assert.equal(e.at, NOW);
  assert.equal(e.expiresAt, NOW + DEFAULT_EMOTION_TTL_MS);
  const custom = normalizeEmotion({ label: '开心', at: NOW - 5 * MINUTE, expiresAt: NOW + HOUR }, NOW);
  assert.equal(custom.at, NOW - 5 * MINUTE);
  assert.equal(custom.expiresAt, NOW + HOUR);
  // 30 小时前的条目即使恢复默认 expiresAt 也已过期
  const old = normalizeEmotion({ label: '开心', at: NOW - 30 * HOUR }, NOW);
  assert.equal(old.expiresAt, NOW - 30 * HOUR + DEFAULT_EMOTION_TTL_MS);
});

// 5. 返回字段与 source / note 归一
check('normalizeEmotion 字段完整、source/note 归一', () => {
  const e = normalizeEmotion({ label: '开心', at: NOW }, NOW);
  // v1.8：情绪带上 PAD 三维（愉悦/唤醒/掌控），旧记录按 label 补默认值。
  assert.deepEqual(Object.keys(e).sort(), ['at', 'expiresAt', 'id', 'intensity', 'label', 'note', 'pad', 'source']);
  assert.equal(e.source, 'self');
  assert.equal(e.note, '');
  assert.equal(normalizeEmotion({ at: NOW, source: '  chat  ' }, NOW).source, 'chat');
  assert.equal(normalizeEmotion({ at: NOW, source: '   ' }, NOW).source, 'self');
  assert.equal(
    normalizeEmotion({ at: NOW, source: { kind: 'group', key: '123456' } }, NOW).source,
    'group:123456',
  );
  assert.equal(normalizeEmotion({ at: NOW, note: '  心情   还行  ' }, NOW).note, '心情 还行');
  assert.equal(normalizeEmotion({ at: NOW, note: 'x'.repeat(500) }, NOW).note.length, 200);
});

// 6. id 稳定性：缺省由 label+at 生成，显式 id 保留
check('normalizeEmotion id 稳定且短', () => {
  const a = normalizeEmotion({ label: '开心', at: NOW }, NOW);
  const b = normalizeEmotion({ label: '开心', at: NOW }, NOW);
  assert.equal(a.id, b.id, '相同 label+at 应生成相同 id');
  assert.match(a.id, /^emo_[0-9a-f]{12}$/);
  assert.notEqual(a.id, normalizeEmotion({ label: '开心', at: NOW + 1 }, NOW).id);
  // intensity 不参与 id 生成
  assert.equal(a.id, normalizeEmotion({ label: '开心', at: NOW, intensity: 0.9 }, NOW).id);
  // label 先归一再生成 id
  assert.equal(
    normalizeEmotion({ label: '暴躁', at: NOW }, NOW).id,
    normalizeEmotion({ label: '平静', at: NOW }, NOW).id,
  );
  // 显式 id 尊重调用方（去空白、限长）
  assert.equal(normalizeEmotion({ id: ' custom-1 ', label: '开心', at: NOW }, NOW).id, 'custom-1');
});

// 7. 纯函数：同样输入两次调用结果完全一致（没有隐含 Date.now 抖动）
check('normalizeEmotion 两次调用 deepEqual', () => {
  const raw = { label: '开心', intensity: 0.6, at: NOW - 5 * MINUTE, source: 'chat', note: '聊得不错' };
  assert.deepEqual(normalizeEmotion(raw, NOW), normalizeEmotion(raw, NOW));
});

// 8. activeEmotions：过滤过期/未来，按 at 升序
check('activeEmotions 过滤过期与未来、按 at 升序', () => {
  const items = [
    { id: 'e4', label: '疲惫', at: NOW - 30 * HOUR }, // 过期
    { id: 'e2', label: '烦躁', at: NOW - 20 * MINUTE },
    { id: 'e3', label: '低落', at: NOW + MINUTE }, // 未来
    { id: 'e1', label: '开心', at: NOW - 3 * HOUR },
    { id: 'e5', label: '紧张', at: NOW - MINUTE, expiresAt: NOW - 1 }, // expiresAt 已过
  ];
  assert.deepEqual(activeEmotions(items, NOW).map((e) => e.id), ['e1', 'e2']);
  assert.deepEqual(activeEmotions([], NOW), []);
  assert.deepEqual(activeEmotions(null, NOW), []);
  assert.deepEqual(activeEmotions(undefined, NOW), []);
});

// 9. activeEmotions 对旧数据/缺字段条目自动归一
check('activeEmotions 自动归一裸条目', () => {
  const active = activeEmotions([{ label: '平静', at: NOW - HOUR }], NOW);
  assert.equal(active.length, 1);
  assert.match(active[0].id, /^emo_[0-9a-f]{12}$/);
  assert.equal(active[0].expiresAt, NOW - HOUR + DEFAULT_EMOTION_TTL_MS);
});

// 10. latestEmotion：取 at 最大的一条有效情绪，否则 null
check('latestEmotion 取最新有效情绪 / 空时 null', () => {
  const items = [
    { id: 'old', label: '低落', at: NOW - 2 * HOUR },
    { id: 'new', label: '开心', at: NOW - 30 * MINUTE },
    { id: 'mid', label: '平静', at: NOW - HOUR },
  ];
  assert.equal(latestEmotion(items, NOW).id, 'new');
  assert.equal(latestEmotion([], NOW), null);
  assert.equal(latestEmotion(null, NOW), null);
  assert.equal(latestEmotion([{ label: '疲惫', at: NOW - 30 * HOUR }], NOW), null);
  assert.equal(latestEmotion([{ label: '开心', at: NOW + HOUR }], NOW), null);
});

// 11. emotionPrompt 强/中/轻三档措辞
check('emotionPrompt 按 intensity 分档', () => {
  assert.equal(
    emotionPrompt({ label: '烦躁', intensity: 0.8, at: NOW - MINUTE }, NOW),
    '现在挺烦躁的',
  );
  assert.equal(
    emotionPrompt({ label: '烦躁', intensity: 0.5, at: NOW - 20 * MINUTE }, NOW),
    '刚才有点烦躁',
  );
  assert.equal(
    emotionPrompt({ label: '烦躁', intensity: 0.2, at: NOW - 20 * MINUTE }, NOW),
    '刚才心里有一点点烦',
  );
  // 中/强边界恰好命中
  assert.equal(emotionPrompt({ label: '烦躁', intensity: 0.7, at: NOW }, NOW), '现在挺烦躁的');
  assert.equal(emotionPrompt({ label: '烦躁', intensity: 0.69, at: NOW }, NOW), '现在有点烦躁');
  assert.equal(emotionPrompt({ label: '烦躁', intensity: 0.35, at: NOW }, NOW), '现在有点烦躁');
  assert.equal(emotionPrompt({ label: '烦躁', intensity: 0.34, at: NOW }, NOW), '现在心里有一点点烦');
});

// 12. emotionPrompt 示例措辞：现在/刚才/之前 与不同情绪
check('emotionPrompt 时间前缀与各情绪措辞', () => {
  assert.equal(emotionPrompt({ label: '开心', intensity: 0.5, at: NOW - MINUTE }, NOW), '现在心情还不错');
  assert.equal(emotionPrompt({ label: '开心', intensity: 0.9, at: NOW - MINUTE }, NOW), '现在心情特别好');
  assert.equal(emotionPrompt({ label: '平静', intensity: 0.8, at: NOW - MINUTE }, NOW), '现在心里挺平静的');
  assert.equal(emotionPrompt({ label: '紧张', intensity: 0.4, at: NOW - HOUR }, NOW), '刚才有点紧张');
  assert.equal(emotionPrompt({ label: '疲惫', intensity: 0.5, at: NOW - 10 * HOUR }, NOW), '之前有点累了');
  assert.equal(emotionPrompt({ label: '委屈', intensity: 0.1, at: NOW }, NOW), '现在心里有一点点不是滋味');
  // 非法 label 归平静后仍能给出措辞
  assert.equal(emotionPrompt({ label: '暴躁', intensity: 0.5, at: NOW }, NOW), '现在还算平静');
});

// 13. emotionPrompt 不输出数字（情绪不暴露成数值）
check('emotionPrompt 不出现数字', () => {
  for (const label of EMOTION_LABELS) {
    for (const intensity of [0, 0.2, 0.35, 0.5, 0.7, 0.9, 1]) {
      const prompt = emotionPrompt({ label, intensity, at: NOW - MINUTE }, NOW);
      assert.equal(typeof prompt, 'string', `${label}/${intensity} 应返回短句`);
      assert.ok(!/\d/.test(prompt), `${label}/${intensity} 不应出现数字：${prompt}`);
      assert.ok(prompt.length >= 4 && prompt.length <= 20, `${label}/${intensity} 长度异常：${prompt}`);
      assert.ok(/^(现在|刚才|之前)/.test(prompt), `${label}/${intensity} 缺时间前缀：${prompt}`);
    }
  }
});

// 14. emotionPrompt 过期 / 尚未发生 / 空入参 → null
check('emotionPrompt 超过 24h 或 expiresAt 已过返回 null', () => {
  const base = { label: '开心', intensity: 0.8, at: NOW };
  assert.equal(emotionPrompt(base, NOW + DEFAULT_EMOTION_TTL_MS - 1), '之前心情特别好');
  assert.equal(emotionPrompt(base, NOW + DEFAULT_EMOTION_TTL_MS), null);
  assert.equal(emotionPrompt(base, NOW + DEFAULT_EMOTION_TTL_MS + 1), null);
  assert.equal(
    emotionPrompt({ label: '开心', at: NOW, expiresAt: NOW + 1000 }, NOW + 2000),
    null,
  );
  assert.equal(emotionPrompt({ label: '开心', at: NOW + 1000 }, NOW), null);
  assert.equal(emotionPrompt(null, NOW), null);
  assert.equal(emotionPrompt(undefined, NOW), null);
});

// 15. pruneEmotions：过期进 expired、其余进 kept，字段保留
check('pruneEmotions 划分 kept/expired', () => {
  const items = [
    { id: 'e1', label: '开心', at: NOW - 3 * HOUR },
    { id: 'e2', label: '烦躁', at: NOW - 20 * MINUTE },
    { id: 'e3', label: '低落', at: NOW + MINUTE },
    { id: 'e4', label: '疲惫', at: NOW - 30 * HOUR },
    { id: 'e5', label: '紧张', at: NOW - MINUTE, expiresAt: NOW - 1 },
  ];
  const { kept, expired } = pruneEmotions(items, NOW);
  assert.deepEqual(kept.map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.deepEqual(expired.map((e) => e.id), ['e4', 'e5']);
  assert.equal(kept.length + expired.length, items.length, '剪枝不应丢条目');
  // expired 保留归档需要的完整字段
  assert.equal(expired[0].label, '疲惫');
  assert.equal(expired[0].intensity, 0.5);
  assert.equal(expired[0].at, NOW - 30 * HOUR);
  assert.match(expired[0].id, /^e4$/);
});

// 16. pruneEmotions 空/脏输入安全
check('pruneEmotions 空输入安全', () => {
  assert.deepEqual(pruneEmotions([], NOW), { kept: [], expired: [] });
  assert.deepEqual(pruneEmotions(null, NOW), { kept: [], expired: [] });
  assert.deepEqual(pruneEmotions('oops', NOW), { kept: [], expired: [] });
});

console.log(`\n总计：${passed} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
