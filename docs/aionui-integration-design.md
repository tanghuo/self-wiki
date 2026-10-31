# AionUi 复用与内嵌方案

日期：2026-10-31。范围：评估如何使 self-wiki 工作台尽可能直接使用 AionUi。本文完成源码调查与分阶段决策；尚未完成运行验证或产品替换。

实施补记：当前侧栏实验入口已改为同一窗口内的 WebContentsView；浏览器使用 iframe，保留会话用于来回比较。Grok 已补齐原工作台代理配置，Grok 与官方 ACP 均通过同窗口真实回复和界面显示验证。原独立窗口脚本仅作可选入口，业务工具桥接仍未实施。操作与边界见 [实验版说明](aionui-experiment.md)。以下各阶段保留原设计语境，不作为本次已完成范围的声明。

## 目标与推荐结论

优先采用 **AionUi 完整 WebUI + AionCore 独立后端，内嵌到 self-wiki 桌面窗口**。通用工作台直接沿用上游界面和执行体系，self-wiki 负责 Wiki、媒体、已有生图与工作流能力。保持上游目录与依赖独立，只维护少量集成补丁。

用户已明确接受内嵌，并希望尽可能对齐 AionUi。第一阶段可以直接开展独立运行及内嵌验证，无需为这一方向重复征求授权。通过验证后再切换新会话入口。

## 当前事实与证据

### 已检查的上游

- 源码已克隆至 `.local/references/AionUi`，作为参考副本，不作为产品发行依赖。
- 检查提交：`11cd2a9a20d1e033157636efc570b41384c66d85`，`package.json` 版本 `2.2.2`。后续实施应锁定经实测的前后端组合，不能跟随浮动 main/latest。
- `scripts/webui.ts`：无需启动 Electron 的 WebUI 入口；可指定静态资源、后端程序、数据目录和端口。
- `packages/web-host/src/index.ts`：`startWebHost` 组合后端启动器与静态服务，返回地址及停止句柄。
- `packages/web-host/src/static-server.ts`：提供 SPA 与 API/WebSocket 转发；不包含 self-wiki 业务。
- `packages/web-host/package.json`：该包为 private workspace 包，不应假设可直接通过 npm 安装公开稳定 SDK。
- `packages/shared-scripts/src/prepare-aioncore.js`：发行资源包含后端程序、manifest 和 managed-resources；只拿一个 exe 不能视为完整部署。
- `packages/desktop/src/renderer/pages/guid/`：截图首页实际组件所在地；对齐首页可以直接沿用这些组件。
- `packages/desktop/src/renderer/pages/conversation/`：会话、执行过程和 Preview 的现有实现。
- `packages/desktop/src/renderer/pages/settings/AgentSettings/InlineAgentEditor.tsx`：自定义 Agent 命令、参数和环境配置入口。
- `packages/desktop/src/common/types/platform/acpTypes.ts`：ACP 能力与自定义 Agent 配置类型。存在扩展入口不代表 Grok 已兼容。
- 上游确有 `antigravity` 会话类型分支，但不能据此认定与本仓库 Google 官方 ACP 接入完全相同；认证、模型、审批、恢复均需实测。
- 已查看 `resources/homepage.png`：首页是完整侧栏、引擎选择条、输入卡、项目选择和助手网格；不是只换颜色和圆角就能对齐。
- 上游 AionUi 与 AionCore 标示 Apache-2.0；复制/发行时保留许可和相关归属，修改文件标明修改，核对 NOTICE 与第三方依赖声明。

