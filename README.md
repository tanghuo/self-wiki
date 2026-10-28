# 个人 Wiki · self-wiki

本地优先的个人内容空间，用来保存图片、视频、文字和会话，通过标签、关联与关系画布组织资料，并用 Wiki Agent 检索、整理和创作。

内容保存在本机 SQLite 数据库和文件目录中。基础内容管理无需模型服务；对话、自动整理和语义检索按需配置。调用 AI 时，相关文字、图片或视频抽帧会发送到所配置的模型服务，本地运行应用不等于离线推理。

## 功能概览

| 功能 | 可以做什么 |
| --- | --- |
| 内容库 | 粘贴、拖入或导入图片和视频，保存文字；搜索、筛选、标记素材、批量管理和回收恢复 |
| 标签与关联 | 公共标签与单项标签、名称与别名、双向或有向关联、标签集合关联 |
| 相似堆叠 | 按已有“相似”关联收起重复浏览项，展开查看成员，保留每份原内容 |
| 关系画布 | 关系、平铺与标签视图；展开关联、编辑关系并保存布局 |
| Wiki Agent | 基于资料对话、选择模型与思考等级、保存回答和生成图片、查看调用记录与用量 |
| 工作流 | 自由搭建节点与循环，运行 AI 创作流程，人工检查、重试、恢复及派生继续；详见[工作流指南](docs/workflows.md) |
| 自动整理 | 识别图片、建议或添加标签与关联、检查文字及视频首帧相似关系，查看依据并修正 |
| 语义与画面检索 | 文字和图片说明的语义检索、视频抽帧分析、按图片或片段查找相似素材 |
| 视频标注 | 播放与定位，标记时间点或片段，添加说明、标签和关联内容 |
| 局域网共享 | 通过配对地址在手机或其他电脑浏览，按需开放编辑 |
| 临时分享 | 分享本机文件或将目录打包为 ZIP，配对设备下载，到期或退出应用后清理 |
| CLI | 通过本机 HTTP 接口搜索、导入和管理资料，供脚本或 agent 使用 |

详细操作见 [使用与配置指南](docs/usage.md)。

## 快速开始

### Windows 桌面版

如果已有打包的便携版，解压后运行可执行文件即可，无需安装 Node.js。数据默认保存在可执行文件旁的 `data/`，升级时请保留并备份该目录。

从源码运行需要 **Node.js 24 或更新版本**。以下命令均在项目根目录执行，Windows PowerShell 使用 `npm.cmd`；其他终端可使用 `npm`。

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run desktop
```

Windows 也可双击 [run.bat](run.bat)，自动检查 Node.js、安装缺失依赖、构建并启动桌面程序。桌面程序启动自己的本地后端，退出时一起关闭。

### 浏览器模式

安装依赖并构建后运行：

```powershell
npm.cmd start
```

默认打开 `http://127.0.0.1:8765`。指定数据目录和端口时使用：

```powershell
node src/server/server.js --port 8765 --data-dir "D:\wiki-data" --open
```

### 第一次使用

1. 应用默认进入 Wiki Agent。从侧栏打开“全部内容”，点击“新增内容”，或直接拖入图片、视频。
2. 加入文字和标签，点击“保存全部”；每张图片、每段视频和每段文字各自保存为独立内容。
3. 打开详情，编辑标签、添加关联或标记视频时间点；在关系画布中浏览资料之间的联系。
4. 需要 AI 时，再按下表配置对应服务。内容导入、浏览、关联和手动视频标注可先独立使用。

## 可选服务与配置

优先通过应用“设置”修改配置。文件保存于实际数据目录；退出应用后也可编辑配置文件，重新启动生效。

| 能力 | 设置入口 | 依赖与说明 |
| --- | --- | --- |
| Agent 对话 | Agent 连接 | 可选本机 Codex 或 Grok Build 聊天引擎，安装并登录对应 CLI 后保存和检测；详见[聊天引擎](docs/chat-engines.md) |
| 自动整理 | 自动整理与检索 | 复用 Agent 执行器，可选择“先生成建议”或“自动添加” |
| 聊天生图 | 会话输入框旁；服务连接在自动整理与检索 | 支持 Codex CLI、ChatGPT 网页版、ComfyUI、Grok Build；Grok 聊天可在原会话连续改图，详见 [生图配置](docs/image-generation.md) |
| 语义检索 | 自动整理与检索 → 模型、超时与语义检索 | 需兼容 embeddings 的服务，默认连接本机 Ollama |
| 视频分析 | 视频与画面检索 | 需 FFmpeg、ffprobe 和可用的 Codex 视觉执行器；可手动开始或后台自动分析 |
| 视觉相似检索 | 视频与画面检索 | 需单独运行本地 SigLIP2 编码服务，默认地址 `http://127.0.0.1:8767` |
| 标签与关联归一 | 名称与别名 | 预览并归并不同叫法，保留有向关系的正反名称 |

