// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、reserved2 落库丢表情识别字段（R16）。
  'test-audit-regressions.mjs',
  // QQ 文件段：url > base64/本地 > get_file 的取字节链路、文本注入、
  // 图片按文件发来的归一化、state/media/inbound 落盘与 reserved2 fileText 快照。
  'test-file-media.mjs',
  // 群会话 → owner 私聊闸门：只能 owner、只能 owner 本回合触发，其余拒绝并写
  // state/tool-restrict.log；纯函数解析 turn-sender.json + /api/send/private 端到端。
  'test-owner-dm.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'test-media-search.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'test-issue-regressions.mjs',
  // 二代「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'test-v2-initial-prompt.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // 入站语音转写（纯函数）：语音段识别 / fetch_ptt_text 载荷清洗 / 注记格式 /
  // 每回合转写计划（跳过自己、无 messageId、已有注记）。
  'test-voice-inbound.mjs',
  // 视频理解（纯函数 + 自带 CLI 端到端）：ffprobe 摘要 / 抽帧计划与参数 /
  // digest 结构与缓存键 / 每视频一个缓存目录、撞 hash 才复用。
  'test-video-digest.mjs',
  // 按会话模型覆盖：落盘 actor 必须是 console（SessionRouter 只认它，写成 owner
  // 会一调 API 就 500）、整条替换语义、删除回落、reload、损坏文件 fail-open。
  'test-conversation-policy.mjs',
  // 人格自主成长的护栏（纯函数）：清洗/截断、网址/代码/HTML/命令行一律不采纳、
  // 每日条数与最小间隔、跨天归零。
  'test-persona-growth.mjs',
  // 主人授权的运维小工具：配置写入白名单（拒绝凭据/非白名单根）、path=value 解析、
  // 深路径读写、白名单 GET(嵌套)→POST(扁平) 映射。
  'test-qq-admin.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // 记忆层级策略（2026-11-22）：事件/事实/话题默认短期、被反复想起才升长期；
  // 日层/日记/承诺/偏好/关系/档案天然长期；空日层不再生成；存量迁移可 dryRun。
  'test-memory-layer-policy.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
