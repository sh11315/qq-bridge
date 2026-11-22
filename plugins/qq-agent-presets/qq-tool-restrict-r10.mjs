// qq-tool-restrict 的版本化壳（2026-10-28 r10）。
//
// DSH 的 preset 行按模块 URL 缓存 ESM：只改被 re-export 的实现文件，运行中的 DSH
// 进程仍会复用旧的模块实例。要让它加载新代码，必须更换壳的文件名（或壳内部
// `?v=` 至少对「壳自己」是新的），这就是这里的 rNN 断点。
//
// 为什么指向版本化壳：DSH 的 profile HMR / preset 热加载只会重新 import
// 「preset patch 行里写的模块 URL」。实现文件本身被缓存后不会重新求值，
// 因此每改一次实现就把壳升一位，并在 build-agent-preset-patches.mjs 里同步
// GUARD_SPECIFIER。
//
// r9 → r10：apply 期 MCP 工具还没注册进全局层（restrict 全报 unknown），
// 改为在 agent/pre-step（模型第一回合之前）用 apply 捕获的 ctx 执行一次
// 「全局无用工具」隐藏；per-feature 名单不再做 schema 收窄（会跨会话泄漏）。
export * from './qq-tool-restrict.mjs?v=20261031-autowake-local'
