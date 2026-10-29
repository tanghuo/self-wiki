# P5 本机原生协议决定（2026-10-29）

源方案：[工作台](agent-workbench-plan.md)。P0–P4 已通过；本记录固定 P5 的新增边界，避免把 Grok 宿主语义套用到 Codex。

## 已核实事实

- 本机 Codex CLI 0.159.0；其导出的实验协议 schema 保存在 `.local/codex-workbench-schema`。`thread/start`、`thread/resume`、原生命令/文件审批、动态工具、取消和通知均有实际 schema。
- 实机 `--listen stdio://` 返回 `invalid transport`；`--stdio` initialize 成功。接入改用实际可用的参数，旧接入专项 12 项通过。
- 零模型调用的权限探针已正常登录，但创建 `:root=deny` 的上下文被 Windows elevated 沙箱拒绝，要求 effective `:root` read access。证据 `.local/codex-workbench-policy-selected-live.json`。
- 当前 Windows build 22631；官方 MXC 支持要求更高版本。没有修改系统用户、ACL、防火墙或安装沙箱组件。

## 用户明确选择

用户已回答：“允许 Codex 使用原生全盘读取权限，并在界面明确提示；写入和危险命令仍按原生审批”。这是方案 5.2 根外默认拒绝规则在 **Codex 交互项目执行** 上的显式例外。

Codex 采用原生 read-only 权限起点、`untrusted` 审批策略、`user` 审批接收方。协议允许的安全读取可能自动运行，不能宣称每条命令都由本应用审批。只返回本次 accept/decline，不新增会话级授权或 execpolicy 规则。文件审批必须带已观察到的同 item Diff；缺失或无法绑定时拒绝。网络和额外权限不自动授予。没有可验证原生控制的版本不可选。

应用工具通过 `item/tool/call` 本连接回调执行；每次验证当前 thread/turn/generation、名称和参数，Wiki/付费操作继续使用应用层采纳和 operation 审批。关闭 native image generation、子 Agent、插件、浏览器及额外 MCP；实际目录有外部 MCP 时禁止发送任务。

受限 workflow Agent 节点没有这项例外：独立会话，精确工具范围、无任意 Shell/写文件/管理工具，不能继承交互批准。父工作流不重复占用子引擎资源；调用链记录父任务、祖先工作流与深度，环路或深度大于 2 拒绝。

工作流本身仍由现有 workflowRepository 权威维护；工作台只保存 operation→task→runId 关联和引用。所有可能调用外部模型或生成的 workflow_submit 均先展示待批准操作，按固化定义和输入执行；未知结果只核查，不重提。

## 验收与当前状态

先原生协议 fixture，再合成项目真实命令/写入、拒绝、停止、恢复、应用工具；之后工作流兼容和递归/资源测试。没有完成的实机项不标通过。P5 专项与实机验收已完成，Codex 选项已开放；整个工作台仍默认关闭。批次 B 的最终全量回归和打包结果以实施进度为准。

证据：[原生策略](agent-workbench-codex-policy-2026-10-29.json)、[文件/命令/恢复](agent-workbench-codex-mainline-2026-10-29.json)、[动态工具与停止](agent-workbench-codex-sdk-cancel-2026-10-29.json)、[真实浏览器](agent-workbench-codex-ui-2026-10-29.json)、[受限 Grok](agent-workbench-restricted-2026-10-29.json)、[真实工作流桥接](agent-workbench-workflow-2026-10-29.json)。

来源：[官方 App Server](https://learn.chatgpt.com/docs/app-server)、[权限配置](https://learn.chatgpt.com/docs/permissions)、[Windows 沙箱](https://learn.chatgpt.com/docs/windows/windows-sandbox)。协议字段以本机导出的 0.159.0 schema 为准，文档不是执行通过证据。