自动整理与语义检索配置见 [organization.example.json](config/organization.example.json)，视频分析配置见 [video-analysis.example.json](config/video-analysis.example.json)。默认不启用自动整理、语义索引和视频自动分析；应用不会自动安装模型服务或下载权重。

语义检索默认使用 `qwen3-embedding:0.6b`、1024 维，服务地址为 `http://127.0.0.1:11434/v1`。视觉服务安装、模型切换与重建索引的细节见 [使用与配置指南](docs/usage.md)。

## 媒体支持与边界

| 类型 | 支持范围 |
| --- | --- |
| 图片 | PNG、JPEG、WebP、GIF；每张最多 25 MiB、4000 万解码像素、动画最多 200 帧 |
| 视频 | MP4（含 M4V）、WebM、MOV；每个文件最多 1 GiB，播放能力取决于浏览器支持的编码 |
| 文字 | 每条最多 12000 字，保留换行和空格 |

导入会复制原始文件，之后移动来源文件不会影响 Wiki。完全相同的图片或视频复用已有内容并补充标签；同名不同内容分别保存。视频不自动转码，不支持的编码可下载原文件后用本地播放器打开。

视频列表支持封面、时长和悬停静音预览；详情支持进度定位、下载及时间标注。视频暂不作为聊天参考资料，也不提取字幕。自动分析基于抽样帧，范围时间可能是近似值。

## 局域网共享

在“设置 → 局域网共享”开启访问，将面板中的配对地址或二维码交给同一网络的设备。默认关闭共享，默认端口为 `8766`；设备配对后通过 Cookie 保持访问，更换配对码可使旧配对失效。

共享默认只读，可在高级设置中允许编辑内容。Agent 会话、自动整理、视频分析启动和配置、索引重建等操作仍限本机。共享使用 IPv4，Windows 防火墙需允许对应端口的专用网络入站访问；应用不会自动修改防火墙。

