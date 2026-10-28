import { useLayoutEffect, useRef } from "react";
import { ArrowLeft, Copy, Download, Pencil, Plus } from "lucide-react";
import { apiUrl, request } from "./api.js";
import { recordElementUsage } from "./elementUsage.js";

export default function WikiContextMenu({ menu, onClose, onAddReference, onSetMaterial, onEdit, onBack, disabled = false, onNotice, onError }) {
  const menuRef = useRef(null);
  useLayoutEffect(() => {
    const node = menuRef.current;
    const previous = document.activeElement;
    const { width, height } = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`;
    node.querySelector("button").focus({ preventScroll: true });
    const close = () => onClose();
    const pointer = (event) => { if (!node.contains(event.target)) close(); };
    const key = (event) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        close();
        if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
      }
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...node.querySelectorAll("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
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

  async function copy() {
    onClose(); onError(""); onNotice("");
    try {
      if (menu.element.kind !== "image") await navigator.clipboard.writeText(menu.element.body);
      else {
        const png = (async () => {
          const detail = await request(`/api/elements/${menu.element.id}`);
          const response = await fetch(apiUrl(detail.image.url));
          if (!response.ok) throw new Error("图片读取失败");
          const bitmap = await createImageBitmap(await response.blob());
          try {
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            canvas.getContext("2d").drawImage(bitmap, 0, 0);
            return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片转换失败")), "image/png"));
          } finally { bitmap.close(); }
        })();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      }
      onNotice("已复制");
      recordElementUsage(menu.element.id, "copy");
    } catch (failure) { onError(`复制失败：${failure.message}`); }
  }

  return <div ref={menuRef} className="menu-panel wiki-back-menu" role="menu" aria-label={menu.element ? "内容菜单" : "详情页菜单"} style={{ left: menu.x, top: menu.y }}>
    {menu.element ? <>
      {onEdit && menu.element.kind === "text" && !menu.element.record && <button type="button" role="menuitem" disabled={disabled} onClick={() => { onClose(); onEdit(menu.element); }}><Pencil size={16} />编辑文字</button>}
      {menu.element.kind === "video" ? <button type="button" role="menuitem" disabled={disabled} onClick={() => {
        const link = document.createElement("a"); link.href = apiUrl(`/api/elements/${menu.element.id}/download`); link.download = ""; link.click(); onClose();
      }}><Download size={16} />保存原视频</button> : <button type="button" role="menuitem" disabled={disabled} onClick={copy}><Copy size={16} />复制</button>}
      {onAddReference && menu.element.kind !== "video" && <button type="button" role="menuitem" disabled={disabled} onClick={() => { onClose(); onAddReference(menu.element); }}><Plus size={16} />加入资料</button>}
      {onSetMaterial && !menu.element.deletedAt && !menu.element.localOnly && ["text", "image", "video"].includes(menu.element.kind) && <button type="button" role="menuitem" disabled={disabled} onClick={() => { onClose(); onSetMaterial(menu.element); }}>{menu.element.material ? "取消资料标记" : "设为资料"}</button>}
    </> : <button type="button" role="menuitem" disabled={disabled} onClick={onBack}><ArrowLeft size={16} />返回</button>}
  </div>;
}
