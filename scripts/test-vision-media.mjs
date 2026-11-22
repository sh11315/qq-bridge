// 视觉/图片链路自检脚本：
// 1. 校验配置默认模型为 DeepSeek-V4-Flash-Vision-Exp
// 2. 校验 safe-fetch 的 SSRF 防护（本机地址应被拒绝）
// 3. 若桥接运行中，校验 /api/images/message 端点可用（用二代 agent token）
// 运行：node scripts/test-vision-media.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const config = readJson(path.join(ROOT, 'config.json'));
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. 配置
// 多模态模型清单：DSH provider 里声明 inputModalities 含 image 的模型。
//   · deepseek-flash（DeepSeek 官方进阶档，2026-10-26 用真实会话日志确认能描述图片内容）
//   · deepseek-v4.1-flash（WorkBuddy LAN 网关别名，2026-10-26 直接打 /v1/chat/completions
//     传红/蓝 PNG，分别回答「红色/蓝色」；chat 群聊基础档用的就是它）
//   · deepseek-v4-flash-vision-exp 为更早的历史默认名，保留兼容。
const MULTIMODAL_MODELS = ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash-vision-exp'];
check('config.dsh.model 为多模态模型', MULTIMODAL_MODELS.includes(config.dsh?.model), `当前 ${config.dsh?.model}`);
// chat 两个档位都要多模态：群聊 basic 用 dsh.model，私聊 advanced 用 dsh.advanced.model。
check('config.dsh.advanced.model 为多模态模型',
  !config.dsh?.advanced?.model || MULTIMODAL_MODELS.includes(config.dsh.advanced.model),
  `当前 ${config.dsh?.advanced?.model || '未配置'}`);
// 思考强度只要求是 DSH 支持的合法值（旧断言写死 max，配置改成 auto 后会误报）。
const REASONING_EFFORTS = ['auto', 'low', 'high', 'max'];
check('config.dsh.reasoningEffort 合法', REASONING_EFFORTS.includes(config.dsh?.reasoningEffort), `当前 ${config.dsh?.reasoningEffort}`);
check('config.socialV2.tools.getImages 默认开启', config.socialV2?.tools?.getImages !== false);

// 2. safe-fetch SSRF
try {
  await safeFetchBuffer('http://127.0.0.1/');
  check('safe-fetch 拒绝本机地址', false, '未抛出异常');
} catch (error) {
  check('safe-fetch 拒绝本机地址', /内网|本机|禁止/.test(String(error?.message ?? error)), error?.message);
}

// 3. 桥接端点（可选）
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const socialV2File = path.join(ROOT, 'state', 'social-v2.json');
if (fs.existsSync(consoleTokenFile) && fs.existsSync(socialV2File)) {
  try {
    const consoleToken = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    const social = JSON.parse(fs.readFileSync(socialV2File, 'utf8'));
    const conv = social?.conversations ? Object.entries(social.conversations)[0] : null;
    if (conv) {
      const [key, st] = conv;
      const agentToken = st?.agentToken;
      const messageId = st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;
      if (agentToken && messageId) {
        const url = `http://127.0.0.1:${config.consolePort || 3100}/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`;
        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        check('桥接 /api/images/message 端点可访问', res.ok === true && body.ok === true, `HTTP ${res.status}`);
      } else {
        console.log('⚠️ 跳过桥接端点检查：没有可用 agentToken/messageId');
      }
    }
  } catch (error) {
    console.log(`⚠️ 桥接端点检查跳过：${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过桥接端点检查：缺少 state/console-token 或 state/social-v2.json');
}

// 4. DSH 侧模型能力声明（2026-10-26 实测踩过的坑）
//
// 只改桥接不够：DSH 只把图交给「声明了 image 输入」的模型，否则 tool/result 会被替换成
//   [image unavailable: image/png; model "..." does not declare image input; ...]
// 声明位置是 web profile 的 llm-pi-ai.providers.workbuddy.models[].input。
// 这里做一次静态检查；profile 不存在或模型不在 profile 里（走官方 provider）时跳过。
const modelName = String(config.dsh?.model || '');
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileFile = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
if (fs.existsSync(profileFile)) {
  const lines = fs.readFileSync(profileFile, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${escapeRe(modelName)}\\s*$`).test(l));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*-\s*id:/.test(lines[i])) { end = i; break; }
    }
    const block = lines.slice(start, end).join('\n');
    const m = /^\s*input:\s*\[([^\]]*)\]/m.exec(block);
    const inputs = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    check('DSH profile 给 chat 基础模型声明了 image 输入', inputs.includes('image'), `${modelName} input=[${inputs.join(', ')}]`);
  } else {
    console.log(`⚠️ 跳过 DSH 模型能力检查：web profile 里没有 ${modelName}（可能走官方 provider）`);
  }
} else {
  console.log('⚠️ 跳过 DSH 模型能力检查：没有 profiles/web/cordis.patch.yml');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
