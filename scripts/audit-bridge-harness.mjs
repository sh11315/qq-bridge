// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
import * as docExtract from '../src/doc-extract.js';
import * as ownerDmGuard from '../src/owner-dm-guard.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
// 收藏表情同步的退避重试/连上补同步调度器（bridge.js 顶层 import 会被 VM 剥掉，必须注入）。
import * as stickerSyncRetry from '../src/sticker-sync-retry.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as stateAcl from '../src/state-acl.mjs';
// 五套功能会话的纯逻辑（bridge.js 顶层 import 会被 VM 剥掉，必须注入 context）。
import * as board from '../src/core/board.mjs';
import * as featureSessions from '../src/core/feature-sessions.mjs';
// 入站语音转写 / 视频摘要 / 按会话模型覆盖：bridge 顶层 import 在 VM 里被剥掉，
// 必须把这三个纯逻辑模块的导出注入 context，否则 main() 一启动就 ReferenceError。
import * as voiceInbound from '../src/core/voice-inbound.mjs';
import * as videoDigest from '../src/core/video-digest.mjs';
import * as conversationPolicy from '../src/core/conversation-policy.mjs';
// 照片记忆（bridge 的 vision 捕获分支会调用 photoMemoryConfig，VM 里必须注入）
import * as photoMemory from '../src/core/photo-memory.mjs';
// 活人感行为提示（纯规则）：bridge 每回合会调用 buildPresenceHint，VM 里必须注入。
import * as presence from '../src/core/presence.mjs';
// 回忆检索：bridge 会写归档并调用 searchHistoryMessages，VM 里必须注入。
import * as historyArchive from '../src/history-archive.mjs';
import * as historySearch from '../src/core/history-search.mjs';
// 跨群用户索引：appendMessageArchive 会写入，VM 里必须注入。
import * as userIndex from '../src/user-index.mjs';
// DSH 事件契约监控：bridge 启动时创建，VM 里必须注入。
import * as dshEventMonitor from '../src/core/dsh-event-monitor.mjs';
// 跨群用户记忆 + 出图：bridge 的 main() 初始化/每回合都会调用，VM 里必须注入。
import * as userMemory from '../src/core/user-memory.mjs';
import * as userMemoryStore from '../src/user-memory-store.mjs';
import * as imageGen from '../src/image-gen.mjs';
// 表情去重/审核：collectStickerV2 会用到；ffmpeg 解析复用 voice-core。
import * as dhashImage from '../src/dhash-image.mjs';
import * as dhashCore from '../src/core/dhash.mjs';
import * as imageReview from '../src/core/image-review.mjs';
import * as voiceCore from '../src/voice-core.js';
// 秘书旁路：sendWakePromptV2 会调用，VM 里必须注入。
import * as secretary from '../src/core/secretary.mjs';
// 风格画像：bridge 每条群消息/每回合都会调用，VM 里必须注入。
import * as styleProfile from '../src/core/style-profile.mjs';
import * as styleStoreModule from '../src/style-store.mjs';
import * as proactive from '../src/core/proactive.mjs';
// 低优先级会话写入（writer-held 退避重试）：bridge.js 顶层 import 同样会被 VM 剥掉。
import * as lowPriorityPrompt from '../src/low-priority-prompt.mjs';
// 跨功能会话的「上一轮结论」摘要（bridge.js 顶层 import 会被 VM 剥掉，必须注入 context）。
import * as turnSummary from '../src/core/turn-summary.mjs';
// 「仅@」判定（bridge.js 顶层 import 会被 VM 剥掉，必须自己注入）。
import * as mentionOnly from '../src/mention-only.js';
// 角色卡：chat/mention-only 分支会调用 currentRoleHint()。以前测试只走 reserved2
// （在那之前就 return 了），所以一直没暴露 VM 里缺这套绑定。
import * as roleCard from '../src/role-card.js';
// 直连 api 后端（合并自「自定义版」）：bridge.js 的 import 会被 VM 剥掉，
// 这里必须把模块的导出注入 context，否则 loadConfig 里的 normalizeApiConfig 会是 undefined。
import * as apiChat from '../src/api-chat.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {}, apiSessions = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [], httpPttScript: [], selectedModels: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body, at: Date.now() });
    const action = String(url).split('/').pop();
    // fetch_custom_face_detail：同步收藏表情的 HTTP 兜底路径要拿到**数组**（WS 失败时用）。
    if (action === 'fetch_custom_face_detail') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      // 允许测试预置一串响应：验证「QQ 侧转写还没生成」时的重试与永久失败分支。
      const scripted = calls.httpPttScript.length ? calls.httpPttScript.shift() : null;
      if (scripted) {
        if (scripted.throw) throw new Error(scripted.throw);
        return { ok: scripted.ok !== false, status: scripted.status ?? 200, json: async () => scripted.json };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async (params) => { calls.selectedModels.push(params); return success({ selected: { provider: 'fixture', model: 'fixture' } }); },
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  // 测试可覆盖会话 API（例如模拟 DSH 的 session/writer-held 写锁冲突）。
  Object.assign(api.sessions, apiSessions);
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 群成员列表：v2 读工具 qq_get_group_members 会用到（含 WS 不可用时的 HTTP 兜底路径）。
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  // 在 bot.connect() 之前插入 return：这样 bot 的 open/close/error 事件接线会真实执行
  // （测试可以用 h.bot.emit('open') 驱动「SnowLuma 连上」），而 connect/启动预热/守护循环
  // 仍被跳过，避免测试真的连网关或起定时器。
  source = source.replace('  bot.connect().catch((error) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, deliverPromptNow, drainPromptQueue, queueChatPrompt,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2, recordTurnSummaryV2,
    userMemoryStore, buildUserMemoryLine, saveGeneratedImage, styleStore, buildStyleLineV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    computeGapsV2, clampGapV2,
    syncStickerLibrary, listStickersForV2, getStickerImageData, stickerSyncScheduler,
    refreshMode, modeAllowed, modePreset, normalizeModeInput, VALID_MODES, MODE_INPUT_ALIASES, applyLocalModeFallback, trackTurnEvent, replayPendingWakeReasonsV2,
    collectors, setupSleepTimerV2,
    // 角色卡注入记录：验证「重置会话/清空工作区后必须重新注入完整人格卡」。
    roleInjectedVersion, forgetRoleInjection, roleHintForPrompt,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchFileMedia, fetchMediaData, resolveMediaList,
    resolveReplyInfo, findMessageMedia,
    // 新能力接线后的可观测点：语音转写装饰、视频摘要、按会话模型覆盖。
    conversationPolicy, transcribeInboundVoice, decorateInboundVoice, digestInboundVideo,
    VIDEO_CACHE_DIR, readVideoDigest, runVideoDigestCli,
    // 视频媒体 kind 的存储/迁移（2026-11-22 事故：mp4 被拍平成 image 导致「视频打不开」）。
    MEDIA_KINDS, looksLikeVideoMedia, migrateVideoMediaKinds,
    // QQ 客户端本地视频缓存命中的查找（免走会过期的下载 URL）。
    findLocalVideoFile, videoLocalCacheHits,
    // 大文件（> maxInlineFileBytes）只落盘给路径、不内联抽正文的文案（2026-11-22 121MB PDF 事故）。
    loadInboundFile, largeFileNote, MAX_FILE_BYTES, MAX_INLINE_FILE_BYTES,
    ensureTurnModelFor,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    // 唤醒租约心跳（2026-11-22：重回合跑满 5 分钟不再被误判成卡死）。
    pendingWakeKeys, pendingWakeLeaseTimers, PENDING_WAKE_LEASE_MS,
    armPendingWakeLease, renewPendingWakeLease, disarmPendingWakeLease,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    ...(typeof featuresActive === 'function' ? {
      routeTurn, v2ToolEnabled, setFeatureOverride, takeFeatureOverride, clearFeatureOverride,
      peekFeatureOverride, activeVariantOfKey, activeFeatureOfKey, featuresActive,
      featureStatusPayload, runFeatureSelftest, lastAppliedModelBySession,
    } : {}),
    getMode() { return currentMode; },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.connect().catch((error) => {`);
  const timers = new Set();
  // 自定义 fake bot（测试通过 globals 覆盖 SnowLumaWebSocketClient 时）也补上连接事件方法：
  // bridge 会在 bot 上挂 open/close/error，缺了 `on` 会让整个 harness 初始化抛错。
  // 同时给一个 getLoginInfo 兜底（bot.on('open') 里会读昵称）。
  const { SnowLumaWebSocketClient: ProvidedBotClass, ...globalsRest } = globals;
  const BotClass = ProvidedBotClass ?? FakeBot;
  const BotWithEvents = class extends BotClass {
    constructor(...args) {
      super(...args);
      if (!this._handlers) this._handlers = new Map();
    }
    on(event, fn) { const list = this._handlers.get(event) ?? []; list.push(fn); this._handlers.set(event, list); return this; }
    off(event, fn) {
      const list = (this._handlers.get(event) ?? []).filter((f) => f !== fn);
      if (list.length) this._handlers.set(event, list); else this._handlers.delete(event);
      return this;
    }
    emit(event, ...args) { for (const fn of [...(this._handlers.get(event) ?? [])]) fn(...args); return true; }
    async getLoginInfo() {
      return (typeof super.getLoginInfo === 'function')
        ? super.getLoginInfo()
        : { nickname: 'fixture-bot', user_id: 123 };
    }
    // bridge 启动时会注册这些 SDK 订阅方法；以前 harness 在注册前就 return 了，
    // 所以 FakeBot 没实现也没人发现。这里缺省给 no-op，自定义 fake bot 有实现就走 super。
    onPrivateMessage(handler) {
      return (typeof super.onPrivateMessage === 'function') ? super.onPrivateMessage(handler) : this;
    }
    onGroupMessage(handler) {
      return (typeof super.onGroupMessage === 'function') ? super.onGroupMessage(handler) : this;
    }
    onNotice(type, handler) {
      return (typeof super.onNotice === 'function') ? super.onNotice(type, handler) : this;
    }
    onEvent(handler) {
      return (typeof super.onEvent === 'function') ? super.onEvent(handler) : this;
    }
    onEventError(handler) {
      return (typeof super.onEventError === 'function') ? super.onEventError(handler) : this;
    }
    onBotStatus(handler) {
      return (typeof super.onBotStatus === 'function') ? super.onBotStatus(handler) : this;
    }
  };
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // 视频摘要会 spawn 子进程跑 scripts/video-digest.mjs（真跑 ffmpeg 又慢又脏沙箱）。
    // 桩成「启动后立刻以退出码 1 结束」：fail 路径可断言，且不会真的抽帧。
    spawn: () => {
      const child = {
        on(event, fn) {
          if (event === 'exit') setTimeout(() => fn(1), 0);
          return child;
        },
        once() { return child; },
        kill() {}
      };
      return child;
    },
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, cwd: () => process.cwd(), argv: process.argv, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: BotWithEvents, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    // 需求 C：DSH 就绪时桥接会自动 POST /sidebar/api/settings.get 预热 sidebar_open。
    // VM 里 fetch 是桩、也不该真的打 3080，所以给一个成功桩：checkDsh 照常走完整路径，
    // 同时不会往 calls.http 里掺假请求（那会打乱其它用例对 http 调用的断言）。
    warmSidebarToolRegistration: async () => ({ ok: true, attempts: 1, elapsedMs: 0, agentOpenTools: true }),
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker, ...stickerSyncRetry,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...presetPrompt, ...apiChat, ...mentionOnly, ...roleCard, ...docExtract, ...ownerDmGuard,
    ...board,
    ...featureSessions,
    ...voiceInbound,
    ...videoDigest,
    ...photoMemory,
    ...conversationPolicy,
    ...presence,
    ...historyArchive,
    ...historySearch,
    ...userIndex,
    ...dshEventMonitor,
    ...userMemory,
    ...userMemoryStore,
    ...imageGen,
    ...dhashImage,
    ...dhashCore,
    ...imageReview,
    resolveFfmpeg: voiceCore.resolveFfmpeg,
    ...secretary,
    ...styleProfile,
    ...styleStoreModule,
    // 主动机会策略（bridge.js 用 DEFAULT_PROACTIVE_POLICY 兜 quietHours 等默认值，
    // VM 里剥掉 import 后必须注入，否则 scheduleProactiveCheckV2 一路 ReferenceError）。
    ...proactive,
    ...turnSummary,
    ...lowPriorityPrompt,
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    resolveMediaFetchLimit: mediaNormalize.resolveMediaFetchLimit,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    // 注意 bridge.js 现在会把待发送音频读成 base64:// 再交给网关（NapCat 在容器
    // 里看不到宿主机路径），所以"处理后的文件"必须真实存在；本桩不转码，原样复制
    // 字节即可（真实 ffmpeg 会重新编码）。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      const target = changed ? `${file}.vol` : file;
      if (changed) fs.copyFileSync(file, target);
      return {
        path: target,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globalsRest,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
