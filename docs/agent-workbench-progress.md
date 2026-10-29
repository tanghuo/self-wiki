# Agent 工作台实施进度

源方案：[agent-workbench-plan.md](agent-workbench-plan.md)。当前工作区含用户已有的工作流、ComfyUI 和文档修改，全部保留。串行推进共享数据库、契约和服务接线；不提交或发布。

| 包 | 依赖 | 状态 | 可观察验收与下一步 |
| --- | --- | --- | --- |
| P0 | 无 | completed | 固定 1.0.70 f50904；显式原生工具注册表、SDK 通道、MCP 目录核对，hook error 下尝试绕过原生 grep 仍失败；正常取消/load 实测。未验证的原生图片/子 Agent 不在注册表 |
| P1 | 无 | completed | 认证、配对、CLI 凭据、LAN/分享回归通过；真实 Electron beforeunload 退出 fixture 的确认时序已修复并通过 |
| P2 | P0/P1 | completed | 数据/事件、幂等、文件/命令审批、进程清理、草稿、恢复已接入；真实浏览器→Grok 改合成文件并执行测试通过，拒绝/刷新/窄屏验证通过 |
| P3 | P2 | completed | Wiki 建议真实调用通过；获授权的 1 次生成和 1 次改色均保存成功；重复/取消/崩溃/存储失败取回验证通过，同引擎真实资源锁轮询让出测试通过 |
| P4 | P3 | completed | 完整工作台与批次 A 实机主线、全量回归、构建、架构检查、Windows 目录包和真实桌面 smoke 均通过；批次 A 已验收 |
| P5 | P4 | completed | Codex 原生文件/命令/动态工具/停止/恢复及真实浏览器通过；真实 Grok→工作流→受限 Agent 保存结果；原子绑定、冻结、防递归和资源让出通过 |
| P6 | P5 | completed | 历史转接、Wiki 模板与入口切换、完整恢复、全量回归、构建/架构、Windows 目录包及真实桌面 smoke 全部通过 |

每包完成实现、针对性测试、规格与代码自查、集成验证后才标 completed；可运行不等于已经验收。P0 的未覆盖执行路径不得以提示词或失败可能放行的 hook 作为唯一控制。

## 实机证据

- [精确工具范围和无令牌 SDK](agent-workbench-sdk-live-2026-10-29.json)：2 次文本模型请求，0 次图片调用；故意让 hook 报错且允许引擎权限后，`use_tool→grep` 仍被注册表拒绝。应用 SDK 不携带管理 Bearer。
- [内核文件与命令](agent-workbench-p2-live-2026-10-29.json)：1 次模型调用，实际 41→42，测试命令退出 0、输出标记核对、事件 seq 连续。
- [Wiki 建议](agent-workbench-wiki-live-2026-10-29.json)：1 次模型调用，先读版本再提出建议，未自动采纳，显式采纳后写入。
- [真实图片任务](agent-workbench-images-live-2026-10-29.json)：用户明确授权的最多两次图片调用均已使用；生成蓝色圆形并改为绿色，两项 succeeded、产物已保存、重复批准复用同一任务。后续未追加生成。
- [原上下文恢复](agent-workbench-resume-live-2026-10-29.json)：0 次 prompt、0 次图片调用；同原生上下文、无新 turn、只追加恢复事件。
- [真实浏览器→Grok](agent-workbench-ui-live-2026-10-29.json)：1 次文本/看图调用、0 次图片生成；上传合成蓝图、草稿提交、页面审批改文件和固定命令、输出可见、刷新和 390px 窄屏全部通过。
- `npm.cmd run build` / `check:arch` 已通过。Windows 目录包 `release/win-unpacked` 构建及 `tools/smoke-desktop.mjs --packaged` 真实启动通过；在最终代码冻结后复跑。
- 全量首轮 749 项：719 通过、23 失败、2 取消、5 跳过。迁移版本断言已补 41–43；独立 ComfyUI 取回测试复跑通过；其余主要为已有工作流界面改版移除的按钮/布局。修复后的验证在 `.local/agent-workbench-regression-fixes.log` 和 `.local/agent-workbench-workflow-ui-current.log`，尚不宣称全量通过。

使用说明：[Agent 工作台](agent-workbench-usage.md)。P0–P6 均已完成，最终验证结果见下方；不以早期批次 A 记录替代最终验收。

## 批次 A 最终验证

