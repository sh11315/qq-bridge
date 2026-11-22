// 版本化 re-export 壳（r4）：让 DSH 在不重启进程时拿到新版守卫实现。
//
// 背景：DSH 的 ESM 模块按 URL 缓存。
//   · preset 行名不变 → 壳模块命中缓存；
//   · 壳内部 `?v=` 只在首次 import 时固定子 URL；
//   · 守卫内部相对 import 的 feature-sessions.mjs 也会按 URL 缓存。
// 所以每次要实现/政策热更新，就新开一个壳文件名（r3 → r4 …），并在守卫里
// 给 feature-sessions import 带上对应版本串。DSH 真正重启后可改回 r2/清理。
export * from './qq-tool-restrict.mjs?v=20261028-schema-tools4'
