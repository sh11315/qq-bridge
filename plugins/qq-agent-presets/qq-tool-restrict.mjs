// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 五套功能会话的 MCP 工具政策与 variant 解析：与 bridge / 测试共用同一份纯函数，
// 避免守卫里再抄一份名单（抄了必然漂移）。这个模块无副作用、不读文件，DSH 加载安全。
// 注意：URL 带版本查询串——DSH 进程按模块 URL 缓存 ESM，旧 guard 在启动时已经加载过
// 不带查询串的 feature-sessions.mjs；不换 URL 的话，热加载进来的新 guard 会拿到旧政策
// 模块（2026-10-28 实测：chat 仍被旧 BASE_FLAGS 放行成员列表）。改政策要同步 bump。
import {
  FEATURES,
  FEATURE_LABELS,
  FLAG_TO_MCP_TOOLS,
  SCHEMA_ONLY_HIDDEN_MCP_TOOLS,
  featureOfVariant,
  mcpToolNamesForFeature,
} from '../../src/core/feature-sessions.mjs?v=20261117-schema-hide1'
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把**继承层**的本地执行/文件类工具与开发工具从工具清单里隐藏；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝；
//  3) 用 tools.guard 的**参数**判定兜底：管理员回合放行 pwsh/bash 之后，仍按
//     `args.command` 过破坏性命令黑名单（关机/重启/磁盘/账户/递归删除/下载执行），
//     命中即拒绝（reason=blocked-command）。见 DEFAULT_BLOCKED_COMMANDS 上方的长注释。
//
// ⚠️ 2026-10-25 起口径变了：管理员回合需要真的能用 pwsh/read/write，所以
//    qq-chat preset **自己挂载**了这组本地工具。规则如下：
//      · preset 是会话级组合，无法按回合增删工具；
//      · `tools.restrict()` 只过滤继承层（全局/祖先层），**管不到 own-layer 注册**；
//      · 因此这些名字会出现在每个回合的 schema 里，执行期 guard（按
//        turn-sender 判定 owner 回合 + ADMIN_TURN_LOCAL_TOOL_NAMES）是唯一硬边界。
//    restrict 名单仍然保留：它挡的是「别的 composition 把本地工具推进全局层」
//    这类回归，以及 dev_* / plugin_manager 等全局工具。guard 默认（没有回合
//    快照 / 非 owner）仍然 fail-closed 拒绝。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：默认/非管理员回合**不得**拥有；
 * 管理员回合也只放行 {@link ADMIN_TURN_LOCAL_TOOL_NAMES} 这一小撮（见下方白名单）。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 *
 * 2026-10-22 针对 DSH 0.2.1-rc.2 重新对账（`node scripts/scan-dsh-tool-names.mjs`）。
 * DSH 这轮把不少能力从「实验组合包」转正，工具面因此变了三处：
 *   ① **新增一个真的会进仿真会话的全局工具**：`dsh-base` 现在默认挂
 *      `working-directory` + `tool-working-directory` 两行，于是 `working_directory`
 *      和 `list_mcp_resources` 一样属于**全局层继承**——QQ 会话一定拿得到，
 *      必须从 schema 隐藏（`state/tool-restrict.log` 的 known global tools 实测可见）。
 *   ② 新增终端能力 `dsh-tool-terminal`（`terminal_open|send|read|signal|close|list`）：
 *      终端 = 直接 shell，是本名单第一优先级要挡的东西；当前 composition 没启用，
 *      列进来是**回归网**（一旦被插件市场/组合包装上就自动挡）。
 *   ③ 新增会话历史检索 `dsh-tool-session-query`
 *      （`session_search|trace`、`session_event_read|search|trace`）：
 *      能跨会话读事件正文 ⇒ 等于把别的聊天记录递给 QQ 群，列进来。
 *   另有两个「装载权」入口同轮补上：`plugin_market`（插件市场，等价 plugin_manager）
 *   与 `create_worktree`（写盘 + 起 git 进程）、`wait_agent`（team 家族同族）。
 *
 * ⚠️ 0.2.1 把 Codex / Claude Code 从内置 preset 改成**按需安装的可选插件**，
 *    因此 `subagent_codex` / `subagent_claude_code` 在默认安装里**不存在**——
 *    restrict 对它们必然抛错。但用户一旦装上那两个组合包，名字就会回到全局层，
 *    所以仍然保留为**可选项名单**（{@link OPTIONAL_BUNDLE_TOOL_NAMES}）而不是删掉；
 *    扫描器/测试把这一组排除在「拼错假名」判定之外，其余名字照旧逐个对账。
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 0.2.1 新增对账（2026-10-22，见上方长注释）：
  //   ① dsh-base 默认启用 ⇒ 全局层继承
  'working_directory',
  //   ② 终端（= shell）
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  //   ③ 会话历史检索（能读别的会话的事件正文）
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  //   ④ 装载权 / 写盘起进程
  'plugin_market', 'create_worktree',
  //   ⑤ team 家族同族补齐
  'wait_agent',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

/**
 * 0.2.1 起改为「按需安装」的可选能力包里才会注册的全局工具名。
 *
 * 它们默认**不存在**于安装树里（0.2.0 时写在 `dsh-web-app/presets/*.patch.yml`），
 * `tools.restrict()` 对它们必然抛错——守卫逐个 try/catch 正是为这种名字设计的。
 * 保留的收益：用户装上 Codex / Claude Code 组合包后，名字回到全局层时**立刻**被挡，
 * 不必等下一次对账。
 *
 * 扫描器与测试用这一组把「可选项」和「拼错的假名」区分开：只有不在本组、又扫不到的
 * 名字才判成假名。
 */
export const OPTIONAL_BUNDLE_TOOL_NAMES = Object.freeze([
  'subagent_codex',
  'subagent_claude_code',
])

const CONTEXT_MANAGEMENT_TOOLS = [
  // 宿主侧的上下文管理工具（billion-context 注入）。QQ 桥接的白名单只放行 QQ MCP 与无害模型侧工具，
  // 这些工具既不在白名单里、又会在上下文变长时被模型反复尝试调用——执行期拒绝只会换来一串重试循环
  // （2026-11-02 群会话因 48 段上下文连续调用 compress 被拒 6 次）。所以直接从 schema 隐藏。
  'compress', 'decompress', 'search_context', 'acp_status', 'acp_cache', 'acp_read_original_image',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // 宿主上下文管理面（模型不该看见，更不该调用）
  ...CONTEXT_MANAGEMENT_TOOLS,
  // 按需安装的可选能力包（0.2.1 起默认不存在；装上就要挡）
  ...OPTIONAL_BUNDLE_TOOL_NAMES,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 执行期快速判定用（owner 例外时仍要挡住这些本地执行/文件工具）。
const DANGEROUS_TOOL_NAME_SET = new Set(KNOWN_DANGEROUS_GLOBAL_TOOLS)

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  // 深度记忆（会遗忘的长期记忆 + 知识图谱）：只读写 state/memory/brain.json，
  // 不执行本地命令、不联网、不发消息，非管理员回合也允许。
  'mcp__memory__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
//
// 2026-11-22（记忆融合）：dsh-memory-evolve 插件的 `memory` / `memory_suggest`
// 只读写本机 Markdown 记忆文件（MEMORY.md / USER.md / 项目 / 每日 / KEY），
// 不执行命令、不联网、不发消息，和 QQ 侧的 qq_memory_append 同级；
// 因此对所有回合放行（群友也可以让机器人记住「叫我某某」这类事实）。
// 技能管理 `skill_manage` 会写技能库（等价于给未来的自己加指令），仍留给
// 管理员回合（走下面的 owner-turn 插件工具分支），不在这里放行。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  'memory',
  'memory_suggest',
])

// ── 功能会话工具面（2026-10-26）──────────────────────────────────────────────
//
// 背景：reserved2 下聊天/表情包/看图/语音/联网各自用独立的 DSH 会话。会话隔离靠
// sessions.json 的 parkedSessions；但 MCP 工具是 **profile 级**挂载的，所有会话的
// schema 里都看得见 qq_* 与 web-search 工具。DSH 的 preset 无法按会话增删工具，
// 所以执行期守卫是唯一硬边界。
//
// 判定数据从哪来（不额外落盘，避免两份真相）：
//   · state/sessions.json：active（sessions[key] + sessionVariants[key]）与停放
//     （parkedSessions[key][variant]）都能反查出 sessionId → variant；
//   · state/mode.json：只有 reserved2 才启用功能会话门禁（其它模式退回旧行为）；
//   · config.json：dsh.features.enabled=false 时整体回滚；
//   · 工具政策：直接复用 src/core/feature-sessions.mjs 的 mcpToolNamesForFeature()。
//
// 失败口径：
//   · 配置缺失 / 模式不是 reserved2 / 会话没有映射（owner 自己的普通 DSH 会话）
//     → 不拦（继续走原来的白名单判定），避免把非 QQ 会话误伤；
//   · 有映射但工具不属于该功能域 → 拒绝，reason=feature-tool-out-of-scope。
const SESSIONS_FILE_ENV = 'QQ_TOOL_RESTRICT_SESSIONS'
const MODE_FILE_ENV = 'QQ_TOOL_RESTRICT_MODE'

