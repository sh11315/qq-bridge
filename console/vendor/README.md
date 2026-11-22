# 控制台前端第三方插件（离线随控制台分发）

| 文件 | 包 | 版本 | 许可证 |
|---|---|---|---|
| `3d-force-graph.min.js` | `3d-force-graph` | 1.80.1 | MIT（见 `3d-force-graph.LICENSE`） |

用途：控制台「记忆网络」页（`#neural`）的海马体 3D 拓扑渲染。UMD 单文件，内含 three.js / OrbitControls / 3d-force-graph，
浏览器全局名为 `ForceGraph3D`，不需要联网或 CDN。

升级步骤：

```bash
npm install 3d-force-graph --no-save        # 在任意临时目录即可
copy node_modules/3d-force-graph/dist/3d-force-graph.min.js console/vendor/
copy node_modules/3d-force-graph/LICENSE console/vendor/3d-force-graph.LICENSE
```

`console/ui.html` 通过 `<script src="/vendor/3d-force-graph.min.js">` 加载；`console/server.mjs` 的 `/vendor/*` 路由只读
`console/vendor/` 目录并校验路径不越界。
