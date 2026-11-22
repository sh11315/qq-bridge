import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const bridge = fs.readFileSync(path.join(repo, 'src', 'bridge.js'), 'utf8');
const server = fs.readFileSync(path.join(repo, 'console', 'server.mjs'), 'utf8');

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('PASS', name);
  } catch (error) {
    console.log('FAIL', name, '—', error.message);
    process.exitCode = 1;
  }
}

check('bridge 不再把原始回合错误发到 QQ（含群聊）', () => {
  assert.equal(/sendToQQ\([^\n]*处理出错/.test(bridge), false, 'still sends 处理出错 to QQ');
  assert.equal(bridge.includes('群聊不发送错误提示'), true);
});

check('bridge 私聊故障提示是中性文案且有两分钟抑制', () => {
  assert.equal(bridge.includes("刚才卡了一下，没接住，等会儿再说"), true);
  assert.equal(bridge.includes('lastUpstreamNotice'), true);
});

check('console 路由链把 5xx / DeepSeek 502 / APITimeout 当失败', () => {
  const line = server.split('\n').find((row) => row.includes('const CHAIN_FAIL_RE'));
  assert.ok(line, 'CHAIN_FAIL_RE not found');
  for (const token of ['500', '502', '503', '504', 'DeepSeek Messages request failed', 'APITimeoutError']) {
    assert.ok(line.includes(token), `missing ${token}`);
  }
});

check('投递/安全拦截/限流/连接失败一律不发 QQ（只写日志）', () => {
  for (const bad of [
    'sendToQQ(key, `⚠️ 消息未被接受',
    "sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息",
    "sendToQQ(key, '⚠️ 服务正忙",
    "sendToQQ(key, '⚠️ 模型连接失败",
  ]) {
    assert.equal(bridge.includes(bad), false, `still sends: ${bad}`);
  }
  assert.ok(bridge.includes('[投递失败]'), 'missing 投递失败 log');
  assert.ok(bridge.includes('[安全拦截]'), 'missing 安全拦截 log');
});

check('回答/审批回执失败只在私聊提示，群聊只记日志', () => {
  assert.ok(bridge.includes("if (String(key).startsWith('private:')) await sendToQQ(key, '⚠️ 回答提交失败"));
  assert.ok(bridge.includes("if (String(key).startsWith('private:')) await sendToQQ(key, '⚠️ 审批回执提交失败"));
});

check('看图/表情通道不再被「休眠前 5 分钟观察」卡住', () => {
  assert.equal(bridge.includes('不在这里设置潜水/唤醒'), true);
  assert.equal(bridge.includes('不要在这里设置潜水或下一次唤醒'), true);
});

console.log(`\n结果：${pass} 项通过${process.exitCode ? '，有失败' : '，0 项失败'}`);
