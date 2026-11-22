#!/usr/bin/env node
/**
 * 自升级提案模块测试（node:assert/strict，无网络、无真实 brain.json 写入）。
 *
 * 覆盖：
 *   - 外部卡尺 SELF_RUBRIC 结构（≥3 条规则、三个 id 齐全、hints/minHits 合法）；
 *   - 三条规则各自能扫出问题（客服腔 / 问句收尾 / 主动开口过多）；
 *   - 扫描窗口过滤、examples 最多 3 条且截断到 80 字；
 *   - buildProposals 生成待审批提案、同 rubricId 已 open 的跳过、max 上限；
 *   - normalizeProposal 非法状态归 pending、非法外部分归 null、形状与 model 一致；
 *   - isProposalOpen 只认 pending/approved；
 *   - weeklyReview 结构完整、drift 计算正确、externalScore 恒为 null；
 *   - scripts/memory-self-review.mjs：--dry-run 不写文件、不写 brain.json；正常运行写 self-review.json。
 *
 * 运行：node scripts/test-memory-selfupgrade.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SELF_RUBRIC,
  DAY_MS,
  DEFAULT_SCAN_DAYS,
  MAX_EXAMPLES,
  scanToneIssues,
  buildProposals,
  normalizeProposal,
  isProposalOpen,
  weeklyReview,
} from '../src/memory/self-upgrade.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_SCRIPT = path.join(SCRIPT_DIR, 'memory-self-review.mjs');

const NOW = Date.UTC(2026, 9, 29, 4, 0, 0); // 固定时间，保证可复现
const HOUR_MS = 3_600_000;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error?.message ?? error}`);
  }
}

/** 距 NOW 若干天前的条目。 */
function item(text, daysAgo = 0, kind) {
  const entry = { text, at: NOW - daysAgo * DAY_MS };
  if (kind) entry.kind = kind;
  return entry;
}

/** 混合语料：三条外部卡尺都能命中（共 12 条，窗口 7 天内）。 */
function sampleToneItems() {
  return [
    item('希望对您有帮助，有需要随时告诉我。', 0), // customer-service 命中 1
    item('今天先这样，希望对您有帮助。', 1), // customer-service 命中 2
    item('你也这么觉得吗？', 0), // question-tails 命中 1
    item('好吧那就先这样？', 1), // question-tails 命中 2
    item('那明天再说吧？', 2), // question-tails 命中 3
    item('这不是问句。', 3), // 不算问句收尾
    item('问号在中间？后面还有字。', 4), // 不以问号结尾，不算
    ...Array.from({ length: 5 }, (_, index) => item(`主动来找你说第${index + 1}句。`, index, 'proactive')),
  ];
}

// ---------------------------------------------------------------------------
// 1. 外部卡尺结构
// ---------------------------------------------------------------------------

check('SELF_RUBRIC 至少 3 条规则，且三个 id 齐全', () => {
  assert.ok(Array.isArray(SELF_RUBRIC));
  assert.ok(SELF_RUBRIC.length >= 3, `规则数 ${SELF_RUBRIC.length} < 3`);
  const ids = SELF_RUBRIC.map((rule) => rule.id);
  for (const id of ['customer-service', 'question-tails', 'over-proactive']) {
    assert.ok(ids.includes(id), `缺少规则 ${id}`);
  }
});

