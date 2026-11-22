// 视频理解（video-digest）的纯函数层。
//
// 目标：把一段视频归一成「时长 + 均匀抽帧点 + 音轨有无」的可缓存摘要，交给视觉会话看图。
// 这里只做计算，不碰文件系统、不 spawn 进程 —— 真正的 ffprobe/ffmpeg 调用在
// scripts/video-digest.mjs（CLI），桥接由 src/bridge.js 复用同一套函数，测试可完全离线跑。
//
// 设计取舍：
// · 抽帧点按时长均匀分布：首帧避开 0（很多视频首帧是黑场/封面），
//   末帧留 0.5s（避开结尾黑场，以及容器尾部截断导致 seek 抽不到帧）。
// · 最多 8 帧、宽 720：够看懂剧情，又不至于让一帧 4K 大图把视觉上下文撑爆。
// · digestHash 只读「文件名 + 大小 + mtime」，不读文件内容：11MB 视频每次全读太贵，
//   而同一落地文件重复调用时这三个量稳定；改内容/改时间自然 miss（换目录仍命中）。
import crypto from 'node:crypto';
import path from 'node:path';

/** 抽帧与音轨的默认值（CLI 与桥接共用，改这里就够）。 */
export const VIDEO_DIGEST_DEFAULTS = Object.freeze({
  maxFrames: 8,
  frameWidth: 720,
  firstFrameSec: 0.1,
  endMarginSec: 0.5,
  minMultiFrameSec: 2,
  audioSampleRate: 16000,
  audioChannels: 1,
  frameJpegQuality: 3,
  hashLength: 16,
});

/** CLI 与桥接共享的文件名约定。 */
export const DIGEST_FILE_NAME = 'digest.json';
export const AUDIO_FILE_NAME = 'audio.wav';

const HEX_RE = /^[0-9a-f]+$/;

/** 只接受有限正数；其余（含 'N/A'、undefined、负数）一律 null。 */
function positiveNumber(value) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** 秒数统一保留 3 位小数，避免 0.30000000000000004 这类值进入 JSON/命令行。 */
function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

/** 整数夹取；非法值走 fallback。 */
function clampInt(value, min, max, fallback) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** 封面图（attached_pic）不是视频流，不能拿来当 width/height。 */
function isAttachedPic(stream) {
  const flag = stream?.disposition?.attached_pic;
  return flag === 1 || flag === '1' || flag === true;
}

/** frame-01.jpg / frame-08.jpg；index 从 1 开始。 */
export function frameFileName(index) {
  const num = Math.floor(Number(index));
  if (!Number.isFinite(num) || num < 1) throw new TypeError(`frameFileName 需要 >=1 的序号：${index}`);
  return `frame-${String(num).padStart(2, '0')}.jpg`;
}

/**
 * 解析 ffprobe 的 JSON 输出（`-of json`），归一成摘要需要的字段。
 * 容忍字符串数字、缺字段、封面图流；拿不到时长时 durationSec 为 0。
 *
 * @param {object|string} ffprobeJson ffprobe JSON 对象（或它的字符串形式）
 * @returns {{durationSec:number,width:number,height:number,hasAudio:boolean,hasVideo:boolean,
 *   videoCodec:string,audioCodec:string,audioSampleRate:number,audioChannels:number}}
 */
export function probeSummary(ffprobeJson) {
  let json = ffprobeJson;
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch {
      throw new TypeError('probeSummary 需要 ffprobe 的 JSON 对象（给的字符串不是合法 JSON）');
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('probeSummary 需要 ffprobe 的 JSON 对象');
  }

  const streams = Array.isArray(json.streams) ? json.streams.filter((s) => s && typeof s === 'object') : [];
  const video = streams.find((s) => s.codec_type === 'video' && !isAttachedPic(s)) ?? null;
  const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
  const format = json.format && typeof json.format === 'object' ? json.format : {};

  // 时长优先级：视频流 > 容器 > 音频流（纯音频容器没有视频流）。
  const durationSec = roundSec(
    positiveNumber(video?.duration) ?? positiveNumber(format.duration) ?? positiveNumber(audio?.duration) ?? 0,
  );

  return {
    durationSec,
    width: Math.round(positiveNumber(video?.width) ?? 0),
    height: Math.round(positiveNumber(video?.height) ?? 0),
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : '',
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : '',
    audioSampleRate: Math.round(positiveNumber(audio?.sample_rate) ?? 0),
    audioChannels: Math.round(positiveNumber(audio?.channels) ?? 0),
  };
}

