QQ Bridge 便携包 0.2.1-r1（2026-11-23）
========================================

这是一个「QQ <-> DeepSeek Harness」桥接的完整部署包，解压即可用（已带 node_modules）。

第一次用，按这个顺序看：
  1. DEPLOY.md            —— 部署手册（先看第 0～2 节，再照着做）
  2. PLUGIN_ADDRESSES.md  —— 插件从哪里来、npm/GitHub 地址
  3. THINKING_AND_MEMORY.md —— 思考过程（reasoning）与记忆模式（memory）怎么开、怎么看
  4. HANDOFF_PROMPT.md    —— 想让另一个 DSH 帮你部署时，把里面的提示词整段发给它

最短流程：
  cd C:\qq-bridge
  Copy-Item config.example.json config.json   # 改 ownerQQ / allow / dsh / snowluma
  node scripts/setup-dsh.mjs web              # 注册 preset + MCP
  （重启 DSH）
  .\start.bat                                 # 起桥接
  .\start-console.bat                          # 起控制台
  node scripts/deploy-check.mjs                # 自检

前置：Windows x64、Node >= 22.13、DeepSeek Harness、SnowLuma（QQ 网关）。
需要你本人：QQ 扫码登录、确认 ownerQQ 与白名单。

注意：
  - 本包不含 config.json / state/ / token / QQ 数据；这些在新机器上生成。
  - config.example.json 里的 QQ 号是示例，必须换成你自己的。
  - 白名单为空时谁都不理（安全设计，不是 bug）。
  - 详细排错见 DEPLOY.md 第 13 节与 docs/DEPLOY_HANDOFF.md。

包校验：见发布目录（zip 旁）的 SHA256SUMS.txt。
