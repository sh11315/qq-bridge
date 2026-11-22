# QQ Bridge Console 本机代码签名

## 证书

| 项目 | 值 |
| --- | --- |
| 主题 | `CN=QQ Bridge Console (Local), O=QQ Bridge, C=CN` |
| 指纹 (SHA-1) | `9479DAD7966D395D6338BBE6933977B9F5B2DD77` |
| 有效期 | 2026-10-27 17:19:18 ～ 2031-10-27 17:19:18（本机时间） |
| 私钥 | `Cert:\CurrentUser\My\9479DAD7966D395D6338BBE6933977B9F5B2DD77`（仅当前 Windows 用户，未导出 PFX） |
| 信任位置 | `Cert:\CurrentUser\Root` 与 `Cert:\CurrentUser\TrustedPublisher` |
| 公钥证书 | `signing\QQBridgeConsole-Local.cer` |

证书只安装在当前用户（DESKTOP-6BPQ3B6\1）的证书存储中，没有写入 LocalMachine，因此安装和签名都不需要 UAC。

## 签名与验证

```powershell
# 重新签名（exe 不能被占用；控制台 7788 可以继续运行）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "C:\qq-bridge\desktop-app\signing\Sign-QQBridgeConsole.ps1"

# 验证
Get-AuthenticodeSignature `
  "C:\qq-bridge\desktop-app\QQBridgeConsole.exe" |
  Format-List Status, StatusMessage, SignerCertificate
```

脚本使用 SHA-256 和 DigiCert 时间戳（`http://timestamp.digicert.com`）；时间戳服务不可用时会自动重试为不带时间戳的签名。

## 本次修复（2026-10-27 18:34 构建）

现象：桌面快捷方式启动后，Edge 窗口只显示白页，标题/地址栏是 `127.0.0.1/`（丢了 `7788` 端口）；而手动执行同一条
`wscript.exe open-edge.vbs <edge> "http://127.0.0.1:7788/" <profile> 1620 1020` 却正常。

排查结论（两步）：

1. **传参本身没有丢端口。** 用检测脚本让 `open-edge.vbs` 回写 `WScript.Arguments`，wscript 收到的 arg1 就是
   `http://127.0.0.1:7788/`；msedge 进程命令行同样是 `--app="http://127.0.0.1:7788/"`。白页时页面没有
   renderer 子进程，Edge 在“没有 renderer、没有页面标题”时会退回显示 URL，并把端口省掉，于是看起来像丢了端口。
2. **真正的根因是强制完整性标签（Mandatory Integrity Level）。** 本机 `C:\qq-bridge`
   整个目录被 `icacls` 标成了 `Low`（`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`），新编译的
   `QQBridgeConsole.exe` 继承了 `Low` 标签。Windows 会按文件标签以**低完整性**启动它（实测 launcher 进程
   `S-1-16-4096`），wscript/Edge 继续继承低完整性；低完整性 Edge 无法创建 renderer、也无法正常写 profile，
   于是出现白页。手动从普通（Medium）终端调用 wscript 时，wscript 是 Medium，Edge 正常，所以“手动同参数能开”。

修复内容：

- `launcher.cs`：新增 `QuoteArgument()`，按 `CommandLineToArgvW` 规则给 wscript 的每个实参统一加双引号并转义
  反斜杠（URL 也变成 `"http://127.0.0.1:7788/"`）；同时把最终命令行写进 `launcher.log`，方便下次排查。
  .NET Framework 4.x 没有 `ProcessStartInfo.ArgumentList`，所以用等价的手工转义。
- `Sign-QQBridgeConsole.ps1`：签名后自动执行 `icacls <exe> /setintegritylevel Medium`。**重新编译后必须走这个脚本**，
  否则新 exe 会再次继承目录的 Low 标签，问题复发。

验证证据（2026-10-27 18:34:59：双击 `C:\Users\example\Desktop\QQ Bridge 控制台.lnk`）：

| 检查项 | 结果 |
| --- | --- |
| launcher 进程完整性 | `S-1-16-8192`（Medium） |
| Edge 主进程 | `--app="http://127.0.0.1:7788/"`，有 2 个 renderer 子进程 |
| Edge 窗口标题 | `QQ Bridge 统一控制台`（不是 `127.0.0.1/`） |
| 控制台健康检查 | `http://127.0.0.1:7788/api/health` 返回 `{"ok":true,...}` |
| 其他服务 | 3100 / 3080 / 3001 仍在监听，未重启 |
| 截图 | `desktop-app\backups\verify-shortcut-20261027.png` |

## 最终签名结果（2026-10-27 18:34 构建）

