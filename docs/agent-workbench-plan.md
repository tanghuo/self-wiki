# 通用 Agent 工作台：重构设计、实施顺序与验收

日期：2026-10-29。代码核对基线：`19abbacffccda01e5215fbb7141687d8760a9e5d`，以及本次工作区现状。

状态：实施中。用户已授权实施本方案及本轮显式 Shell 适配。Grok 1.0.70 terminal 兼容问题已修正，真实读写/终端/拒绝与 load 探针通过；P0 的项目配置、搜索/子工具、真实取消等覆盖仍待完成，详见 [P0 实机记录](agent-workbench-p0.md)。P1 本机认证已实施，相关验证通过；此前全量回归有一项未修改的 Electron 退出保护测试超时。P2–P6 尚未实施；不代表迁移或发布已完成。

## 1. 问题、目标与范围

用户不满意 Windows Grok Build 的终端交互，希望在 self-wiki 中使用完整 Agent：绑定项目、持续对话、自主调用工具、修改文件、运行命令、验证结果，并能审批、停止和恢复。现有 Agent 主要为 Wiki、生图与工作流服务，仅增加一个模型选项不满足目标。允许重构或重写 Agent 编排，不要求重写稳定的业务服务。

目标结构：通用 Agent 工作台作为独立入口；Wiki、生图、工作流成为可组合的应用能力，原来的业务页面和 CLI 继续存在。模型执行循环由 Grok / Codex 提供，应用负责会话运行、实际授权、执行宿主、任务和产物持久化。业务规则不搬进提示词。

### 1.1 交付批次

| 批次 | 必须交付 | 明确不包含 |
| --- | --- | --- |
| A：可用工作台（P0–P4） | Grok；project/scratch；会话和事件；审批；文件与命令执行；变更展示；恢复；Wiki 搜索/读取/建议；异步生图/改图及产物引用 | 强隔离承诺、整轮撤销、跨会话永久允许、worktree、交互式终端、内嵌编辑器、多 Agent 展示 |
| B：完成本次重构（P5–P6） | Codex 接入同一工作台；调用已有工作流；受限 workflow Agent 节点；旧聊天转接与数据兼容；删除已无调用者的旧编排 | 自研模型循环、OpenAI 兼容反代、任意第三方引擎市场、远程 Agent 操作 |

批次 A 是阶段成果，不能宣称“完整重构完成”；B 也通过才满足完整目标。远程分享继续遵守现有 LAN 边界，新工作台和审批仅本机可用。

### 1.2 产品验收主线

选择真实测试项目 → 创建 Grok 会话 → 读取文件 → 提议修改并审批 → 执行测试命令 → 展示输出和文件变化 → 检索 Wiki → 提交生图 → 界面收到产物并可在下一轮引用 → 停止和重启恢复。批次 B 在 Codex 上重复适用部分，并演示 Agent 调用工作流、工作流调用受限 Agent。

## 2. 已核实基础与证据边界

下列路径以当前仓库为准，符号名比行号更稳定。

| 事实 | 代码依据 | 改造含义 |
| --- | --- | --- |
| Grok 已通过隐藏子进程运行 ACP stdio | [grokProcess.js](../src/agent/executors/grokProcess.js)，`startGrokAcp` | 复用传输经验，不从零编造协议 |
| 当前初始化为 `clientCapabilities: {}`；处理文字、工具、图片；钩子白名单拒绝原生 Shell 等 | [grokSession.js](../src/agent/executors/grokSession.js)，`openGrokSession` | 客户端文件/终端宿主、交互审批和扩展事件尚需实现 |
| 聊天目录为 `chat-workspace/<sessionId>` | [chatConnection.js](../src/server/application/chat/chatConnection.js)，`connection` | 需要独立 workspace 绑定 |
| Wiki 指令、图片引用、工具与归档混在聊天服务 | [chatService.js](../src/server/application/chat/chatService.js) | 拆编排与业务策略，不能把旧服务简单改名 |
| Codex 已有会话适配；workspace-write、approvalPolicy never | [codexSession.js](../src/agent/executors/codexSession.js) | 复用传输，审批与能力另行适配 |
| 业务工具已有带随机令牌的会话 HTTP MCP 桥 | [grokTools.js](../src/agent/executors/grokTools.js) | 保留工具能力授权，不向 Agent 发管理端凭据 |
| Grok 聊天整轮持有资源额度；同 key 单并发，全局最多两个 | [resourceGate.js](../src/agent/executors/resourceGate.js) 与 `grokSession.js` | 嵌套同引擎任务不能同步等待 |
| 工作流已有 requestKey/hash 去重、dispatch 标记、unknown 和取回 | [workflowRepository.js](../src/server/data/workflowRepository.js)，[nodes.js](../src/server/application/workflow/nodes.js)，[service.js](../src/server/application/workflow/service.js) | 先以桥接复用现有状态，不一次迁移所有工作流表 |
| 本机路由校验 Host/Origin，没有统一的必需身份凭据 | [routes.js](../src/server/http/routes.js)，`createRequestHandler` | 增加本机认证；不要把 Origin 校验当调用者身份 |
| 进程树终止已有 Windows/POSIX 实现 | [processTree.js](../src/agent/executors/processTree.js) | 复用并增加执行宿主生命周期测试 |
| 架构检查限制跨层依赖 | [check-architecture.mjs](../tools/check-architecture.mjs) | application 只能经 executorsPort 访问引擎，agent 不导入 server |

