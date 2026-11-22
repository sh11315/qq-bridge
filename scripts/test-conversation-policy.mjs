/**
 * 按会话模型覆盖测试：持久化 / 覆盖 / 删除 / 重载 / 损坏文件 fail-open / 模型拆分。
 * 跑法：node scripts/test-conversation-policy.mjs
 *
 * 这里钉住的是「写进去的是 caller 已经鉴权过的 actor」这条契约：SessionRouter 只接受
 * `console` / `command:<ownerKey>`，写成 `owner` 会在 setConversation 里直接抛
 * TypeError —— 曾经就是一调 API 就 500 的原因，所以必须有回归。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  POLICY_VERSION,
  createConversationPolicy,
  resolveModelTarget,
} from '../src/core/conversation-policy.mjs';

const OWNER_QQ = '100000001';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-policy-'));
let fileSeq = 0;

function newFile() {
  fileSeq += 1;
  return path.join(tmpDir, `policies-${fileSeq}.json`);
}

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

console.log('会话模型覆盖');

check('没有文件时：snapshot 正常、policyFor 为空、不写盘', () => {
  const file = newFile();
  const policy = createConversationPolicy({ file, ownerQQ: OWNER_QQ });
  const snap = policy.snapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.version, POLICY_VERSION);
  assert.equal(snap.file, file);
  assert.equal(snap.defaults.mode, 'simulation');
  assert.equal(snap.defaults.preset, 'qq-chat-v2');
  assert.deepEqual(snap.conversations, {});
  assert.equal(policy.policyFor('group:100000003').hasOverride, false, '无覆盖时 hasOverride 为 false');
  assert.equal(policy.policyFor('group:100000003').model, '');
  assert.equal(policy.policyFor(''), null);
  assert.equal(policy.policyFor('not-a-key'), null, '非法 key 必须静默回落而不是抛错');
  assert.equal(fs.existsSync(file), false, '只读查询不得创建文件');
});

check('setPolicy 写入 provider/model/effort 并落盘', () => {
  const file = newFile();
  const policy = createConversationPolicy({ file, ownerQQ: OWNER_QQ });
  const result = policy.setPolicy('group:100000003', {
    provider: 'workbuddy',
    model: 'hy3',
    reasoningEffort: 'high',
  });
  assert.equal(result.ok, true);
  assert.equal(result.key, 'group:100000003');
  assert.equal(result.changed, true);
  assert.equal(result.policy.provider, 'workbuddy');
  assert.equal(result.policy.model, 'hy3');
  assert.equal(result.policy.reasoningEffort, 'high');
  assert.equal(result.policy.hasOverride, true);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, POLICY_VERSION);
  assert.equal(onDisk.defaults.mode, 'simulation');
  const record = onDisk.conversations['group:100000003'];
  assert.equal(record.model, 'workbuddy/hy3');
  assert.equal(record.reasoningEffort, 'high');
  assert.equal(record.updatedBy, 'console', '默认 actor 必须是 console（SessionRouter 只认它）');
  assert.equal(record.mode, 'simulation');
  assert.equal(record.preset, 'qq-chat-v2');
});

check('同一 key 再写一次是覆盖（旧 model 不残留）', () => {
  const file = newFile();
  const policy = createConversationPolicy({ file, ownerQQ: OWNER_QQ });
  policy.setPolicy('group:100000003', { provider: 'workbuddy', model: 'hy3', reasoningEffort: 'high' });
  const second = policy.setPolicy('group:100000003', { model: 'gpt-6-sol' });
  assert.equal(second.changed, true);
  assert.equal(second.policy.provider, '', '不给 provider 时回落全局 provider');
  assert.equal(second.policy.model, 'gpt-6-sol');
  assert.equal(second.policy.reasoningEffort, '', '覆盖是整条替换，旧 effort 不残留');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.conversations['group:100000003'].model, 'gpt-6-sol');
  assert.equal(onDisk.conversations['group:100000003'].reasoningEffort, null);
});

check('只写思考强度：model 为空但覆盖仍然生效', () => {
  const file = newFile();
  const policy = createConversationPolicy({ file, ownerQQ: OWNER_QQ });
  const result = policy.setPolicy(`private:${OWNER_QQ}`, { reasoningEffort: 'low' });
  assert.equal(result.policy.model, '');
  assert.equal(result.policy.reasoningEffort, 'low');
  assert.equal(result.policy.hasOverride, true);
});

check('deletePolicy 删除覆盖并回落到默认', () => {
  const file = newFile();
  const policy = createConversationPolicy({ file, ownerQQ: OWNER_QQ });
  policy.setPolicy('group:100000004', { provider: 'workbuddy', model: 'hy3' });
  const removed = policy.deletePolicy('group:100000004');
  assert.equal(removed.ok, true);
  assert.equal(removed.changed, true);
  assert.equal(removed.policy.hasOverride, false);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.conversations, {});
});

check('reload 会读回磁盘上的外部改动', () => {
  const file = newFile();
  const first = createConversationPolicy({ file, ownerQQ: OWNER_QQ });
  first.setPolicy('group:100000003', { model: 'hy3' });
  const second = createConversationPolicy({ file, ownerQQ: OWNER_QQ });
  assert.equal(second.policyFor('group:100000003').model, 'hy3');
  // 外部（手工/另一个进程）改盘：直接换掉 model。实例不轮询磁盘，必须 reload 才可见。
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.conversations['group:100000003'].model = 'gpt-6-astra';
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(second.policyFor('group:100000003').model, 'hy3', '改盘后未 reload 时仍用内存里的值');
  second.reload();
  assert.equal(second.policyFor('group:100000003').model, 'gpt-6-astra');
});

check('文件损坏 / 版本不对：fail-open 到空状态并记 lastError', () => {
  const file = newFile();
  fs.writeFileSync(file, '{ not json');
  const policy = createConversationPolicy({ file, ownerQQ: OWNER_QQ });
  const snap = policy.snapshot();
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.conversations, {});
  assert.match(snap.lastError, /JSON|Unexpected/i);
  // 损坏之后仍然可写（写盘会覆盖成合法文件）。
  assert.equal(policy.setPolicy('group:1', { model: 'hy3' }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, POLICY_VERSION);

  const wrongVersion = newFile();
  fs.writeFileSync(wrongVersion, JSON.stringify({ version: 99, defaults: {}, conversations: {} }));
  const v2 = createConversationPolicy({ file: wrongVersion, ownerQQ: OWNER_QQ });
  assert.deepEqual(v2.snapshot().conversations, {});
  assert.equal(v2.snapshot().defaults.mode, 'simulation');
});

check('非法 key：setPolicy/deletePolicy 抛错（调用方必须先校验）', () => {
  const file = newFile();
  const policy = createConversationPolicy({ file, ownerQQ: OWNER_QQ });
  assert.throws(() => policy.setPolicy('group-not-a-number', { model: 'hy3' }), /key/i);
  assert.throws(() => policy.deletePolicy('nope'), /key/i);
  assert.equal(fs.existsSync(file), false, '校验失败不得留下文件');
});

check('resolveModelTarget：policy 优先、空值回落 fallback', () => {
  assert.deepEqual(
    resolveModelTarget({ provider: 'workbuddy', model: 'hy3' }, 'deepseek-account'),
    { provider: 'workbuddy', model: 'hy3' },
  );
  assert.deepEqual(
    resolveModelTarget({ provider: '', model: 'hy3' }, 'deepseek-account'),
    { provider: 'deepseek-account', model: 'hy3' },
  );
  assert.deepEqual(resolveModelTarget(null, 'deepseek-account'), { provider: 'deepseek-account', model: '' });
});

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length) {
  console.log(`\n${failures.length} 项失败：`);
  for (const { name, error } of failures) console.log(`  ✗ ${name}\n    ${error?.stack ?? error}`);
  process.exitCode = 1;
} else {
  console.log(`\n全部通过：${passed} 项`);
}
