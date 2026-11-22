// video-digest 回归测试：纯函数离线断言 + 端到端（有 tools/ffmpeg 时）验证抽帧/缓存/音轨。
//
// 跑法：node scripts/test-video-digest.mjs
// 输出：逐条 PASS/FAIL，末尾汇总用例数与断言数；任何失败退出码 1。
//
// 端到端测试在 tmp 目录现场生成 2.5s 小视频（不碰仓库 state/）；
// CLI 子进程的 stdout/stderr 用文件描述符重定向而不是 pipe —— 与仓库
// 「受限沙箱下 pipe 会 EPERM」的教训一致，这样在受限环境也能跑完。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  frameFileName,
  isDigestHash,
  planFrames,
  probeSummary,
} from '../src/core/video-digest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI_PATH = path.join(HERE, 'video-digest.mjs');
const FFMPEG = path.join(REPO_ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(REPO_ROOT, 'tools', 'ffmpeg', 'ffprobe.exe');

let passed = 0;
let failed = 0;
let skipped = 0;
let assertions = 0;

/** 包一层断言：顺便统计断言条数，报告里能直接写「多少项断言」。 */
const check = {
  ok(value, message) { assertions += 1; assert.ok(value, message); },
  equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); },
  notEqual(actual, expected, message) { assertions += 1; assert.notEqual(actual, expected, message); },
  deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); },
  match(value, regex, message) { assertions += 1; assert.match(value, regex, message); },
  throws(fn, expected, message) { assertions += 1; assert.throws(fn, expected, message); },
};

function test(name, run) {
  try {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${String(error?.message ?? error).split('\n').join('\n     ')}`);
  }
}

function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP ${name}（${reason}）`);
}

// ── 纯函数：probeSummary ─────────────────────────────────────────────

// 真实状态：state/media/inbound 里那条 60.17s、1500×838 h264+aac 的视频。
const PROBE_REAL = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1500, height: 838, duration: '60.169850' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '60.169850' },
  ],
  format: { duration: '60.169850', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
};

test('probeSummary 解析真实 h264+aac 视频', () => {
  const meta = probeSummary(PROBE_REAL);
  check.equal(meta.durationSec, 60.17);
  check.equal(meta.width, 1500);
  check.equal(meta.height, 838);
  check.equal(meta.hasVideo, true);
  check.equal(meta.hasAudio, true);
  check.equal(meta.videoCodec, 'h264');
  check.equal(meta.audioCodec, 'aac');
  check.equal(meta.audioSampleRate, 48000);
  check.equal(meta.audioChannels, 2);
});

test('probeSummary 跳过封面图流（attached_pic）', () => {
  const meta = probeSummary({
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: '12.5' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
    ],
    format: { duration: '12.5' },
  });
  check.equal(meta.width, 1280);
  check.equal(meta.height, 720);
  check.equal(meta.videoCodec, 'h264');
  check.equal(meta.durationSec, 12.5);
  check.equal(meta.hasAudio, true);
});

test('probeSummary 容忍 JSON 字符串、缺字段与纯音频容器', () => {
  const fromString = probeSummary(JSON.stringify({
    streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: 8000, channels: 1, duration: '3.333' }],
    format: { duration: 'N/A' },
  }));
  check.equal(fromString.durationSec, 3.333);
  check.equal(fromString.width, 0);
  check.equal(fromString.height, 0);
  check.equal(fromString.hasVideo, false);
  check.equal(fromString.hasAudio, true);
  check.equal(fromString.audioSampleRate, 8000);
  check.equal(fromString.audioChannels, 1);

  const empty = probeSummary({});
  check.equal(empty.durationSec, 0);
  check.equal(empty.hasVideo, false);
  check.equal(empty.hasAudio, false);
  check.equal(empty.videoCodec, '');
});

test('probeSummary 拒绝非法输入', () => {
  check.throws(() => probeSummary(null), TypeError);
  check.throws(() => probeSummary([]), TypeError);
  check.throws(() => probeSummary('不是 JSON'), TypeError);
  check.throws(() => probeSummary(42), TypeError);
});

// ── 纯函数：planFrames ──────────────────────────────────────────────

test('planFrames 短片段只抽 1 帧且避开首尾', () => {
  for (const duration of [0.5, 1, 1.999]) {
    const times = planFrames({ durationSec: duration });
    check.equal(times.length, 1, `duration=${duration} 应只抽 1 帧`);
    check.ok(times[0] > 0 && times[0] < duration, `duration=${duration} 的帧点应落在 (0, ${duration})`);
  }
});

