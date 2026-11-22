// 日志脱敏（console / bridge 共用）：只用于“写日志/落盘/回显”的文本，
// 不要拿它处理要发到 QQ 的正文——QQ 号、路径在聊天里是正常内容。
//
// 覆盖五类：
//   1) token / password / apiKey 等键值，含 URL query 与 x-console-token 头
//   2) Authorization（Bearer/Basic/Token）
//   3) Cookie / Set-Cookie
//   4) QQ 号（带 qq/uin/senderId/群号 等标签时，以及 config 里已知的号码）
//   5) 本机绝对路径（Windows 盘符、UNC、/home /Users /etc 等）
//
// 已知令牌（例如 agentToken、console token）可以按精确字符串传入 knownSecrets，
// 这样即使它以裸串出现也能被打码；长度 < 6 的值不登记，避免误伤普通单词。

const REDACTED = '***';

const QUERY_SECRET_RE = /([?&](?:token|access_token|refresh_token|id_token|api_key|apikey|key|secret|password)=)([^&#\s]+)/gi;
const URL_USERINFO_RE = /(\bhttps?:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi;
const AUTHORIZATION_RE = /(\bauthorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;]+/gi;
const COOKIE_RE = /((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi;
const KEY_VALUE_RE = /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|secret|password|passwd|passphrase|credential|x-console-token|x-agent-token)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const QQ_LABEL_RE = /((?:\b(?:qq|uin|ownerqq|senderid|user_id|group_id)\b["']?\s*[:=号]?\s*["']?)|(?:群号|账号)\s*[:=号]?\s*)([1-9]\d{4,11})/gi;
const WINDOWS_PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|,;)]*/g;
const UNC_PATH_RE = /(?<!\\)\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+/g;
const UNIX_PATH_RE = /(?<![\w.])\/(?:home|Users|etc|var|root|opt|tmp|mnt|srv)\/[^\s"'<>|,;)]*/g;

function asSecretList(knownSecrets) {
  if (!knownSecrets) return [];
  if (typeof knownSecrets === 'string') return knownSecrets.length >= 6 ? [knownSecrets] : [];
  const out = [];
  for (const value of knownSecrets) {
    if (typeof value === 'string' && value.length >= 6) out.push(value);
  }
  return out;
}

/**
 * 把日志文本里的凭据/QQ 号/绝对路径替换成 ***。
 * @param {unknown} text 任意日志参数
 * @param {Iterable<string>|string} [knownSecrets] 已知的精确令牌
 * @returns {string}
 */
export function redactLogText(text, knownSecrets = null) {
  let out = String(text ?? '');
  if (!out) return out;

  for (const secret of asSecretList(knownSecrets)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }

  out = out.replace(URL_USERINFO_RE, `$1${REDACTED}$3`);
  out = out.replace(QUERY_SECRET_RE, `$1${REDACTED}`);
  out = out.replace(AUTHORIZATION_RE, `$1${REDACTED}`);
  out = out.replace(COOKIE_RE, `$1${REDACTED}`);
  out = out.replace(KEY_VALUE_RE, `$1${REDACTED}`);
  out = out.replace(QQ_LABEL_RE, `$1${REDACTED}`);

  out = out.replace(WINDOWS_PATH_RE, REDACTED);
  out = out.replace(UNC_PATH_RE, REDACTED);
  out = out.replace(UNIX_PATH_RE, REDACTED);
  return out;
}

export { REDACTED as LOG_REDACTED };