function sessionsFilePath() {
  return process.env[SESSIONS_FILE_ENV]
    ? path.resolve(process.env[SESSIONS_FILE_ENV])
    : fileURLToPath(new URL('../../state/sessions.json', import.meta.url))
}

function modeFilePath() {
  return process.env[MODE_FILE_ENV]
    ? path.resolve(process.env[MODE_FILE_ENV])
    : fileURLToPath(new URL('../../state/mode.json', import.meta.url))
}

/** feature → 允许的 MCP 工具名集合（与 bridge 的 flag 策略同源）。 */
export const FEATURE_TOOL_POLICY = Object.freeze(Object.fromEntries(
  FEATURES.map((feature) => [feature, [...mcpToolNamesForFeature(feature)].sort()]),
))

const FEATURE_TOOL_SETS = Object.freeze(Object.fromEntries(
  FEATURES.map((feature) => [feature, mcpToolNamesForFeature(feature)]),
))

let modeCache = { file: '', mtimeMs: -1, mode: '' }
let sessionsCache = { file: '', mtimeMs: -1, size: -1, at: 0, map: new Map() }

/** 测试用：清掉文件缓存。 */
export function resetFeatureGateCache() {
  modeCache = { file: '', mtimeMs: -1, mode: '' }
  sessionsCache = { file: '', mtimeMs: -1, size: -1, at: 0, map: new Map() }
}

function readModeCached() {
  const file = modeFilePath()
  try {
    const stat = fs.statSync(file)
    if (modeCache.file === file && modeCache.mtimeMs === stat.mtimeMs) return modeCache.mode
    const raw = readJsonFileSafe(file)
    modeCache = { file, mtimeMs: stat.mtimeMs, mode: String(raw?.mode ?? '') }
    return modeCache.mode
  } catch {
    modeCache = { file, mtimeMs: -1, mode: '' }
    return ''
  }
}

function buildSessionFeatureMap(rawState) {
  const map = new Map()
  const sessions = rawState?.sessions && typeof rawState.sessions === 'object' ? rawState.sessions : {}
  const variants = rawState?.sessionVariants && typeof rawState.sessionVariants === 'object' ? rawState.sessionVariants : {}
  for (const [key, sid] of Object.entries(sessions)) {
    if (!sid) continue
    map.set(String(sid), featureOfVariant(variants[key] || 'chat:basic'))
  }
  const parkedAll = rawState?.parkedSessions && typeof rawState.parkedSessions === 'object' ? rawState.parkedSessions : {}
  for (const parked of Object.values(parkedAll)) {
    if (!parked || typeof parked !== 'object') continue
    for (const [variant, sid] of Object.entries(parked)) {
      if (!sid) continue
      map.set(String(sid), featureOfVariant(variant))
    }
  }
  return map
}

function readSessionFeatureMap() {
  const file = sessionsFilePath()
  try {
    const stat = fs.statSync(file)
    const now = Date.now()
    if (sessionsCache.file === file
      && sessionsCache.mtimeMs === stat.mtimeMs
      && sessionsCache.size === stat.size
      && now - sessionsCache.at < 5000) {
      return sessionsCache.map
    }
    const raw = readJsonFileSafe(file)
    const map = buildSessionFeatureMap(raw)
    sessionsCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, at: now, map }
    return map
  } catch {
    sessionsCache = { file, mtimeMs: -1, size: -1, at: 0, map: new Map() }
    return sessionsCache.map
  }
}

/** sessionId → feature（'chat'/'sticker'/…）；未知返回 ''。 */
export function sessionFeatureForId(sessionId) {
  const sid = String(sessionId ?? '')
  if (!sid) return ''
  return readSessionFeatureMap().get(sid) || ''
}

/**
 * 功能会话工具门禁。
 * @returns {null|{feature:string, reason:string}} null=放行；非 null=拒绝。
 */
export function featureToolGate(toolName, sessionId) {
  const name = String(toolName ?? '')
  const isQqTool = name.startsWith('mcp__snowluma__')
  const isWebTool = name.startsWith('mcp__web-search-safe__')
  if (!isQqTool && !isWebTool) return null
  if (readModeCached() !== 'reserved2') return null
  const cfg = readJsonFileSafe(configFilePath())
  if (cfg?.dsh?.features?.enabled === false) return null
  const feature = sessionFeatureForId(sessionId)
  if (!feature) return null
  if (isWebTool) {
    return feature === 'web' ? null : { feature, reason: 'feature-tool-out-of-scope' }
  }
  // 政策名单里存的是不带 MCP 前缀的工具名（qq_send_sticker），这里去掉命名空间再比。
  const bareName = name.replace(/^mcp__snowluma__/, '')
  const allowed = FEATURE_TOOL_SETS[feature] || FEATURE_TOOL_SETS.chat
  return allowed.has(bareName) ? null : { feature, reason: 'feature-tool-out-of-scope' }
}


// ── 全局工具的 schema 级隐藏（2026-10-28）────────────────────────────────────
//
// `tools.restrict()` 能遮掉继承的全局 MCP 工具，但需要 scoped ctx；实测把
// per-feature 名单挂在 apply/pre-step/agent-created 的 ctx 上会在同 workspace 的
// 会话之间泄漏（vision 会话因此丢了 get_forward_msg）。所以这里只保留「所有
// 功能域都不允许」的全局名单在 apply 期隐藏——对任何 feature 都无副作用；
// per-feature 的越界工具仍由执行期 guard 即时拒绝（feature-tool-out-of-scope）。
/** 某 feature 需要从 schema 隐藏的 MCP 工具名（含 mcp__ 前缀）。测试用导出。 */
export function featureSchemaDenyList(feature) {
  const allowed = FEATURE_TOOL_SETS[feature] || FEATURE_TOOL_SETS.chat
  // 以 FLAG_TO_MCP_TOOLS 的全量工具名为底：即使某个工具已经从所有 feature 收窄掉
  // （例如成员列表/历史消息），它仍出现在 DSH 的工具清单里，也必须按会话隐藏。
  const all = new Set()
  for (const names of Object.values(FLAG_TO_MCP_TOOLS)) {
    for (const toolName of names) all.add(toolName)
  }
  const deny = []
  for (const bareName of all) {
    if (!allowed.has(bareName)) deny.push(`mcp__snowluma__${bareName}`)
  }
  if (feature !== 'web') {
    deny.push('mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch')
  }
  // 低频工具的 schema-only 隐藏（2026-11-17）：执行期仍放行（FLAG_TO_MCP_TOOLS 未变），
  // 只是不让模型在每回合清单里看到旧发送入口/记忆清理，省约 4.5KB/域。
  for (const bareName of SCHEMA_ONLY_HIDDEN_MCP_TOOLS) deny.push(`mcp__snowluma__${bareName}`)
  return [...new Set(deny)]
}

/**
 * 所有功能域都不允许的 MCP 工具（成员列表 / 历史消息 / 详情 / 社交状态）。
 * 这些工具已经从 chat/vision/voice/web 的政策里全部移除，因此在 apply 期
 * 就能确定要从 schema 隐藏——不需要等到知道该 session 的 feature。
 */
export function globalSchemaDenyList() {
  const allowed = new Set()
  for (const feature of FEATURES) {
    for (const name of FEATURE_TOOL_SETS[feature] || []) allowed.add(name)
  }
  const deny = []
  for (const names of Object.values(FLAG_TO_MCP_TOOLS)) {
    for (const bareName of names) {
      if (!allowed.has(bareName)) deny.push(`mcp__snowluma__${bareName}`)
    }
  }
  // 宿主侧上下文管理工具：QQ 会话看不到、也不该调用（模型看到就会在上下文变长时反复重试）。
  for (const name of CONTEXT_MANAGEMENT_TOOLS) deny.push(name)
  // 低频工具（旧发送入口 / 记忆清理）：任何 feature 都不放进 schema，装配期即可隐藏。
  for (const bareName of SCHEMA_ONLY_HIDDEN_MCP_TOOLS) deny.push(`mcp__snowluma__${bareName}`)
  return [...new Set(deny)]
}