test('planFrames 长视频均匀 8 帧且首末对齐', () => {
  const duration = 10;
  const times = planFrames({ durationSec: duration });
  check.equal(times.length, VIDEO_DIGEST_DEFAULTS.maxFrames);
  check.equal(times[0], VIDEO_DIGEST_DEFAULTS.firstFrameSec);
  check.equal(times.at(-1), duration - VIDEO_DIGEST_DEFAULTS.endMarginSec);
  for (let index = 1; index < times.length; index += 1) {
    check.ok(times[index] > times[index - 1], '帧点应严格递增');
  }
  const steps = times.slice(1).map((at, index) => at - times[index]);
  for (const step of steps) check.ok(Math.abs(step - steps[0]) < 0.002, `步长应均匀：${step}`);
});

test('planFrames 尊重 maxFrames 且封顶 8', () => {
  check.equal(planFrames({ durationSec: 60, maxFrames: 3 }).length, 3);
  check.equal(planFrames({ durationSec: 600, maxFrames: 20 }).length, 8);
  const single = planFrames({ durationSec: 10, maxFrames: 1 });
  check.equal(single.length, 1);
  check.equal(single[0], 4.8);
});

test('planFrames 帧点不越界（末帧 ≤ duration-0.5）', () => {
  for (const duration of [2, 2.5, 3, 60.17]) {
    const times = planFrames({ durationSec: duration });
    check.ok(times.length >= 1, `duration=${duration} 应该至少 1 帧`);
    check.ok(
      times.every((at) => at > 0 && at <= duration - VIDEO_DIGEST_DEFAULTS.endMarginSec + 1e-9),
      `duration=${duration} 的帧点越界：${times.join(',')}`,
    );
  }
});

test('planFrames 非法/零时长返回空', () => {
  for (const duration of [0, -1, NaN, Infinity, undefined, 'abc']) {
    check.deepEqual(planFrames({ durationSec: duration }), []);
  }
  check.deepEqual(planFrames(), []);
});

// ── 纯函数：ffmpeg 参数 ─────────────────────────────────────────────

test('buildFfmpegFrameArgs 生成逐帧参数与 frame-01 命名', () => {
  const jobs = buildFfmpegFrameArgs({ input: 'D:\\in\\a.mp4', times: [0.1, 1.5, 2.9], outDir: 'D:\\out' });
  check.equal(jobs.length, 3);
  check.deepEqual(jobs.map((job) => path.basename(job.path)), ['frame-01.jpg', 'frame-02.jpg', 'frame-03.jpg']);
  check.deepEqual(jobs.map((job) => job.at), [0.1, 1.5, 2.9]);
  const args = jobs[0].args;
  check.equal(args[args.indexOf('-ss') + 1], '0.1');
  check.equal(args[args.indexOf('-i') + 1], 'D:\\in\\a.mp4');
  check.equal(args[args.indexOf('-frames:v') + 1], '1');
  check.equal(args[args.indexOf('-vf') + 1], `scale=${VIDEO_DIGEST_DEFAULTS.frameWidth}:-2:flags=lanczos`);
  check.equal(args.at(-1), jobs[0].path);
  check.ok(args.indexOf('-ss') < args.indexOf('-i'), '-ss 应放在 -i 之前（快进 seek，比全解码快一个量级）');
});

test('buildFfmpegFrameArgs 支持自定义宽度、空 times 与参数校验', () => {
  const [job] = buildFfmpegFrameArgs({ input: 'in.mp4', times: [0], outDir: 'out', width: 480 });
  check.equal(job.args[job.args.indexOf('-vf') + 1], 'scale=480:-2:flags=lanczos');
  check.deepEqual(buildFfmpegFrameArgs({ input: 'in.mp4', times: [], outDir: 'out' }), []);
  check.throws(() => buildFfmpegFrameArgs({ input: '', times: [0], outDir: 'out' }), TypeError);
  check.throws(() => buildFfmpegFrameArgs({ input: 'in.mp4', times: [0], outDir: '' }), TypeError);
  check.throws(() => buildFfmpegFrameArgs({ input: 'in.mp4', times: [-1], outDir: 'out' }), TypeError);
});