- 全量复跑 `.local/agent-workbench-full-tests-final.log`：753 项，748 通过、5 项原有跳过、0 失败、0 取消。
- 工作流旧界面测试改用直接画布、现有运行记录按钮；移除旧布局选择器的依赖，继续验证审核、输入定义快照、次序、模板有效性和用户编辑，不回退既有产品改版。专项 28 项全通过。
- `--no-optional-locks` 修复 Git 状态查询刷新索引缓存的问题；真实 Git fixture 核对 dirty index 原始字节不变。批准命令可写 cwd 外的合成文件，明确记录没有 OS 沙箱的边界。
- 进程树清理返回实际确认结果；Windows taskkill 失败或超时不能被当作清理成功，运行时保留 unknown。修复后真实终端/取消专项 8 项通过。
- build、check:arch、Windows 目录打包和真实 packaged smoke 通过，日志 `.local/agent-workbench-build.log`、`agent-workbench-arch.log`、`agent-workbench-package-final.log`、`agent-workbench-packaged-smoke-final.log`。无提交、无发布。
- 当前连接在轮次结束即关闭，下一轮按需 load。优先保证宿主和工具绑定及时回收，未启用 60 秒空闲池；这是连接复用优化，不影响持久上下文。

## 批次 B 实机与专项

- Codex 0.159.0 原生策略、文件/命令、动态工具与停止、无 prompt 恢复、真实浏览器审批/刷新/390px 窄屏均通过。证据见 [P5 决策](agent-workbench-p5-decisions.md)。用户明确批准原生全盘读取例外，工作流受限节点不继承此例外。
- [真实受限 Grok](agent-workbench-restricted-2026-10-29.json)：1 次文字请求、0 次生图；仅 search_tool/use_tool，Wiki SDK 调用成功，原生终端请求被拒绝，无宿主副作用。
- [真实工作流桥接](agent-workbench-workflow-2026-10-29.json)：2 次文字请求、0 次生图；父会话提交待批准操作，批准后原工作流运行独立受限 Agent，Wiki 标记进入已保存摘要。没有重复获取同一引擎资源。
- 工作台/工作流专项 76 项通过；原子 run 绑定、冻结定义/输入/执行器、operation 去重、跨会话产物拒绝、防递归、最多两层、父轮询让出资源均有集成测试。
- 历史专项 6 项通过，含真实旧表的分支、原生线程、草稿、图片、trace 和原文保留；浏览器旧聊天→新会话草稿→明确发送通过。迁移 44 支持失败回滚与重复执行，完整资料备份恢复后两次启动、外键与完整性检查通过。
- 首轮批次 B 全量 765 项：757 通过、3 失败、5 跳过。已修复旧聊天新建按钮异步时序；两项 ComfyUI 图片审核测试按现有“通过选中的 1 / 2 张”契约更新。涉及浏览器专项 84 项全通过；最终全量复跑中。
- 新 Windows 目录包及真实 packaged Electron smoke 已通过，最终代码冻结后再次核对包内源码。

## 最终交付验收

- 完整回归：774 项，769 通过、5 项原有跳过，0 失败、0 取消。日志：`.local/agent-workbench-complete-tests.log`。
- 上一轮 770 项有一项 Wiki→Agent 导航超时，独立 6 项全部通过。导航测试对临时 busy 保护造成的未切换执行有界重试，保留搜索、详情、浏览器返回的全部断言；随后完整复跑通过。
- 最后补充的历史/工作流/恢复专项 9 项全部通过，含长输出与 Wiki 12000 字契约；摘要明确截取，完整原运行未改写。日志：`.local/agent-workbench-final-contract-tests.log`。
- 重新执行审批补齐原始提示词/参考图或冻结工作流版本与步骤后，全部工作台专项和浏览器 32 项通过；重新构建、架构检查、打包及真实桌面 smoke 再次通过。日志：`.local/agent-workbench-final-amendment-tests.log`。
- 构建、架构规则、diff 空白检查通过；Windows 目录包完成，实际 packaged Electron smoke 通过。包内 10 个关键文件 SHA-256 与最终源码相同。
- [最终验证清单](agent-workbench-final-validation-2026-10-29.json)。可执行文件：`release/win-unpacked/self-wiki.exe`。开关保持默认关闭。未提交、未发布。
- 已检索旧 ChatService、chatConnection、chatImageExecutor、CodexSession 和 workflow model 调用者：兼容旧 API/关闭开关路径、历史工具和图片执行仍有调用，保留；旧 workflow model 的 hook-only 编排已替换为精确空工具的受限引擎。未删除仍有调用者的兼容代码。
