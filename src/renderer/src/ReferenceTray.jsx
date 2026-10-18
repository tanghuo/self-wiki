import { ChevronDown, ChevronUp, FileText, Layers, MessageCircle, X } from "lucide-react";
import { apiUrl } from "./api.js";
import { elementLabel } from "../../shared/domain/elements.js";
import { REFERENCE_DRAG_TYPE } from "./referenceDrag.js";
import "./referenceTray.css";

export default function ReferenceTray({ elements, collapsed, onCollapse, onRemove, onClear, onOpen, onStart, busy, loading, error, onRetry, startDisabled, docked }) {
  return <aside className={`reference-tray${docked ? " is-docked" : ""}`} aria-label="参考列表" aria-busy={busy}>
    <header>
      <button className="text-button reference-tray-toggle" aria-expanded={!collapsed} aria-controls="reference-tray-content" onClick={() => onCollapse(!collapsed)}>
        <Layers size={18} /><strong>参考列表</strong><span aria-live="polite">{elements.length} / 12</span>{collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
    </header>
    <div id="reference-tray-content" hidden={collapsed}>
      <p className="reference-tray-hint">可拖入会话输入框或正在编辑的消息附件区，也可收集好参考后进入对话。</p>
      <ul className="reference-tray-list">{elements.map((element) => {
        const label = element.label || elementLabel(element);
        return <li key={element.id}>
          <button className="reference-tray-preview" title={`${label} · 可拖入会话输入框或消息附件区`} aria-label={`预览参考：${label}`} disabled={busy || !element.kind} onClick={() => onOpen(element.id)}
            draggable={!busy && Boolean(element.kind)} onDragStart={(event) => {
              if (busy || !element.kind) { event.preventDefault(); return; }
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(REFERENCE_DRAG_TYPE, JSON.stringify({ id: element.id, kind: element.kind, label }));
            }}>
            {element.kind === "image" ? <img draggable={false} src={apiUrl(`/api/elements/${element.id}/thumbnail?width=400`)} alt="" /> : <span className="reference-tray-text-icon"><FileText size={21} /></span>}
            <span><small>{element.kind === "image" ? "图片" : element.kind ? "文字" : "等待读取"} · #{element.id}</small><span>{label}</span></span>
          </button>
          <button className="icon-only" aria-label={`移除参考 ${element.id}`} title="移除参考" disabled={busy} onClick={() => onRemove(element.id)}><X size={15} /></button>
        </li>;
      })}</ul>
    </div>
    {error && <p className="wiki-error reference-tray-error" role="alert">{error}{onRetry && <button className="text-button" disabled={busy} onClick={onRetry}>重试</button>}</p>}
    <footer><button className="text-button" disabled={busy} onClick={onClear}>清空</button><button className="primary" disabled={busy || startDisabled} onClick={onStart}><MessageCircle size={16} />{loading ? "正在恢复…" : busy ? "正在进入…" : "进入对话"}</button></footer>
  </aside>;
}