test('buildAudioArgs 输出 16k 单声道 wav', () => {
  const args = buildAudioArgs({ input: 'in.mp4', outWav: 'out.wav' });
  check.equal(args[args.indexOf('-ar') + 1], String(VIDEO_DIGEST_DEFAULTS.audioSampleRate));
  check.equal(args[args.indexOf('-ac') + 1], String(VIDEO_DIGEST_DEFAULTS.audioChannels));
  check.ok(args.includes('-vn'));
  check.equal(args[args.indexOf('-c:a') + 1], 'pcm_s16le');
  check.equal(args.at(-1), 'out.wav');

  const custom = buildAudioArgs({ input: 'in.mp4', outWav: 'o.wav', sampleRate: 48000, channels: 2 });
  check.equal(custom[custom.indexOf('-ar') + 1], '48000');
  check.equal(custom[custom.indexOf('-ac') + 1], '2');
  check.throws(() => buildAudioArgs({ outWav: 'o.wav' }), TypeError);
  check.throws(() => buildAudioArgs({ input: 'in.mp4' }), TypeError);
});

// ── 纯函数：hash / digest / 摘要 ────────────────────────────────────

test('digestHash 稳定、16 位且能区分不同文件', () => {
  const baseline = digestHash('D:\\a\\clip.mp4', 11832283, 1762069825000);
  check.equal(digestHash('D:\\a\\clip.mp4', 11832283, 1762069825000), baseline);
  check.equal(baseline.length, VIDEO_DIGEST_DEFAULTS.hashLength);
  check.ok(isDigestHash(baseline));
  check.notEqual(digestHash('D:\\a\\clip.mp4', 11832284, 1762069825000), baseline);
  check.notEqual(digestHash('D:\\a\\clip.mp4', 11832283, 1762069825001), baseline);
  check.notEqual(digestHash('D:\\a\\other.mp4', 11832283, 1762069825000), baseline);
  // 同一落地文件换目录（同名/同大小/同 mtime）应命中同一缓存键
  check.equal(digestHash('D:\\b\\clip.mp4', 11832283, 1762069825000), baseline);
  check.ok(!isDigestHash('xyz'));
  check.ok(!isDigestHash('ABCDEF0123456789'));
});

test('buildDigest 输出固定结构并标注音轨来源', () => {
  const meta = probeSummary(PROBE_REAL);
  const frames = [
    { at: 0.1, path: 'D:\\out\\frame-01.jpg' },
    { at: 9.5, path: 'D:\\out\\frame-02.jpg', extra: '多余字段应被丢掉' },
  ];
  const digest = buildDigest({ meta, frames, audioText: '  大家好  ', hash: 'abcdef0123456789' });
  check.deepEqual(Object.keys(digest), ['durationSec', 'width', 'height', 'frames', 'audio', 'hash']);
  check.equal(digest.durationSec, 60.17);
  check.equal(digest.width, 1500);
  check.equal(digest.height, 838);
  check.deepEqual(digest.frames, [
    { at: 0.1, path: 'D:\\out\\frame-01.jpg' },
    { at: 9.5, path: 'D:\\out\\frame-02.jpg' },
  ]);
  check.deepEqual(digest.audio, { present: true, text: '大家好', source: 'transcript' });
  check.equal(digest.hash, 'abcdef0123456789');

  const probeOnly = buildDigest({ meta, frames, hash: 'aaaaaaaaaaaaaaaa' });
  check.deepEqual(probeOnly.audio, { present: true, text: '', source: 'probe' });

  const noAudio = buildDigest({
    meta: { durationSec: 3, width: 320, height: 240, hasAudio: false },
    frames: [],
    hash: 'bbbbbbbbbbbbbbbb',
  });
  check.deepEqual(noAudio.audio, { present: false, text: '', source: 'none' });
  check.deepEqual(noAudio.frames, []);
  check.equal(noAudio.durationSec, 3);
  check.equal(noAudio.width, 320);
});

test('formatDigestSummary 生成一行中文摘要', () => {
  const text = formatDigestSummary({
    durationSec: 60.17,
    width: 1500,
    height: 838,
    frames: [{}, {}],
    audio: { present: true, text: '' },
  });
  check.equal(text, '视频 60.2s（1500×838），抽 2 帧，含音轨（未转写）');
  check.equal(
    formatDigestSummary({ durationSec: 1, width: 0, height: 0, frames: [], audio: { present: false, text: '' } }),
    '视频 1.0s（尺寸未知），抽 0 帧，无音轨',
  );
  check.match(
    formatDigestSummary({ durationSec: 2, width: 10, height: 10, frames: [], audio: { present: true, text: '你好' } }),
    /含音轨（有转写）/,
  );
});