check('SELF_RUBRIC 每条规则都有 {id,label,desc,hints,minHits} 且 hints 是字符串数组', () => {
  for (const rule of SELF_RUBRIC) {
    assert.equal(typeof rule.id, 'string');
    assert.ok(rule.id.length > 0);
    assert.equal(typeof rule.label, 'string');
    assert.equal(typeof rule.desc, 'string');
    assert.ok(Array.isArray(rule.hints), `${rule.id}.hints 不是数组`);
    for (const hint of rule.hints) assert.equal(typeof hint, 'string');
    assert.ok(Number.isFinite(rule.minHits) && rule.minHits > 0, `${rule.id}.minHits 非法`);
  }
  const customerService = SELF_RUBRIC.find((rule) => rule.id === 'customer-service');
  for (const hint of ['希望对您有帮助', '如有需要', '随时告诉我', '感谢您的', '亲', '呢~', '哦~']) {
    assert.ok(customerService.hints.includes(hint), `客服腔缺少关键词 ${hint}`);
  }
  const questionTails = SELF_RUBRIC.find((rule) => rule.id === 'question-tails');
  for (const hint of ['？', '吗？', '呢？', '吧？']) {
    assert.ok(questionTails.hints.includes(hint), `问句收尾缺少关键词 ${hint}`);
  }
  const overProactive = SELF_RUBRIC.find((rule) => rule.id === 'over-proactive');
  assert.deepEqual(overProactive.hints, []);
});

// ---------------------------------------------------------------------------
// 2. 三条规则都能扫出问题
// ---------------------------------------------------------------------------

check('scanToneIssues：客服腔能扫出问题（count = 命中条数）', () => {
  const scan = scanToneIssues(sampleToneItems(), { now: NOW });
  const issue = scan.issues.find((entry) => entry.rubricId === 'customer-service');
  assert.ok(issue, '没有扫出客服腔问题');
  assert.equal(issue.count, 2);
  assert.equal(issue.label, '客服腔');
  assert.equal(scan.scanned, 12);
  assert.equal(scan.windowDays, 7);
});

check('scanToneIssues：问句收尾只算以问号结尾的条目', () => {
  const scan = scanToneIssues(sampleToneItems(), { now: NOW });
  const issue = scan.issues.find((entry) => entry.rubricId === 'question-tails');
  assert.ok(issue, '没有扫出问句收尾问题');
  assert.equal(issue.count, 3); // “这不是问句。”“问号在中间？后面还有字。”都不算
});

check('scanToneIssues：主动开口过多用调用方传的 proactiveCount 判断', () => {
  const items = [item('平时说话。', 0), item('我不主动。', 1)];
  const few = scanToneIssues(items, { now: NOW, proactiveCount: 2 });
  assert.ok(!few.issues.some((entry) => entry.rubricId === 'over-proactive'), '2 次不应报主动开口过多');
  const many = scanToneIssues(items, { now: NOW, proactiveCount: 8 });
  const issue = many.issues.find((entry) => entry.rubricId === 'over-proactive');
  assert.ok(issue, '8 次应报主动开口过多');
  assert.equal(issue.count, 8);
  assert.ok(issue.examples.length <= MAX_EXAMPLES);
});

check('scanToneIssues：没传 proactiveCount 时用 kind=proactive 的条目数兜底', () => {
  const scan = scanToneIssues(sampleToneItems(), { now: NOW });
  const issue = scan.issues.find((entry) => entry.rubricId === 'over-proactive');
  assert.ok(issue, '5 条 proactive 条目应报主动开口过多');
  assert.equal(issue.count, 5);
});

check('scanToneIssues：窗口外/未来/无时间的条目不计入 scanned', () => {
  const items = [
    item('希望对您有帮助。', 0), // 窗口内
    item('有需要随时告诉我。', 6), // 窗口内（第 6 天）
    item('希望对您有帮助。', 8), // 窗口外（8 天前）
    { text: '希望对您有帮助。', at: NOW + HOUR_MS }, // 未来时间
    { text: '希望对您有帮助。' }, // 缺少 at
    { text: '   ', at: NOW - HOUR_MS }, // 空文本
  ];
  const scan = scanToneIssues(items, { now: NOW, days: 7 });
  assert.equal(scan.scanned, 2);
  const sortIssue = scan.issues.find((entry) => entry.rubricId === 'customer-service');
  assert.ok(sortIssue);
  assert.equal(sortIssue.count, 2);
  // 3 天窗口下只剩 1 条，达不到 minHits=2
  const narrow = scanToneIssues(items, { now: NOW, days: 3 });
  assert.equal(narrow.scanned, 1);
  assert.ok(!narrow.issues.some((entry) => entry.rubricId === 'customer-service'));
});