// 2026-10-28：全局名单的隐藏时机从 apply 挪到 agent/pre-step ——
// MCP 工具在 profile apply 时还没注册进全局层，apply 期 restrict 会全部 unknown；
// pre-step 发生在模型第一个回合之前，此时工具已注册，且 restrict 会作用到该
// agent 继承的全局层，第一回合的 schema 就能收窄。
// 2026-11-12：重试上限 + 增量重试。
// 原来只要有一项藏不掉，`globalSchemaHidden` 就永远不置位，而 pre-step 每回合都跑，
// 于是每个回合都把 12 个 deny 全量重试一遍、永不收敛。实测 8 次 apply-schema 里 4 次
// 卡在 6/12（compress/decompress/search_context/acp_status/acp_cache/
// acp_read_original_image 这 6 个宿主侧上下文工具在 pre-step 时还没注册）。
// 现在：① 只重试上一轮没藏掉的项；② 达到上限后放弃并只记一行，不再每回合刷。
const MAX_SCHEMA_HIDE_ATTEMPTS = 5
let globalSchemaHidden = false
let globalSchemaHideAttempts = 0
let globalSchemaPending = new Set() // 尚未成功隐藏的工具名；空 = 还没试过
function ensureGlobalSchemaHidden(scopedCtx, via) {
  if (globalSchemaHidden) return
  const deny = globalSchemaDenyList()
  if (deny.length === 0) { globalSchemaHidden = true; return }

  if (globalSchemaHideAttempts >= MAX_SCHEMA_HIDE_ATTEMPTS) {
    // 已达上限：停止重试（把标志置位让后续 pre-step 直接短路返回）
    globalSchemaHidden = true
    appendRestrictLog(
      `apply-schema | via=${via} | give-up after ${globalSchemaHideAttempts} attempts | still-visible=${[...globalSchemaPending].join(',') || '-'} | at=${new Date().toISOString()}`
    )
    return
  }

  // 只重试还没藏掉的；首轮跑全量
  const todo = globalSchemaPending.size ? [...globalSchemaPending] : deny
  const failed = []
  let hidden = 0
  for (const name of todo) {
    try { scopedCtx.tools.restrict({ deny: [name] }); hidden += 1 } catch { failed.push(name) }
  }
  globalSchemaPending = new Set(failed)
  globalSchemaHideAttempts += 1

  if (failed.length === 0) {
    globalSchemaHidden = true
    appendRestrictLog(`apply-schema | via=${via} | hidden-global=${deny.length}/${deny.length} | attempts=${globalSchemaHideAttempts} | at=${new Date().toISOString()}`)
    return
  }
  // 只在第一次和达到上限那次留痕，避免每个回合刷日志。
  if (globalSchemaHideAttempts === 1 || globalSchemaHideAttempts === MAX_SCHEMA_HIDE_ATTEMPTS) {
    appendRestrictLog(
      `apply-schema | via=${via} | hidden-global=${deny.length - failed.length}/${deny.length} | attempts=${globalSchemaHideAttempts} | failed=${failed.join(',')} | at=${new Date().toISOString()}`
    )
  }
}

// ── 管理员回合可用的 Agent 本地工具白名单（2026-10-25）──────────────────────
//
// 背景：管理员（ownerQQ）在群聊/私聊里要求「用 pwsh 看一下当前目录」「读一下
// 这个文件」时，模型过去只会回答「我没有工具」——因为 qq-chat 预设根本没有挂载
// 本地工具。现在预设挂载了 pwsh / tool-fs / tool-fs-search（见
// dsh/agent-presets/qq-chat*/agent.cordis.yml），但**只允许管理员回合执行**。
//
// 为什么必须用「白名单」而不是「owner 回合放行所有危险工具」：
//   · 本地工具一旦挂进 preset 就进了**本 agent 自己的注册层**，而
//     `ctx.tools.restrict()` 只过滤继承层（全局/祖先层），对 own-layer 注册
//     无效——所以 schema 里一定看得见这些名字，执行期 guard 是唯一的硬边界。
//   · 若 owner 回合放行整个 LOCAL_EXECUTION_TOOLS，subagent / workflow /
//     terminal / plugin_manager / dsh_snapshot 这些会顺带拿到「派生 agent、
//     装卸插件、改宿主」的能力，远超「跑命令/读写文件」的诉求。
// 因此这里只列「管理员明确要求就能用」的那一组，其余危险工具在 owner 回合
// 也继续拒绝（reason=local-tool-not-in-admin-allowlist）。
//
// 与 preset 实际挂载的工具保持一致：
//   tool-pwsh        → pwsh
//   tool-bash        → bash（非 Windows 部署时替换）
//   tool-fs          → read / read_image / write / edit
//   tool-fs-search   → glob / grep
// test-tool-restrict-guard.mjs 会断言 owner 回合的 bash/read 放行、群友回合拒绝。
export const ADMIN_TURN_LOCAL_TOOL_NAMES = Object.freeze([
  'pwsh', 'bash',
  'read', 'read_image', 'write', 'edit',
  'glob', 'grep',
])

const ADMIN_TURN_LOCAL_TOOL_SET = new Set(ADMIN_TURN_LOCAL_TOOL_NAMES)

// ── 自动唤醒回合的本地工具（2026-10-31 追加）──────────────────────────────
//
// 需求：管理员要「醒了可以看看哪里能改的改改」。此前非 owner 回合一律拒绝本地工具，
// 自动唤醒（timeout / proactiveCheck / replyCheck）没有消息、也算非 owner 回合，
// 于是「醒来做自我升级」这条链路实际上永远断在工具闸门上。
//
// 边界（故意比 owner 回合窄）：
//   · 只对**桥接标记为自动唤醒**的回合生效（turn-sender.json 里 `autoWake: true`，
//     由桥接在投递 wake prompt 前写入；普通群友消息不会带这个标记）；
//   · 只能读写**项目目录内**的路径（默认 `qq-bridge-full/`，可用环境变量
//     QQ_TOOL_RESTRICT_PROJECT_ROOT 覆盖，测试用）；越界一律拒绝；
//   · pwsh/bash 的 workdir 必须在项目目录内，且仍走同一份破坏性命令黑名单；
//   · 不开放 plugin_manager / subagent / terminal 等派生能力；
//   · `config.json` 的 `adminTurnTools.autoWakeLocal=false` 可整条关闭。
//
// 为什么不复用 owner 回合的白名单：owner 回合的语义是「人现在坐在电脑前」，
// 自动唤醒的语义是「没人看着，它自己动手」——后者必须自己能解释改了哪里，
// 所以这里连路径范围都写死。
const AUTO_WAKE_PROJECT_ROOT_ENV = 'QQ_TOOL_RESTRICT_PROJECT_ROOT'

/** 自动唤醒回合允许触碰的本地工具（= owner 白名单原样，但不含 plugin_manager）。 */
const AUTO_WAKE_LOCAL_TOOL_SET = new Set([
  'pwsh', 'bash', 'read', 'read_image', 'write', 'edit', 'glob', 'grep',
])

/** 这些工具的参数里带目标路径，必须做「项目目录内」校验。 */
const AUTO_WAKE_PATH_ARG_TOOLS = Object.freeze({
  read: 'file_path',
  read_image: 'file_path',
  write: 'file_path',
  edit: 'file_path',
  glob: 'path',
  grep: 'path',
  pwsh: 'workdir',
  bash: 'workdir',
})

/** 项目根目录（自动唤醒回合的可写范围）。 */
function autoWakeProjectRoot() {
  const override = String(process.env[AUTO_WAKE_PROJECT_ROOT_ENV] ?? '').trim()
  return override
    ? path.resolve(override)
    : path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
}

/** target 是否落在 root 之内（含 root 本身）。用 resolve+relative 判，避免大小写/尾部斜杠差异。 */
function isPathInsideRoot(root, target) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const rel = path.relative(resolvedRoot, resolvedTarget)
  if (rel === '') return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 自动唤醒回合的路径范围判定。
 * 参数缺省视为「默认工作目录」——DSH 的默认 cwd 是项目内的 state/agents，天然在范围内。
 * 但只给默认值判不安全的是「相对路径 ../..」：一律按 cwd 解析后再比。这里没有 cwd 可用，
 * 所以相对路径按项目根解析，越界（../../x）会被 relative 判成 .. 开头而拒绝。
 */
function autoWakePathVerdict(toolName, args) {
  const argKey = AUTO_WAKE_PATH_ARG_TOOLS[toolName]
  if (!argKey) return { ok: true, detail: '' }
  const raw = args && typeof args === 'object' ? args[argKey] : undefined
  if (raw == null || String(raw).trim() === '') return { ok: true, detail: 'default-workdir' }
  const root = autoWakeProjectRoot()
  const candidate = path.isAbsolute(String(raw)) ? String(raw) : path.join(root, String(raw))
  if (isPathInsideRoot(root, candidate)) return { ok: true, detail: candidate }
  return { ok: false, detail: candidate }
}

// ── 管理员回合可用的「插件装卸」工具白名单（2026-10-25）────────────────────
//
// 需求：管理员在 QQ 里说“装个插件/列一下已安装插件/把某插件关掉”时，模型要能真的
// 调 `plugin_manager`，而不是只会说“请在管理端操作”。
//
// 为什么单独一张名单、不并进 ADMIN_TURN_LOCAL_TOOL_NAMES：
//   · `adminTurnTools.allowLocal=false` 的语义是“关掉本地 shell/文件工具”，
//     装卸插件不属于这个范围（用户可能只想禁本地命令，仍保留插件管理）；
//   · 现有测试与文档都按“本地工具”解释 allowLocal，混进去会让那个开关的含义漂移。
//   因此这里只受总开关 `adminTurnTools.enabled` 控制；allowLocal 不影响它。
//
// ⚠️ 真正的操作边界还有一层：`plugin_manager` 自身要求会话处于
//   danger-full-access，或对**本次调用**通过审批（见 dsh-plugin-manager README）。
//   本 guard 只负责“工具可见 + owner 回合放行”，不改变沙箱/审批策略——在
//   workspace-write 下调用会走审批流程，拿不到审批就失败，这是 DSH 的安全设计。
//
// 工具名核对：`@deepseek-ai/dsh-plugin-manager/tools` 注册的名字是
// `plugin_manager`（不是 plugin-manager / plugin_market；后者属于另一个插件市场包）。
export const ADMIN_TURN_PLUGIN_TOOL_NAMES = Object.freeze([
  'plugin_manager',
])

const ADMIN_TURN_PLUGIN_TOOL_SET = new Set(ADMIN_TURN_PLUGIN_TOOL_NAMES)

