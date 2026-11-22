#!/usr/bin/env node
// video-digest CLI：把本地视频变成可缓存的摘要（JSON + 均匀抽帧图）。
//
// 用法：
//   node scripts/video-digest.mjs --input <视频文件> [选项]
//
// 选项：
//   --input, -i <path>   要解析的视频文件（必填；也可直接给第一个位置参数）
//   --out-dir, -o <dir>  输出目录（默认 <仓库>/state/media-video）
//   --max-frames <n>     抽帧数量 1-8（默认 8）
//   --json               只输出单行紧凑 JSON，stderr 不打人类摘要
//   --keep               把音轨抽成 audio.wav（16kHz 单声道）留在 out-dir
//   --help, -h           显示帮助
//
// 输出：stdout 一个 JSON（digest 字段 + outDir / cached / audioPath / elapsedMs）；
// 诊断信息走 stderr。退出码：0 成功，1 参数/文件/ffprobe/ffmpeg 失败（stderr 给可读原因）。
//
// 缓存：out-dir/digest.json 里的 hash 与当前文件一致、且帧文件都还在 → 直接复用，
// 不跑 ffprobe/ffmpeg。hash 只由「文件名 + 大小 + mtime」决定（见 src/core/video-digest.mjs）。
//
// 说明：ffmpeg/ffprobe 默认用仓库自带的 tools/ffmpeg/*.exe，可用环境变量
// FFMPEG_PATH / FFPROBE_PATH 覆盖，最后才回落到 PATH。子进程一律 stdio: 'ignore'
// （与 bridge 侧的教训一致：受限沙箱里 pipe 会 EPERM），结果全部走文件。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_FILE_NAME,
  DIGEST_FILE_NAME,
  VIDEO_DIGEST_DEFAULTS,
  buildAudioArgs,
  buildDigest,
  buildFfmpegFrameArgs,
  digestHash,
  formatDigestSummary,
  planFrames,
  probeSummary,
} from '../src/core/video-digest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'state', 'media-video');
const FFPROBE_TIMEOUT_MS = 20000;
const FFMPEG_TIMEOUT_MS = 30000;
const FRAME_PATTERN = /^frame-\d{2}\.jpg$/;
const PROBE_ENTRIES = [
  'format=duration,format_name',
  'stream=codec_type,codec_name,width,height,duration,sample_rate,channels',
  'stream_disposition=attached_pic',
].join(':');

const USAGE = `用法：node scripts/video-digest.mjs --input <视频文件> [选项]

选项：
  --input, -i <path>   要解析的视频文件（必填；也可直接给第一个位置参数）
  --out-dir, -o <dir>  输出目录（默认 <仓库>/state/media-video）
  --max-frames <n>     抽帧数量 1-8（默认 ${VIDEO_DIGEST_DEFAULTS.maxFrames}）
  --json               只输出单行紧凑 JSON，stderr 不打人类摘要
  --keep               保留抽出的音轨 audio.wav（16kHz 单声道）
  --help, -h           显示本帮助

示例：
  node scripts/video-digest.mjs --input state/media/inbound/xx.mp4 --max-frames 3 --keep
`;

