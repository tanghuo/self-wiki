import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FileText, Layers, MessageCircle, X } from "lucide-react";
import { apiUrl } from "./api.js";
import { elementLabel } from "../../shared/domain/elements.js";
import { REFERENCE_DRAG_TYPE } from "./referenceDrag.js";
import "./referenceTray.css";
import { Button } from "./ui/Button.jsx";

const positionCookie = "selfWikiTrayPosition";

function readTrayPosition() {
  try {
    const entry = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${positionCookie}=`));
    if (!entry) return null;
    const [x, y] = entry.slice(positionCookie.length + 1).split(",").map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch { return null; }
}

function writeTrayPosition(position) {
  try { document.cookie = `${positionCookie}=${Math.round(position.x)},${Math.round(position.y)}; Path=/; Max-Age=31536000; SameSite=Strict`; }
  catch { /* The tray still stays where it was dropped during this visit. */ }
}

function clampTray(x, y, width, height) {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  return {
    x: Math.round(Math.min(maxX, Math.max(margin, x))),
    y: Math.round(Math.min(maxY, Math.max(margin, y))),
  };
}

export default function ReferenceTray({ elements, collapsed, onCollapse, onRemove, onClear, onOpen, onStart, busy, loading, error, onRetry, startDisabled, docked }) {
  const trayRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClick = useRef(false);
  const [position, setPosition] = useState(readTrayPosition);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const tray = trayRef.current;
    if (!position || !tray) return;
    const rect = tray.getBoundingClientRect();
    const next = clampTray(position.x, position.y, rect.width, rect.height);
    if (next.x === position.x && next.y === position.y) return;
    setPosition(next);
    writeTrayPosition(next);
  }, [position, collapsed, elements.length]);

  useEffect(() => {
    const onResize = () => {
      const tray = trayRef.current;
      if (!tray) return;
      setPosition((current) => {
        if (!current) return current;
        const rect = tray.getBoundingClientRect();
        const next = clampTray(current.x, current.y, rect.width, rect.height);
        if (next.x === current.x && next.y === current.y) return current;
        writeTrayPosition(next);
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function moveDrag(event) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    // A short press still toggles the tray; only a real move repositions it.
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    setDragging(true);
    const rect = trayRef.current.getBoundingClientRect();
    setPosition(clampTray(drag.left + dx, drag.top + dy, rect.width, rect.height));
  }
  function endDrag(event) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.id) return;
    dragRef.current = null;
    setDragging(false);
    if (!drag.moved) return;
    suppressClick.current = true;
    const rect = trayRef.current.getBoundingClientRect();
    const next = clampTray(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y, rect.width, rect.height);
    setPosition(next);
    writeTrayPosition(next);
  }
  function startDrag(event) {
    if (event.button !== 0) return;
    const rect = trayRef.current.getBoundingClientRect();
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    const move = (next) => moveDrag(next);
    const end = (next) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      endDrag(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  return <aside ref={trayRef} className={`reference-tray${docked ? " is-docked" : ""}${position ? " is-placed" : ""}${dragging ? " is-dragging" : ""}`} aria-label="资料篮" aria-busy={busy} style={position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined}>
    <header onPointerDown={startDrag}>
      <button className="text-button reference-tray-toggle" aria-expanded={!collapsed} aria-controls="reference-tray-content" title="拖动可移动资料篮，点击收起或展开" onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onCollapse(!collapsed); }}>
        <Layers size={18} /><strong>资料篮</strong><span aria-live="polite">{elements.length} / 12</span>{collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
    </header>
    <div id="reference-tray-content" hidden={collapsed}>
      <p className="reference-tray-hint">选好资料后点「问 Agent」开始对话；也可拖入下方输入框。</p>
      <ul className="reference-tray-list">{elements.map((element) => {
        const label = element.label || elementLabel(element);
        return <li key={element.id}>
          <button className="reference-tray-preview" title={`${label} · 可拖入会话输入框或消息附件区`} aria-label={`预览资料：${label}`} disabled={busy || !element.kind} onClick={() => onOpen(element.id)}
            draggable={!busy && Boolean(element.kind)} onDragStart={(event) => {
              if (busy || !element.kind) { event.preventDefault(); return; }
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(REFERENCE_DRAG_TYPE, JSON.stringify({ id: element.id, kind: element.kind, label }));
            }}>
            {element.kind === "image" ? <img draggable={false} src={apiUrl(`/api/elements/${element.id}/thumbnail?width=400`)} alt="" /> : <span className="reference-tray-text-icon"><FileText size={21} /></span>}
            <span><small>{element.kind === "image" ? "图片" : element.kind ? "文字" : "等待读取"} · #{element.id}</small><span>{label}</span></span>
          </button>
          <button className="icon-only" aria-label={`移除资料 ${element.id}`} title="移除资料" disabled={busy} onClick={() => onRemove(element.id)}><X size={15} /></button>
        </li>;
      })}</ul>
    </div>
    {error && <p className="wiki-error reference-tray-error" role="alert">{error}{onRetry && <button className="text-button" disabled={busy} onClick={onRetry}>重试</button>}</p>}
    <footer><button className="text-button" disabled={busy} onClick={onClear}>清空</button><Button variant="primary" type="submit" disabled={busy || startDisabled} onClick={onStart} aria-label="带着资料问 Agent"><MessageCircle size={16} />{loading ? "正在恢复…" : busy ? "正在打开…" : "问 Agent"}</Button></footer>
  </aside>;
}