// ── 诊断落盘：restrict 失败时到底为什么 ────────────────────────────────────
//
// 为什么必须落盘（2026-10-18 实测）：重启之后新建的 QQ 会话 schema 里，
// `dev_*` **仍然是 18 个**——说明 `ctx.tools.restrict({deny})` 根本没生效，
// 而失败被下面的 per-name try/catch 吞掉了。DSH 的 stderr 不落日志文件（只有启动失败
// 才会写 ~/.dsh/logs），所以「为什么失败」在现网完全不可观测。
//
// 这里把失败原因写到 <repo>/state/tool-restrict.log（有界、只写最近 200 行），
// 并把失败的名字在 3 秒后重试一次：如果只是「注入器比 preset 晚注册」的时序问题，
// 重试就能把工具真正藏掉；如果重试也失败，日志里会留下 DSH 的原始报错，
// 下次排查不用再猜。
//
// 同一份文件还承载**执行期判定日志**（需求 B）：每次 guard 判定写一行
//   allow|deny | tool=... | session=... | sender=... | isOwner=... | reason=... | at=...
// 两类行共用同一个有界上限，靠行首内容区分（restrict 行以时间戳开头，
// 判定行以 allow/deny 开头）。上限从 20 提到 200：判定会频繁写，太小会把
// 启动期的 restrict 诊断挤掉，太大又失去有界性。
/**
 * 判定/诊断日志路径。优先在调用时解析 QQ_TOOL_RESTRICT_LOG；同时记住模块
 * import 时 env 已经设置的值 —— 测试有两类用法：
 *   · 动态 import（import 前设 env，import 后立刻恢复 env）：依赖 import 时快照；
 *   · 静态 import（import 后才在用例里设 env）：依赖调用时读取。
 * 两者都支持，才能既满足测试隔离、又不把测试假工具名写进生产日志。
 */
const importTimeDiagFile = (() => {
  const envFile = process.env.QQ_TOOL_RESTRICT_LOG
  return envFile ? path.resolve(envFile) : ''
})()

function diagFilePath() {
  // 测试可用 QQ_TOOL_RESTRICT_LOG 改到临时文件，避免污染真实 state/
  if (process.env.QQ_TOOL_RESTRICT_LOG) return path.resolve(process.env.QQ_TOOL_RESTRICT_LOG)
  if (importTimeDiagFile) return importTimeDiagFile
  try {
    // 本文件位于 <repo>/plugins/qq-agent-presets/，往上两层就是仓库根
    return fileURLToPath(new URL('../../state/tool-restrict.log', import.meta.url))
  } catch { return '' }
}

/** 诊断/判定日志共用的有界上限（保留最近 N 行）。 */
const LOG_MAX_LINES = 200

/**
 * 启动期 restrict 诊断（「隐藏了 X 个 / 78 个名字未注册 / 失败样例 / 延迟重试」）默认**静默**。
 *
 * 为什么（2026-10-26 实测）：这些行只会说明「expected no-op」（DSH 当前没注册这个名字），
 * 不是守卫失败；但每次 preset apply 都会各写 2~3 行，控制台实时日志里 88% 都是它们。
 * 真正需要留证据的场景——restrict 抛非 unknown 错误——仍然用 console.error + 落盘。
 * 排查插件加载时序时设置 QQ_TOOL_RESTRICT_DEBUG=1 即可恢复全部诊断。
 */
const DEBUG_DIAG = String(process.env.QQ_TOOL_RESTRICT_DEBUG ?? '').trim() === '1'

/**
 * 追加一行到 state/tool-restrict.log（有界、同步、失败静默）。
 *
 * 为什么同步：guard 是同步函数，判定日志不能引入异步竞态；单行 IO 的量级
 * （每次工具调用一次）远小于一次模型往返，值得换「日志一定在」。
 */
function appendRestrictLog(line) {
  const file = diagFilePath()
  if (!file || !line) return
  // 单行截断：DSH 的报错里会把**整份** known global tools 清单拼进去（实测单行 2KB+），
  // 不截就等于把日志变成噪声。判定行本身很短，这个上限只对 restrict 诊断生效。
  const trim = (value) => (value.length > 400 ? `${value.slice(0, 400)}…` : value)
  try {
    let previous = []
    try { previous = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch {}
    const next = [...previous, trim(String(line))].slice(-LOG_MAX_LINES)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, next.join('\n') + '\n', 'utf8')
  } catch {}
}

function writeDiagnostics(lines) {
  if (!lines.length) return
  for (const line of lines) appendRestrictLog(line)
}

// ── 「本回合发送者 == 管理员」例外（2026-10-25 需求 B）───────────────────────
//
// 规则：**插件类工具**（sidebar_open 这类既不是本地危险工具、也不在白名单里的
// 工具）只在「该会话**当前回合**的消息发送者是 ownerQQ」时放行：
//   · 管理员私聊                          → 放行
//   · 管理员在群里发言的那一回合          → 放行
//   · 群友在群里发言的那一回合            → 拒绝
//   · 非管理员私聊                        → 拒绝
//
// 2026-10-25 追加（管理员插件管理）：qq-chat / qq-chat-v2 预设现在也挂载
// `@deepseek-ai/dsh-plugin-manager/tools`，于是 `plugin_manager` 和本地工具一样
// 会出现在每回合 schema 里。guard 对它单独判定（见 ADMIN_TURN_PLUGIN_TOOL_NAMES）：
//   · owner 回合 + enabled → 放行（reason=owner-turn-plugin-tool）；
//   · allowLocal=false 不影响它（那个开关只关本地 shell/文件工具）；
//   · 非 owner 回合 → 拒绝（reason=plugin-tool-closed-agent-only）。
//
// 2026-10-25 追加（管理员本地工具）：qq-chat 预设现在**挂载**了
// pwsh / read / write / edit / glob / grep（见 ADMIN_TURN_LOCAL_TOOL_NAMES）。
// 它们同样按「本回合发送者」判定，但多一道 `adminTurnTools` 开关：
//   · owner 回合 + enabled + allowLocal → 放行（否则模型只会嘴上说“没有工具”）；
//   · 非 owner 回合 → **一律拒绝**，群友不能借用管理员回合；
//   · 本地/插件白名单之外的 subagent / workflow / terminal /
//     dsh_snapshot / dev_* → owner 回合也拒绝（不在授权范围）。
//
// ⚠️ 与旧注释的差异：本地工具不再“永远只允许 closed-agent”。原因是用户明确要求
// 管理员在群聊/私聊里能用 Agent 本地工具。安全边界从“注册期不挂载”改成
// “注册期挂载 + 执行期按回合白名单拒绝”：preset 无法按回合增删工具，
// `tools.restrict()` 也管不到 own-layer 注册，因此 guard 是唯一的硬边界。
// 非管理员调用会得到明确拒绝并落日志（sender/isOwner/reason 都有）。
//
// 数据从哪来：guard 跑在 DSH 进程里，拿不到 QQ 号；桥接在**投递 prompt 前**把
// 本回合的发送者写进 `state/turn-sender.json`：
//   { sessionId, senderId, isOwner, ts,
//     sessions: { "<sessionId>": { sessionId, senderId, isOwner, ts } } }
// 这里只信这份「回合快照」，因此必须逐项校验（任一不满足都 fail-closed 拒绝）：
//   · sessionId：文件按 sessionId 建索引，必须与 `exec.agent.id` 完全一致；
//   · isOwner：必须是布尔 true（不接受 "true"/1 这类宽松真值）；
//   · senderId：必须等于 config.json 的 ownerQQ；
//   · ts：必须落在 [now - 10 分钟, now + 60 秒] 内（60 秒是时钟漂移容差，
//     放太宽就等于给未来时间戳开了绕过 TTL 的口子）；
//   · 文件缺失 / JSON 损坏 / 记录缺失 / 字段缺失 → 一律拒绝。
//
// 多人群共享会话以**最新回合**为准：桥接只覆盖写当前 sessionId 的记录，管理员
// 说完、群友接话的那一回合写进去的 senderId 是群友 → 本回合无权限。
//
// 与旧实现（按 `state/sessions.json` 的 `private:<ownerQQ>` 判定）的差异：
// 旧逻辑只看「这个 sessionId 是不是管理员私聊会话」，因此在群里永远拒绝，
// 而且一旦 DSH 重启换了 sessionId 就会失配。新逻辑改看「这一回合是谁发的」，
// 群聊/私聊统一，且不再依赖 sessions.json。
const TURN_SENDER_FILE_ENV = 'QQ_TOOL_RESTRICT_TURN_SENDER'
const TURN_SENDER_TTL_MS = 10 * 60 * 1000
const TURN_SENDER_CLOCK_SKEW_MS = 60 * 1000

function readJsonFileSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** config.json 路径（测试可用 QQ_TOOL_RESTRICT_CONFIG 指到临时文件）。 */
function configFilePath() {
  return process.env.QQ_TOOL_RESTRICT_CONFIG
    ? path.resolve(process.env.QQ_TOOL_RESTRICT_CONFIG)
    : fileURLToPath(new URL('../../config.json', import.meta.url))
}