test('frameFileName 两位补零并从 1 开始', () => {
  check.equal(frameFileName(1), 'frame-01.jpg');
  check.equal(frameFileName(8), 'frame-08.jpg');
  check.equal(frameFileName(12), 'frame-12.jpg');
  check.throws(() => frameFileName(0), TypeError);
});

// ── 端到端：真跑 ffmpeg/ffprobe ─────────────────────────────────────

const toolsReady = fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE);

/** 跑 CLI：stdout/stderr 重定向到文件（不用 pipe），返回文本与退出码。 */
function runCli(args) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stdoutFile = path.join(os.tmpdir(), `vd-stdout-${stamp}.json`);
  const stderrFile = path.join(os.tmpdir(), `vd-stderr-${stamp}.log`);
  const outFd = fs.openSync(stdoutFile, 'w');
  const errFd = fs.openSync(stderrFile, 'w');
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      timeout: 120000,
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: fs.readFileSync(stdoutFile, 'utf8'),
      stderr: fs.readFileSync(stderrFile, 'utf8'),
    };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    fs.rmSync(stdoutFile, { force: true });
    fs.rmSync(stderrFile, { force: true });
  }
}

/** 读 JPEG 的 SOF 段取宽度（验证 scale=720 生效）。 */
function jpegWidth(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return buffer.readUInt16BE(offset + 7);
    offset += 2 + segmentLength;
  }
  return 0;
}

/** 用 lavfi 现场生成 2.5s / 640×360 / mpeg4 + aac 的小视频（mpeg4/aac 都是 ffmpeg 内置编码器）。 */
function generateClip(targetPath) {
  const result = spawnSync(
    FFMPEG,
    [
      '-v', 'error',
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '2.5',
      '-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-shortest',
      targetPath,
    ],
    { windowsHide: true, stdio: 'ignore', timeout: 120000 },
  );
  try {
    return result.status === 0 && fs.statSync(targetPath).size > 0;
  } catch {
    return false;
  }
}

