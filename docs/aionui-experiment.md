# AionUi 应用内实验版

本地源码版通过独立导航入口在同一窗口内展示真正的 AionUi 2.2.2 + AionCore 0.2.2，用于与现有工作台 A/B 比较。接入现有 Google 官方 Antigravity ACP，并为 Grok Build 沿用原工作台的代理环境。

## 打开

- **应用内打开**：重启源码运行的 self-wiki，点击内容库左侧“工具 → AionUi 实验版”，自动在当前页面连接并加载，不再要求点击另开窗口的按钮。
- **A/B 切换**：内嵌页顶部“切换原工作台”和原工作台侧栏“AionUi 实验版”可互相切换。切换时保留内嵌页及会话；桌面版在打开 self-wiki 设置等弹窗时临时隐藏原生内嵌区域，关闭弹窗后恢复。
- **浏览器模式**：刷新页面后，同一入口以 iframe 在页面内加载。桌面版使用隔离 session 的 WebContentsView；若旧桌面进程尚未重启，则暂用 iframe 路径。
- `run-aionui-ab.bat` 仍保留为可选的独立窗口启动方式，应用内入口不再调用它。

在 AionUi 首页选择 **Google 官方 ACP · self-wiki**，输入任务开始。初次建立会话后可读取并切换该账号实际提供的模型和推理配置。它调用的是现有 `agy_acp_server.exe`，不是 AionUi 自带的 `agy` CLI；复用官方服务端已有的 Google 登录。如果凭据过期且不能静默刷新，可先在原工作台重新连接 Antigravity 账号。

默认程序位置为 `.local/antigravity-acp/runtime/agy_acp_server.exe`；自定义安装可在启动前设置 `ANTIGRAVITY_ACP_EXECUTABLE` 为绝对路径。

Grok Build 使用上游 ACP 接入，但代理设置与原工作台一致（当前为 `127.0.0.1:7890`，由 `grokEnvironment` 提供）。此前只使用上游默认环境，可能结束一轮却没有回复；已补齐 HTTP/HTTPS/ALL_PROXY 及小写变量。旧的失败消息不会自动重发，需手动重新发送。

## 本版范围

- 完整沿用上游工作台 UI、会话、执行过程、模型配置和预览能力；尚未把 Wiki、生图和工作流工具连接到 AionUi。
- 实验会话单独保存于实际 self-wiki 数据目录的 `aionui-experiment/`。独立脚本默认使用项目 `data/aionui-experiment/`，`APP_DATA_DIR` 可覆盖其父目录；不会迁移旧工作台会话。
- 桌面内嵌视图使用独立 Electron session，不注入 Wiki preload。启动时通过上游一次性登录交换写入 AionUi 自己的登录 Cookie，无需用户设置一套额外密码。浏览器 iframe 沿用浏览器自己的 Cookie 存储。
- 服务只监听 loopback，入口仅限已配对的本机用户；不随 Wiki 的局域网共享开放。采用上游本机运行模式，不应通过端口转发把此服务公开。
- 应用内切换到其他模块不停止后台任务；退出 self-wiki 时停止实验服务。可选的独立批处理入口在关闭实验窗口后停止服务。停止会中断实验版正在执行的任务。
- 启动器为每次运行创建实验数据目录下的 `runtime-temp-*`，让官方服务端解包使用该资料盘，避免大量临时解包占满系统盘。确认进程树终止后清理本次运行的专用临时目录；异常退出且未确认终止时保留。
- 注册参数与引擎代理未改变时不重复做启动健康探测，减少不必要的进程启动及解包。
- 首次启动可能下载上游托管的 Node/适配器运行资源；实验环境需要网络访问。原 CLI 使用当前用户权限，项目目录不构成操作系统沙箱。
- 当前实现针对本仓库 Windows 源码运行方式，未加入便携发行包。

## 准备与重建

本机已下载依赖并构建。其他检出目录或清理 `.local` 后运行：

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup-aionui-experiment.ps1
npm.cmd run build
```

准备脚本把 Bun、AionCore、上游源码和依赖放在 `.local/`，与项目依赖分开。源码固定提交 `11cd2a9a20d1e033157636efc570b41384c66d85`；Bun 与 AionCore 压缩包校验固定 SHA256。AionUi 包内声明配套 `aioncoreVersion: v0.2.2`。重建宿主也由准备脚本完成。

上游采用 [Apache-2.0](https://github.com/iOfficeAI/AionUi/blob/11cd2a9a20d1e033157636efc570b41384c66d85/LICENSE)。本次没有修改上游源码；以后分发构建产物需附带上游许可及适用的归属、NOTICE 和依赖声明。

## 验证与排查

- 已验证：只有一个 BrowserWindow 的原生内嵌视图、独立登录 session、Wiki preload 隔离、切换比较与设置弹窗时显示/隐藏，以及 Grok Build 和官方 ACP 的真实、可见回复。
- 生命周期、路由、本机认证、浏览器 iframe 草稿保留及桌面嵌入交互有自动化回归覆盖。
- 尚未完成：官方 ACP 原生工具批准/拒绝、断连恢复和所有模型选项的实机验证；不能把正常对话通过等同于全部工具兼容。
- 原架构检查目前被其他既有 CSS 检查项阻断：`wiki.css` 的 6 个原始颜色值及 `workflow.css` 的 30px 控件高度；本次未修改这些文件。

启动失败先看实验数据目录里的 `launcher.log` 和 `logs/`。未准备环境时页面会给出提示；启动失败可点击“重新连接”，不会自动重发模型任务。内嵌实机结果保存在 `.local/aionui-experiment/embedded-smoke.json` 和 `embedded-{grok,acp}.png`。

```powershell
node --test test/integration/aionui-experiment.test.js test/ui/aionui-experiment.test.js
node tools/smoke-aionui-embedded.mjs
```

第二条会打开一个 self-wiki 测试窗口，分别通过内嵌的 Grok 和官方 ACP 发送最小消息，并验证回复在界面显示；使用单独测试目录，完成后关闭窗口。
