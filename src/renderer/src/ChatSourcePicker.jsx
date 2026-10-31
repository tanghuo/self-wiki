import { useEffect, useRef, useState } from "react";
import { Check, FileText, Video, Search, ZoomIn } from "lucide-react";
import { DialogFrame } from "./ui/ConfirmDialog.jsx";
import { apiUrl } from "./api.js";
import { elementLabel } from "../../shared/domain/elements.js";
import useWikiResource from "./useWikiResource.js";
import WikiPaging from "./WikiPaging.jsx";
import { maxChatImages } from "../../shared/domain/chat.js";
import VideoPlayer from "./VideoPlayer.jsx";
import Select from "./Select.jsx";
import { Button } from "./ui/Button.jsx";

export default function ChatSourcePicker({ selected, onChange, busy, onClose, limit = 12, imageLimit = maxChatImages }) {
  const [q, setQ] = useState(""), [kind, setKind] = useState(""), [tag, setTag] = useState("");
  const [page, setPage] = useState(1), [showSelected, setShowSelected] = useState(false);
  const [retry, setRetry] = useState(0), [preview, setPreview] = useState(null);
  const body = useRef(null);
  const results = useWikiResource(showSelected ? null : `/api/elements?${new URLSearchParams({ q, kind, tag, page, pageSize: 24 })}`, retry);
  const tags = useWikiResource("/api/tags", retry);
  const visible = showSelected ? selected : results.data?.elements || [];
  const ids = new Set(selected.map((s) => s.id));
  const images = selected.filter((source) => source.kind === "image").length;
  const full = (element) => element.kind === "video" || !ids.has(element.id) && (selected.length >= limit || element.kind === "image" && images >= imageLimit);
  useEffect(() => { body.current?.scrollTo(0, 0); }, [q, kind, tag, page, showSelected]);
  function toggle(element) {
    if (busy || full(element)) return;
    onChange((current) => current.some((s) => s.id === element.id)
      ? current.filter((s) => s.id !== element.id)
      : current.length < limit ? [...current, { ...element, label: element.label || elementLabel(element) }] : current);
  }
  const label = (element) => element.label || elementLabel(element);
  return <><DialogFrame bare label="选择会话资料" className="wiki-dialog chat-source-dialog" onClose={onClose} title="从资料库选择" description={<>可跨页勾选，最多 {limit} 份；本轮图片合计最多 {maxChatImages} 张，当前还可选择 {Math.max(0, imageLimit - images)} 张。</>} closeLabel="关闭从资料库选择" footer={<><span role="status">已选 {selected.length} / {limit}{selected.length === limit ? " · 已达上限，可取消后替换" : ""}</span>{!showSelected && <WikiPaging pagination={results.data?.pagination} onPage={setPage} disabled={results.loading} />}<Button variant="primary" type="submit" onClick={onClose}>完成选择</Button></>}>
    <div className="chat-source-controls">
      <div className="chat-source-filters">
        <label className="wiki-search"><Search size={17} /><input autoFocus aria-label="搜索会话资料" disabled={showSelected} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="搜索文字或文件名…" /></label>
        <Select aria-label="会话资料类型" disabled={showSelected} value={kind} onChange={(next) => { setKind(next); setPage(1); }} options={[{ value: "", label: "全部类型" }, { value: "image", label: "图片" }, { value: "text", label: "文字" }]} />
        <Select aria-label="会话资料标签" disabled={showSelected} value={tag} onChange={(next) => { setTag(next); setPage(1); }} options={[{ value: "", label: "全部标签" }, ...(tags.data?.tags || []).map((t) => ({ value: t, label: t }))]} />
      </div>
      <div className="chat-source-tools"><span className="wiki-muted">{showSelected ? "全部已选资料，不受筛选影响" : "点击卡片勾选，放大查看完整内容"}</span><button className="text-button" aria-pressed={showSelected} onClick={() => setShowSelected(!showSelected)}>{showSelected ? "返回资料库" : `只看已选 · ${selected.length}`}</button><button className="text-button" disabled={busy || !selected.length} onClick={() => onChange([])}>清空选择</button></div>
    </div>
    <div className="chat-source-body" ref={body}>
      {!showSelected && results.loading && <p role="status">正在查找资料…</p>}
      {(results.error || tags.error) && <p className="wiki-error" role="alert">{results.error || tags.error}<button onClick={() => setRetry((n) => n + 1)}>重试</button></p>}
      <div className="wiki-relation-grid">{visible.map((element) => <article className="wiki-relation-card" key={element.id}>
        <button className="wiki-relation-pick" aria-label={label(element)} aria-pressed={ids.has(element.id)} disabled={busy || full(element)} onClick={() => toggle(element)}>
          {element.kind === "image" ? <span className="wiki-relation-image"><img src={apiUrl(`/api/elements/${element.id}/thumbnail?width=400`)} alt="" loading="lazy" /></span> : <span className="wiki-relation-text">{element.kind === "video" ? <Video size={20} /> : <FileText size={20} />}<span>{element.body || label(element)}</span>{element.kind === "video" && <small>视频暂不支持作为 AI 资料</small>}</span>}
          <span className="wiki-relation-check" aria-hidden="true">{ids.has(element.id) && <Check size={14} />}</span>
          <span className="wiki-relation-caption" title={label(element)}>#{element.id} · {label(element)}</span>
        </button>
        <button className="icon-only wiki-relation-zoom" aria-label={`预览：${label(element)}`} title="查看完整资料" onClick={() => setPreview(element)}><ZoomIn size={17} /></button>
      </article>)}</div>
      {!visible.length && (showSelected || results.data) && <p className="wiki-empty-inline">{showSelected ? "还没有加入本轮资料，返回资料库开始勾选。" : "没有匹配的资料，试试其他关键词、类型或标签。"}</p>}
    </div>
  </DialogFrame>{preview && <SourcePreview element={preview} selected={ids.has(preview.id)} disabled={busy || full(preview)} onToggle={toggle} onClose={() => setPreview(null)} />}</>;
}

function SourcePreview({ element, selected, disabled, onToggle, onClose }) {
  const [retry, setRetry] = useState(0);
  const detail = useWikiResource(`/api/elements/${element.id}`, retry);
  return <DialogFrame bare label="资料预览" className="wiki-dialog chat-source-preview" onClose={onClose} title={<>资料预览 · #{element.id}</>} closeLabel="关闭资料预览" footer={<><span>{detail.data?.tags?.join(" · ")}</span><Button variant="primary" type="submit" aria-pressed={selected} disabled={disabled || !detail.data} onClick={() => onToggle(detail.data)}>{selected ? "取消选择" : "选择这份资料"}</Button></>}>
    <div className="chat-source-body">{detail.loading && <p role="status">正在加载…</p>}{detail.error && <p role="alert">{detail.error}<button onClick={() => setRetry((n) => n + 1)}>重试</button></p>}{detail.data && (detail.data.kind === "image" ? <img src={apiUrl(detail.data.image.url)} alt={elementLabel(detail.data)} /> : detail.data.kind === "video" ? <><VideoPlayer element={detail.data} /><p className="wiki-muted">视频暂不支持作为 AI 资料。</p></> : <p className="chat-source-full-text">{detail.data.body}</p>)}</div>
  </DialogFrame>;
}
