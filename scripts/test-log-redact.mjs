// R12 回归：日志脱敏必须覆盖 token / Authorization / Cookie / QQ 号 / 绝对路径，
// 同时不能把普通的 URL、端口、模型名、时间戳打成 ***。
import { redactLogText, LOG_REDACTED } from '../src/log-redact.js';

let pass = 0;
let fail = 0;
function check(name, actual, predicate, detail = '') {
  if (predicate(actual)) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? `：${detail}` : ''}`);
    console.error(`  actual=${JSON.stringify(actual)}`);
  }
}
const absent = (needle) => (s) => !s.includes(needle);
const hasRedacted = (s) => s.includes(LOG_REDACTED);

// 1) URL query token
{
  const src = 'GET /go/bridge?token=abc123456789&x=1';
  const out = redactLogText(src);
  check('query token 被替换', out, (s) => absent('abc123456789')(s) && s.includes('?token=***'), out);
}
// 2) Authorization
{
  const out = redactLogText('Authorization: Bearer sk-abcdef123456');
  check('Authorization 被替换', out, (s) => absent('sk-abcdef123456')(s) && s.includes('***'), out);
}
// 3) Cookie
{
  const out = redactLogText('Cookie: qqb_console_token=abcdef123456; Path=/');
  check('Cookie 被替换', out, (s) => absent('abcdef123456')(s) && s.includes('***'), out);
}
// 4) JSON 键值
{
  const out = redactLogText('{"apiKey":"sk-1234567890","name":"x"}');
  check('JSON apiKey 被替换', out, (s) => absent('sk-1234567890')(s) && s.includes('***'), out);
}
// 5) QQ 号（带标签）
{
  const out = redactLogText('ownerQQ=100000001 senderId: 100000002 群号 100000003');
  check('QQ 号被替换', out, (s) => absent('100000001')(s) && absent('100000002')(s) && absent('100000003')(s) && s.includes('***'), out);
}
// 6) Windows / UNC / Unix 绝对路径
{
  const out = redactLogText('读取 C:\\Users\\example\\AppData\\Local\\qq-bridge\\config.json 失败；备选 \\\\server\\share\\x；再试 /home/example/.dsh/config.json');
  check('绝对路径被替换', out, (s) => !s.includes('C:\\\\Users\\\\example') && !s.includes('/home/example') && !s.includes('\\\\server\\\\share') && s.includes('***'), out);
}
// 7) knownSecrets 精确替换
{
  const out = redactLogText('agentToken 是 abcdef123456，请勿外传', ['abcdef123456']);
  check('knownSecrets 被替换', out, (s) => absent('abcdef123456')(s) && s.includes('***'), out);
}
// 8) 幂等
{
  const once = redactLogText('token=abcdef123456');
  const twice = redactLogText(once);
  check('脱敏幂等', twice, (s) => s === once, `${once} -> ${twice}`);
}
// 9) 非敏感内容不被误伤
{
  const src = 'http://127.0.0.1:3080/ deepseek-flash port 7788 2026-11-23T07:00:00+08:00';
  const out = redactLogText(src);
  check('普通 URL/模型/端口/时间保留', out, (s) => s === src, out);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