check('scanToneIssues：examples 最多 3 条、每条截断到 80 字', () => {
  const longText = '希望对您有帮助。';
  const items = Array.from({ length: 6 }, (_, index) =>
    item(`${index}${longText}${'很啰嗦的一句话'.repeat(20)}`, index)
  );
  const scan = scanToneIssues(items, { now: NOW });
  const issue = scan.issues.find((entry) => entry.rubricId === 'customer-service');
  assert.ok(issue);
  assert.equal(issue.count, 6);
  assert.equal(issue.examples.length, MAX_EXAMPLES);
  for (const example of issue.examples) {
    assert.equal(typeof example, 'string');
    assert.ok(example.length <= 80, `example 长度 ${example.length} 超过 80`);
  }
  assert.equal(issue.examples.length, new Set(issue.examples).size, 'examples 不应重复');
});

// ---------------------------------------------------------------------------
// 3. 生成提案 + 去重
// ---------------------------------------------------------------------------

check('buildProposals：生成 pending 提案，externalScore 恒为 null', () => {
  const scan = scanToneIssues(sampleToneItems(), { now: NOW });
  const proposals = buildProposals({ issues: scan.issues, now: NOW, scanned: scan.scanned });
  assert.equal(proposals.length, 3);
  for (const proposal of proposals) {
    assert.equal(proposal.kind, 'tone');
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.createdAt, NOW);
    assert.equal(proposal.decidedAt, null);
    assert.equal(proposal.by, null);
    assert.equal(proposal.externalScore, null, 'externalScore 必须是 null（外部卡尺由主人判定）');
    assert.ok(proposal.id.startsWith('prop_'));
    assert.ok(proposal.title.length > 0 && /[\u4e00-\u9fa5]/.test(proposal.title), 'title 应为中文');
    assert.ok(/[\u4e00-\u9fa5]/.test(proposal.detail), 'detail 应为中文');
    assert.ok(proposal.detail.includes('自评嫌疑'), 'detail 应明确"只是自评嫌疑"');
    assert.ok(Number.isFinite(proposal.selfScore) && proposal.selfScore >= 0 && proposal.selfScore <= 1);
    assert.ok(Array.isArray(proposal.evidence));
    assert.ok(proposal.evidence.length >= 1 && proposal.evidence.length <= 5);
    for (const evidence of proposal.evidence) {
      assert.equal(typeof evidence.text, 'string');
      assert.equal(typeof evidence.at, 'number');
    }
  }
  const byRubric = new Map(proposals.map((proposal) => [proposal.rubricId, proposal]));
  assert.equal(byRubric.get('customer-service').selfScore, 0.167); // 2/12
  assert.equal(byRubric.get('question-tails').selfScore, 0.25); // 3/12
  assert.equal(byRubric.get('over-proactive').selfScore, 0.417); // 5/12
});

check('buildProposals：同 rubricId 已有 pending/approved 提案时跳过，rejected 不挡', () => {
  const scan = scanToneIssues(sampleToneItems(), { now: NOW });
  const existingOpen = [
    { rubricId: 'customer-service', title: '旧', detail: '旧', status: 'pending' },
    { rubricId: 'question-tails', title: '旧', detail: '旧', status: 'approved' },
  ];
  const openSkipped = buildProposals({ issues: scan.issues, existing: existingOpen, now: NOW, scanned: scan.scanned });
  assert.deepEqual(
    openSkipped.map((proposal) => proposal.rubricId),
    ['over-proactive']
  );
  const withRejected = existingOpen.concat([{ rubricId: 'over-proactive', title: '旧', detail: '旧', status: 'rejected' }]);
  const afterRejected = buildProposals({ issues: scan.issues, existing: withRejected, now: NOW, scanned: scan.scanned });
  assert.equal(afterRejected.length, 1, 'rejected 不应挡住新提案');
  assert.equal(afterRejected[0].rubricId, 'over-proactive');
});