/** turn-sender.json 路径（测试可用 QQ_TOOL_RESTRICT_TURN_SENDER 指到临时文件）。 */
function turnSenderFilePath() {
  return process.env[TURN_SENDER_FILE_ENV]
    ? path.resolve(process.env[TURN_SENDER_FILE_ENV])
    : fileURLToPath(new URL('../../state/turn-sender.json', import.meta.url))
}

/** 读 config.json 的 ownerQQ；缺失/非数字返回空串（调用方按拒绝处理）。 */
function readOwnerQQ() {
  const cfg = readJsonFileSafe(configFilePath())
  const ownerQQ = String(cfg?.ownerQQ ?? '').trim()
  return /^\d+$/.test(ownerQQ) ? ownerQQ : ''
}

/**
 * 读 `config.json` 的 `adminTurnTools` 开关（2026-10-25）：
 *   { "adminTurnTools": { "enabled": true, "allowLocal": true } }
 *
 * 语义：
 *   · enabled=false  → 管理员回合也**不放行任何**插件工具/本地工具（安全熔断开关）；
 *   · allowLocal=false → 管理员回合仍可调用已安装插件工具，但本地 shell/文件工具全部拒绝；
 *   · 字段缺失/文件损坏/类型不对 → **默认放行**（默认值就是 enabled=true,
 *     allowLocal=true；只有显式写 false 才关，避免升级后因缺字段把功能悄悄锁死）。
 *   · 非管理员回合根本走不到这里：ownerTurnDecision 已经 fail-closed。
 *
 * 为什么不检查 `enabled` 的类型宽松真值：只有 `=== false` 才算关闭，
 * 与 isOwner 的「必须是布尔 true」保持同一套严格口径，防止 `"false"`/0 之类
 * 被误当成关闭或开启。
 *
 * 2026-10-25 追加：同时把 `blockedCommands`（破坏性命令黑名单配置）原样带出，
 * 让 guard 的一次配置读取同时服务于「开关」与「命令黑名单」两件事——
 * 少读一遍 config.json（guard 是同步函数，每多一次同步 IO 都在工具调用路径上）。
 */
function readAdminTurnToolsConfig() {
  const DEFAULT = { enabled: true, allowLocal: true, autoWakeLocal: true, blockedCommands: undefined }
  const cfg = readJsonFileSafe(configFilePath())
  const raw = cfg?.adminTurnTools
  if (raw === false) return { enabled: false, allowLocal: false, autoWakeLocal: false, blockedCommands: undefined }
  if (raw === true) return DEFAULT
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT
  return {
    enabled: raw.enabled !== false,
    allowLocal: raw.allowLocal !== false,
    autoWakeLocal: raw.autoWakeLocal !== false,
    blockedCommands: raw.blockedCommands,
  }
}

// ── 破坏性命令黑名单（2026-10-25 追加）─────────────────────────────────────
//
// 真实事故：2026-10-25 的一次**管理员回合**群会话里，模型执行了
// `shutdown.exe /s /t 60`，机器真的关机 → NapCat 崩溃/重启。当时的 guard 只看
// **工具名**：`pwsh` 在 ADMIN_TURN_LOCAL_TOOL_NAMES 里 ⇒ 放行；于是「放行 pwsh」
// 实际等于「放行任意命令」。本段补的就是这一层：看 `args.command`。
//
// 为什么拦在 guard，而不是桥接的工具调用拦截层：
//   桥接的 `state/tool-calls.jsonl` 是**事后记录**（DSH 侧执行完才发事件），
//   不在调用路径上，拦不住。而 guard 拿得到参数——已核对本机 DSH 0.2.x 的
//   dsh-tools 实现（`ToolRuntime.prepareExecution`）：它先跑 `tools/pre-execute`
//   瀑布，再对**同一个 exec** 调 `guardReason(exec)`；exec 由 `createExecution()`
//   构造，`arguments` 字段在进 guard 之前就已经 `deepFreeze(snapshotJsonValue())`
//   过了。所以这里读到的 `exec.arguments.command` 就是模型要执行的命令原文。
//
// 判定口径（缺一不可）：
//   1. 只看 `pwsh` / `bash`：两者 schema 里命令参数都叫 `command`
//      （本机 DSH 的 `shellCall(name, args)` 同时处理这两个名字，已核对）。
//   2. 大小写不敏感：统一 lower 后再匹配，`SHUTDOWN` / `Shutdown.Exe` /
//      `RESTART-COMPUTER` 都命中。
//   3. **管理员回合同样拒绝**：命令黑名单不随 isOwner 放行。拒绝写
//      `reason=blocked-command`，日志里带 sender/isOwner/command 片段。
//   4. 正常命令不受影响：命令名前后都有「词边界」——前面不能紧贴标识符字符
//      （`[a-z0-9_-]`），后面必须是收尾字符（空白/引号/`;|&()`/结束）或
//      `.exe` 这类可执行后缀。于是 `Get-Volume | Format-Table` 不命中 `format`，
//      `Get-Content shutdown.log` 不命中 `shutdown`，`9*9` / `Get-Process` 照旧。
//      代价：把危险词当**字面量**搜索（`rg "shutdown" .`）也会被拦——策略层宁可
//      误拦一条 grep，也不能漏掉一次关机。
//   5. 这是**策略层，不是沙箱**：Base64（`-EncodedCommand` 已单独按形态拦）、
//      字符串拼接（`& ("shut"+"down")`）、先写 .ps1 再执行都能绕过正则。
//      真正的强隔离要靠 OS 沙箱/受限账户；本层负责挡住「模型顺手照抄」的那类命令。
//
// 配置（`config.json`，见 {@link buildBlockedCommandRules}）：
//   "adminTurnTools": {
//     "enabled": true,
//     "allowLocal": true,
//     "blockedCommands": ["自定义正则", ...]                  // 数组 = 整体替换内置清单
//     // 或 { "append": ["追加正则"] } / { "replace": [...] } / { "replace": [...], "append": [...] }
//   }
//   缺省 / 非法 / 空数组 → 用内置默认清单（fail-safe：手滑清空不会关掉保护）。

/** 只检查带 shell `command` 参数的工具名（见口径第 1 条）。 */
export const BLOCKED_COMMAND_TOOL_NAMES = Object.freeze(['pwsh', 'bash'])

const BLOCKED_COMMAND_TOOL_SET = new Set(BLOCKED_COMMAND_TOOL_NAMES)

// 命令名**前缀**边界：前面不能紧贴标识符字符。空格、引号、`\`、`/`、`|`、`(` 都可以，
// 所以 `C:\Windows\System32\shutdown.exe`、`& "shutdown.exe"`、`; shutdown` 都会命中。
const CMD_PREFIX = '(?<![a-z0-9_-])'

// 命令名**后缀**边界：结束、空白、引号、shell 分隔符，或可执行后缀。
// 故意**不**接受 `.log` 这类普通扩展名 ⇒ `Get-Content shutdown.log` 不会被误拦。
const CMD_SUFFIX = "(?=$|[\\s\"'|&;()<>,]|\\.(?:exe|com|bat|cmd|ps1)(?=$|[\\s\"'|&;()<>,]))"

/** 参数位收尾（flag 用）：只认空白/引号/分隔符/结束。 */
const ARG_END = "(?=$|[\\s\"'|&;()<>,])"

/** 一个命令名的匹配源（`word` 可以传 `a|b` 这类备选）。 */
function cmdWord(word) {
  return `${CMD_PREFIX}(?:${word})${CMD_SUFFIX}`
}

/**
 * 「同一个命令里同时出现两个 flag」才算命中（顺序无关，允许中间夹别的参数）。
 *
 * 为什么不用「先命中命令名、再在剩余字符串里找 flag」的两段式：guard 是同步的
 * 单次正则判定，两段式要么写状态机、要么引入更多分支，反而更容易出错。这里用
 * 两个 lookahead 在同一个**有界窗口**里分别找 flag，窗口在 `|` `;` `&` 和换行处
 * 截断（默认最多 200 字符），避免把两条不相干的命令拼起来误判。
 */
function flagsTogether(head, first, second, window = 200) {
  const gap = `[^|;&\\n]{0,${window}}`
  return `${head}\\s+(?=${gap}(?:${first}))(?=${gap}(?:${second}))`
}

// PowerShell 参数支持唯一前缀缩写：`-r` / `-rec` / `-recurse` 都成立。
const RECURSE_FLAG = `-(?:r|re|rec|recu|recur|recurs|recurse)${ARG_END}`
const FORCE_FLAG = `-(?:f|fo|for|forc|force)${ARG_END}`
// rm 的短参数常合写（bash 里 `rm -rf`）：只认全由 r/f 组成的 2~4 字符短参数，
// 这样 `-force`（含 o/c/e）不会被当成合写参数而误判成「同时含 r 和 f」。
const RM_COMBINED = `-[rf]{2,4}${ARG_END}`
const DELETE_RECURSE = `(?:${RECURSE_FLAG}|${RM_COMBINED})`
const DELETE_FORCE = `(?:${FORCE_FLAG}|${RM_COMBINED})`

/**
 * 内置默认黑名单（每条是**正则源码**，编译时统一加 `i`）。
 *
 * 覆盖需求里的五类：关机/重启/注销、磁盘/格式化、递归删除、账户/策略、下载执行。
 * 所有条目都在 `test-tool-restrict-guard.mjs` 里跑过正例与反例（正常命令放行）。
 */