开发模式的共享页面读取构建产物，前端修改后需运行 `npm.cmd run build`。完整权限与配置说明见 [局域网共享](docs/usage.md#局域网共享)。

从侧栏打开“临时分享”，桌面版可以选择文件或目录，浏览器模式可输入服务所在电脑的绝对路径。文件会复制到临时空间，目录打包为 ZIP，保留目录结构和空目录；准备完成后可下载。开启局域网共享后，可以复制带配对信息的链接或展示二维码，其他设备用浏览器打开即可下载。

分享有效期可选 1 小时、24 小时或 7 天，实际持续时间不超过本次应用运行。支持手动取消，到期后禁止新下载并在约 30 秒内清理临时副本；退出或重启后清理全部临时分享，源文件保留。临时分享不进入资料库，不参与 AI 整理或检索。局域网设备只能下载，不能创建或取消分享；配对链接沿用现有共享权限，也允许浏览其他已开放资料。

当前目录 ZIP 使用不压缩打包，内容总大小需小于 4 GB，最多 65000 个文件与子目录，不支持符号链接或目录联接。单个文件直接分享不受 ZIP 大小限制；创建分享需要相应的临时磁盘空间。

## 数据与备份

| 运行方式 | 默认数据位置 |
| --- | --- |
| 源码桌面版、浏览器模式 | 项目根目录的 `data/` |
| Windows 便携版 | 可执行文件所在目录的 `data/` |
| 其他打包桌面启动方式 | Electron 用户数据目录下的 `data/` |

桌面版可通过 `APP_DATA_DIR` 指定数据目录；浏览器后端使用 `--data-dir`。程序不会自动搬迁旧数据。

数据目录中主要包括：

```text
data/
├── library.sqlite3       # 内容、标签、关联、会话与索引
├── assets/               # 图片、视频原件及图片预览缓存
├── video-analysis-cache/ # 视频分析派生帧
├── organization.json     # Agent、自动整理、生图和语义检索配置
├── video-analysis.json   # 视频分析与视觉索引配置
├── lan-sharing.json      # 局域网共享配置
└── wiki-codex/           # 默认的 Wiki Codex 运行目录
```

**备份前关闭桌面程序和后端，复制完整数据目录。** 数据库和 `assets/` 必须一起保留；完整目录也可保留配置、分析缓存及默认 Codex 运行数据。若另行配置了 Codex 数据目录，需一并备份。恢复时使用对应的整套数据，升级或回退前保留独立副本。

关闭应用后，可用离线工具只读检查媒体缺失和无引用文件：

```powershell
node tools/wiki-assets.mjs
node tools/wiki-assets.mjs --data-dir "D:\wiki-data"
```

确认应用已关闭、检查结果确为遗留文件后，才使用 `--apply --offline` 清理无引用文件。工具不会删除元素或回收站内容，未知文件会保留；缺失原件需从备份恢复。

## CLI

先启动应用或后端，再在项目根目录执行。CLI 默认输出 JSON，自动发现本机后端，不直接读写数据库。

```powershell
node src/cli/main.js schema --pretty
node src/cli/main.js status
node src/cli/main.js elements list --q "资料" --page-size 10
node src/cli/main.js read 123
node src/cli/main.js elements create --body "一份笔记" --tag "资料"
```

也可使用 `npm.cmd run --silent cli -- <命令>`。`--data-dir` 选择资料库，`--url` 指定本机后端；完整命令、输入格式和退出码见 [CLI 使用指南](docs/cli.md)。

## 开发与验证

技术栈：Node.js / Electron / React / Vite，数据使用 SQLite 与 sqlite-vec。

| 命令 | 用途 |
| --- | --- |
| `npm.cmd run dev` | 同时启动 API、Vite 和桌面窗口 |
| `npm.cmd run build` | 构建前端到 `dist/renderer/` |
| `npm.cmd run check` | 语法检查、构建、全部测试及架构检查 |
| `npm.cmd run test:unit` | 单元测试 |
| `npm.cmd run test:integration` | 集成测试 |
| `npm.cmd run test:ui` | 浏览器交互测试 |
| `npm.cmd run check:arch` | 架构依赖检查 |
| `node tools/smoke-desktop.mjs` | 桌面端 smoke 验证 |

开发模式默认使用 `5173` 界面端口与 `8765` API 端口。`EXTERNAL_API_URL` 可指定已有后端，Vite 将 API 请求代理到该地址；`NODE_BINARY` 可覆盖桌面启动后端所用的 Node 运行时。

测试使用临时数据库、本地样本和模拟上游。UI 测试需要 Edge/Chrome，也可通过 `RENDERER_BROWSER_PATH` 指定浏览器；模型 fixture 验证流程，不代表真实模型质量。

```text
src/
├── main/     # Electron 窗口与桌面集成
├── renderer/ # React 界面
├── server/   # HTTP 接口、业务逻辑、数据库与媒体存储
├── agent/    # 模型执行器与连接
├── shared/   # 共享领域逻辑
└── cli/      # 命令行入口
test/         # unit、integration、ui 与 fixtures
tools/        # 打包、smoke、文件检查与视觉编码服务
```

## Windows 打包

在 Windows、Node.js 24+ 环境中执行：

```powershell
npm.cmd run package:win
```

产物位于 `release/`，包含后端 Node 运行时，终端用户无需安装 Node.js。Codex、FFmpeg、Python 和模型服务按所需功能单独配置。

生成未封装目录并验证打包资源：

```powershell
npm.cmd run package:dir
node tools/smoke-semantic-package.mjs
node tools/smoke-desktop.mjs --packaged
```

## 文档导航

- [使用与配置指南](docs/usage.md)：浏览、保存、关联、画布、Agent、整理、检索与共享的完整说明。
- [CLI 使用指南](docs/cli.md)：命令、参数、分页、错误与重试规则。
- [聊天生图配置](docs/image-generation.md)：Codex CLI、ChatGPT 网页版、ComfyUI 与 Grok Build。
- [聊天引擎](docs/chat-engines.md)：Codex / Grok Build、会话恢复与连续生图改图。
- [视频分析与相似素材设计](docs/video-auto-annotation-design.md)、[视频首帧整理](docs/video-first-frame-organization.md)。
- [语义检索设计](docs/semantic-retrieval-design.md)、[搜索相关性](docs/search-relevance.md)。
- [会话实现](docs/wiki-chat-design.md)、[调用记录](docs/chat-call-records.md)、[Token 用量](docs/token-usage.md)。
- [元素生命周期](docs/element-lifecycle-design.md)、[关联方向](docs/relation-directions-design.md)、[名称归一](docs/vocabulary-design.md)。

设计文档包含历史方案与验证边界；日常使用以当前界面、项目首页和使用指南为准。