check('buildProposals：max 上限生效；同批内同 rubricId 只提一条', () => {
  const scan = scanToneIssues(sampleToneItems(), { now: NOW });
  const limited = buildProposals({ issues: scan.issues, now: NOW, scanned: scan.scanned, max: 2 });
  assert.equal(limited.length, 2);
  const duplicated = buildProposals({
    issues: [
      { rubricId: 'customer-service', label: '客服腔', count: 2, examples: ['希望对您有帮助。'] },
      { rubricId: 'customer-service', label: '客服腔', count: 4, examples: ['随时告诉我。'] },
    ],
    now: NOW,
    scanned: 10,
  });
  assert.equal(duplicated.length, 1);
});

check('buildProposals：可接收 scanToneIssues 的完整结果对象', () => {
  const scan = scanToneIssues(sampleToneItems(), { now: NOW });
  const proposals = buildProposals({ issues: scan, now: NOW });
  assert.equal(proposals.length, 3);
  assert.equal(proposals[0].selfScore, 0.167, '传整个 scan 时也应能取到 scanned');
});

// ---------------------------------------------------------------------------
// 4. 归一化与状态
// ---------------------------------------------------------------------------

check('normalizeProposal：非法状态归 pending、缺省字段补全', () => {
  assert.equal(normalizeProposal(null, NOW), null);
  assert.equal(normalizeProposal({}, NOW), null);
  const pending = normalizeProposal({ title: '改一下', detail: '想说人话', status: 'bogus' }, NOW);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.decidedAt, null);
  assert.equal(pending.by, null);
  assert.equal(pending.externalScore, null);
  assert.equal(pending.createdAt, NOW);
  assert.ok(pending.id.startsWith('prop_'));
});

check('normalizeProposal：合法状态/外部分保留，非法外部分归 null（绝不伪造）', () => {
  const approved = normalizeProposal(
    { id: 'p1', title: '改', detail: '行', status: 'approved', selfScore: 0.3, externalScore: 0.5, decidedAt: NOW - 1000, by: '主人' },
    NOW
  );
  assert.equal(approved.id, 'p1');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.selfScore, 0.3);
  assert.equal(approved.externalScore, 0.5);
  assert.equal(approved.decidedAt, NOW - 1000);
  assert.equal(approved.by, '主人');
  assert.equal(normalizeProposal({ title: '改', externalScore: 'abc' }, NOW).externalScore, null);
  assert.equal(normalizeProposal({ title: '改', externalScore: null }, NOW).externalScore, null);
  assert.equal(normalizeProposal({ title: '改', status: 'rejected' }, NOW).status, 'rejected');
});

check('normalizeProposal：title/detail/evidence 有长度上限，形状与 model.self.proposals 一致', () => {
  const raw = buildProposals({ issues: [{ rubricId: 'customer-service', count: 2, examples: ['希望对您有帮助。'] }], now: NOW, scanned: 10 })[0];
  const normalized = normalizeProposal(raw, NOW);
  assert.deepEqual(Object.keys(normalized), [
    'id',
    'kind',
    'rubricId',
    'title',
    'detail',
    'evidence',
    'status',
    'createdAt',
    'decidedAt',
    'by',
    'selfScore',
    'externalScore',
  ]);
  const long = normalizeProposal(
    { title: '标题'.repeat(200), detail: '详情'.repeat(1000), evidence: Array.from({ length: 8 }, (_, index) => ({ text: `证据${index}`, at: NOW })) },
    NOW
  );
  assert.ok(long.title.length <= 200);
  assert.ok(long.detail.length <= 800);
  assert.equal(long.evidence.length, 5);
  assert.deepEqual(Object.keys(long.evidence[0]), ['text', 'at']);
});

check('isProposalOpen：只认 pending/approved', () => {
  assert.equal(isProposalOpen({ status: 'pending' }), true);
  assert.equal(isProposalOpen({ status: 'approved' }), true);
  assert.equal(isProposalOpen({ status: 'rejected' }), false);
  assert.equal(isProposalOpen({ status: 'bogus' }), false);
  assert.equal(isProposalOpen({}), false);
  assert.equal(isProposalOpen(null), false);
});

