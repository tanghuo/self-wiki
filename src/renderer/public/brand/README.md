# self-wiki logo

相连的书页组成 W 形，表达图片、文字独立保存，知识通过关联组织。
暖棕色与纸白色延续应用的暖纸主题；其他主题保留同一品牌配色。

- `self-wiki.png`：原始图标。
- `self-wiki-64.png`：侧栏标记，显示为 32 CSS 像素。
- `self-wiki-32.png`：浏览器标签页图标。
- `self-wiki-180.png`：Apple touch icon。
- `self-wiki.ico`：Windows 窗口及打包图标，包含 16–256 像素尺寸。

更换原始图标后，在仓库根目录运行 `node tools/generate-icons.mjs`，再运行
`npm run build`。Windows 可执行文件图标需重新打包后生效。
