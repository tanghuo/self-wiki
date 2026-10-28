# self-wiki 界面规则（设计系统）

这份文档写给以后改界面的人：照着做，新页面就会和现有页面长得一样。规则由 `npm run check:arch` 和 `test/unit/ui-components.test.js` 自动检查。

## 1. 尺寸与颜色（tokens，定义在 `src/renderer/src/themes.css`）

| 用途 | token | 值 |
|---|---|---|
| 控件高度 | `--h-sm` / `--h-md` / `--h-lg` | 28 / 36 / 44 px（44 只给手机触屏） |
| 间距 | `--sp-1` … `--sp-12` | 4px 网格：4 8 12 16 20 24 32 40 48 |
| 圆角 | `--r-sm` / `--r-md` / `--r-lg` / `--r-xl` / `--r-full` | 6 / 8 / 12 / 16 / 999 |
| 字号 | `--fs-caption` / `--fs-small` / `--fs-body` / `--fs-section` / `--fs-dialog` / `--fs-page` | 12 / 13 / 14 / 16 / 18 / 24 |
| 阴影 | `--e-1` / `--e-2` / `--e-3` | 卡片 / 弹出菜单 / 对话框 |
| 颜色 | `--ink` `--muted` `--subtle` `--line` `--panel` `--accent` `--bad` `--bad-solid` … | 每个主题各一套；深色主题危险色 `#d93f45` |

- 除 `themes.css` 外，CSS 里不允许出现原始颜色（`#fff`、`rgb(…)`）。
- 按钮、summary 的高度只能用 `--h-*`。

## 2. 按钮：四个级别

| 级别 | class / 组件 | 用在哪 |
|---|---|---|
| 主按钮 | `primary` / `<Button variant="primary">` | **每个画面最多一个**，放在最右边：添加内容、发送、保存、开始运行 |
| 普通 | 默认 `<button>` | 其余操作 |
| 文字 | `text-button` / `variant="ghost"` | 返回、收起、次要链接 |
| 危险 | `danger-quiet`（红字）/ `danger`（实心红，只给删除确认框的确认按钮） | 移入回收站、永久删除 |

- 尺寸：默认 36；`button-sm` 28（表格行、卡片内）；`button-lg` 44。
- 不可用的按钮要说明原因：`<Button disabledReason="…">` 或 `title="…"`。
- 只有图标的按钮必须有 `aria-label`（`<IconButton label>`）。

## 3. 页面结构

每个页面都用 `<PageHeader>`：可选「← 上一级」→ 标题（24px，只有一个 h1）+ 一句说明 → 右侧操作（最多两个普通 + 一个主按钮）→ 可选标签页。没有面包屑栏。页面边距统一：上 28px，左右 32px（窄屏 16px）；侧边栏宽 208px。

## 4. 标签页与分段切换

- 切换「看哪一块内容」用 `<Tabs>`（下划线样式，`ui-tabs`）。
- 切换「同一内容怎么显示」用 `<Segmented>`（灰底胶囊，`ui-segmented`）。
- 两者都不是按钮样式，不会出现实心色块。

## 5. 对话框

`<DialogFrame>` / `<ConfirmDialog>`：标题（可带 ×）→ 正文 → 底部按钮 **[取消] [具体动作]**，取消在左、确认在右；确认按钮写具体动词（「永久删除 3 项」「保存改动」），不写「确定」。危险确认框默认聚焦「取消」。

## 6. 设置

- 外观、浏览偏好：改了立即生效并自动保存。
- 连接与服务（局域网共享、Agent 连接、自动整理、视频与画面检索）：改完在底部 `<SaveBar>` 统一保存，显示「N 项改动未保存」，可「放弃改动」。

## 7. 侧边栏

Agent 对话 → 我的内容（全部内容、图片、视频、文字、关系画布）→ 工具（工作流、临时分享）→ 底部：回收站、设置、快捷键 · 用量与整理。所有项同一种样式（36px，当前项白底 + 轻阴影）。

## 8. 用词

添加（不用「新增」）· 新建对话 · 内容（不用「元素」）· 移入回收站（可恢复）· 永久删除 N 项（不可恢复）。

## 组件清单（`src/renderer/src/ui/`）

Button / IconButton、PageHeader、Toolbar、Tabs / Segmented、DialogFrame / ConfirmDialog、Field、Card、ListRow、Notice / EmptyState、Toast、Menu、SaveBar。
