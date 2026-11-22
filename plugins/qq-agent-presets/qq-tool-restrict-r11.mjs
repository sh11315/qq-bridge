// qq-tool-restrict 的版本化壳（2026-11-03 r11）。
//
// r10 → r11：宿主上下文管理工具（compress/decompress/search_context/acp_*）加入
// schema 隐藏名单；执行期命中时返回「已禁用、不要重试」，避免模型在上下文触顶时
// 连续重试 compress（2026-11-02 群会话实测）。
export * from './qq-tool-restrict.mjs?v=20261103-context'