// ---------------------------------------------------------------------------
// 5. weeklyReview
// ---------------------------------------------------------------------------

check('weeklyReview：结构完整、externalScore 恒为 null、drift 计算正确', () => {
  const topics = [
    item('a'.repeat(10), 0),
    item('b'.repeat(20), 1),
    item('你也这么觉得吗？', 2), // 8 字，问句收尾
    item('希望对您有帮助。', 3), // 8 字，客服腔
  ];
  const review = weeklyReview({ items: topics, now: NOW });
  assert.equal(review.ok, true);
  assert.equal(review.externalScore, null);
  assert.deepEqual(review.drift, { avgLen: 12, questionTailRate: 0.25, serviceToneRate: 0.25 });
  assert.equal(review.scan.scanned, 4);
  assert.equal(review.scan.windowDays, DEFAULT_SCAN_DAYS);
  assert.equal(review.scan.issues.length, 0); // 都没到 minHits
  assert.equal(review.proposals.length, 0);
  assert.equal(review.selfScore, 0);
});

check('weeklyReview：有问题时同时给出 scan/proposals/漂移/自评嫌疑', () => {
  const review = weeklyReview({ items: sampleToneItems(), now: NOW });
  assert.equal(review.scan.issues.length, 3);
  assert.equal(review.proposals.length, 3);
  assert.equal(review.selfScore, 0.833); // (2+3+5)/12
  for (const proposal of review.proposals) assert.equal(proposal.externalScore, null);
  assert.ok(review.drift.serviceToneRate > 0);
  assert.ok(review.drift.questionTailRate > 0);
});

check('weeklyReview：existing 里的 open 提案会让 weeklyReview 跳过同类提案', () => {
  const existing = [{ rubricId: 'customer-service', title: '旧', detail: '旧', status: 'pending' }];
  const review = weeklyReview({ items: sampleToneItems(), existing, now: NOW });
  assert.deepEqual(
    review.proposals.map((proposal) => proposal.rubricId),
    ['question-tails', 'over-proactive']
  );
});

// ---------------------------------------------------------------------------
// 6. 周报脚本（真实子进程，临时目录，不碰真实 brain.json）
// ---------------------------------------------------------------------------

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-selfreview-'));
}

function makeBrainFixture(now = Date.now()) {
  const hour = HOUR_MS;
  const memories = {
    m_cs_1: { title: '日层摘要', text: '今天先这样，希望对您有帮助。', createdAt: now - 5 * hour, updatedAt: now - 4 * hour },
    m_cs_2: { title: '', text: '有需要随时告诉我。', createdAt: now - 3 * hour },
    m_q_1: { title: '问句一', text: '你也这么觉得吗？', createdAt: now - 2 * hour },
    m_q_2: { title: '问句二', text: '好吧那就先这样？', createdAt: now - 2 * hour },
    m_q_3: { title: '问句三', text: '那明天再说吧？', createdAt: now - 2 * hour },
  };
  for (let index = 1; index <= 5; index += 1) {
    memories[`m_proactive_${index}`] = {
      title: `主动开口 ${index}`,
      text: '我主动来找你说一句。',
      tags: ['proactive'],
      createdAt: now - hour,
    };
  }
  memories.m_plain = { title: '普通记忆', text: '今天群里很安静。', createdAt: now - hour };
  return {
    version: 1,
    memories,
    self: {
      proposals: [
        {
          id: 'prop_old_cs',
          kind: 'tone',
          rubricId: 'customer-service',
          title: '旧提案（已有待审批）',
          detail: '旧提案详情',
          status: 'pending',
          createdAt: now - 10 * hour,
          selfScore: 0.1,
          externalScore: null,
        },
      ],
    },
  };
}