在线来源：[AionUi](https://github.com/iOfficeAI/AionUi)、[WebUI 入口](https://github.com/iOfficeAI/AionUi/blob/11cd2a9a20d1e033157636efc570b41384c66d85/scripts/webui.ts)、[WebHost](https://github.com/iOfficeAI/AionUi/tree/11cd2a9a20d1e033157636efc570b41384c66d85/packages/web-host)、[AionCore 架构](https://github.com/iOfficeAI/AionCore/blob/main/ARCHITECTURE.zh-CN.md)、[许可](https://github.com/iOfficeAI/AionUi/blob/11cd2a9a20d1e033157636efc570b41384c66d85/LICENSE)。AionCore 架构说明当前后端为 Rust/Axum；其具体发行版本尚未锁定。

### self-wiki 当前边界

- `src/main/main.js:42`：Electron 宿主。现有主窗口只信任 self-wiki 页面，并挂载专用 preload；不可把同样 preload 直接给 AionUi。
- `src/renderer/src/App.jsx:29`、`:240`：当前自研工作台独立 lazy 加载，可增加替代入口而不更改 Wiki 主体。
- `src/server/server.js:90`：工作流的受限 Agent 节点依赖当前 `agentWorkbench.executeWorkflowAgent`，工作台 UI 被替换后仍须保留这一内部执行入口。
- `src/server/server.js:94`：任务服务的 enabled 条件与旧工作台开关耦合；不能关闭旧开关后假定所有业务任务仍可用。
- `src/server/application/agentTools/service.js:30`：工具上下文需要 sessionId、turnId、存活检查和读取快照。
- `src/server/application/agentTasks/service.js:96`、`src/server/data/agentTaskRepository.js:14`：任务、事件、审批和产物绑定本地会话与轮次，不能把 AionUi conversation ID 直接当作本地整数 ID。
- `src/server/http/agentWorkbenchRoutes.js:5`：原接口仅限本机，不能直接转发整套管理 API 供内嵌页面任意调用。
- `src/cli/main.js` 与 `src/cli/commands.js` 已提供内容检索、读取和导入，可用于初期人工/可信本地 Agent 验证，但 CLI 含写入能力，不能当作受限只读桥接。
- 工作区已有大量未提交的引擎、会话与 UI 修改。本次只新增方案，未覆盖这些修改。

## 路线选择

| 路线 | 达到的效果 | 代价与结论 |
| --- | --- | --- |
| 完整 WebUI + AionCore 内嵌 | 直接获得上游真实界面与主要交互，后续可跟上游更新 | 首选；需要运行资源、进程管理和业务桥接 |
| Fork AionUi，直接把 Wiki 接进去 | 最终外观和导航更统一 | 备选长期路线；现有 Wiki 外壳、视频与画布迁移面较大，先不整体搬家 |
| 抽取上游 React 页面接现有后端 | 外观可接近 | 需实现两套消息、状态、审批和文件协议的转换，容易长期维护一个分叉，不优先 |
| 看截图重写 CSS 和组件 | 可快速做静态相似页 | 无法直接获得完整交互，不作为本次主要方案 |

## 推荐边界

```text
self-wiki Electron 窗口
  ├─ 薄导航：工作台 / Wiki / 工作流 / 历史工作台
  ├─ 工作台区域：完整 AionUi WebUI（独立 WebContentsView / 独立 session）
  │    └─ AionUi WebHost → AionCore → 上游 Agent 接入
  └─ Wiki 与原工作流 UI → self-wiki 后端与原资料库

第二阶段：AionUi 的工具扩展 → 受限 self-wiki 桥接 → 原业务服务
```

桌面优先使用 WebContentsView，沿用上游页面自身布局，不在其外面再套一套项目/会话侧栏。self-wiki 只保留紧凑的跨模块导航。页面切换时隐藏视图而非销毁，返回时继续原会话；resize、缩放、焦点和弹窗遮挡需实际处理。

WebContentsView 使用单独 partition，不注入 Wiki preload，不启用 Node integration。不同端口不能隔离同主机 Cookie，因此不能仅靠 `127.0.0.1` 的端口差别隔离登录；桌面 session 必须独立。外链与 OAuth 只开放明确需要的外部浏览器流程。

浏览器模式先提供打开独立 AionUi WebUI 的入口；iframe 是否可用需要检查实际 CSP/frame 策略、认证、文件选择与 Cookie。不能把 iframe 放进去就声称桌面和浏览器均已完成内嵌，也不为方便代理登录而共享 Wiki 管理凭据。

### 数据、会话与权限

- Wiki SQLite、媒体、工作流保持现有服务所有权；AionUi 会话和配置使用独立数据目录。
- AionUi 管理新会话的流式输出、工具审批、文件执行和恢复。禁止两套后端同时驱动同一个新会话。
- 历史会话保留原工作台入口，可继续使用原引擎；首版不迁移原生线程、不伪造恢复。
- AionUi 的文件/命令审批不等于 self-wiki 业务批准。Wiki 建议采纳、生图和工作流批准继续由 self-wiki 执行。
- 桥接初期只开放检索与读取。后续提交任务需要服务端生成映射：AionUi conversation/turn → 本地业务 owner/turn；身份由连接绑定，不能由模型随意指定。
- 未实现可靠轮次映射、建议卡与独立审批 UI 前，不开放现有 `forTurn` 的写入/付费工具。只添加 MCP 配置无法自动完成这些契约。
- 桥接凭据只授予声明工具和对应会话范围，不给 AionUi renderer Wiki 管理 Bearer。原生 Agent 仍运行在当前用户权限下，不能把这种集成宣称为操作系统沙箱。
- Grok 优先尝试上游自定义 ACP Agent 入口；Antigravity 先核实上游的具体接法。失败时保留旧引擎入口，不静默切换 API 计费或替换模型。

## 实施与验收

### P0：先把真正的 AionUi 跑起来

1. 锁定前端提交及匹配 AionCore 发行包、资源 manifest、校验值；资源放入独立运行目录，依赖不混入本项目 node_modules。
2. 使用单独测试资料目录，启动上游完整 WebUI，明确监听 loopback；不修改用户已有 AionUi 配置。
3. 用本机已登录的 Codex 做真实会话，验证模型选择、流式响应、一次工具审批、文件修改预览、停止、关闭后恢复。
4. 核实 Antigravity 与 Grok 的可用路径，分别记录支持/失败原因。运行前查看所用 CLI 的认证和权限行为，不沿用原工作台测试结论。

退出标准：不仅首页出现，还应有一份固定版本的真实对话与工具执行记录。运行不了时先解决资源/版本问题，不先写替代聊天 UI。

### P1：桌面内嵌原版界面

影响区域：`src/main/` 新增 AionUi 进程与视图管理；`src/renderer/src/App.jsx` 与窄 IPC 接口增加显示/隐藏/状态；打包脚本加入固定上游资源。

1. 先添加实验入口；在同一窗口内展示完整 AionUi，不改原会话数据。
2. 生命周期明确区分本应用启动的后端与外部已有实例，只关闭自己拥有的进程。切换 Wiki 不停任务；退出整个应用才按上游机制停止并检查子进程。
3. 启动失败显示原因和重试入口，不自动重发上一条模型任务。可回到旧工作台。
4. 验证窗口 resize/缩放、主题、中文输入、附件拖放、文件选择、登录外跳、预览与工作台/Wiki 往返。
5. 核对首页与用户提供的上游截图，并验证真实执行过程、权限交互和右侧预览。

退出标准：用户在 self-wiki 同一个桌面窗口中使用真正的 AionUi 完成任务；重启能恢复其会话，Wiki 和原工作流仍可用。

### P2：连接 Wiki 与创作能力

先实现只读搜索/读取桥接，验证引用能回到正确资料；再冻结单独的写入/任务桥接契约，包含身份映射、artifact 引用、人工批准展示、operationId 和恢复。复用原业务服务；不得让 AionUi 直接读写 Wiki SQLite。

付费任务断线后只查询已有 operationId；重试执行必须创建明确的新批准操作。Wiki 建议仍带内容版本校验。桥接需验证跨会话访问被拒绝、重复提交不重复派发、停止聊天不误取消已批准任务。

退出标准：从 AionUi 完成“检索资料 → 提建议 → 人工采纳”以及“申请创作任务 → 人工批准 → 取回 → 保存到 Wiki”。在此之前不能宣称已完成旧业务能力迁移。

### P3：切换默认入口并减少自研维护

只有 P0–P2 达标才把新会话默认入口切到 AionUi。旧工作台保留为历史入口；其内部受限 Agent、旧任务查询与恢复仍有调用者时不能删除。后续上游更新只推进经过同套验收的版本组合。

## 回退与验证边界

- 关闭实验入口恢复原 UI；两个资料目录独立，回退不需要改写 Wiki 库。
- AionCore 升级前完整备份其资料目录；旧二进制不能直接打开已升级数据库，回退使用匹配的备份。
- 本次已做：克隆并固定 AionUi 提交，检查首页图片、WebUI/宿主/准备资源代码、自定义 Agent 配置与当前服务耦合。
- 本次未做：安装上游依赖、下载匹配后端、编译、启动、真实模型调用、桌面内嵌和浏览器 iframe 验证。
- 待解证据由实施者负责：匹配的 Windows AionCore 资源组合、WebUI 的原生文件操作覆盖、两个目标引擎实际兼容性。它们是 P0/P1 的验证门槛，不阻止先做隔离原型。

## 设计检查

### 补充：ACP / CLI 兼容性源码核对

后续核对 AionCore 提交 `503a87199eb978790ca77675b39c84b241535bf3`，参考副本 `.local/references/AionCore`。这是额外源码证据，尚未证明它与上述前端提交是已验收的配套发行组合。

| 当前调用方式 | 上游实际实现 | 判断 |
| --- | --- | --- |
| Codex `app-server` stdio JSON-RPC | `crates/aionui-session/src/backend/codex_conn.rs` 原生 app-server 连接与审批处理 | 同协议，有直接接入基础；现有版本、登录目录及自定义配置仍需实测 |
| Grok `agent ... stdio` ACP | registry 包含 Grok；`crates/aionui-ai-agent/src/protocol/acp.rs` 提供 ACP initialize/new/load/prompt/config/permission 与 terminal 服务 | 基础调用有现成基础；上游锁文件中的 Grok 包版本不等于本机 Grok Build 1.0.70，需覆盖命令并实测 |
| 官方 `agy_acp_server.exe` ACP | 可尝试自定义 ACP Agent；内置 `antigravity` 经 `factory/acp.rs` 强制走 agy 直连 CLI | 自定义 Agent 使用独立 ID，避免名为 antigravity 的后端标签；内置按钮不能视为当前接法的替代 |

特别限制：上游 ACP initialize 当前不声明文件系统服务，而本仓库 Grok 文件写入由客户端文件网关承接；上游提供 terminal 服务不等于保留原文件网关策略。本仓库还使用 `x.ai/mcp/sdk_call`、`x.ai/hooks`、agentProfile 和特定 authenticate 元数据，不应假设通用 ACP 客户端会复现这些私有约定。Codex 本仓库存在 ephemeral token 刷新路径，上游对应反向请求处理策略不同；普通 CLI 登录与本仓库特殊认证注入需分开验证。

因此：允许继续沿用本机 CLI/ACP 方向，不要求统一改成模型 API Key；接入协议兼容与全部权限、工具、恢复语义兼容是两级验收。

按 sr-review 同上下文检查本方案与已检查源码；未使用独立评审。

已修正的实质问题：把 WebHost private 包误当公开 SDK 的风险；只取后端 exe 漏资源；关闭旧工作台会切断工作流内部执行和任务 enabled；跨端口 Cookie 不能实现隔离；把 MCP 接入误当成已完成会话/审批桥接。

结论：**APPROVED（P0 隔离验证方案）**。P1/P2 的最终实现与默认入口切换仍受上述验收约束；不表示内嵌、业务迁移或上游运行已经通过。