/** 解析命令行；未知参数/缺值一律抛错（由 main 统一转成退出码 1）。 */
function parseArgs(argv) {
  const options = { input: '', outDir: '', maxFrames: null, json: false, keep: false, help: false };
  const takeValue = (flag, value) => {
    if (value == null || value === '' || value.startsWith('--')) throw new Error(`参数 ${flag} 缺少值`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      options.input = takeValue(arg, argv[++i]);
    } else if (arg === '--out-dir' || arg === '-o') {
      options.outDir = takeValue(arg, argv[++i]);
    } else if (arg === '--max-frames') {
      const raw = takeValue(arg, argv[++i]);
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 1) throw new Error(`--max-frames 需要 1-${VIDEO_DIGEST_DEFAULTS.maxFrames} 的整数：${raw}`);
      options.maxFrames = Math.min(VIDEO_DIGEST_DEFAULTS.maxFrames, Math.floor(num));
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}（用 --help 看用法）`);
    } else if (options.input) {
      throw new Error(`多余的位置参数：${arg}`);
    } else {
      options.input = arg;
    }
  }
  return options;
}

/** 跑一个子进程，只关心退出码；stdout/stderr 全部丢弃（stdio ignore），避免 pipe 在沙箱里 EPERM。 */
function runProcess(bin, args, { timeoutMs = FFMPEG_TIMEOUT_MS, label = bin } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, code: -1, error: `无法启动 ${label}：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程可能已消失 */ }
      finish({ ok: false, code: -1, error: `${label} 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish({ ok: false, code: -1, error: `${label} 启动失败：${error?.message ?? error}` }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, code: 0 } : { ok: false, code, error: `${label} 退出码 ${code}` }));
  });
}

/** ffmpeg/ffprobe 定位：环境变量 → 仓库自带 tools/ffmpeg → PATH。 */
function resolveTool(name, envKey) {
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;
  const bundled = path.join(REPO_ROOT, 'tools', 'ffmpeg', `${name}.exe`);
  if (fs.existsSync(bundled)) return bundled;
  const bundledPlain = path.join(REPO_ROOT, 'tools', 'ffmpeg', name);
  if (fs.existsSync(bundledPlain)) return bundledPlain;
  return name;
}

/** 同 hash 且帧文件齐全才算缓存命中。 */
function readCachedDigest(digestPath, hash) {
  try {
    const parsed = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.hash !== hash) return null;
    if (!Array.isArray(parsed.frames) || parsed.frames.length === 0) return null;
    const framesOk = parsed.frames.every(
      (frame) => frame && typeof frame.path === 'string' && frame.path && fs.existsSync(frame.path),
    );
    return framesOk ? parsed : null;
  } catch {
    return null;
  }
}

/** 重新抽帧前清掉上次留下的 frame-NN.jpg，避免旧帧混进这次摘要。 */
function cleanStaleFrames(outDir) {
  let entries = [];
  try { entries = fs.readdirSync(outDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !FRAME_PATTERN.test(entry.name)) continue;
    try { fs.rmSync(path.join(outDir, entry.name), { force: true }); } catch { /* 删不掉就留着，不影响本次写帧 */ }
  }
}

/** 先写临时文件再 rename，避免半个 JSON 被下一次缓存读取。 */
function writeDigestFile(filePath, digest) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(digest, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/** ffprobe → JSON 文件 → probeSummary。ffprobe 的 -o 支持写文件，不用 pipe。 */
async function probeVideo(ffprobe, inputPath, outDir) {
  const probeFile = path.join(outDir, `.probe-${process.pid}-${Date.now()}.json`);
  try {
    const run = await runProcess(
      ffprobe,
      ['-v', 'error', '-show_entries', PROBE_ENTRIES, '-of', 'json', '-o', probeFile, inputPath],
      { timeoutMs: FFPROBE_TIMEOUT_MS, label: 'ffprobe' },
    );
    if (!run.ok) throw new Error(`ffprobe 解析失败（${run.error}）：文件可能不是可识别的视频容器`);
    let raw = '';
    try {
      raw = fs.readFileSync(probeFile, 'utf8');
    } catch (error) {
      throw new Error(`读不到 ffprobe 输出：${error?.message ?? error}`);
    }
    if (!raw.trim()) throw new Error('ffprobe 没有输出元信息（文件可能损坏或是空容器）');
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error('ffprobe 输出不是合法 JSON');
    }
    return probeSummary(json);
  } finally {
    try { fs.rmSync(probeFile, { force: true }); } catch { /* 清理失败不致命 */ }
  }
}

/** 逐帧抽图；任何一帧失败都抛错（带上第几帧/时间点，方便定位下载坏的视频）。 */
async function extractFrames(ffmpeg, { inputPath, times, outDir }) {
  const jobs = buildFfmpegFrameArgs({ input: inputPath, times, outDir });
  const frames = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const run = await runProcess(ffmpeg, job.args, { timeoutMs: FFMPEG_TIMEOUT_MS, label: 'ffmpeg' });
    if (!run.ok) throw new Error(`抽帧失败：第 ${index + 1}/${jobs.length} 帧 @${job.at}s（${run.error}）`);
    let bytes = 0;
    try { bytes = fs.statSync(job.path).size; } catch { /* 下面按 0 字节处理 */ }
    if (bytes <= 0) throw new Error(`抽帧失败：第 ${index + 1}/${jobs.length} 帧 @${job.at}s 没有产出文件（${job.path}）`);
    frames.push({ at: job.at, path: job.path });
  }
  return frames;
}

/** 抽 16k 单声道 wav（--keep 或缓存命中但 wav 丢了时补抽）。 */
async function extractAudio(ffmpeg, { inputPath, outDir }) {
  const outWav = path.join(outDir, AUDIO_FILE_NAME);
  const run = await runProcess(ffmpeg, buildAudioArgs({ input: inputPath, outWav }), {
    timeoutMs: FFMPEG_TIMEOUT_MS,
    label: 'ffmpeg',
  });
  if (!run.ok) throw new Error(`抽音轨失败（${run.error}）`);
  let bytes = 0;
  try { bytes = fs.statSync(outWav).size; } catch { /* 下面报错 */ }
  if (bytes <= 0) throw new Error(`抽音轨失败：没有产出 ${outWav}`);
  return outWav;
}

/** 缓存命中且要 --keep 时，wav 已存在就复用，否则补抽一次。 */
async function ensureAudio(ffmpeg, { inputPath, outDir }) {
  const outWav = path.join(outDir, AUDIO_FILE_NAME);
  try {
    if (fs.statSync(outWav).size > 0) return outWav;
  } catch { /* 不存在：补抽 */ }
  return extractAudio(ffmpeg, { inputPath, outDir });
}

async function main(argv) {
  const startedAt = Date.now();
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!options.input) throw new Error('缺少 --input <视频文件>（用 --help 看用法）');

  const inputPath = path.resolve(options.input);
  let stat;
  try {
    stat = fs.statSync(inputPath);
  } catch {
    throw new Error(`找不到视频文件：${inputPath}`);
  }
  if (!stat.isFile()) throw new Error(`不是文件（目录？）：${inputPath}`);
  if (stat.size <= 0) throw new Error(`文件为空：${inputPath}`);

  const outDir = options.outDir ? path.resolve(options.outDir) : DEFAULT_OUT_DIR;
  const digestPath = path.join(outDir, DIGEST_FILE_NAME);
  const hash = digestHash(inputPath, stat.size, stat.mtimeMs);
  const ffprobe = resolveTool('ffprobe', 'FFPROBE_PATH');
  const ffmpeg = resolveTool('ffmpeg', 'FFMPEG_PATH');

  let digest = readCachedDigest(digestPath, hash);
  const cached = Boolean(digest);
  let audioPath = null;

  if (cached) {
    if (options.keep && digest.audio?.present) {
      audioPath = await ensureAudio(ffmpeg, { inputPath, outDir });
    }
  } else {
    fs.mkdirSync(outDir, { recursive: true });
    const meta = await probeVideo(ffprobe, inputPath, outDir);
    if (!meta.hasVideo) throw new Error(`没有视频流（只有音轨？）：${inputPath}`);
    if (!meta.durationSec) throw new Error(`读不出视频时长（文件可能损坏）：${inputPath}`);
    const times = planFrames({
      durationSec: meta.durationSec,
      maxFrames: options.maxFrames ?? VIDEO_DIGEST_DEFAULTS.maxFrames,
    });
    if (times.length === 0) throw new Error(`视频时长太短（${meta.durationSec}s），抽不到帧：${inputPath}`);
    cleanStaleFrames(outDir);
    const frames = await extractFrames(ffmpeg, { inputPath, times, outDir });
    if (options.keep && meta.hasAudio) {
      audioPath = await extractAudio(ffmpeg, { inputPath, outDir });
    }
    digest = buildDigest({ meta, frames, audioText: '', hash });
    writeDigestFile(digestPath, digest);
  }

  const payload = { ...digest, outDir, cached, audioPath, elapsedMs: Date.now() - startedAt };
  process.stdout.write(`${JSON.stringify(payload, null, options.json ? 0 : 2)}\n`);
  if (!options.json) {
    process.stderr.write(
      `[video-digest] ${formatDigestSummary(digest)} → ${outDir}（${cached ? '缓存命中' : '缓存未命中'}，${payload.elapsedMs} ms）\n`,
    );
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`[video-digest] 错误：${error?.message ?? error}\n`);
    if (process.env.VIDEO_DIGEST_DEBUG) process.stderr.write(`${error?.stack ?? ''}\n`);
    process.exitCode = 1;
  });
