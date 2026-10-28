import { useState } from "react";
import { X, Pencil, Expand, Link2, Trash2, Unlink, Download, ArrowUpRight } from "lucide-react";
import { apiUrl } from "../api.js";
import useWikiResource from "../useWikiResource.js";
import ElementEditor from "../ElementEditor.jsx";
import RelationPicker from "../RelationPicker.jsx";
import TagRelations from "../TagRelations.jsx";
import { canvasTitle } from "./CanvasNode.jsx";
import { elementLabel, relationLabel } from "../../../shared/domain/elements.js";
import VideoPlayer from "../VideoPlayer.jsx";

export default function CanvasInspector({ id, edge, nodes, edges, revision, busy, readOnly, visible = true, onClose, onSelect, onOpen, onExpand, onChanged, onTrash, onUnlink, onRename, onModalChange }) {
  const [modal, setModal] = useState("");
  const [relationKind, setRelationKind] = useState(null);
  const detail = useWikiResource(id ? `/api/elements/${id}` : null, revision);
  const related = useWikiResource(id ? `/api/elements/${id}/tag-relations` : null, revision);
  const element = detail.data;
  function showModal(value) { if (value === "relate") setRelationKind(element.kind); setModal(value); onModalChange(Boolean(value)); }
  const connected = id ? edges.filter((entry) => entry.source === id || entry.target === id) : [];
  const labels = new Map(nodes.map((node) => [node.id, canvasTitle(node.data.element)]));
  const label = (nodeId) => labels.get(nodeId) || "内容";
  return <aside className="canvas-inspector" aria-label={edge ? "关联操作" : "画布内容详情"}>
    <header><strong>{edge ? "关联" : "内容详情"}</strong><button className="icon-only" disabled={busy} aria-label="关闭画布详情" onClick={onClose}><X size={17} /></button></header>
    {edge ? <div className="canvas-inspector-body">
      <h2>{label(edge.source)}</h2><Link2 size={18} /><h2>{label(edge.target)}</h2>
      <p className="wiki-muted">{relationLabel(edge.data, edge.data.sourceId) + " → " + label(edge.target)}</p>
      {edge.data?.aiResultId && <p className="wiki-muted">AI 添加 · 整理 #{edge.data.aiResultId}{edge.data.aiModified ? " · 人工已修改" : ""}</p>}
      {edge.data?.targetTag && <p className="wiki-muted">来自 tag：{edge.data.targetTag}，可在来源内容管理。</p>}
      {!readOnly && <button disabled={busy} onClick={onRename}><Pencil size={15} />重命名关联</button>}
      {!readOnly && !edge.data?.tagRelationId && <button disabled={busy} onClick={() => onUnlink(edge.id)}><Unlink size={15} />解除关联</button>}
    </div> : <div className="canvas-inspector-body">
      {detail.loading && <p className="wiki-muted">正在读取内容…</p>}
      {detail.error && <p className="wiki-error" role="alert">{detail.error}<button onClick={onChanged}>重试</button></p>}
      {element && <>
        <h2>{elementLabel(element)}</h2>
        {element.kind === "image" ? <a href={apiUrl(element.image.url)} target="_blank" rel="noreferrer" title="查看原图"><img className="canvas-inspector-image" src={apiUrl(`/api/elements/${id}/thumbnail`)} alt={elementLabel(element)} /></a> : element.kind === "video" ? <VideoPlayer key={id} element={element} visible={visible} /> : <pre tabIndex={0} aria-label="正文预览">{element.body}</pre>}
        <div className="wiki-tags">{element.tags.map((tag) => <span key={tag} className="wiki-tag">{tag}{element.aiTags?.some((a) => a.name === tag) && <span className="ai-source" title="AI 添加，打开详情页查看整理记录">AI</span>}</span>)}</div>
        <div className="canvas-inspector-actions">
          <button className="canvas-inspector-open" disabled={busy} onClick={() => onOpen(element.id)}><ArrowUpRight size={15} />打开详情页</button>
          <button disabled={busy} onClick={() => onExpand(id)}><Expand size={15} />展开关联</button>
          {!readOnly && <><button disabled={busy} onClick={() => showModal("edit")}><Pencil size={15} />编辑内容</button><button disabled={busy} onClick={() => showModal("relate")}><Link2 size={15} />添加关联</button></>}
          {element.kind === "image" && <a className="button" href={apiUrl(`/api/elements/${id}/download`)} download><Download size={15} />保存原图</a>}
          {element.kind === "video" && <a className="button" href={apiUrl(`/api/elements/${id}/download`)} download><Download size={15} />保存原视频</a>}
        </div>
        <TagRelations relations={related.data?.tagRelations} busy={busy} readOnly={readOnly} onChanged={onChanged} />
        {related.error && <p className="wiki-error" role="alert">{related.error}<button onClick={onChanged}>重试</button></p>}
        <h3>画布中的关联 · {connected.length}</h3>
        <ul className="canvas-linked-list">{connected.map((entry) => {
          const target = entry.source === id ? entry.target : entry.source;
          const description = relationLabel(entry.data, id);
          return <li key={entry.id}><button onClick={() => onSelect(target)} disabled={busy}>{label(target)}<small>{description}</small></button>{!readOnly && !entry.data?.tagRelationId && <button className="icon-only" disabled={busy} aria-label={`解除${description}：${label(target)}`} onClick={() => onUnlink(entry.id)}><Unlink size={14} /></button>}</li>;
        })}</ul>
        <p className="wiki-muted">可展开更多关联；解除关联会保留两份内容。</p>
        {!readOnly && <button className="danger-quiet" disabled={busy} onClick={() => onTrash(element)}><Trash2 size={15} />移入回收站</button>}
      </>}
    </div>}
    {modal === "edit" && element && <ElementEditor element={element} onClose={() => showModal("")} onSaved={(updated) => { showModal(""); onChanged({ updated }); }} />}
    {modal === "relate" && <RelationPicker sourceId={Number(id)} sourceKind={relationKind} onClose={() => showModal("")} onChanged={() => onChanged(id)} />}
  </aside>;
}