function writeBrainFixture(root, brain) {
  const dir = path.join(root, 'state', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const brainPath = path.join(dir, 'brain.json');
  fs.writeFileSync(brainPath, JSON.stringify(brain, null, 2), 'utf8');
  return brainPath;
}

function runReview(root, args) {
  return spawnSync(process.execPath, [REVIEW_SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
}

check('memory-self-review.mjs --json --dry-run：输出 JSON、扫描正确、不写任何文件', () => {
  const root = makeTempRoot();
  try {
    const brainPath = writeBrainFixture(root, makeBrainFixture());
    const brainBefore = fs.readFileSync(brainPath, 'utf8');
    const result = runReview(root, ['--json', '--dry-run']);
    assert.equal(result.status, 0, `退出码 ${result.status}；stderr=${result.stderr}`);
    const review = JSON.parse(result.stdout.trim());
    assert.equal(review.kind, 'self-review');
    assert.equal(review.dryRun, true);
    assert.equal(review.windowDays, 7);
    assert.equal(review.scanned, 11); // 2 客服 + 3 问句 + 5 proactive + 1 普通
    assert.equal(review.externalScore, null);
    assert.equal(typeof review.summary, 'string');
    assert.ok(review.summary.length > 0);
    assert.ok(review.suspicion.includes('只是自评'), 'suspicion 文案应明确只是自评');
    assert.deepEqual(
      review.proposals.map((proposal) => proposal.rubricId).sort(),
      ['over-proactive', 'question-tails'] // customer-service 已有 pending 提案 → 跳过
    );
    for (const proposal of review.proposals) assert.equal(proposal.externalScore, null);
    assert.equal(fs.existsSync(path.join(root, 'state', 'memory', 'self-review.json')), false, '--dry-run 不应写文件');
    assert.equal(fs.readFileSync(brainPath, 'utf8'), brainBefore, '不得修改 brain.json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('memory-self-review.mjs 正常运行：写 self-review.json 且不修改 brain.json', () => {
  const root = makeTempRoot();
  try {
    const brainPath = writeBrainFixture(root, makeBrainFixture());
    const brainBefore = fs.readFileSync(brainPath, 'utf8');
    const result = runReview(root, ['--json']);
    assert.equal(result.status, 0, `退出码 ${result.status}；stderr=${result.stderr}`);
    const outputPath = path.join(root, 'state', 'memory', 'self-review.json');
    assert.ok(fs.existsSync(outputPath), '应写出 self-review.json');
    const saved = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(saved.kind, 'self-review');
    assert.equal(saved.dryRun, false);
    assert.equal(saved.externalScore, null);
    assert.equal(saved.scanned, 11);
    assert.deepEqual(
      saved.proposals.map((proposal) => proposal.rubricId).sort(),
      ['over-proactive', 'question-tails']
    );
    assert.equal(fs.readFileSync(brainPath, 'utf8'), brainBefore, '不得修改 brain.json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('memory-self-review.mjs 人读摘要：包含"每周自我审视"和外部卡尺说明', () => {
  const root = makeTempRoot();
  try {
    writeBrainFixture(root, makeBrainFixture());
    const result = runReview(root, ['--dry-run']);
    assert.equal(result.status, 0, `退出码 ${result.status}；stderr=${result.stderr}`);
    assert.ok(result.stdout.includes('每周自我审视'), '人读输出缺少标题');
    assert.ok(result.stdout.includes('待主人判定'), '人读输出缺少外部卡尺说明');
    assert.ok(result.stdout.includes('--dry-run'), '人读输出应说明未写文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('memory-self-review.mjs：非法 --days 退出码 1、--help 退出码 0', () => {
  const bad = spawnSync(process.execPath, [REVIEW_SCRIPT, '--days', 'abc', '--dry-run'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(bad.status, 1);
  assert.ok(String(bad.stderr).includes('--days'), `stderr 应提示 --days：${bad.stderr}`);
  const help = spawnSync(process.execPath, [REVIEW_SCRIPT, '--help'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('每周自我审视'));
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\n总计：${passed} 项通过，${failures.length} 项失败`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n失败：${failure.name}`);
    console.error(failure.error?.stack ?? failure.error);
  }
  process.exitCode = 1;
}
