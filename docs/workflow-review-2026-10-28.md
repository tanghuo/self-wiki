# 工作流改动复查（2026-10-28）

本次确认了 6 个此前遗漏的问题，均已修复。数量是本次复现确认的发现数，不是对整个工作流剩余问题数量的估计。

## 范围与方法

沿最近几轮改动检查了运行准备、节点身份与依赖、素材选择与预览、上传附件、草稿保存、提交运行、输入快照、结果展示，以及对应的 HTTP、文件存储和输入契约边界。没有扫描整个仓库，也没有调用真实模型服务或验证安装包。

先编写浏览器复现，再修改实现：前 5 个复现用例在修改前全部失败，第 6 个在补查后单独确认失败。测试使用隔离服务、真实浏览器、请求延迟和失败响应，不触碰用户数据。

## 确认的问题

| 编号 | 问题与影响 | 修复 | 复现用例 |
| --- | --- | --- | --- |
| 1 | 草稿保存请求尚未完成时继续修改，旧请求返回后无条件清除 dirty 标记；返回列表时可能丢失后续修改。 | 保存完成时核对当前工作流与提交时的名称、定义，保留后续修改的未保存标记；运行前保存期间若发生修改则中止启动，要求重新确认。 | `edits made while saving remain dirty after the earlier save completes` |
| 2 | 退出图片输入页后，旧组件的上传回调仍写入共享输入状态；重新打开同参数的表单会混入旧图片。 | 卸载时取消上传，完成回调核对组件生命周期；使用最新值与回调提交结果。 | `finishing an upload after leaving a run form cannot modify a newly opened form` |
| 3 | JSON 只在失焦时解析，失败仅设置原生 validity；启动按钮不读取该状态，因此仍可提交上次有效值。 | 输入时立即解析并标记错误；保存和启动统一检查 aria-invalid 与原生无效字段。 | `invalid JSON cannot silently run using the previous valid input` |
| 4 | 提交前可修改固定素材，运行后的输入快照却只列 runtime 节点，无法核对本次提交的固定内容；结构化值也可能显示为空。 | 快照列出所有独立输入素材，从不可变运行定义或运行输入取值；显示结构化值，排除计算节点。 | `submitted snapshots show fixed content as well as runtime inputs` |
| 5 | 画布、准备页使用统一步骤编号与名称，运行结果仍显示原始默认名称“元素”，循环标题亦未对齐。 | 普通结果、循环和循环子节点都从运行定义解析步骤标识，避免使用当前草稿覆盖历史身份。 | `result headings retain the step number and name used by the canvas and run form` |
| 6 | 资料库文字读取尚未完成时即可复制为空文字；读取失败又把错误信息放进文字内容，复制后会替换原有引用。 | 区分读取成功、加载和失败状态；成功前禁用复制，错误单独展示，不作为工作流内容。 | `library text cannot be replaced by an empty string or an error while its preview is unavailable` |

实现位于 `src/renderer/src/features/workflow/WorkflowApp.jsx`、`WorkflowContentField.jsx` 和 `WorkflowRun.jsx`。6 个复现用例保存在 `test/ui/workflow-review.test.js`。

## 验证结果与边界

- `npm run build` 通过。
- 工作流单元、集成、界面测试及上述复现共 61 项通过。
- 已有测试继续验证粘贴和上传不创建库条目、独立附件可重开、显式保存节点才入库、模型返回内容不进入人工填写区。
- 本次没有验证真实 Grok/ComfyUI 服务、仓库其余模块或打包后的应用。61 项通过不能推导为整个功能不存在其他问题。
- 之前误入库的图片保留原状；本次没有删除、迁移用户已有素材。工作流附件当前仍随草稿保留，尚未引入自动清理。
