import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (err) { fail += 1; console.log(`FAIL ${name}\n     ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
const bridge = fs.readFileSync(path.join(repo, 'src', 'bridge.js'), 'utf8');
const mcp = fs.readFileSync(path.join(repo, 'src', 'mcp-snowluma-safe.js'), 'utf8');

check('config 给普通模式的等待也设了 60 秒上限', () => {
  const v = Number(cfg.socialV2?.wait?.reserved2MaxMs);
  assert(Number.isFinite(v) && v > 0 && v <= 120000, `reserved2MaxMs=${v}`);
});

check('bridge 在 wait 路由里对 maxMs 做统一截断', () => {
  assert(bridge.includes('const reserved2MaxMs'), 'missing reserved2MaxMs');
  assert(bridge.includes('maxMs = Math.min(maxMs, reserved2MaxMs)'), 'missing clamp');
});

check('MCP 工具描述写明单次最多 60 秒', () => {
  assert(mcp.includes('单次最多 60 秒'), 'description not updated');
});

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