export const DEFAULT_BLOCKED_COMMANDS = Object.freeze([
  // ── 关机 / 重启 / 注销 / 启动配置 ────────────────────────────────────────
  cmdWord('shutdown'),            // shutdown、shutdown.exe、SHUTDOWN /S、C:\Windows\System32\shutdown.exe
  cmdWord('restart-computer'),    // Restart-Computer -Force
  cmdWord('stop-computer'),       // Stop-Computer -Force
  cmdWord('logoff'),              // logoff
  cmdWord('bcdedit'),             // bcdedit /set {default} safeboot minimal
  // ── 磁盘 / 格式化 ────────────────────────────────────────────────────────
  cmdWord('format'),              // format D: /q、format.exe；`Format-Table` 不命中（后面是 `-`）
  cmdWord('format-volume'),       // Format-Volume -DriveLetter D
  cmdWord('diskpart'),            // diskpart
  cmdWord('clear-disk'),          // Clear-Disk -Number 1 -RemoveData
  // ── 删除：只拦「递归 + 强制」这一档（单文件删除是正常操作）────────────────
  flagsTogether(cmdWord('rm'), DELETE_RECURSE, DELETE_FORCE),                 // rm -rf / rm -r -f / rm -Recurse -Force
  flagsTogether(cmdWord('(?:remove-item|ri)'), DELETE_RECURSE, DELETE_FORCE), // Remove-Item -Recurse -Force
  flagsTogether(cmdWord('(?:rd|rmdir|del|erase)'), `/s${ARG_END}`, `/q${ARG_END}`), // rd /s /q、del /f /s /q
  // ── 账户 / 策略 ──────────────────────────────────────────────────────────
  `${CMD_PREFIX}net(?:\\.exe)?\\s+user${ARG_END}`,        // net user xxx /add|/delete
  `${CMD_PREFIX}net(?:\\.exe)?\\s+localgroup${ARG_END}`,  // net localgroup administrators xxx /add
  `${CMD_PREFIX}reg(?:\\.exe)?\\s+delete${ARG_END}`,      // reg delete HKLM\... /f
  // ── 下载执行 / 动态求值 ──────────────────────────────────────────────────
  cmdWord('iex'),                      // iwr https://... | iex
  cmdWord('invoke-expression'),        // Invoke-Expression "..."
  `\\|\\s*(?:powershell|pwsh)(?:\\.exe)?${ARG_END}`, // curl https://... | powershell
  // 嵌套外壳 + Base64 载荷：正则看不见载荷内容，只能按形态拦
  `${CMD_PREFIX}(?:powershell|pwsh)(?:\\.exe)?${ARG_END}`
    + `[^|;&\\n]{0,160}-(?:e|ec|enc|enco|encod|encode|encoded|encodedcommand)${ARG_END}`,
])

/** 编译结果缓存：key 是配置段的 JSON 文本，避免每次工具调用都重新编译正则。 */
let blockedCommandCache = { key: '\u0000missing', rules: [] }

/**
 * 把配置里的 `blockedCommands` 解析成「可执行的正则清单」。
 *
 * 语义（缺省一律 fail-safe 回内置默认）：
 *   · 字符串数组                        → **整体替换**默认清单；
 *   · 空数组                            → 视为误配置，**沿用默认清单**（不会关掉保护）；
 *   · `{ append: [...] }`               → 在默认清单后**追加**；
 *   · `{ replace: [...] }`              → 整体替换；
 *   · `{ replace: [...], append: [...] }` → 先替换再追加。
 *
 * @returns {{ rules: Array<{source:string, regex:RegExp}>, notes: string[] }}
 *   `notes` 是给人看的诊断（写进 state/tool-restrict.log），不影响判定。
 */
function buildBlockedCommandRules(raw) {
  const notes = []
  let base = DEFAULT_BLOCKED_COMMANDS.slice()
  let append = []
  if (Array.isArray(raw)) {
    if (raw.length === 0) notes.push('blockedCommands 为空数组，按保守策略仍使用内置默认清单')
    else base = raw.slice()
  } else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.replace) && raw.replace.length > 0) base = raw.replace.slice()
    else if (raw.replace != null) notes.push('blockedCommands.replace 不是非空数组，已忽略')
    if (Array.isArray(raw.append)) append = raw.append.slice()
    else if (raw.append != null) notes.push('blockedCommands.append 不是数组，已忽略')
  } else if (raw != null) {
    notes.push('blockedCommands 既不是数组也不是对象，已忽略并沿用内置默认清单')
  }

  const sources = []
  // 内置条目由本文件生成（`rm` / `Remove-Item` 那两条天然就超过 300 字符），
  // 长度上限只用于**配置里手写**的条目，否则会把默认清单自己裁掉。
  const builtin = new Set(DEFAULT_BLOCKED_COMMANDS)
  for (const item of [...base, ...append]) {
    if (typeof item !== 'string') {
      notes.push(`非字符串条目已忽略: ${String(item).slice(0, 40)}`)
      continue
    }
    const source = item.trim()
    if (!source) continue
    if (source.length > 300 && !builtin.has(source)) {
      notes.push(`过长条目已忽略（>300 字符）: ${source.slice(0, 40)}…`)
      continue
    }
    sources.push(source)
    if (sources.length >= 50) {
      notes.push('条目超过 50 条，多余部分已忽略')
      break
    }
  }

  const rules = []
  for (const source of sources) {
    try {
      rules.push({ source, regex: new RegExp(source, 'i') })
    } catch (error) {
      notes.push(`正则无效已忽略: ${source}（${error?.message ?? error}）`)
    }
  }
  if (rules.length === 0) {
    // 自定义规则一条都不成立 ⇒ 回退内置默认（否则「配错一行」等于关掉整个保护）。
    notes.push('自定义命令黑名单全部无效，回退内置默认清单（fail-safe）')
    for (const source of DEFAULT_BLOCKED_COMMANDS) {
      try { rules.push({ source, regex: new RegExp(source, 'i') }) } catch {}
    }
  }
  return { rules, notes }
}

/** 取（并缓存）当前生效的命令黑名单规则。 */
function compileBlockedCommands(raw) {
  let key
  try { key = JSON.stringify(raw ?? null) } catch { key = String(raw) }
  if (blockedCommandCache.key === key) return blockedCommandCache.rules
  const { rules, notes } = buildBlockedCommandRules(raw)
  blockedCommandCache = { key, rules }
  if (notes.length > 0) {
    const stamp = new Date().toISOString()
    for (const note of notes) appendRestrictLog(`${stamp} blockedCommands: ${note}`)
  }
  return rules
}

/**
 * 命令归一化：只做「不改变语义、但消除常见变体」的处理。
 *   · 全角/弯引号 → ASCII 引号（`“shutdown”` 这类粘贴进来的命令）；
 *   · 全角空格/不换行空格 → 普通空格；
 *   · 统一小写（正则编译时也带了 `i`，这里是第二道保险）。
 */
function normalizeCommandForMatch(command) {
  return String(command)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00a0\u3000]/g, ' ')
    .toLowerCase()
}

/**
 * 命令片段脱敏（写日志/回给模型用）。
 *   · 折叠换行与连续空白（日志必须单行，且不能让人借换行伪造日志行）；
 *   · 去掉控制字符；
 *   · 把 `token=...` / `password: ...` 这类值换成 `***`（日志里不落密钥）；
 *   · 截断到 160 字符。
 */
const COMMAND_SECRET_RE = /((?:token|key|secret|password|passwd|pwd|authorization|cookie|credential)[a-z0-9_-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;|&]+)/gi

