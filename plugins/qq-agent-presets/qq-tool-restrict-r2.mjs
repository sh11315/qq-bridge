// 版本化 re-export 壳：让 DSH 在**不重启进程**的情况下拿到 qq-tool-restrict 的新实现。
//
// 背景：DSH 的 profile HMR 会重新读取 preset patch 并重新装配 preset 行，但它按
// 模块 URL 缓存 ESM —— 只要行名还是 `qq-agent-presets/qq-tool-restrict.mjs`，
// 重新装配拿到的仍是旧模块实例（2026-10-25 实测：新加的 plugin_manager 工具
// 已经出现在 schema 里，guard 却还是旧白名单）。
//
// 本壳用带查询串的相对说明符 import 唯一实现：URL 变了 ⇒ ESM 重新求值 ⇒ 新代码
// 生效，而实现仍然只有 `qq-tool-restrict.mjs` 一份。DSH 真正重启后这个壳可以删，
// 把 build-agent-preset-patches.mjs 的 GUARD_SPECIFIER 改回原名即可（行为不变）。
//
// ⚠️ 改实现时**不需要**改这里；只有「想让已经缓存过的 DSH 进程重新加载」才需要
// 把版本号往上加一位。
// 2026-10-25：破坏性命令黑名单（blockedCommands）落地，版本号跟着加一位。
// 2026-10-26：五套功能会话的独立工具面（feature-tool-out-of-scope）落地，再加一位。
// 2026-10-28：功能会话的 schema 级工具隐藏 + chat 工具面收窄，再加一位。
export * from './qq-tool-restrict.mjs?v=20261028-schema-tools'