/**
 * 规划均匀抽帧时间点（秒）。
 * 规则：短于 2s 或只要 1 帧时只取 1 帧（取中点）；否则从 0.1s 到 duration-0.5s
 * 均匀取 maxFrames 帧（封顶 8）；时长未知/非法返回空数组。
 *
 * @param {{durationSec:number,maxFrames?:number}} input
 * @returns {number[]} 递增的时间点
 */
export function planFrames({ durationSec, maxFrames = VIDEO_DIGEST_DEFAULTS.maxFrames } = {}) {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  // 连 1ms 都不到的片段没法 seek，直接不给帧。
  if (duration < 0.002) return [];

  const limit = clampInt(maxFrames, 1, VIDEO_DIGEST_DEFAULTS.maxFrames, VIDEO_DIGEST_DEFAULTS.maxFrames);
  const { firstFrameSec: start, endMarginSec: margin, minMultiFrameSec } = VIDEO_DIGEST_DEFAULTS;
  const end = duration - margin;

  // 单帧：短片段取中点；长片段但 limit=1 时取 [start,end] 的中点（同样是「均匀」）。
  if (limit === 1 || duration < minMultiFrameSec || end <= start) {
    const mid = duration < minMultiFrameSec ? duration / 2 : (start + end) / 2;
    return [roundSec(Math.min(Math.max(mid, 0.001), duration - 0.001))];
  }

  const step = (end - start) / (limit - 1);
  const times = [];
  for (let i = 0; i < limit; i += 1) times.push(roundSec(start + step * i));
  times[0] = roundSec(start);
  times[limit - 1] = roundSec(end);
  // 防御：四舍五入后若撞点（极短片段 + 很多帧），去重保序。
  return times.filter((at, index) => index === 0 || at > times[index - 1]);
}

/**
 * 生成逐帧抽取的 ffmpeg 调用参数。每个时间点一次 ffmpeg（-ss 前置快进 + -frames:v 1），
 * 输出 frame-01.jpg…；-ss 放在 -i 前是快进 seek，比解码整段快一个量级。
 *
 * @param {{input:string,times:number[],outDir:string,width?:number}} input
 * @returns {Array<{at:number,path:string,args:string[]}>}
 */
export function buildFfmpegFrameArgs({ input, times, outDir, width = VIDEO_DIGEST_DEFAULTS.frameWidth } = {}) {
  const inputPath = typeof input === 'string' ? input.trim() : '';
  if (!inputPath) throw new TypeError('buildFfmpegFrameArgs 需要 input 路径');
  const dir = typeof outDir === 'string' ? outDir.trim() : '';
  if (!dir) throw new TypeError('buildFfmpegFrameArgs 需要 outDir');
  const scaleWidth = clampInt(width, 16, 4096, VIDEO_DIGEST_DEFAULTS.frameWidth);
  const list = Array.isArray(times) ? times : [];

  return list.map((time, index) => {
    const at = roundSec(Number(time));
    if (!Number.isFinite(at) || at < 0) {
      throw new TypeError(`buildFfmpegFrameArgs 第 ${index + 1} 帧时间点非法：${time}`);
    }
    const outPath = path.join(dir, frameFileName(index + 1));
    return {
      at,
      path: outPath,
      args: [
        '-v', 'error',
        '-y',
        '-ss', String(at),
        '-i', inputPath,
        '-frames:v', '1',
        '-vf', `scale=${scaleWidth}:-2:flags=lanczos`,
        '-q:v', String(VIDEO_DIGEST_DEFAULTS.frameJpegQuality),
        outPath,
      ],
    };
  });
}

/**
 * 生成抽音轨的 ffmpeg 参数：16kHz 单声道 pcm_s16le wav（后续转写/语音理解都吃这个格式）。
 *
 * @param {{input:string,outWav:string,sampleRate?:number,channels?:number}} input
 * @returns {string[]}
 */