if (!toolsReady) {
  skip('CLI 端到端（抽帧 / 缓存 / 音轨 / 错误路径）', '仓库里没有 tools/ffmpeg/ffmpeg.exe 或 ffprobe.exe');
} else {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-digest-test-'));
  try {
    const clip = path.join(tmpRoot, 'clip.mp4');
    if (!generateClip(clip)) {
      skip('CLI 端到端（抽帧 / 缓存 / 音轨 / 错误路径）', 'lavfi 测试小视频生成失败');
    } else {
      test('CLI 端到端：抽 8 帧 720 宽 JPEG 并写 digest.json', () => {
        const outDir = path.join(tmpRoot, 'out-default');
        const result = runCli(['--input', clip, '--out-dir', outDir, '--json']);
        check.equal(result.status, 0, `CLI 应成功退出：${result.stderr}`);
        check.equal(result.stderr.trim(), '', '--json 模式 stderr 不应有诊断噪音');

        const payload = JSON.parse(result.stdout);
        check.equal(payload.cached, false);
        check.equal(payload.width, 640);
        check.equal(payload.height, 360);
        check.ok(payload.durationSec > 2 && payload.durationSec < 3, `时长应约 2.5s，实际 ${payload.durationSec}`);
        check.equal(payload.frames.length, 8);
        check.equal(payload.audio.present, true);
        check.equal(payload.audio.source, 'probe');
        check.equal(payload.audio.text, '');
        check.equal(payload.hash.length, 16);
        check.ok(isDigestHash(payload.hash));
        check.equal(payload.audioPath, null);

        const digestPath = path.join(outDir, DIGEST_FILE_NAME);
        check.ok(fs.existsSync(digestPath), '应写出 digest.json');
        const { outDir: _outDir, cached: _cached, audioPath: _audioPath, elapsedMs: _elapsedMs, ...digestOnly } = payload;
        check.deepEqual(JSON.parse(fs.readFileSync(digestPath, 'utf8')), digestOnly, 'digest.json 应是纯摘要（不含运行态字段）');

        for (const frame of payload.frames) {
          check.ok(fs.existsSync(frame.path), `帧文件应存在：${frame.path}`);
          const buffer = fs.readFileSync(frame.path);
          check.equal(buffer[0], 0xff);
          check.equal(buffer[1], 0xd8);
          check.equal(jpegWidth(buffer), 720, `帧宽应为 720：${frame.path}`);
          check.ok(buffer.length > 1000, '单帧不应是空文件');
          check.ok(frame.at > 0 && frame.at < payload.durationSec, '帧时间点应在视频内');
        }
      });

      test('CLI 端到端：同 hash 二次运行走缓存、不重写帧与摘要', () => {
        const outDir = path.join(tmpRoot, 'out-cache');
        const first = runCli(['--input', clip, '--out-dir', outDir, '--max-frames', '4', '--json']);
        check.equal(first.status, 0, first.stderr);
        const firstPayload = JSON.parse(first.stdout);
        check.equal(firstPayload.cached, false);
        check.equal(firstPayload.frames.length, 4);

        const framePaths = firstPayload.frames.map((frame) => frame.path);
        const frameStats = framePaths.map((file) => fs.statSync(file).mtimeMs);
        const digestPath = path.join(outDir, DIGEST_FILE_NAME);
        const digestMtime = fs.statSync(digestPath).mtimeMs;

        const second = runCli(['--input', clip, '--out-dir', outDir, '--max-frames', '4', '--json']);
        check.equal(second.status, 0, second.stderr);
        const secondPayload = JSON.parse(second.stdout);
        check.equal(secondPayload.cached, true);
        check.equal(secondPayload.hash, firstPayload.hash);
        check.deepEqual(secondPayload.frames, firstPayload.frames);
        check.deepEqual(framePaths.map((file) => fs.statSync(file).mtimeMs), frameStats, '缓存命中不应重写帧');
        check.equal(fs.statSync(digestPath).mtimeMs, digestMtime, '缓存命中不应重写 digest.json');
      });

      test('CLI --max-frames 3 --keep 保留 16k 单声道音轨', () => {
        const outDir = path.join(tmpRoot, 'out-keep');
        const result = runCli(['--input', clip, '--out-dir', outDir, '--max-frames', '3', '--keep', '--json']);
        check.equal(result.status, 0, result.stderr);
        const payload = JSON.parse(result.stdout);
        check.equal(payload.frames.length, 3);
        check.equal(
          payload.frames.map((frame) => path.basename(frame.path)).join(','),
          'frame-01.jpg,frame-02.jpg,frame-03.jpg',
        );
        check.equal(payload.audioPath, path.join(outDir, AUDIO_FILE_NAME));
        check.ok(fs.existsSync(payload.audioPath), '应保留 audio.wav');

        const wav = fs.readFileSync(payload.audioPath);
        check.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
        check.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
        check.equal(wav.readUInt16LE(20), 1, 'WAV 应为 PCM');
        check.equal(wav.readUInt16LE(22), 1, 'WAV 应为单声道');
        check.equal(wav.readUInt32LE(24), 16000, 'WAV 应为 16kHz');
        check.ok(wav.length > 1000, '音轨不应是空文件');
      });

      test('CLI 错误路径：缺文件 / 未知参数 / 缺 --input 给出可读原因', () => {
        const missing = runCli(['--input', path.join(tmpRoot, 'not-exist.mp4'), '--out-dir', path.join(tmpRoot, 'out-err'), '--json']);
        check.equal(missing.status, 1);
        check.match(missing.stderr, /找不到视频文件/);
        check.equal(missing.stdout.trim(), '');

        const unknown = runCli(['--input', clip, '--wat', '--json']);
        check.equal(unknown.status, 1);
        check.match(unknown.stderr, /未知参数/);

        const noInput = runCli(['--json']);
        check.equal(noInput.status, 1);
        check.match(noInput.stderr, /缺少 --input/);

        const help = runCli(['--help']);
        check.equal(help.status, 0);
        check.match(help.stdout, /--max-frames/);
      });
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n失败 ${failed} 个用例（通过 ${passed}，跳过 ${skipped}，断言 ${assertions} 项）`);
  process.exitCode = 1;
} else {
  console.log(`\n全部通过：${passed} 个用例 / ${assertions} 项断言${skipped ? `（跳过 ${skipped} 个）` : ''}`);
}
