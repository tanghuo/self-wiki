import { useLayoutEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { request } from "./api.js";

export default function SourceReference({ id, label, onReference, disabled, children, showButton = false }) {
  const [menu, setMenu] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const menuRef = useRef(null);
  useLayoutEffect(() => {
    if (!menu) return;
    const node = menuRef.current;
    const previous = document.activeElement;
    const bounds = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    node.querySelector("button").focus({ preventScroll: true });
    const close = () => setMenu(null);
    const pointer = (event) => { if (!node.contains(event.target)) close(); };
    const key = (event) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        close(); previous?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("pointerdown", pointer);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", pointer);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);
  async function reference() {
    if (disabled || busy) return;
    setMenu(null); setBusy(true); setError("");
    try {
      const element = await request(`/api/elements/${id}`);
      if (element.kind === "video") throw new Error("视频暂不支持作为 AI 资料，可在内容库播放。");
      onReference(element);
    }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <span className="source-reference" onContextMenu={(event) => {
    if (disabled || busy) return;
    event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY });
  }}>
    {children}
    {showButton && <button className="text-button source-reference-add" disabled={disabled || busy} title="引用到对话" aria-label={label ? `引用到对话：${label}` : "引用到对话"} onClick={reference}><Plus size={13} />{busy ? "正在引用…" : "引用到对话"}</button>}
    {menu && <span ref={menuRef} className="menu-panel source-reference-menu" role="menu" aria-label="资料引用菜单" style={{ left: menu.x, top: menu.y }}><button role="menuitem" disabled={disabled || busy} onClick={reference}>引用到对话</button></span>}
    {error && <span className="wiki-error" role="alert">引用失败：{error}</span>}
  </span>;
}
