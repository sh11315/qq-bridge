# 语音系统（VOICE）

> 覆盖两条路径：**独立的发语音工具** 与 **AI 在聊天里发语音**。

## 1. 入口

| 用途 | 入口 | 说明 |
|---|---|---|
| 命令行 | `../voice-tool/voice-cli.mjs` | `node voice-cli.mjs status` / `list`，不带参数进入交互菜单 |
| 图形界面 | `../voice-tool/voice-gui.mjs` + `public/voice.html` | 本地小服务 + 浏览器 UI |
| 双击启动 | 上一级的 `发语音-图形界面.cmd` | 图形界面快捷方式 |
| 菜单式 | `发语音.cmd` | 传统命令行菜单 |

`voice-tool` 位于本仓库的**上一级目录**（`../voice-tool/`），不依赖 qq-bridge 运行。

## 2. AI 发语音默认是关的

- `socialV2.voice.enabled` 与 `socialV2.tools.sendVoice` 默认 `false`。
- 先把音频放进 `audio/`（或控制台语音库），再到控制台打开开关。
- 你自己用 `voice-cli.mjs` / `voice-gui.mjs` 发语音，不受这个开关影响。

## 3. 配置来源

优先级：环境变量 → `voice-tool/config.json` → `../qq-bridge/config.json` → 默认值。

环境变量：

- `SNOWLUMA_HTTP_URL`：OneBot HTTP（默认 `http://127.0.0.1:3000`）
- `SNOWLUMA_TOKEN`：桥接/网关令牌
- `SNOWLUMA_HOME`：SnowLuma 安装目录（默认路径内置）
- `VOICE_DIR`：语音库目录
- `FFMPEG_PATH`：ffmpeg 可执行文件（本仓库自带 `tools/ffmpeg/ffmpeg.exe`）

## 4. 常用命令

```bash
cd ../voice-tool
node voice-cli.mjs status     # 账号/token 自动发现 + 连通性
node voice-cli.mjs list       # 可发的群聊/私聊 + 语音库
node voice-cli.mjs            # 交互菜单
node voice-gui.mjs            # 图形界面
```

## 5. 常见问题

- **发不出去**：先 `status` 看账号在线与 token；token 不匹配时到控制台「Token」页刷新。
- **找不到 ffmpeg**：设置 `FFMPEG_PATH`，或 `socialV2.voice.ffmpegPath` 指向 `tools/ffmpeg/ffmpeg.exe`。
- **时长/频率超限**：见控制台语音页的 limits；超限会被桥接拒绝。
- **AI 仍不发语音**：确认 `socialV2.voice.enabled`、`socialV2.tools.sendVoice` 都已打开，且语音库里有文件。