export function buildAudioArgs({
  input,
  outWav,
  sampleRate = VIDEO_DIGEST_DEFAULTS.audioSampleRate,
  channels = VIDEO_DIGEST_DEFAULTS.audioChannels,
} = {}) {
  const inputPath = typeof input === 'string' ? input.trim() : '';
  if (!inputPath) throw new TypeError('buildAudioArgs 需要 input 路径');
  const wavPath = typeof outWav === 'string' ? outWav.trim() : '';
  if (!wavPath) throw new TypeError('buildAudioArgs 需要 outWav 路径');
  const rate = clampInt(sampleRate, 8000, 48000, VIDEO_DIGEST_DEFAULTS.audioSampleRate);
  const ac = clampInt(channels, 1, 2, VIDEO_DIGEST_DEFAULTS.audioChannels);
  return [
    '-v', 'error',
    '-y',
    '-i', inputPath,
    '-vn',
    '-ac', String(ac),
    '-ar', String(rate),
    '-c:a', 'pcm_s16le',
    wavPath,
  ];
}

/**
 * 视频摘要的缓存键：文件名（Windows 下忽略大小写）+ 大小 + mtime，sha256 取前 16 位十六进制。
 * 同一落地文件重复调用稳定；换目录仍命中；改内容 / 重下载（mtime 变）则 miss。
 *
 * @param {string} filePath
 * @param {number} size 字节数
 * @param {number} mtimeMs 毫秒时间戳
 * @returns {string} 16 位小写十六进制
 */
export function digestHash(filePath, size, mtimeMs) {
  const rawName = typeof filePath === 'string' ? path.basename(filePath.trim()) : '';
  const name = process.platform === 'win32' ? rawName.toLowerCase() : rawName;
  const sizeNum = Number.isFinite(Number(size)) ? Math.max(0, Math.floor(Number(size))) : 0;
  const mtimeNum = Number.isFinite(Number(mtimeMs)) ? Math.max(0, Math.round(Number(mtimeMs))) : 0;
  const key = `${name}\u0000${sizeNum}\u0000${mtimeNum}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, VIDEO_DIGEST_DEFAULTS.hashLength);
}

/**
 * 组装最终摘要（digest.json 的内容）：{durationSec,width,height,frames:[{at,path}],audio:{present,text,source},hash}。
 * audio.source：transcript=有转写文本，probe=只探到音轨没转写，none=无音轨。
 *
 * @param {{meta?:object,frames?:Array<{at:number,path:string}>,audioText?:string,hash?:string}} input
 */
export function buildDigest({ meta, frames, audioText, hash } = {}) {
  const summary = meta && typeof meta === 'object' ? meta : {};
  const frameList = (Array.isArray(frames) ? frames : [])
    .filter((item) => item && typeof item.path === 'string' && item.path.length > 0)
    .map((item) => ({ at: roundSec(Number(item.at) || 0), path: item.path }));
  const hasAudio = Boolean(summary.hasAudio);
  const text = audioText == null ? '' : String(audioText).trim();
  const source = text ? 'transcript' : hasAudio ? 'probe' : 'none';
  const digestHashValue = typeof hash === 'string' ? hash : typeof summary.hash === 'string' ? summary.hash : '';

  return {
    durationSec: roundSec(Number(summary.durationSec) || 0),
    width: Math.round(Number(summary.width) || 0),
    height: Math.round(Number(summary.height) || 0),
    frames: frameList,
    audio: { present: hasAudio, text, source },
    hash: digestHashValue,
  };
}

/** 一行中文摘要，给日志/提示词用：`视频 60.2s（1500×838），抽 8 帧，含音轨（未转写）`。 */
export function formatDigestSummary(digest) {
  const data = digest && typeof digest === 'object' ? digest : {};
  const duration = Number(data.durationSec) || 0;
  const size = data.width && data.height ? `${data.width}×${data.height}` : '尺寸未知';
  const frames = Array.isArray(data.frames) ? data.frames.length : 0;
  const audio = data.audio?.present ? (data.audio.text ? '含音轨（有转写）' : '含音轨（未转写）') : '无音轨';
  return `视频 ${duration.toFixed(1)}s（${size}），抽 ${frames} 帧，${audio}`;
}

/** 供调用方校验 hash 是否可信（16 位小写十六进制）。 */
export function isDigestHash(value) {
  return typeof value === 'string' && HEX_RE.test(value) && value.length === VIDEO_DIGEST_DEFAULTS.hashLength;
}