| 项目 | 值 |
| --- | --- |
| Status | `Valid` |
| 签名者 | `CN=QQ Bridge Console (Local), O=QQ Bridge, C=CN` |
| 指纹 | `9479DAD7966D395D6338BBE6933977B9F5B2DD77` |
| 时间戳 | `CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1`（带时间戳） |
| 完整性标签 | `Mandatory Label\Medium Mandatory Level:(NW)` |
| 文件大小 | 67,048 字节（签名后） |
| SHA-256 | `6401071103B8B9B829208C11C971EFC51BD41C4DDA3C91D84580949D4474098A` |

启动实测：2026-10-27 18:34:59 通过桌面快捷方式启动，`QQBridgeConsole.exe` 进程正常启动且为 Medium 完整性，
控制台窗口标题为「QQ Bridge 统一控制台」，`http://127.0.0.1:7788/` 返回 HTTP 200；没有「打开文件 - 安全警告」
或 SmartScreen 窗口。修复前的 exe、launcher.cs 与日志备份在 `desktop-app\backups\launcher-fix-20261027-175713\`。

## 撤销 / 恢复

在当前用户 PowerShell 中执行（无需管理员）：

```powershell
$tp = '9479DAD7966D395D6338BBE6933977B9F5B2DD77'
Remove-Item "Cert:\CurrentUser\TrustedPublisher\$tp" -Force -ErrorAction SilentlyContinue
Remove-Item "Cert:\CurrentUser\Root\$tp"             -Force -ErrorAction SilentlyContinue
Remove-Item "Cert:\CurrentUser\My\$tp"               -Force -ErrorAction SilentlyContinue
```

- 删除 `Root` / `TrustedPublisher` 后，exe 上的 Authenticode 签名会变成不受信任（`UntrustedRoot` 等），发布者名称不再被系统信任。
- 删除 `My` 会同时删除私钥，之后无法再签；需要重新生成证书。
- 也可用 `certmgr.msc` 图形界面删除“个人 / 受信任的根证书颁发机构 / 受信任的发布者”中的对应证书。
- 要彻底回到“无签名”状态，重新编译 exe 最干净；`Set-AuthenticodeSignature` 本身没有提供删除签名参数（本机也没有安装 Windows SDK 的 `signtool`）。

## 注意事项

- **自签名证书只在本机、当前用户下受信任。** 换 Windows 用户或换机器时，需要把 `QQBridgeConsole-Local.cer` 导入对方的 `CurrentUser\Root` 和 `CurrentUser\TrustedPublisher`（可运行 `signing\Install-Trust.ps1`）；否则签名会显示为不受信任/未知发布者。
- **自签名不会获得 SmartScreen 信誉。** 实测签名后，Windows 的「打开文件 - 安全警告」仍会弹出，但“发行商”从“未知发布者”变成了 `QQ Bridge Console (Local)`；SmartScreen 的「Windows 已保护你的电脑」也不能靠自签名消除。要彻底消除，需要 CA 颁发的代码签名证书（OV/EV），或使用受信任进程包装启动（例如 `cmd.exe /c start "" "<exe>"`）。
- **当前桌面快捷方式已改为** `cmd.exe /c start "" "C:\qq-bridge\desktop-app\QQBridgeConsole.exe"`（另一个 agent 完成；原来的 `wscript.exe` + `launch.vbs` 方案已弃用）。实测这条路径在 17:39:24（上一版）和 17:39:58（最终版）都能直接拉起 exe，没有安全警告；这是绕过 ShellExecute 检查的包装方式，属于安全权衡，不要随意改回直接指向 exe。若改回，警告会重新出现。
- **每次重新编译 `QQBridgeConsole.exe` 都会覆盖签名，也会继承目录的 Low 完整性标签。** 重新编译后必须重跑
  `Sign-QQBridgeConsole.ps1`：它会重新签名，并把 exe 的强制完整性标签改回 `Medium`（脚本最后会打印
  `Integrity: Mandatory Label\Medium Mandatory Level`）。如果只编译不跑脚本，launcher 会以低完整性启动，
  Edge 又会白页。签名前先退出托盘启动器（控制台服务 7788 不受影响）。
- **不要给 `C:\qq-bridge` 目录本身设 Low 完整性标签。** 本次故障就是该目录（及其子目录）
  带有 `Low Mandatory Level:(OI)(CI)(NW)` 导致的；当前运行中的 node 控制台进程仍是低完整性，直接改目录标签
  会让它无法再写 `state/`、日志等文件，所以只把 exe 标签改回 Medium，不动目录。若以后要彻底清理目录标签，
  需要在停掉全部服务后统一处理。
- 本说明不包含私钥、密码或 PFX；私钥只存在于当前用户的证书存储中。