function commandSnippet(command) {
  let text = String(command ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  text = text.replace(COMMAND_SECRET_RE, '$1***')
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/**
 * 判定一次调用是否命中破坏性命令黑名单。
 *
 * @param toolName - `exec.name`。
 * @param args - `exec.arguments`（DSH 已 deepFreeze；这里只读）。
 * @returns `{ pattern, hit, snippet } | null`；null 表示放行。
 */
function matchBlockedCommand(toolName, args) {
  if (typeof toolName !== 'string' || !BLOCKED_COMMAND_TOOL_SET.has(toolName)) return null
  if (!args || typeof args !== 'object') return null
  const command = args.command
  if (typeof command !== 'string' || command.trim() === '') return null
  const normalized = normalizeCommandForMatch(command)
  if (!normalized) return null
  const rules = compileBlockedCommands(readAdminTurnToolsConfig().blockedCommands)
  for (const rule of rules) {
    // 规则都用非全局正则（无 g），exec 不会留下 lastIndex 状态。
    const matched = rule.regex.exec(normalized)
    if (matched) {
      return {
        pattern: rule.source,
        hit: String(matched[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
        snippet: commandSnippet(command),
      }
    }
  }
  return null
}

/**
 * 判定「当前回合发送者 == 管理员」是否成立。
 *
 * @param exec - 工具执行上下文（用到 exec.agent.id）。
 * @returns {{allow:boolean, senderId:string, isOwner:boolean, reason:string}}
 *   reason 会原样写进 state/tool-restrict.log，便于排查「为什么这次被拒」。
 */
function ownerTurnDecision(exec) {
  const agentId = exec?.agent?.id
  if (agentId == null || String(agentId).trim() === '') {
    return { allow: false, senderId: '', isOwner: false, reason: 'session-id-missing' }
  }
  const sessionId = String(agentId)
  const ownerQQ = readOwnerQQ()
  if (!ownerQQ) {
    return { allow: false, senderId: '', isOwner: false, reason: 'owner-qq-missing' }
  }
  const store = readJsonFileSafe(turnSenderFilePath())
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    return { allow: false, senderId: '', isOwner: false, reason: 'turn-sender-missing-or-corrupt' }
  }
  const sessions = store.sessions
  const indexed = sessions && typeof sessions === 'object' && !Array.isArray(sessions)
    ? sessions[sessionId]
    : null
  // 兼容「只有顶层一条记录」的形状：此时顶层 sessionId 必须就是当前会话。
  const flat = store.sessionId != null && String(store.sessionId) === sessionId ? store : null
  const record = indexed && typeof indexed === 'object' && !Array.isArray(indexed) ? indexed : flat
  if (!record) {
    return { allow: false, senderId: '', isOwner: false, reason: 'turn-sender-missing-for-session' }
  }
  const senderId = String(record.senderId ?? '').trim()
  const isOwner = record.isOwner
  // 自动唤醒回合（桥接写入的 autoWake 标记）：不是 owner，但允许在项目目录内动本地工具。
  const autoWake = record.autoWake === true
  const ts = Number(record.ts)
  // 记录里自带的 sessionId 也必须一致（防手工拼接/串记录）
  if (record.sessionId != null && String(record.sessionId) !== sessionId) {
    return { allow: false, senderId, isOwner: isOwner === true, autoWake, reason: 'turn-sender-session-mismatch' }
  }
  if (!Number.isFinite(ts)) {
    return { allow: false, senderId, isOwner: isOwner === true, autoWake, reason: 'turn-sender-ts-invalid' }
  }
  const now = Date.now()
  if (ts > now + TURN_SENDER_CLOCK_SKEW_MS) {
    return { allow: false, senderId, isOwner: isOwner === true, autoWake, reason: 'turn-sender-future' }
  }
  if (now - ts > TURN_SENDER_TTL_MS) {
    return { allow: false, senderId, isOwner: isOwner === true, autoWake, reason: 'turn-sender-expired' }
  }
  if (isOwner !== true) {
    return { allow: false, senderId, isOwner: false, autoWake, reason: 'sender-not-owner' }
  }
  if (senderId !== ownerQQ) {
    return { allow: false, senderId, isOwner: true, autoWake, reason: 'sender-mismatch' }
  }
  return { allow: true, senderId, isOwner: true, autoWake, reason: 'owner-turn' }
}

/**
 * 写一行执行期判定日志（需求 B.4）：
 *   allow|deny | tool=... | session=... | sender=... | isOwner=... | reason=... | at=...
 * 未知字段一律写 `-`，不打印任何密钥/令牌。
 *
 * `detail` 是可选追加段（例如命令黑名单的 `| hit=... | command=...`），**插在
 * `reason=` 与 `at=` 之间**：既有测试/日志解析都按「reason=... | at=」的邻接关系
 * 匹配，把新字段放到 reason 之后、at 之前，老格式一行都不用改。
 */
function logGuardDecision(verdict, name, sessionId, senderId, isOwner, reason, detail = '') {
  const ownerFlag = isOwner === true ? 'true' : (isOwner === false ? 'false' : '-')
  appendRestrictLog(
    `${verdict} | tool=${name || '-'} | session=${sessionId || '-'} | sender=${senderId || '-'}`
    + ` | isOwner=${ownerFlag} | reason=${reason}${detail ? ` ${detail}` : ''} | at=${new Date().toISOString()}`
  )
}

export function apply(ctx) {
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  const stamp = new Date().toISOString()
  const failed = []
  const attempt = (names) => {
    let ok = 0
    for (const name of names) {
      try {
        ctx.tools.restrict({ deny: [name] })
        ok += 1
      } catch (error) {
        const message = String(error?.message ?? error)
        // `unknown global tool "x"` 表示这个 DSH 当前根本没有注册该名字 ——
        // 没有东西可隐藏，属于**预期的 no-op**，不是守卫失败。把两者分开记，
        // 否则 4/82 成功、78 个名字未注册的正常情况会在控制台显示成红色错误。
        failed.push({ name, message, unknown: /unknown global tool/i.test(message) })
      }
    }
    return ok
  }

  const firstOk = attempt(KNOWN_DANGEROUS_GLOBAL_TOOLS)
  const firstFailed = failed.slice()
  failed.length = 0

  if (firstFailed.length > 0) {
    const reasons = [...new Set(firstFailed.map((f) => f.message))]
    const unknownFailed = firstFailed.filter((f) => f.unknown)
    const realFailed = firstFailed.filter((f) => !f.unknown)
    // 真正的 restrict 失败（权限/时序/协议错误）才用 error；unknown 只是名字不存在。
    if (realFailed.length > 0) {
      const realReasons = [...new Set(realFailed.map((f) => f.message))]
      console.error(
        `[qq-tool-restrict] restrict 失败 ${realFailed.length}/${KNOWN_DANGEROUS_GLOBAL_TOOLS.length}：${realReasons.join(' | ')}`
      )
    } else {
      // unknown 只是「DSH 当前没注册这个名字」的预期 no-op：默认静默，避免刷屏。
      if (DEBUG_DIAG) {
        const sample = unknownFailed.slice(0, 4).map((f) => f.name).join(', ')
        console.info(
          `[qq-tool-restrict] 已隐藏 ${firstOk}/${KNOWN_DANGEROUS_GLOBAL_TOOLS.length} 个工具；`
          + `${unknownFailed.length} 个名字当前 DSH 未注册（无需隐藏：${sample}${unknownFailed.length > 4 ? '…' : ''}，执行期白名单仍生效）`
        )
      }
    }
    // 只有「真失败」或显式调试才落盘诊断；unknown-only 的 no-op 不再写文件（控制台会 tail 它）。
    if (realFailed.length > 0 || DEBUG_DIAG) {
      writeDiagnostics([
        `${stamp} restrict ok=${firstOk} failed=${firstFailed.length}（unknown=${unknownFailed.length} real=${realFailed.length}）原因: ${reasons.join(' | ')}`,
        `${stamp} 失败样例: ${firstFailed.slice(0, 3).map((f) => f.name).join(', ')}`,
      ])
    }
    // 时序兜底：注入器的工具可能在 preset apply 之后才注册进全局层。
    // 3 秒后重试失败项；成功则记一行，失败保留原因。
    const timer = setTimeout(() => {
      let ok = 0
      const still = []
      for (const { name } of firstFailed) {
        try { ctx.tools.restrict({ deny: [name] }); ok += 1 } catch (error) { still.push(`${name}: ${error?.message ?? error}`) }
      }
      if (ok > 0 && DEBUG_DIAG) console.info(`[qq-tool-restrict] 延迟重试补藏成功 ${ok} 个`)
      // 仍然失败的项若是 unknown-only，也没有诊断价值：只在真失败/调试时落盘。
      if (realFailed.length > 0 || DEBUG_DIAG) {
        writeDiagnostics([
          `${new Date().toISOString()} 延迟重试 ok=${ok} 仍失败=${still.length}${still.length ? ` 原因: ${still[0]}` : ''}`,
        ])
      }
    }, 3000)
    timer?.unref?.()
  }

  // 1b) 全局工具的 schema 隐藏（2026-10-28）：apply 期 MCP 工具还没注册进全局层，
  //     直接 restrict 会全部报 unknown；改到 agent/pre-step（模型第一个回合之前）
  //     用 apply 时捕获的 schemaCtx 执行一次，成功后静默，失败最多记录一次。
  const schemaCtx = ctx
  try {
    ctx.on('agent/pre-step', async function (payload, next) {
      try {
        ensureGlobalSchemaHidden(schemaCtx, 'pre-step')
      } catch (error) {
        appendRestrictLog(
          `apply-schema-error | via=pre-step | err=${String(error?.message ?? error).slice(0, 160)} | at=${new Date().toISOString()}`
        )
      }
      return next()
    })
  } catch (error) {
    appendRestrictLog(
      `apply-schema-listener-failed | err=${String(error?.message ?? error).slice(0, 160)} | at=${new Date().toISOString()}`
    )
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  //
  // 判定顺序（需求 B + 2026-10-25 管理员本地工具）：
  //   ① 白名单内（QQ MCP / 无害模型侧工具）→ 放行（reason=safe-tool）
  //   ② 本回合发送者判定（ownerTurnDecision，fail-closed）——只对非 safe 工具做，
  //      避免每调一次 QQ 工具都读一遍 turn-sender.json。
  //   ③ 本地工具白名单（pwsh/bash/read/write/edit/glob/grep…）：
  //        owner 回合 + adminTurnTools.enabled + allowLocal → 放行
  //          （reason=owner-turn-local-tool）
  //        owner 回合但开关关闭 → 拒绝（reason=admin-turn-tools-disabled /
  //          admin-local-tools-disabled）
  //        非 owner → 拒绝（reason=local-tool-closed-agent-only）
  //   ③-c 破坏性命令黑名单（pwsh/bash 的 args.command，2026-10-25）：
  //        权限已通过后**再按参数拒一次**，owner 回合也拦（reason=blocked-command，
  //        日志带 hit/command 片段）。见 DEFAULT_BLOCKED_COMMANDS 上方的长注释。
  //   ③b 插件装卸白名单（plugin_manager）：
  //        owner 回合 + adminTurnTools.enabled → 放行（reason=owner-turn-plugin-tool）；
  //        **不受 allowLocal 影响**（allowLocal 只关本地 shell/文件工具）；
  //        非 owner → 拒绝（reason=plugin-tool-closed-agent-only）。
  //   ④ 其余危险工具（subagent/workflow/terminal/dsh_snapshot/dev_*…）：
  //        即使 owner 回合也拒绝（reason=local-tool-not-in-admin-allowlist）——
  //        它们能派生 agent、改宿主，不属于「跑命令/读写文件/装卸插件」的授权范围。
  //   ⑤ 其余 = 插件类工具（sidebar_open 等）：
  //        owner 回合 + adminTurnTools.enabled → 放行（reason=owner-turn）
  //        开关关闭 → 拒绝（reason=admin-turn-tools-disabled）
  //        非 owner/数据缺失 → 拒绝（reason 写明是 sender-not-owner 还是文件问题）
  //
  // ⚠️ 非 owner 回合**永远**拒绝本地工具：群聊里其他成员不能借用管理员回合；
  //    turn-sender.json 是按 sessionId + senderId + isOwner + ts 四重校验的，
  //    日志里 `sender=` 会写明这一回合到底是谁，便于事后审计。
  // 每次判定都写一行 state/tool-restrict.log。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : ''
    if (typeof name !== 'string' || name.length === 0) {
      logGuardDecision('deny', '', sessionId, '', null, 'invalid-tool-name')
      return '工具名无效，已拒绝'
    }
    // 五套功能会话的独立工具面：MCP 工具是 profile 级共享的，schema 里每套都能看见；
    // 这里按「exec.agent.id → sessions.json 里的 variant」在执行期做硬门禁。
    // 非 reserved2 / 未映射会话 / features.enabled=false 时返回 null，完全保持旧行为。
    const featureGate = featureToolGate(name, sessionId)
    if (featureGate) {
      const label = FEATURE_LABELS[featureGate.feature] || featureGate.feature
      logGuardDecision('deny', name, sessionId, '', null, featureGate.reason, `| feature=${featureGate.feature}`)
      return `工具 "${name}" 不在当前「${label}」功能会话的可用范围内（reason=${featureGate.reason}）。`
        + `五套功能会话的工具面彼此独立：表情包只给表情包工具、看图只给看图工具、联网只给搜索工具。`
        + `如果确实需要该能力，请管理员用 /sticker、/vision、/voice、/web 指定对应会话后再调用。`
    }
    if (SAFE_EXACT.has(name) || SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      logGuardDecision('allow', name, sessionId, '', null, 'safe-tool')
      return
    }

    // 本回合发送者判定：任何非 safe 工具都要先过这一关（fail-closed）。
    const decision = ownerTurnDecision(exec)
    const adminCfg = readAdminTurnToolsConfig()
    const logVerdict = (verdict, reason) => logGuardDecision(
      verdict, name, sessionId, decision.senderId, decision.isOwner, reason,
    )

    // ③ 管理员回合的 Agent 本地工具白名单。
    if (ADMIN_TURN_LOCAL_TOOL_SET.has(name)) {
      if (!decision.allow) {
        // ③-a 自动唤醒回合：没有新消息、也不是 owner，但桥接标记了 autoWake。
        // 只放行「项目目录内」的读写/搜索/shell，其余照旧拒绝。
        if (decision.autoWake === true && adminCfg.enabled && adminCfg.autoWakeLocal && AUTO_WAKE_LOCAL_TOOL_SET.has(name)) {
          const wakeBlocked = matchBlockedCommand(name, exec?.arguments)
          if (wakeBlocked) {
            logGuardDecision('deny', name, sessionId, decision.senderId, decision.isOwner, 'blocked-command',
              `| autoWake=1 | hit=${wakeBlocked.hit || '-'} | command=${wakeBlocked.snippet}`)
            return `命令被拒绝（reason=blocked-command）：命中破坏性命令黑名单「${wakeBlocked.hit || wakeBlocked.pattern}」。`
              + `自动唤醒回合更不能关机/重启/格式化。命令片段：${wakeBlocked.snippet}。`
          }
          const scope = autoWakePathVerdict(name, exec?.arguments)
          if (!scope.ok) {
            logGuardDecision('deny', name, sessionId, decision.senderId, decision.isOwner, 'autowake-path-out-of-scope',
              `| autoWake=1 | target=${scope.detail}`)
            return `工具 "${name}" 已拒绝：自动唤醒回合只能操作项目目录内的路径（reason=autowake-path-out-of-scope）。`
              + `被拒路径：${scope.detail}。请在项目目录内改代码；系统目录、其它盘的路径一律不允许。`
          }
          logGuardDecision('allow', name, sessionId, decision.senderId, decision.isOwner, 'autowake-local-tool',
            `| autoWake=1 | target=${scope.detail || '-'}`)
          return
        }
        logVerdict('deny', 'context-management-disabled')
        if (CONTEXT_MANAGEMENT_TOOLS.includes(name)) return `工具 "${name}" 已禁用：上下文压缩由系统自动处理，不要重试，也不要向对方解释这件事。`
        logVerdict('deny', 'local-tool-closed-agent-only')
        return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（本地执行/文件类工具仅管理员本回合可用）`
      }
      if (!adminCfg.enabled) {
        logVerdict('deny', 'admin-turn-tools-disabled')
        return `工具 "${name}" 已拒绝：config.json 的 adminTurnTools.enabled=false（管理员回合工具总开关已关闭）`
      }
      if (!adminCfg.allowLocal) {
        logVerdict('deny', 'admin-local-tools-disabled')
        return `工具 "${name}" 已拒绝：config.json 的 adminTurnTools.allowLocal=false（管理员回合本地工具已关闭）`
      }
      // ③-c 破坏性命令黑名单（2026-10-25）：**工具名放行 ≠ 命令放行**。
      // 这一步故意放在「权限已通过」之后：非管理员回合本来就轮不到执行命令，
      // 日志里也应优先写权限原因（local-tool-closed-agent-only），避免掩盖越权。
      // 管理员回合命中黑名单时仍然拒绝——这是需求里「管理员回合也禁止」的落点。
      const blockedCommand = matchBlockedCommand(name, exec?.arguments)
      if (blockedCommand) {
        logGuardDecision('deny', name, sessionId, decision.senderId, decision.isOwner, 'blocked-command',
          `| hit=${blockedCommand.hit || '-'} | command=${blockedCommand.snippet}`)
        return `命令被拒绝（reason=blocked-command）：命中破坏性命令黑名单「${blockedCommand.hit || blockedCommand.pattern}」。`
          + `关机/重启/注销/格式化/删盘/改账户/下载执行类命令即使在管理员回合也不允许执行。`
          + `命令片段：${blockedCommand.snippet}。`
          + `如确需执行，请管理员改 config.json 的 adminTurnTools.blockedCommands（对话内无法授权）。`
      }
      logVerdict('allow', 'owner-turn-local-tool')
      return
    }

    // ③b 管理员回合的插件装卸工具（plugin_manager）：只受 enabled 控制，
    // allowLocal=false 不影响（见 ADMIN_TURN_PLUGIN_TOOL_NAMES 的说明）。
    if (ADMIN_TURN_PLUGIN_TOOL_SET.has(name)) {
      if (!decision.allow) {
        logVerdict('deny', 'plugin-tool-closed-agent-only')
        return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（插件装卸工具仅管理员本回合可用）`
      }
      if (!adminCfg.enabled) {
        logVerdict('deny', 'admin-turn-tools-disabled')
        return `工具 "${name}" 已拒绝：config.json 的 adminTurnTools.enabled=false（管理员回合工具总开关已关闭）`
      }
      logVerdict('allow', 'owner-turn-plugin-tool')
      return
    }

    // ④ 不在本地/插件白名单里的危险工具：owner 也不放行（防「顺手」拿到派生 agent 等能力）。
    if (DANGEROUS_TOOL_NAME_SET.has(name)) {
      if (decision.allow) {
        logVerdict('deny', 'context-management-disabled')
        if (CONTEXT_MANAGEMENT_TOOLS.includes(name)) return `工具 "${name}" 已禁用：上下文压缩由系统自动处理，不要重试，也不要向对方解释这件事。`
        logVerdict('deny', 'local-tool-not-in-admin-allowlist')
        return `工具 "${name}" 不在管理员回合的本地工具白名单内，已拒绝`
      }
      logVerdict('deny', 'local-tool-closed-agent-only')
      return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（本地执行/文件类工具仅管理员本回合可用）`
    }

    // ⑤ 插件类工具（sidebar_open 等）：只认「本回合发送者 == 管理员」。
    if (decision.allow) {
      if (!adminCfg.enabled) {
        logVerdict('deny', 'admin-turn-tools-disabled')
        return `工具 "${name}" 已拒绝：config.json 的 adminTurnTools.enabled=false（管理员回合工具总开关已关闭）`
      }
      logVerdict('allow', 'owner-turn')
      return
    }
    logVerdict('deny', decision.reason)
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具；插件类工具仅管理员本回合可用）`
  })
}