设计阶段曾运行 Grok 聊天 6 项模拟集成测试且通过，不代表新工作台通过验收。实施阶段已重新记录 Grok 1.0.70 的二进制位置和真实 ACP 探针，结果见 [P0 实机记录](agent-workbench-p0.md)；尚无新工作台或安装包完成证据。

### 2.1 外部报告的使用方式

[外部架构评估](https://self-wiki-agent-qxka.pages.grok.bot/)声称已从 Grok main 源码确认客户端 fs/terminal 切换、钩子错误放行，并在临时库复现无密钥改配置。本文已独立核对本机路由和资源锁代码；本次实施补做了 [真实 CLI 探针](agent-workbench-p0.md)，但没有审阅该报告所称的 Grok 源码或复现其接口攻击实验。“全部原生工具都会经过宿主”“所有版本钩子错误都必然放行”“Windows 存在有效 Grok 沙箱”仍不作为已验证前提。

已查阅 ACP v1 的 [文件系统](https://agentclientprotocol.com/protocol/v1/file-system)、[终端](https://agentclientprotocol.com/protocol/v1/terminals)、[工具与权限](https://agentclientprotocol.com/protocol/v1/tool-calls)规范：协议存在客户端文件和终端能力，不等于安装的 Grok 已完整实现。按 v1 与实际版本建立兼容测试，不自动切换到 v2 草案。

Grok 的 [官方脚本入口](https://docs.x.ai/build/cli/headless-scripting)支持 ACP stdio。Codex 的新工作台行为在 P5 按当时安装版本和官方协议核实，不从 Grok 接口反推。

## 3. 架构与所有权

以下均是同一 Node 后端中的职责模块，不引入微服务、消息中间件或通用插件框架。

| 层 | 负责 | 不负责 | 建议落点 |
| --- | --- | --- | --- |
| 工作台 | 项目、会话、时间线、审批、任务、变更和产物预览 | 权限最终裁决、直接执行命令 | `src/renderer/src/features/agentWorkbench/` |
| 运行内核 | 会话/轮次状态、进程代际、事件、恢复、取消和队列 | 模型工具选择循环、业务写入规则 | `src/server/application/agentWorkbench/` |
| 引擎适配 | 启动/协议/能力探测、事件翻译、引擎请求回执 | 授权、业务数据操作 | `src/agent/engines/`，通过现有 `executorsPort.js` 注入 |
| 授权与执行宿主 | 权限决定；文件/终端执行；变更记录；进程清理 | Agent 推理、数据库内容业务规则 | `src/server/application/agentWorkbench/` 内独立模块 |
| 应用工具 | 输入校验、能力范围、调用业务服务、输出转换 | 重写 Wiki、生图或工作流调度器 | `src/server/application/agentTools/` |
| 任务与产物 | 派发/尝试/未知/结果；文件归档与访问授权 | 引擎上下文管理 | `src/server/application/agentTasks/`、`src/server/data/`、`src/server/assets/` |
| 业务服务 | Wiki 版本校验/建议采纳、图片执行、工作流执行 | 聊天连接和展示 | 保留现有 application 服务及 modelAdapters |

依赖方向：HTTP → application → data/assets/业务服务；application → executorsPort → agent。引擎通过注入的回调提出宿主请求，不反向导入 server。共享契约放 `src/shared/domain/agentWorkbench/`，不依赖具体引擎。新增 import 规则和契约测试，不放宽现有整个目录的边界。

## 4. 核心数据与状态契约

新增表采用当前数据库迁移机制分配下一版本号，不预定版本数字。不改变旧表字段语义。

| 对象/建议表 | 核心字段与约束 |
| --- | --- |
| `agent_workspaces` | id、kind(project/scratch)、用户路径、规范路径、路径身份、信任确认时间；scratch 由应用创建；项目目录可以包含或位于应用数据目录 |
| `agent_sessions` | id、workspaceId、engine、purpose(interactive/workflow)、policySnapshot、capabilitySnapshot、engineSessionId、engineVersion、revision、state、createdAt；engine/workspace/purpose 创建后不可改，切换创建新会话 |
| `agent_turns` | id、sessionId、requestKey、inputHash、state、delivery(not_sent/attempted/acknowledged/unknown)、connectionGeneration、开始/结束时间；唯一 `(sessionId,requestKey)`；同 key 异载荷 409 |
| `agent_events` | sessionId、递增 seq、turnId、generation、type、schemaVersion、data、sourceEventId(可空)、rawRef；唯一 `(sessionId,seq)` |
| `agent_approvals` | id、sessionId、turnId、generation、operationHash、policyRevision、状态、决定、期限；重复决定相同返回原结果，不同返回 409 |
| `agent_operations` | operationId、ownerSessionId、originTurnId、kind、inputSnapshot/hash、executorSnapshot、state(pending/approved/rejected/expired)、expiresAt、taskId；付费授权独立持久化，批准后只能创建同一任务 |
| `agent_tasks` / `agent_task_attempts` | taskId、ownerSessionId、originTurnId、kind、operationId、inputHash、executorSnapshot、state、attemptId、dispatch、remoteId、resultRefs、cancelRequested、revision；唯一 `(ownerSessionId,operationId)` |
| `agent_artifacts` / `agent_artifact_refs` | id、类型、存储键/hash/长度/MIME、producer、task/turn 来源、保存状态；独立引用表授予会话或任务可读权限，不以知道 ID 为授权 |
| `agent_commands` | 用于幂等用户控制命令的 scope/requestKey/hash/result；适用于重试、取消、恢复、采纳等 |

workspace/purpose 正交：project 与 scratch 都可交互；workflow 使用应用拥有的独立目录，绑定父运行。不是给模型一个可随时修改的“模式”参数。

### 4.1 状态机

- 会话：`ready / running / needs_attention / archived`；连接是否存活是独立属性，断开浏览器不改变会话权限。
- 轮次：`queued → running → completed | failed | cancelled | unknown`；运行中可处于 `awaiting_approval` 或 `cancelling`。只要存在无法判定的副作用，不能用普通 failed 掩盖。
- 任务：`queued → dispatching → running → succeeded | failed | cancelled | unknown`。`cancelRequested` 独立于 state；收到取消请求不等于已取消。unknown 只经核查或用户明确创建新尝试离开，不能自动重新提交。
- 工具执行：`pending / running / completed / failed / cancelled / unknown`；等待审批是 pending 的原因。模型文字不是任何执行状态的权威来源。
- 一个会话最多一个运行轮次。来自恢复、旧进程、旧审批的事件按 generation/turn 校验，不能写进新轮次。

### 4.2 事件和流式传输

统一事件外壳，保留差异：`message.delta`、`tool.updated`、`approval.requested/resolved`、`plan.updated`、`command.output`、`file.changed`、`task.updated`、`artifact.created`、`turn.finished`、`engine.extension`。未知扩展保留经过脱敏的有限记录，不猜测字段含义。

状态变更与对应事件在同一个短事务提交，提交后再发布 SSE。文本片段可按最多 100ms/16KiB 合并写入，结束前 flush；终端输出分页落文件，事件仅带游标和截断信息。前端按 `(sessionId,seq)` 去重；断线用 last seq 续读，缺口时重新取快照。启动时不把引擎 load 的历史重放写成新事件，更不能重放工具副作用。

默认每个命令保存最近可展示的 1MiB 输出，截断显示标记；参数/错误/原始事件设长度和嵌套限制，复用现有 trace 脱敏经验。绝不记录 Bearer、管理密钥、完整环境、图片 Base64。诊断保留时间和清理入口在 P3 落实；首版不自动删除被会话引用的任务产物。

### 4.3 引擎接口

适配器提供 `connect`、`capabilities`、`newSession`、`loadSession`、`prompt`、`cancel`、`respondPermission`、`close`；具体内部方法命名可随仓库约定调整，但语义必须一致。外部 fs/terminal 请求通过注入宿主回调执行。

能力是“协议声明＋本版本探针结果＋应用实现”交集，包含 resume、clientFs、clientTerminal、permissions、plans、usage、images 等。不支持的操作在后端拒绝、前端隐藏。动态引擎模型/配置按返回值呈现，不能根据引擎名称伪造支持。

引擎扩展按命名空间存储，只由该适配器解释。Codex 原生执行可继续使用其执行路径，不强迫模拟 ACP 宿主；UI 显示实际控制能力，不能因为两者有同一接口就宣称同等隔离。

## 5. 工作空间、信任与权限

### 5.1 执行边界

首版采用本机可信用户的交互工作台：命令经批准后使用当前用户权限执行。cwd、文件网关、审批卡均不是操作系统沙箱。项目配置可能引入 MCP、钩子和规则；打开项目先显示信任确认。P0 必须核对项目配置何时加载，确认前只允许不加载项目的能力探测，不启动项目会话。

project 路径经 realpath 规范化；拒绝设备路径、网络路径和整块磁盘根作为 workspace。项目目录可以包含或位于应用数据目录。Windows 大小写、junction、符号链接和父子目录重叠纳入锁判断。应用内重叠目录同一时刻只允许运行一个交互轮次，排队可取消；空闲会话不占锁。此规则不约束外部编辑器。

workflow purpose 无任意 Shell、无任意文件写、只允许节点声明工具。若无法证明所选引擎在受限配置中可执行这些边界，禁止注册该引擎为 workflow Agent 节点；不能只靠提示词或可能放行的 hook。

### 5.2 审批

- Grok 项目根内读取在项目授权范围内自动处理；根外默认拒绝，可由用户在会话设置显式添加只读根，模型不能扩权。
- 用户已明确批准 Codex 交互会话例外：使用原生全盘读取，界面显示并在创建时确认；写入和危险命令采用原生 read-only＋untrusted＋user 审批，仅允许本次。此例外不适用于受限 workflow Agent。原因、协议与证据见 [P5 决策](agent-workbench-p5-decisions.md)。
- 文件写入展示真实绝对路径和内容差异，默认逐次审批；可显式授予本会话当前工作根内文件写权限，修改策略版本使未决审批失效。
- Shell 每次显示程序、参数、cwd 和申请的环境变量名；首版只提供允许一次/拒绝，不提供模糊的“同类命令全允许”。
- Wiki 工具只产生建议；采纳继续经过现有业务版本校验。生图提交遵守第 7 节的付费任务批准，不继承文件写授权。
- 权限请求不直接映射为执行成功。宿主必须在执行前校验 session/turn/generation、操作哈希和授权；超时、断开引擎、取消或变更策略后拒绝/取消，不默认批准。
- 浏览器短暂断开允许审批卡留待重新连接，默认 5 分钟到期，且不能超过引擎实际请求期限；期限到达时明确拒绝。该值是首版产品默认，不是协议事实。
- 对无法关联到同一操作的引擎审批与宿主请求宁可再次审批，不能靠标题相同复用许可。执行记录说明授权依据。

### 5.3 本机管理接口认证

Host/Origin 校验保留，增加必需凭据。认证目标是防止未授权 HTTP 请求，不承诺阻挡同用户权限的恶意进程直接读取文件或数据库。

- 启动生成随机管理凭据，进程重启轮换。桌面通过主进程与后端的私有启动通道获得一次性 bootstrap code，preload 仅提供兑换动作；不能把通用管理密钥注入 renderer 或 Agent。
- 浏览器模式启动器打开带一次性 code 的 fragment 链接；前端兑换为 HttpOnly、SameSite=Strict 的本机 Cookie，立刻移除 fragment；code 短时有效、单次使用，响应 no-store。普通访问显示配对入口，不能对每个匿名 GET 自动发管理 Cookie。
- CLI 用数据目录内用户可读的受限凭据文件取得独立管理 Bearer，限制权限并声明同用户进程仍可读取；`--url` 模式显式配置 token 来源。文件不能放进项目目录。保留实例身份变化校验。
- Agent 只获得独立工具 Bearer，绑定会话、purpose、scope、generation 和过期时间；工具凭据不能调用管理路由。
- 本机 API（含 SSE、命令输出、产物）除 bootstrap 和最小无敏感健康响应外全部认证。静态资源不包含秘密；Vite 开发代理、桌面随机端口和浏览器模式都需验证。
- LAN 配对与临时下载令牌保留原语义，不能兑换本机 Cookie；所有新增 Agent 管理路由在 LAN 明确拒绝。临时分享下载仍只授权对应文件。
- 子进程使用环境允许列表：必须的系统路径、用户目录/CLI 认证位置、显式引擎配置；不继承应用管理凭据、无关服务密钥和代理凭据。按实际登录兼容性补齐变量，不打印变量值。

## 6. 执行宿主、Diff 与停止

### 6.1 文件

实现声明的 `fs/read_text_file`、`fs/write_text_file`；遵守所用 ACP v1 字段和错误语义。写前校验现存文件 realpath，创建文件校验最近存在的父目录、拒绝逃逸路径和 junction 重定向；执行前再次检查。保留原始字节/哈希，写入用同目录临时文件和替换，并检查审批后的文件内容未改变；有冲突返回 conflict，重新读取并重新审批。

这减少意外覆盖，不宣称抵御同用户恶意进程的 TOCTOU。不支持的编码、超大文件和二进制写入明确失败，首版文本上限 2MiB；不得静默转码或截断后覆盖。

### 6.2 命令

按 ACP v1 完整实现 `terminal/create`、`output`、`wait_for_exit`、`kill`、`release`；只在方法齐全后声明 terminal。程序与参数数组直接 spawn，不把模型文本拼进额外 shell；确实需要 PowerShell 时把其 executable/参数完整呈现并审批。windowsHide；独立进程树；stdout/stderr 有上限、退出码和截断标记。terminal ID 只能由所属连接代际访问。

创建终端前再次校验审批与 cwd。kill 是终止，release 按规范回收资源，不能泄漏后台子进程。应用退出清理所有应用拥有的命令；重启不凭旧 PID 杀进程，必须有可验证的进程所有权/存活信息，否则标未知并提供核查。

2026-10-29 适配修订：Grok 1.0.70 的整条命令字符串允许映射为明确的系统 PowerShell 操作；最终 executable、完整 argv（含 UTF-8 前导脚本）、cwd 和有效环境必须作为不可变审批对象并参与 hash。调用方明确选择 PowerShell 语法，不能按空格拆分命令、静默切换解释器或使用未展示的 shell。显示类环境按名称和值白名单处理，Grok 注入的 Java opts 等省略并记录；未知或能改变执行器的变量拒绝。当前适配与合成宿主已实现并实机通过，用户审批卡、授权账本及代际约束仍属于 P2。

### 6.3 变更展示

文件网关写入记录 before/after 哈希与文本差异；引擎 Diff 作为另一来源，不假装它覆盖所有修改。项目开始轮次时记录已有 dirty 状态，结束时显示 Git 工作区差异并标“可能包含外部修改”；无 Git 项目只保证展示宿主可观测写入。命令造成的变化和二进制变化应显示可知范围与限制。

首版不自动 git add/commit/reset，不提供整轮撤销按钮，不改用户索引。未来单文件恢复必须检查当前 hash 等于该次 after hash，恢复冲突不能覆盖；其余外部副作用不归入文件恢复承诺。

### 6.4 停止和退出

停止轮次：原子进入 cancelling、撤销未决审批/工具授权、发送引擎取消、终止本轮宿主命令；等待当前配置的短宽限（初始 1.5 秒，验证后可调整），必要时关闭该会话引擎进程树。迟到事件可用于核实已有操作结果，但不能启动新操作或重开已终止轮次。

独立已提交任务继续运行，界面明确列出；另有“取消任务”操作。未派发的任务可确定取消；已经派发且上游无法确认取消的保持 unknown/cancelRequested。取消与完成竞争时，以真实结果为准保存产物，标注“请求取消后完成”。

浏览器关闭不停止后端任务；应用后端退出不承诺继续本地进程，落盘派发状态并清理拥有的进程，重启执行恢复规则。连接空闲仅在无运行轮次、审批和宿主终端时回收，当前实现每轮结束立即关闭，后续按测量决定是否恢复 60 秒空闲池；独立任务不依赖引擎连接，暂不引入未经测量的 30 分钟常驻策略。

## 7. 应用工具、任务与产物

### 7.1 工具目录

| 工具 | 输入核心 | 输出 | 交付 |
| --- | --- | --- | --- |
| `wiki_search` | 查询、过滤、分页 | 有限条目与可读引用 | A |
| `wiki_read` | 内容 ID/版本 | 内容及来源版本，图片受大小限制 | A |
| `wiki_propose` | 动作、目标版本、依据 | 待采纳建议 ID，不自动修改库 | A |
| `image_submit` | operationId、prompt、reference artifact IDs、executor、参数 | taskId 与 queued 状态 | A，覆盖生成/改图 |
| `task_status` | 可访问 taskId | 状态、进度、产物引用、可用操作 | A |
| `artifact_read` | 有权限的 artifact ID、分页/格式 | 文本/图片内容或受控下载引用 | A |
| `task_cancel` | taskId、revision | 取消请求状态 | A；不能跨 owner |
| `workflow_list/read` | 过滤/工作流 ID | 定义摘要、输入 schema、风险动作 | B |
| `workflow_submit` | operationId、工作流 revision、输入/产物引用 | taskId、绑定的 workflow runId | B |

工具使用稳定名称和 JSON schema；详细说明按需提供，但权限、必填字段和副作用不能延迟到执行后才告知。创建工具注册表只承载描述、校验和 service handler，不创造任意脚本工具。

原生 Grok 生图作为引擎事件产物可归档，但不伪装成具有完整幂等/取消能力的应用任务。批次 A 的受控生图验收使用 `image_submit` 路径；若无法禁用原生生图或将其授权纳入控制，记录能力限制并阻止发布“所有付费调用均经应用审批”的承诺。

### 7.2 幂等与批准

创建付费任务由应用先建立 operationId 和输入快照，UI 展示执行器、提示词、引用及可得费用信息；用户批准后 operationId 绑定 owner、输入 hash 和执行器快照。Agent `image_submit` 缺少批准时创建待审批请求并返回“需批准”，不得派发。审批通过由服务创建 queued 任务，Agent 重复提交同 operationId 只得到同 taskId。

首次 `image_submit` 可省略 operationId，由后端分配并持久化 pending operation，返回 operationId 和审批卡；此时尚无 taskId。后续查询返回 operation state 或已创建的 taskId。操作批准不是引擎 RPC 的等待回复：原轮次正常结束后审批卡仍有效（默认 10 分钟），用户取消该轮次则未批准 operation 一并失效；已经批准的独立任务不受轮次停止影响。批准与 queued 任务创建在同一事务完成；重启将未批准 operation 标 expired，不能悄悄批准或自动重提。文件/命令审批仍执行第 5.2 节的代际和期限规则，两者不能混用。

同 operationId 不同载荷返回 409。模型换工具调用 ID 但复用 operationId 仍不重复；另造 operationId 必须重新批准。用户在界面“再次生成”显式创建新 operationId。首版不授予无限付费额度。

提交在事务中写任务和幂等响应，worker 在事务外执行。dispatch 标记在外部副作用前持久化：崩溃在标记之后、远端确认之前只能标 unknown，不能推断“未执行”。有远端幂等键则使用，但不宣称跨任意上游 exactly-once。

### 7.3 资源与继续执行

保留当前并发上限作为初始配置；把资源排队从聊天内部等待提升为可见调度。引擎轮次持有相应额度，独立任务仅在真正执行期间持有。所有任务提交/状态工具立即返回，不在父轮次持锁时等待同引擎任务完成。

批次 A 不自动发起下一模型轮次：任务完成后通知 UI，用户点击“带结果继续”创建带 artifact 引用的新轮次。批次 B 可继续采用该语义，不以自动唤醒作为完整性前提。工具返回明确的 waitReason 和“结束当前轮次以运行排队任务”提示；每轮对同一无变化任务最多查询 3 次，再返回 resource_wait 并取消该轮次、释放额度，保留对话和任务。测试必须覆盖模型持续轮询，不能只依赖模型遵守提示。

工作流调度器提交子 Agent 前不得持有子引擎资源额度；由真正执行的适配器获取一次，禁止重复获取同 key。第二版调用链带 parentTaskId、祖先 workflowId、depth；重复同工作流和 depth 超过 2 拒绝。2 是首版可调整的防递归默认，不声称普适最优。

### 7.4 产物保存与授权

文件先写任务专属暂存区，校验类型/长度/hash，再原子移动到不可变存储，最后短事务写 artifact 和引用。崩溃可能产生无引用文件，启动核对只标记或隔离，不自动删除未知文件；不能先把任务标成功后再尝试保存结果。

状态分开：上游执行结果、产物已保存、是否已入 Wiki。保存失败保留 remoteId/可取回来源，尝试取回不能再次调用生成；task 返回存储错误及可恢复状态。`succeeded` 要求所承诺的产物已保存。

访问 artifact 校验会话/任务引用，不接受任意服务器路径。复制到工作目录时继续走文件权限，读取源文件 realpath 并限制本次来源；对旧 workflow artifact 使用映射引用，不凭 ID 直接扩权。保存到 Wiki 走明确采纳动作，复用去重及版本规则，取消和失败不自动入库。

## 8. HTTP、界面与恢复

### 8.1 API 最小契约（新命名空间 `/api/agent`）

| 路由 | 行为 |
| --- | --- |
| `POST /workspaces` | 验证路径、信任确认并返回 workspace；不会执行模型 |
| `POST /sessions` / `GET /sessions/:id` | 创建不可变绑定/读取快照 |
| `POST /sessions/:id/turns` | requestKey + input，返回 turn；重复同 key 复用；忙时 409 |
| `GET /sessions/:id/events?after=` | 有游标 SSE；认证及 owner 检查 |
| `POST /turns/:id/cancel` | 幂等停止，返回当前状态 |
| `POST /approvals/:id/decision` | revision、操作 hash、决定；过期/代际不匹配 409 |
| `GET /operations/:id` / `POST /operations/:id/decision` | 读取付费操作状态；用户以 requestKey/hash 批准或拒绝；同事务创建唯一 task；非引擎审批，按 operation 的期限和 owner 检查 |
| `POST /sessions/:id/resume` | 只恢复上下文，不自动发送用户任务 |
| `GET /tasks/:id` / `POST /tasks/:id/cancel` | 查询/取消；不自动重试 |
| `POST /tasks/:id/reconcile` / `POST /tasks/:id/reexecute` | 前者只核查/取回，后者明确新 attempt 并重新取得副作用授权 |
| `GET /artifacts/:id` / `GET /artifacts/:id/content` | 元数据/内容；校验引用权限 |

统一错误包含 code/message/retryable/stateKnown；401 无认证、403 无权限、409 状态冲突，业务校验使用项目现有 4xx 约定。客户端只能安全自动重发带相同 requestKey 的本地控制请求，不能自动重放未知模型或外部生成请求。

### 8.2 界面

沿用 [设计系统](design-system.md)：工作台侧栏显示项目/会话，主区为消息与执行时间线，右侧按需展示变更、产物和任务。正常操作不要求输入 JSON、内部 ID 或服务器文件路径。

审批卡展示操作事实，允许与拒绝同样清楚；拒绝后可看原因，不显示为执行成功。计划、用量等仅在引擎提供时出现。窗口刷新恢复已有审批和任务。产物可引用、下载、显式保存到 Wiki；与 Wiki/工作流页面双向跳转。模型选择按会话，创建时可采用全局默认但后续不被全局修改悄悄替换。

### 8.3 恢复

启动先恢复应用事件和任务账本，再按需 load 引擎会话。挂起审批过期，旧宿主操作不重放；attempted 但未确认的轮次和派发任务标 unknown。尚未 dispatch 的 queued 独立任务可继续调度；已运行任务只核查/取回，不能重新生成。

load 成功不自动 prompt；load 失败展示“原上下文不可恢复”，用户可明确用摘要新建会话。摘要重建有新 ID，不声称延续了原生上下文。路径改变、引擎版本不兼容和工具策略变化必须提示并禁止静默移用旧会话。对话分支只复制对话引用，不回退磁盘。

## 9. 工作流接入与迁移

批次 B 的 `workflow_submit` 固定工作流 revision、输入及执行器快照，验证输入/引用权限后复用现有 submit requestKey。任务账本保存 runId 和结果引用，工作流运行状态仍由 workflowRepository 权威维护；不建立两个能独立修改同一 run 状态的调度器。

新增受限 `agent` 节点与已有 model 节点区分：输入包含任务指令、可用工具集合、输出 schema、执行器；输出保存原始回答和校验结果。schema 不符失败且保留原文。节点不能继承交互会话、权限批准或任意项目根；失败恢复复用现有 unknown 规则。节点和工作流调用授权不得绕过 Wiki 建议采纳。

旧 UI 与新内核先并行，通过默认关闭的 `agentWorkbenchEnabled` 开关启用新路由/入口；旧聊天记录可正常读，新写入留在新表。迁移完成后旧聊天创建入口改用新内核的 Wiki 模板（工具范围＋初始指令），而不是再维护一套执行循环。

旧记录保留 ID、附件、引用、trace、分支和草稿读取；继续旧会话时创建关联的新会话并显示上下文转换，不修改历史。旧自动整理和图片执行器仍可作为任务使用，新旧并行期间共享资源额度避免超发。

数据库迁移只加表和必要映射，兼容测试通过后再改变入口。关闭开关只能阻止新任务；必须先停止并核对新系统活动任务，不能让旧 worker 接管。回退程序前备份关闭状态下的完整数据库和媒体；旧版本如果不支持新 schema，使用已验证的旧程序/备份组合，不承诺任意二进制直接降级。

删除旧代码前查全部引用、自动整理/工作流调用和打包清单；必要的执行器保留。不要借重构修改现有内容、标签、共享、视频或工作流定义语义。

## 10. 实施包与门槛

每个包完成：实现＋针对性测试＋验收证据＋更新本节状态。依赖未通过不得标包完成。

实施状态（2026-10-29 更新）：P0–P3 已通过各自实现与专项验收；P4 已通过全量回归和 Windows 目录包验收；P5–P6 已通过专项、实机、完整回归及 Windows 目录包验收，批次 A/B 均已完成。真实 Grok 客户端文件/终端、精确工具范围、无令牌 SDK、Wiki 建议、获授权的两次图片任务、原上下文恢复、完整浏览器主线均已有证据。当前状态与逐项报告见 [实施进度](agent-workbench-progress.md)，使用见 [工作台指南](agent-workbench-usage.md)。最终验收清单与已确认边界见实施进度。

以下 P1 数字为较早的历史验证；退出保护 fixture 超时已修复并真实 Electron 验证通过。新增迁移和工作台验证、当前全量失败处置以进度记录为准。

P1 验证证据：

- `npm.cmd run build`、`npm.cmd run check:arch` 通过。
- 完整测试使用 `node --test --test-concurrency=4 --test-timeout=120000 --test-reporter=tap "test/unit/*.test.js" "test/integration/*.test.js" "test/ui/*.test.js"`：724 项，718 通过、5 跳过、1 失败。日志为工作区 `.local/agent-workbench-verified-tests.log`。限制并发用于避免多组浏览器/CLI 同时启动时的时序干扰，没有移除测试或修改业务断言。
- 唯一失败是 `test/integration/desktop-close.test.js`：Electron fixture 等待退出保护事件超过 15 秒。该测试、`test/fixtures/desktop-close.cjs` 与 `src/main/quitController.js` 本次均未修改；在独立的针对性执行中仍复现超时，日志为 `.local/agent-workbench-targeted.log`。没有跳过此项，也不宣称 `npm run check` 全通过。发布前仍需处置。
- 认证边界与探针专项 8 项通过；浏览器真实配对、LAN 与临时分享专项 17 项通过。
- `node tools/smoke-desktop.mjs` 通过：实际 Electron 私有启动配对、认证 API、图片与画布操作通过；日志 `.local/agent-workbench-desktop-smoke.log`。
- Vite＋外部 API 的实际桌面 smoke 通过，验证开发代理和自动配对；日志 `.local/agent-workbench-dev-smoke.log`。
- 原有行为测试改为通过真实凭据或一次性兑换建立授权；新增安全测试直接使用原始 server/fetch 验证匿名拒绝，没有产品内测试后门。
- 使用与连接变化见 [本机连接与认证](local-authentication.md)。尚未进行新工作台 UI、数据库迁移或 Windows 安装包验收。

| 包 | 依赖 | 具体改动与产出 | 验收门槛 |
| --- | --- | --- | --- |
| P0 能力摸底 | 无 | 临时目录探针；记录 Grok 版本、初始化、fs/terminal 请求、搜索/子工具路径、项目配置、hook 错误、取消、load；形成实际结果附录 | 能稳定拦截客户端写入/命令并拒绝执行；明确所有未覆盖路径。否则停止 P2，固定可验证 CLI 版本或先改引擎方案，禁止静默放开原生工具 |
| P1 本机认证 | 无；与 P0 独立 | routes 认证；desktop/browser/CLI 启动与兑换；SSE/下载凭据；工具令牌隔离；子进程环境 | 不带凭据无法读私有 API 或改设置；开发/桌面/浏览器/CLI 可用；LAN/分享回归；不宣称隔离同用户 Shell |
| P2 内核与宿主 | P0、P1 | shared 契约；新增表/repository；Grok adapter；会话状态；审批；完整 fs/terminal；进程清理；最小 UI | 真实 Grok 改测试文件并运行测试；拒绝不执行；刷新审批/停止/重启可解释；已有 dirty 文件不被覆盖 |
| P3 工具、任务与产物 | P2 | Wiki 工具；生图/改图；operation 批准；worker/资源队列；不可变产物；任务 API/UI | 生图断开界面仍保存；重复提交只一项任务；同引擎嵌套不死锁；取消/unknown/存储失败不重发 |
| P4 工作台交付 A | P3 | 完整时间线、计划/输出、Diff、项目/会话/产物；打包；使用文档 | 第 11 节 A 项全通过，真实验收路径有记录；不以 mock 代替真实执行 |
| P5 多引擎与工作流 | P4 | Codex 原生审批与事件；相同上层契约；workflow bridge；受限 agent 节点 | Codex 契约测试和真实操作通过；工作流原定义兼容；父子资源不重复取锁；受限节点无越权 |
| P6 迁移与收口 B | P5 | 旧聊天映射；Wiki 模板；入口切换；删除死编排；文档与架构规则更新 | 历史/草稿/附件/来源不丢；恢复和回退演练；完整回归和桌面包验收；所有遗留调用已处理 |

P0 测试只使用合成目录和无害命令，不直接对用户项目运行删除/修改实验。真实模型测试记录次数及是否产生付费任务；登录缺失或额度不可用记录阻塞，不冒充完成。

P0 结果追加到本文或同目录链接的探针记录，逐项填写：CLI 版本和路径、协议版本、OS、输入/能力声明、预期请求、实际请求及脱敏日志位置、通过/失败/未测、是否调用模型、受影响阶段。fixture 结果与真实 CLI 结果分列；“命令帮助里有”不能填作执行通过。P0 失败时保留旧产品可用，明确下一步是升级固定版本还是修改路线，不自行降级为全权限原生执行。

## 11. 可执行验收矩阵

测试文件可按现有目录规则新增；下表是行为验收，不要求复制指定文件名。所有文件/数据库变更测试使用临时目录。

| ID | 批次 | 场景/操作 | 必须结果 |
| --- | --- | --- | --- |
| A01 | A | 声明 fs/terminal，真实 Grok 读取、写入、运行测试 | 请求走已验证路径；程序、cwd、输出/退出码可核对 |
| A02 | A | 拒绝写入/命令；审批超时；等待中取消 | 文件/命令副作用不发生；旧批准无法复用 |
| A03 | A | 写前后改文件、junction 指向外部、创建新目录文件 | 冲突/外部路径拒绝；不覆盖用户新内容；允许的创建成功 |
| A04 | A | 对已批准 Shell 尝试 cwd 外无害写入 | UI 不宣称系统级限制；该测试用来记录实际边界，不能用文件网关通过替代 |
| A05 | A | 无凭据请求配置/事件/产物；工具 token 调管理接口 | 401/403；合法桌面/CLI/浏览器通过；不泄露秘密 |
| A06 | A | LAN 用户请求 Agent 路由、独立分享下载 | Agent 拒绝；合法分享继续只访问对应文件 |
| A07 | A | 消息提交响应丢失后同 requestKey 重试 | 同 turn；不同载荷 409；不产生第二轮模型调用 |
| A08 | A | SSE 断开重连、重复事件、load 历史重放 | 时间线无重复，工具副作用不重放，seq 连贯 |
| A09 | A | 命令生成子进程后取消/退出；终端 release | 已拥有进程树退出；未证明退出的标未知；其他会话进程不受影响 |
| A10 | A | 重启前轮次未确认、任务已 dispatch | 标 unknown；无自动 prompt 或再次生成；可核查 |
| A11 | A | 同 operationId 重试/新 callId/不同载荷 | 同 taskId；异载荷 409；新 operation 未批准不派发 |
| A12 | A | queued 取消、远端不支持取消、完成与取消竞争 | 确定未派发则 cancelled；无法确认则 unknown；已完成产物保留 |
| A13 | A | 文件保存失败、落盘后 DB 失败、取回重试 | 无虚假 succeeded；无引用文件可核查；取回不再生成 |
| A14 | A | Grok 父轮次提交 Grok 生图并持续查状态 | 查询上限触发让出；资源额度释放；任务执行；点击带结果继续可引用 |
| A15 | A | 已有 dirty Git 项目/非 Git/二进制变化 | 不修改索引，不覆盖初始修改；展示范围准确；无虚假整轮撤销 |
| A16 | A | 同目录、大小写别名、父子目录两个会话 | 内部轮次排队，取消队列有效；空闲不占锁 |
| A17 | A | Wiki 建议期间原内容变化；未授权 artifact ID | 采纳冲突且无部分写；artifact 403/404；建议不会自动采纳 |
| A18 | A | 项目配置存在 MCP/hook；未信任前创建会话 | 确认前不加载项目执行配置；确认后展示实际控制限制 |
| A19 | A | 桌面和窄屏完整主线、刷新、草稿保护 | 无需 JSON，审批/输出/任务可见；无未保存内容静默丢失 |
| B01 | B | Codex 下创建、审批、停止、恢复和工具调用 | 使用原生协议且共享应用契约；不支持能力清楚隐藏 |
| B02 | B | 同 operation 提交工作流两次 | 一个绑定 run；定义/输入快照不被后续编辑改变 |
| B03 | B | 工作流受限 Agent 请求 Shell、写文件或管理工具 | 执行前被可靠阻止；未验证可靠门禁的引擎不可选 |
| B04 | B | Agent→工作流→Agent；相同 workflow 递归 | 不重复获取同资源；环路和深度限制明确拒绝 |
| B05 | B | 旧聊天、草稿、图片、分支、来源迁移 | 原数据可读；新会话转换明确；不伪造原引擎恢复 |
| B06 | B | 新库启动两次、迁移中失败、关闭开关、旧备份恢复 | 迁移幂等/回滚；无双 worker；备份恢复可用 |

验证顺序：契约/单元 → 临时库集成（含崩溃注入）→ 真实 Grok/后续 Codex → UI → `npm.cmd run check` → Windows 打包/桌面 smoke。针对测试只验证真实边界，不堆实现镜像测试。全量已有失败要记录基线与独立复现，不能把“不相关”当成新功能已发布的理由；发布门槛是相关新增验证通过且剩余回归有明确处置。

## 12. 未验证事项、阻塞归属与评审结论

| 事项 | 当前结论 | 负责包/阻塞范围 |
| --- | --- | --- |
| Grok 1.0.70 客户端 fs/terminal、搜索覆盖 | 客户端文件/终端、取消/load、显式工具注册表均实测通过；禁止未声明原生工具、子 Agent 和原生图片入口 | P0 已通过固定版本范围；新版本重新验证 |
| hook 超时/错误是否放行 | 实测 hook error 后仍请求客户端写入；宿主拒绝阻止了副作用。超时未测，不能作为唯一边界 | P0；受限 workflow 必须独立证明 |
| 项目配置、权限自动放行、取消子进程 | 已完成中立 cwd 初始化、信任后创建、目录核对、正常取消及拥有的子进程清理验证 | P0/P2 证据见进度 |
| Windows 系统沙箱 | 不作为本方案承诺 | 若以后需要强隔离，另立 OS 隔离设计 |
| Codex 原生审批/恢复与动态工具组合 | 0.159.0 原生协议、真实文件/命令、SDK、停止与无 prompt 恢复通过；原生全盘读取经用户明确批准 | P5 已验证 |
| 真实图片上游取回/取消 | 按执行器能力分别记录；不支持时保留 unknown | P3 |

设计采用 sr-design-gate Artifact 路线。此文允许从探针、认证和纯状态契约开始实施，不允许跳过门槛直接开放原生工具。未验证项不是留给实施者猜测的产品决策，每项已有验证包、失败处理和阻塞范围。

结构化评审范围：本文及当前代码锚点；重点检查审批与执行、任务与资源、状态与恢复、架构依赖和迁移一致性。评审记录见 [文档索引](README.md)；不以文档评审代替真实 CLI 和产品验收。
