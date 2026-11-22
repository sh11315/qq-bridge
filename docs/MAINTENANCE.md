# QQ Bridge 维护手册（fork 版）

本文件记录当前 fork 的维护基线、已修问题和后续路线。上游 `Derpyu520/qq-bridge` 已于 2026-11-18 归档，SnowLuma 已停服；这里只维护现有部署和可复盘的代码，不承诺新部署可用。

## 1. 门禁

每次改动至少跑：

```powershell
node scripts/test-audit.mjs          # 当前 44/44
node scripts/test-console-security.mjs
node scripts/test-tool-restrict-guard.mjs
```

发布包另外做：

1. 个人 QQ / `C:\Users\example` / `/Users/example/` 扫描必须 0 命中。
2. 包内不能有 `config.json`、`state/`、`integrations/`、`audio/`、`napcat/`、`backups/`。
3. 重打 zip 后用 `ZipFile` 检查反斜杠路径为 0。

## 2. 已修（2026-11-23）

| 问题 | 修法 | 提交 |
|---|---|---|
| 7788 无鉴权 / token 进 `/go` Location / 无 CSP | 回环 Host、token 门禁、HttpOnly cookie、CSP；`/go` 只 302 | `d16c2ac` |
| 非 owner 斜杠命令抢话 | 只在被 @/引用/叫名字时回提示 | `7149ea5` |
| autoWakeLocal 默认 true | 默认 false，显式 opt-in | `f8ab33d` |
| 备份含 console-token / agentToken | 跳 `console-token`，JSON 备份脱敏 | `f8ab33d` |
| 启动器绕过 state ACL | spawn 前跑 `harden-state-acl.mjs` | `f8ab33d` |
| `dshCli` 可指向任意脚本 | 校验 DSH 安装目录与 `cli.js` 形状 | `f8ab33d` |
| `/api/model` 暴露 authToken | 返回前 `maskSecrets` | `f8ab33d` |
| 控制台切模式冲掉对账字段 | 先让桥接写；离线时才合并写 | `fbfd64c` |
| 审计 harness 注入失配会真跑 main() | 注入前/后断言 marker 与关键绑定 | `e639238` |
| 恢复备份不限制大小 | 单文件 50MB、总量 512MB 上限 | `e639238` |
| 配置无版本号/无校验 | 加 `schemaVersion` + 只读校验器（只告警，不改文件） | 本轮 |
| 日志泄露 token / Authorization / Cookie / QQ 号 / 绝对路径 | 共享 `redactLogText()`；console 与 bridge 统一接入 | 本轮 |

## 3. 未修 / 待决策

- **R10 管理员登录任务**：显式 opt-in，不作为默认攻击面。
- **R13 agentToken 进提示词**：工具调用需要，考虑按会话短期 token。
- **配置无 schema/版本/迁移**：`config.json` 字段缺失会静默走默认值，是下一次行为突变的主要来源。
- **双控制台重复路由**：桥接内联与 `console/server.mjs` 各一套，长期需要收敛。
- **`bridge.js` 巨石 `main()`**：测试依赖 vm 注入，拆分前先补模块边界测试。

## 4. 路线

### 短期（先做）

1. ~~只读校验器~~ 已完成：`node scripts/validate-config.mjs`；`start.bat` 启动前跑一次，`console/server.mjs` 启动时把警告计数写进日志。迁移器仍待做。
2. ~~R12：统一日志脱敏函数~~ 已完成：`src/log-redact.js`，console 与 bridge 的日志/报错统一走 `redactLogText()`。
3. ~~审计 harness 回归测试~~ 已完成：`scripts/test-audit-harness-guard.mjs`。

### 中期

1. 配置迁移器：`schemaVersion` 递增 + 幂等迁移 + 迁移前自动备份。
2. 原子写助手统一到 console 与 bridge，替换裸 `writeFileSync`。
3. 把 `console/server.mjs` 的 config/session/log 路由改为代理桥接，删重复实现。

### 长期

1. 按连接层 / 会话层 / 媒体层 / 控制台 API 四块拆 `bridge.js`。
2. 每拆一块先补行为测试，再删 vm 注入依赖。
3. 拆完后把 `test:audit` 从 44 个脚本逐步改成真实模块测试。

## 5. 发布流程

1. 源码提交（`qq-bridge-full`）。
2. 复制到 `qq-bridge-release/qq-bridge`，做脱敏扫描。
3. 跑发布包 `test-audit`。
4. 重打便携 zip + handoff，更新 `SHA256SUMS.txt`。
5. 复制到 `publish`，提交并推送；替换 Release 附件。
6. 运行中的 7788/3100 进程需要重启才生效。
