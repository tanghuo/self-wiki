// Keyboard shortcut helpers shared by the app shell and its views.
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
export const modKey = isMac ? "⌘" : "Ctrl";

/** True when a key press belongs to the focused control (typing, sliders, media, menus). */
export function isEditableTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), video, audio, [role='slider'], [role='menu'], [role='listbox'], .react-flow"));
}

/** A modal dialog, menu or popover currently owns the keyboard. */
export function overlayOpen() {
  return Boolean(document.querySelector("dialog[open], [role='menu'], details.library-menu[open]"));
}

export const shortcutGroups = [
  { title: "全局", items: [
    [[modKey, "K"], "搜索内容库（在任意页面跳转到搜索框）"],
    [["/"], "聚焦搜索框"],
    [["?"], "显示快捷键"],
    [["Esc"], "关闭对话框、菜单；在详情页返回列表"],
  ] },
  { title: "内容库", items: [
    [["←", "→"], "详情页切换上一条、下一条"],
    [[modKey, "V"], "粘贴图片或视频，加入待保存内容"],
    [["Esc"], "在搜索框中清空关键词"],
  ] },
  { title: "Agent 对话", items: [
    [["Enter"], "发送消息"],
    [["Shift", "Enter"], "换行"],
  ] },
];
