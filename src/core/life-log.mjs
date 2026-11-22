// 日常采样（桌面活动）→ 粗粒度的一天。
//
// 设计原则（对应 2026-10-31 凌晨 QQ 里那句「给我个大概就行」）：
//   · 只记「前台程序 + 时段 + 是否离开」，不存窗口标题、不截图；
//   · 标题只在采样时用于判断「私事」，判断完就丢；
//   · 机器人拿到的是一天的分段，不是原始日志；
//   · 关闭开关后采样器不再写任何新数据。
//
// 这个文件是纯函数，便于单测与在 bridge / console 里复用。

export const LIFE_LOG_VERSION = 1;
export const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

export const LIFE_CATEGORIES = [
  'code', 'study', 'browser', 'game', 'video', 'chat', 'office', 'design', 'other', 'private', 'away',
];

export const LIFE_LABELS = {
  code: '写代码',
  study: '学习',
  browser: '逛网页',
  game: '打游戏',
  video: '看视频',
  chat: '聊天',
  office: '写文档',
  design: '做图',
  other: '忙别的',
  private: '私事（不细说）',
  away: '不在电脑前',
};

const PROCESS_CATEGORY = [
  [/^(code|cursor|devenv|idea64?|pycharm64?|webstorm64?|sublime_text|notepad\+\+|windowsterminal|powershell|pwsh|cmd|node|python|git-bash|mintty|wsl|docker|postman|insomnia)/i, 'code'],
  [/^(obsidian|notion|acrord32|acrobat|foxitreader|sumatrapdf|calibre|anki)/i, 'study'],
  [/^(chrome|msedge|firefox|brave|opera|vivaldi|arc)/i, 'browser'],
  [/^(steam|steamwebhelper|epicgameslauncher|leagueclient|tslgame|genshinimpact|yuanshen|starrail|minecraft|osu!)/i, 'game'],
  [/^(potplayer|vlc|mpc-hc|bilibili|youku|iqiyi|netflix)/i, 'video'],
  [/^(wechat|weixin|qq|tim|telegram|discord|slack|feishu|lark|dingtalk|deepseek harness)/i, 'chat'],
  [/^(winword|excel|powerpnt|wps|et|wpp|onenote)/i, 'office'],
  [/^(photoshop|illustrator|figma|xd|blender|sketchup)/i, 'design'],
  [/^(1password|keepass|bitwarden|lastpass|dashlane)/i, 'private'],
];

// 只按进程名归类：连窗口标题都不读，避免把网页/文档标题带进日志。
export function categoryOfProcess(proc = '') {
  const name = String(proc || '').replace(/\.exe$/i, '').trim();
  for (const [re, cat] of PROCESS_CATEGORY) if (re.test(name)) return cat;
  return 'other';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function localDateKey(at, tzOffsetMinutes = 480) {
  const d = new Date(Number(at) + tzOffsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function hhmm(at, tzOffsetMinutes = 480) {
  const d = new Date(Number(at) + tzOffsetMinutes * 60_000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * 把采样点压成「一天大概」。
 * @param {Array<{at:number,proc?:string,cat?:string,idle?:number}>} samples
 * @param {{now?:number,maxSegments?:number,gapToleranceMs?:number,tzOffsetMinutes?:number}} opts
 */
export function summarizeSamples(samples = [], opts = {}) {
  const now = Number(opts.now) || Date.now();
  const tz = Number.isFinite(opts.tzOffsetMinutes) ? opts.tzOffsetMinutes : 480;
  const gapTolerance = Number(opts.gapToleranceMs) || SAMPLE_INTERVAL_MS * 2.5;
  const list = (Array.isArray(samples) ? samples : [])
    .map((s) => ({
      at: Number(s?.at) || 0,
      cat: LIFE_CATEGORIES.includes(s?.cat) ? s.cat : 'other',
      idle: Number(s?.idle) || 0,
    }))
    .filter((s) => s.at > 0)
    .sort((a, b) => a.at - b.at);

  const byCat = Object.create(null);
  for (const cat of LIFE_CATEGORIES) byCat[cat] = 0;

  const segments = [];
  let cur = null;
  let prevAt = 0;
  for (const s of list) {
    const cat = s.idle >= 300 ? 'away' : s.cat;
    if (cur && cat === cur.cat && s.at - prevAt <= gapTolerance) {
      cur.end = s.at;
      cur.samples += 1;
    } else {
      if (cur) segments.push(cur);
      cur = { cat, start: s.at, end: s.at, samples: 1 };
    }
    prevAt = s.at;
  }
  if (cur) segments.push(cur);

  const total = segments.reduce((n, seg) => n + seg.samples, 0);
  for (const seg of segments) {
    byCat[seg.cat] += seg.samples;
    seg.minutes = seg.samples * Math.round(SAMPLE_INTERVAL_MS / 60_000);
    seg.startText = hhmm(seg.start, tz);
    seg.endText = seg.cat === 'away' ? seg.startText : hhmm(seg.end + SAMPLE_INTERVAL_MS, tz);
    seg.label = LIFE_LABELS[seg.cat] || seg.cat;
  }

  const lastAt = list.length ? list[list.length - 1].at : 0;
  const activeSegments = segments.filter((s) => s.cat !== 'other' || s.samples >= 3);

  return {
    version: LIFE_LOG_VERSION,
    date: localDateKey(now, tz),
    generatedAt: now,
    sampleCount: total,
    minutes: total * Math.round(SAMPLE_INTERVAL_MS / 60_000),
    firstAt: list.length ? list[0].at : 0,
    lastAt,
    byCat,
    segments: activeSegments,
    allSegments: segments,
    lastActiveText: lastAt ? hhmm(lastAt, tz) : '',
  };
}

/**
 * 生成给机器人看的一句话（≤ maxChars）。
 * 宁可少说，也不要把私事的细节说出来。
 */
export function formatLifeHint(summary, { maxChars = 300 } = {}) {
  if (!summary || !summary.segments?.length) return '';
  // 只有「忙别的/私事」时不如不说：机器人不需要知道你在电脑前发呆。
  if (!summary.segments.some((s) => !['away', 'other', 'private'].includes(s.cat))) return '';
  // 私事连「几点」都不给机器人，避免从时间反推。
  const segs = summary.segments.filter((s) => s.cat !== 'away' && s.cat !== 'other' && s.cat !== 'private');
  const parts = [];
  for (const s of segs) {
    const span = s.startText === s.endText ? s.startText : `${s.startText}–${s.endText}`;
    parts.push(`${span} ${s.label}`);
  }
  const away = summary.byCat?.away ? Math.round(summary.byCat.away * 5) : 0;
  const tail = summary.lastAt
    ? `；最近一次采样 ${summary.lastActiveText}${away >= 60 ? `，今天约 ${Math.round(away / 60)} 小时不在电脑前` : ''}。`
    : '';
  let text = `【他今天大概】${parts.join('；') || '还没采到多少活动'}${tail}`;
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}
