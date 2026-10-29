# 文档索引

## 当前使用与实现参考

- **[通用 Agent 工作台重构](agent-workbench-plan.md)**：[实施进度与实机报告](agent-workbench-progress.md)、[使用说明](agent-workbench-usage.md)、[最终验证](agent-workbench-final-validation-2026-10-29.json)。P0–P6 与批次 A/B 已完成；默认关闭，启用后支持 Grok/Codex、审批、Wiki/图片/工作流任务与旧聊天转接。

- [使用与配置](usage.md)、[CLI](cli.md)、[本机连接与认证](local-authentication.md)、[设计系统](design-system.md)。
- [聊天引擎](chat-engines.md)、[生图配置](image-generation.md)、[调用记录](chat-call-records.md)、[Token 用量](token-usage.md)、[Token 效率](token-efficiency.md)。
- [工作流指南](workflows.md)、[工作流执行契约](workflow-design-and-implementation.md)。
- [视频标注与相似检索](video-auto-annotation-design.md)、[视频首帧整理](video-first-frame-organization.md)。
- [语义检索](semantic-retrieval-design.md)、[搜索相关性](search-relevance.md)。
- [元素生命周期](element-lifecycle-design.md)、[关系方向](relation-directions-design.md)、[名称归一](vocabulary-design.md)。

## 待实施方案

- [工作流界面整理](workflow-ux-redesign.md)：主体已实现，但文件仍在修改且有“命名的最终输出”待设计事项，保留。

## 保留的历史设计

- [Wiki 聊天设计](wiki-chat-design.md)、[自动整理设计](agent-organization-design.md)保留旧业务约束与迁移背景；其中日期更新前后的描述可能不同，不作为新工作台契约。
- 当前行为以代码、测试和使用指南为准。新工作台不自动继承历史文档中的 LAN 开放策略、固定生图指令或工具权限。

## 2026-10-29 清理记录

本次只清理仓库维护文档；不清理用户数据、`.local` 日志、技能说明、第三方说明或有未提交修改的设计文档。删除内容可从此次修改前的 Git 历史恢复。

| 已删除文件 | 原因 / 保留的信息 |
| --- | --- |
| `wiki-neutral-text-design.md` | 2026-09-07 已完成的标题拆分迁移记录；当前元素/关系行为由使用指南、生命周期与方向设计保留，迁移代码不变 |
| `wiki-tags-import-design.md` | 已完成的早期标签/重复导入实施记录；当前导入规则见使用指南，数据与迁移不变 |
| `ui-review-fixes.md` | 已结束的 2026-09-12 修复报告；有效操作说明已在使用指南和聊天设计中，移除其旧链接 |
| `workflow-review-2026-10-28.md` | 六项已修复问题的单次报告；对应 UI 回归测试保留 |
| `review-8435015-fixes.md` | 单次评审修复清单已结束；用户可见的共享/升级规则已写入 README 和使用指南 |

保留验证边界：已删除报告不能证明真实 Grok/ComfyUI、当前打包桌面或 POSIX 进程终止分支已经验证；历史 Electron 关闭测试曾被 Windows ACL 阻断。旧工作流上传附件尚无自动清理；本次未删除用户已有素材。新方案必须执行自己的验证，不能沿用历史通过数。

## 本次设计检查

按 sr-review 做同上下文结构化检查，范围为 `agent-workbench-plan.md` 与其引用的当前源码；未委派独立评审。

- 修正“客户端宿主＝完整沙箱”的误导，明确文件工具控制与同用户 Shell 的差别。
- 把 Grok main 源码的外部结论降为待实测证据，加入 P0 门槛。
- 明确操作批准和 operationId，避免仅靠工具调用 ID 声称付费调用幂等。
- 检查发现付费批准原先缺少持久对象和 HTTP 契约，已补 `agent_operations`、操作查询/决定接口、任务创建原子性及与轮次停止的关系；区别于引擎 RPC 审批。
- 补充同引擎任务持续轮询时的强制让出与资源释放，避免仅返回 taskId 仍互相等待。
- 明确变更展示范围，移除首版整轮撤销/自动 Git 检查点承诺。
- 划清工作流 run 的状态权威、新任务账本桥接、旧聊天迁移及批次 A/B 完成口径。

结论：**APPROVED（文档内部契约与分阶段计划范围）**。允许执行 P0/P1；不代表 Grok 执行宿主能力、Windows 强隔离、实现代码或发布已验收。P0 的结果若与设计不符，必须更新方案再继续受影响阶段。

文档验证：README 与 docs 中 85 个本地文件链接全部可解析；本次已跟踪文档差异通过 `git diff --check`。本轮没有修改产品代码，也没有运行产品回归测试。
