#!/usr/bin/env node
/**
 * qq-admin 的纯函数测试（不联网、不改真实配置）。
 * 覆盖：配置写入白名单、path=value 解析、深路径读写、白名单增删的请求体映射。
 */
import {
  CONFIG_ROOTS,
  isAllowedConfigPath,
  parseConfigSetArgs,
  deepSet,
  deepGet,
  whitelistPostBody,
} from './qq-admin.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  OK   ${name}`); return; }
  fail += 1;
  console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
}

console.log('## 配置写入白名单');
check('允许 dsh.model', isAllowedConfigPath('dsh.model') === true);
check('允许 unifiedConsole.autoHeal', isAllowedConfigPath('unifiedConsole.autoHeal') === true);
check('允许 socialV2.proactive.privateEnabled', isAllowedConfigPath('socialV2.proactive.privateEnabled') === true);
check('允许 allow.groups', isAllowedConfigPath('allow.groups') === true);
check('允许 deny.groups（准入成对）', isAllowedConfigPath('deny.groups') === true);
check('允许 allowAllWhenEmpty', isAllowedConfigPath('allowAllWhenEmpty') === true);
check('允许 mentionOnly.aliases', isAllowedConfigPath('mentionOnly.aliases') === true);
check('允许 slang.enabled', isAllowedConfigPath('slang.enabled') === true);
check('允许 social.maxReplyChars', isAllowedConfigPath('social.maxReplyChars') === true);
check('拒绝 pricing.models', isAllowedConfigPath('pricing.models') === false);
check('拒绝 ownerQQ', isAllowedConfigPath('ownerQQ') === false);
check('拒绝 adminTurnTools（权限本身）', isAllowedConfigPath('adminTurnTools.enabled') === false);
check('拒绝 consoleToken', isAllowedConfigPath('consoleToken') === false);
check('拒绝 imageGen（树里有 apiKey）', isAllowedConfigPath('imageGen.model') === false);
check('拒绝 webSearch（树里有 apiKey）', isAllowedConfigPath('webSearch.provider') === false);
check('拒绝空路径', isAllowedConfigPath('') === false);
check('拒绝凭据字段（任何层级）', isAllowedConfigPath('dsh.authToken') === false && isAllowedConfigPath('socialV2.apiKey') === false);
check('拒绝通配/括号注入', isAllowedConfigPath('dsh.{x}') === false);
check('根清单稳定', CONFIG_ROOTS.includes('socialV2') && CONFIG_ROOTS.includes('unifiedConsole'));

console.log('## path=value 解析');
{
  const pairs = parseConfigSetArgs(['socialV2.proactive.enabled=false', 'dsh.reasoningEffort="high"', 'socialV2.video.maxFrames=6']);
  check('解析出 3 项', pairs.length === 3);
  check('bool 按 JSON 解析', pairs[0][1] === false);
  check('字符串去掉引号', pairs[1][1] === 'high');
  check('数字按 JSON 解析', pairs[2][1] === 6);
  let threw = false;
  try { parseConfigSetArgs(['pricing.models=1']); } catch { threw = true; }
  check('非法路径抛错', threw === true);
  threw = false;
  try { parseConfigSetArgs(['socialV2.proactive.enabled']); } catch { threw = true; }
  check('缺 = 抛错', threw === true);
}

console.log('## 深路径读写');
{
  const obj = {};
  deepSet(obj, 'a.b.c', 1);
  deepSet(obj, 'a.b.d', 'x');
  check('嵌套对象自动创建', obj?.a?.b?.c === 1 && obj?.a?.b?.d === 'x');
  check('deepGet 命中', deepGet(obj, 'a.b.d') === 'x');
  check('deepGet 未命中返回 undefined', deepGet(obj, 'a.z') === undefined);
  deepSet(obj, 'a.b.c', 2);
  check('同路径覆盖', deepGet(obj, 'a.b.c') === 2);
}

console.log('## 白名单请求体映射（GET 嵌套 → POST 扁平）');
{
  const wl = {
    ownerQQ: 100000001,
    allow: { private: ['100000001'], groups: ['100000003'] },
    deny: { private: [], groups: ['123456'] },
    allowAllWhenEmpty: false,
  };
  const add = whitelistPostBody(wl, { action: 'add', kind: 'group', ids: ['100000004'] });
  check('加入群后含两个群', add.allowGroups.join(',') === '100000003,100000004');
  check('ownerQQ 保留且为字符串', add.ownerQQ === '100000001');
  check('denyGroups 保留', add.denyGroups.join(',') === '123456');
  const rm = whitelistPostBody(wl, { action: 'rm', kind: 'group', ids: ['100000003'] });
  check('移出群后为空', rm.allowGroups.length === 0);
  const addPrivate = whitelistPostBody(wl, { action: 'add', kind: 'private', ids: ['10001'] });
  check('加入私聊不影响群', addPrivate.allowGroups.join(',') === '100000003' && addPrivate.allowPrivate.join(',') === '100000001,10001');
  let threw = false;
  try { whitelistPostBody(wl, { action: 'add', kind: 'group', ids: ['abc'] }); } catch { threw = true; }
  check('非法群号抛错', threw === true);
}

console.log(`\nqq-admin 单测：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
