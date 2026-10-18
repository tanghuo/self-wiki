import ChatModelPicker from "./ChatModelPicker.jsx";
import ChatImagePicker from "./ChatImagePicker.jsx";
import { imageExecutorDefinition } from "../../shared/domain/imageGeneration.js";
import RequestTrace, { ToolTrace } from "./ChatTrace.jsx";
import { randomUUID } from "./browserCrypto.js";
import { relationLabel } from "../../shared/domain/elements.js";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, MessageNotSentError } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowUp, BookOpen, Check, ChevronLeft, ChevronRight, Copy, Download, FileText, GitBranch, LoaderCircle, Maximize2, MessageCircle, MoreHorizontal, Network, Pencil, Plus, Search, Square, X } from "lucide-react";
import { apiUrl, request } from "./api.js";
import { elementLabel, maxImageBytes } from "../../shared/domain/elements.js";
import { clipboardImages } from "./contentDrafts.js";
import TagInput, { readTagInput } from "./TagInput.jsx";
import useWikiResource from "./useWikiResource.js";
import SourceReference from "./SourceReference.jsx";
import { REFERENCE_DRAG_TYPE, readReferenceDrag } from "./referenceDrag.js";
import ChatSourcePicker from "./ChatSourcePicker.jsx";
import ChatImageViewer, { chatImageUrl } from "./ChatImageViewer.jsx";
import useChatDraft from "./useChatDraft.js";
import useNewChatDraft from "./useNewChatDraft.js";
import useChatAttachmentDraft from "./useChatAttachmentDraft.js";
import useChatActivity from "./useChatActivity.js";
import { chatMessageParts } from "../../shared/domain/chatMessageParts.js";
import { maxChatImages, chatImageCount, checkChatImageCount } from "../../shared/domain/chat.js";
import "./chat.css";

const ChatContext = createContext(null);
const post = (url, body = {}) => request(`/api/chat/${url}`, { method: "POST", body: JSON.stringify(body) });

function Sources({ sources, allowReference = true, label = "已读取资料", attachments = false, onRemove, onReorder, onAdd, disabled = false }) {
  const { onOpen, externalBusy, onReference, referenceDisabled } = useContext(ChatContext);
  const dragged = useRef(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [receiving, setReceiving] = useState(false);
  function dropIndexAt(event) {
    const bounds = Array.from(event.currentTarget.querySelectorAll(":scope > [data-source-id]"), (node) => node.getBoundingClientRect());
    for (let index = 0; index < bounds.length; index++) {
      const rect = bounds[index];
      if (event.clientY > rect.bottom) continue;
      if (event.clientX < rect.left + rect.width / 2) return index;
      // Attachments align at the bottom of each flex row, including mixed image/text rows.
      if (!bounds[index + 1] || bounds[index + 1].bottom > rect.bottom + 1) return index + 1;
    }
    return bounds.length;
  }
  return sources?.length || onAdd ? <div className={`chat-sources${attachments ? " chat-attachments" : ""}${onAdd ? " chat-sources-droppable" : ""}${receiving && !disabled ? " is-receiving" : ""}`} aria-label={label}
    onDragOver={(event) => {
      if (onReorder && !disabled && dragged.current !== null) {
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
        setDropIndex(dropIndexAt(event)); return;
      }
      if (!onAdd || disabled || !event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setReceiving(true);
    }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setReceiving(false); setDropIndex(null); } }}
    onDrop={(event) => {
      setReceiving(false); setDropIndex(null);
      if (onReorder && !disabled && dragged.current !== null) {
        event.preventDefault(); event.stopPropagation();
        onReorder(dragged.current, dropIndexAt(event)); dragged.current = null; return;
      }
      if (!onAdd || disabled || !event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) return;
      event.preventDefault(); event.stopPropagation();
      const source = readReferenceDrag(event.dataTransfer);
      if (source) onAdd(source);
    }}>{!attachments && <span className="chat-sources-label">{label}</span>}{onAdd && <span className="chat-source-drop-hint">可从参考列表拖入，拖动附件调整顺序</span>}{(sources || []).map((s, index) => {
    const sourceLabel = s.label || `内容 ${s.id}`;
    const button = <button className={`text-button chat-source-link${s.kind === "image" ? " chat-source-image" : ""}`} disabled={externalBusy} title={sourceLabel} aria-label={sourceLabel} onClick={() => onOpen(s.id)}>{s.kind === "image" ? <img className="chat-source-thumbnail" src={apiUrl(`/api/elements/${s.id}/thumbnail?width=400`)} alt="" loading="lazy" /> : <BookOpen size={attachments ? 20 : 12} />}{(!attachments || s.kind !== "image") && <span>{sourceLabel}</span>}</button>;
    return allowReference ? <SourceReference key={s.id} id={s.id} label={s.label} onReference={onReference} disabled={referenceDisabled} showButton>{button}</SourceReference> : <span key={s.id} data-source-id={s.id}
      className={`source-reference${onRemove ? " chat-source-editable" : ""}${dropIndex === index ? " chat-source-drop-before" : ""}${dropIndex === sources.length && index === sources.length - 1 ? " chat-source-drop-after" : ""}`}
      draggable={Boolean(onReorder && !disabled)} title={onReorder ? "拖动调整引用顺序" : undefined}
      onDragStart={(e) => {
        if (!onReorder || disabled || e.target.closest(".chat-source-remove")) { e.preventDefault(); return; }
        dragged.current = s.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(s.id));
      }}
      onDragEnd={() => { dragged.current = null; setDropIndex(null); }}
    >{button}{onRemove && <button className="icon-only chat-source-remove" aria-label={`移除附件 ${s.id}`} title="移除附件" disabled={disabled} onClick={() => onRemove(s.id)}><X size={14} /></button>}</span>;
  })}</div> : null;
}

function Markdown() {
  const { onOpen, externalBusy, onReference, referenceDisabled } = useContext(ChatContext);
  const sources = useAuiState((s) => s.message.metadata.custom?.sources || []);
  return <MarkdownTextPrimitive smooth={false} className="chat-markdown" urlTransform={(url) => /^(wiki:\d+$|https?:\/\/)/.test(url) ? url : ""}
    components={{
      a: ({ href, children }) => {
        const match = href?.match(/^wiki:(\d+)$/);
        if (match) return sources.some((s) => s.id === Number(match[1])) ? <SourceReference id={Number(match[1])} onReference={onReference} disabled={referenceDisabled}><button className="chat-citation" disabled={externalBusy} onClick={() => onOpen(Number(match[1]))}>{children}</button></SourceReference> : <span title="此来源未在本轮读取">{children}</span>;
        return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
      },
      img: ({ alt }) => <span>{alt || "图片链接"}</span>,
    }} />;
}

function Proposal({ proposal: p }) {
  const { onOpen, changed, externalBusy, setError } = useContext(ChatContext);
  const [busy, setBusy] = useState(false), [body, setBody] = useState(p.payload.body || "");
  const [tags, setTags] = useState({ tags: p.payload.tags || [], draft: "" });
  async function act(action) {
    setBusy(true); setError("");
    try {
      const value = await post(`proposals/${p.id}/${action}`, action === "accept" && p.payload.kind === "create_text" ? { body, tags: readTagInput(tags) } : {});
      changed(value);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const pending = p.state === "pending", locked = busy || externalBusy;
  return <section className="chat-proposal" aria-label="Wiki 修改建议">
    <header><strong>{p.payload.kind === "create_text" ? "新文字" : p.payload.kind === "add_tags" ? "添加标签" : "添加关联"}</strong><span>{({ pending: "待采纳", accepted: "已采纳", rejected: "已拒绝", undone: "已撤销" })[p.state]}</span></header>
    <p className="wiki-muted">{p.payload.reason}</p>
    {p.payload.excerpts?.length > 0 && <details className="chat-excerpts"><summary>查看提取依据 · {p.payload.excerpts.length} 段原文</summary>{p.payload.excerpts.map((entry, index) => <blockquote key={index}><small>{({ user: "用户", assistant: "回答", tool: "工具提示词" })[entry.role]}</small><pre>{entry.deleted ? "这段原文已删除" : entry.quote}</pre></blockquote>)}</details>}
    {p.payload.kind === "create_text" ? pending ? <>
      <label className="chat-field">内容草稿<textarea aria-label="内容草稿" value={body} maxLength={12000} rows={6} disabled={locked} onChange={(e) => setBody(e.target.value)} /></label>
      <TagInput value={tags} onChange={setTags} disabled={locked} label="草稿标签" />
    </> : <p className="chat-saved-preview">{p.payload.body.slice(0, 180)}</p> : p.payload.kind === "add_tags" ? <p>为 #{p.payload.elementId} 添加：{p.payload.tags.join("、")}</p> : <p>#{p.payload.sourceId} — {relationLabel(p.payload, p.payload.sourceId)} {p.payload.direction && p.payload.direction !== "symmetric" ? "→" : "↔"} #{p.payload.targetId}</p>}
    <Sources sources={p.sources} />
    <footer>{pending ? <><button className="primary" disabled={locked || (p.payload.kind === "create_text" && !body.trim())} onClick={() => act("accept")}><Check size={14} />{busy ? "处理中…" : "采纳并保存"}</button><button className="text-button" disabled={locked} onClick={() => act("reject")}>拒绝</button></> : p.state === "accepted" ? <>
      {p.changes.createdId && <button disabled={locked} onClick={() => onOpen(p.changes.createdId)}>查看新内容</button>}<button className="text-button" disabled={locked} onClick={() => act("undo")}>撤销这次修改</button>
    </> : null}</footer>
  </section>;
}

function PastedImages({ images = [], onRemove, disabled, label = "图片附件" }) {
  return images.length > 0 && <div className="chat-sources chat-attachments" aria-label={label}>{images.map((image) =>
    <span className="source-reference chat-source-editable" key={image.id} data-attachment-id={image.id}>
      <a className="chat-source-link chat-source-image" href={apiUrl(`/api/chat/attachments/${image.id}/image`)} target="_blank" rel="noopener noreferrer" aria-label={`查看图片：${image.label}`}>
        <img className="chat-source-thumbnail" src={apiUrl(`/api/chat/attachments/${image.id}/image`)} alt={image.label} />
      </a>
      {onRemove && <button type="button" className="icon-only chat-source-remove" aria-label={`移除图片 ${image.id}`} disabled={disabled} onClick={() => onRemove(image.id)}><X size={14} /></button>}
    </span>)}</div>;
}

function UserMessage() {
  const meta = useAuiState((s) => s.message.metadata.custom || {});
  const sources = useAuiState((s) => s.message.metadata.custom?.sources || []);
  const imageEdit = useAuiState((s) => s.message.metadata.custom?.imageEdit);
  const text = useAuiState((s) => s.message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n"));
  const { onPreview, onEdit, onSelectVersion, onVersionRendered, referenceDisabled, setError } = useContext(ChatContext);
  const messageRef = useRef(null);
  useLayoutEffect(() => {
    // Wait for the replacement reply to mount before measuring the scroll range.
    const frame = requestAnimationFrame(() => onVersionRendered(meta.turnId, messageRef.current));
    return () => cancelAnimationFrame(frame);
  }, [meta.turnId, onVersionRendered]);
  const [editing, setEditing] = useState(false), [edited, setEdited] = useState(""), [saving, setSaving] = useState(false);
  const [editedSources, setEditedSources] = useState([]), [pickingSources, setPickingSources] = useState(false);
  const [editedAttachments, setEditedAttachments] = useState([]);
  const editKey = useRef(null);
  function changeSources(value) {
    const next = typeof value === "function" ? value(editedSources) : value;
    try { checkChatImageCount(next, editedAttachments, imageEdit); }
    catch (e) { setError(e.message); return; }
    setEditedSources(next); editKey.current = null;
  }
  function reorderSources(fromId, insertionIndex) {
    changeSources((current) => {
      const from = current.findIndex((s) => s.id === fromId), to = insertionIndex > from ? insertionIndex - 1 : insertionIndex;
      if (from < 0 || to < 0 || from === to) return current;
      const next = [...current]; next.splice(to, 0, next.splice(from, 1)[0]); return next;
    });
  }
  const versions = meta.versions || [], version = versions.indexOf(meta.turnId);
  async function submit() {
    try { checkChatImageCount(editedSources, editedAttachments, imageEdit); }
    catch (e) { setError(e.message); return; }
    setSaving(true); editKey.current ||= randomUUID(); setError("");
    try { await onEdit(meta.turnId, edited, editedSources.map((s) => s.id), editKey.current, editedAttachments.map((image) => image.id)); setEditing(false); }
    catch (e) { setError(e.message); } finally { setSaving(false); }
  }
  return <MessagePrimitive.Root ref={messageRef} className="chat-message chat-user" data-user-turn-id={meta.turnId}>
    <PastedImages images={editing ? editedAttachments : meta.attachments} disabled={referenceDisabled || saving}
      onRemove={editing ? (id) => { setEditedAttachments((current) => current.filter((image) => image.id !== id)); editKey.current = null; } : undefined} />
    <Sources sources={editing ? editedSources : sources} allowReference={false} attachments label="消息附件" disabled={referenceDisabled || saving}
      onAdd={editing ? (source) => {
        if (editedSources.some((entry) => entry.id === source.id)) return;
        if (editedSources.length + editedAttachments.length >= 12) { setError("最多添加 12 个附件，请移除部分附件后重新选择。"); return; }
        setError("");
        changeSources((current) => current.some((entry) => entry.id === source.id) || current.length + editedAttachments.length >= 12 ? current : [...current, source]);
      } : undefined}
      onReorder={editing ? reorderSources : undefined}
      onRemove={editing ? (id) => changeSources((current) => current.filter((s) => s.id !== id)) : undefined} />
    {editing && <div className="chat-attachment-actions"><button className="text-button" disabled={referenceDisabled || saving} onClick={() => setPickingSources(true)}><Plus size={14} />添加附件 · {editedSources.length}/12</button></div>}
    {editing && pickingSources && <ChatSourcePicker selected={editedSources} limit={12 - editedAttachments.length} imageLimit={maxChatImages - chatImageCount([], editedAttachments, imageEdit)} onChange={changeSources} busy={referenceDisabled || saving} onClose={() => setPickingSources(false)} />}
    {imageEdit && <div className="chat-attachment-actions">{imageEdit.deleted ? <p className="wiki-muted">本轮编辑原图已删除</p> : <button className="chat-edit-source" onClick={() => onPreview({ ...imageEdit, text, editing: true })}><img src={chatImageUrl(imageEdit)} alt="本轮编辑原图" /><span>{imageEdit.region ? "编辑所选区域" : "编辑这张图片"}</span></button>}</div>}
    {(editing || text) && <div className={`chat-user-bubble${editing ? " is-editing" : ""}`}>
    {editing ? <div className="chat-message-editor"><label>编辑消息<textarea aria-label="编辑消息内容" value={edited} maxLength={12000} rows={4} autoFocus disabled={saving}
      onChange={(e) => { setEdited(e.target.value); editKey.current = null; }} onKeyDown={(e) => { if (e.key === "Escape" && !saving) setEditing(false); }} /></label>
      <div className="chat-actions chat-message-editor-actions"><button disabled={saving} onClick={() => setEditing(false)}>取消</button><button className="primary" disabled={referenceDisabled || saving || (!edited.trim() && !editedAttachments.length && !imageEdit && !editedSources.some((source) => source.kind === "image"))} onClick={submit}>{saving ? "正在发送…" : "发送"}</button></div>
    </div> : <MessagePrimitive.Parts />}
    </div>}
    {meta.turnId && <div className="chat-message-actions">
      {!editing && <button className="text-button icon-only chat-user-edit" title="编辑消息" aria-label="编辑消息" disabled={referenceDisabled} onClick={() => { setEdited(text); setEditedSources(sources); setEditedAttachments(meta.attachments || []); setPickingSources(false); setEditing(true); editKey.current = null; }}><Pencil size={16} /></button>}
      {versions.length > 1 && <span className="chat-versions" aria-label="消息版本"><button className="icon-only" aria-label="上一个消息版本" disabled={referenceDisabled || saving || version <= 0} onClick={() => onSelectVersion(versions[version - 1])}><ChevronLeft size={15} /></button><span>{version + 1}/{versions.length}</span><button className="icon-only" aria-label="下一个消息版本" disabled={referenceDisabled || saving || version >= versions.length - 1} onClick={() => onSelectVersion(versions[version + 1])}><ChevronRight size={15} /></button></span>}
    </div>}
  </MessagePrimitive.Root>;
}

function GeneratedImage({ artifact, turnId, saved }) {
  const { onPreview, onOpen, onArchive, setError, externalBusy, referenceDisabled } = useContext(ChatContext);
  const [saving, setSaving] = useState(false), [savedId, setSavedId] = useState(null);
  const [imageWidth, setImageWidth] = useState(480), [failed, setFailed] = useState(false);
  const elementId = saved?.elementId || savedId;
  async function save() {
    setSaving(true); setError("");
    try { const result = await onArchive(turnId, { artifact }); setSavedId(result.element.id); }
    catch (e) { setError(e.message); } finally { setSaving(false); }
  }
  const value = { artifact, turnId }, url = chatImageUrl(value);
  return <figure className="chat-generated-image" style={{ width: imageWidth }}>
    <div className="chat-image-card">
      <button className="chat-image-preview-button" aria-label="预览生成的图片" onClick={() => onPreview(value)}><img src={url} alt="生成的图片" onLoad={(event) => { const img = event.currentTarget; setImageWidth(Math.min(640, 720 * img.naturalWidth / img.naturalHeight)); setFailed(false); }} onError={() => setFailed(true)} /></button>
      {failed ? <p className="chat-image-card-error" role="alert">图片加载失败，点击重试。<button className="text-button" onClick={() => onPreview(value)}>重新打开图片</button></p> : <div className="chat-image-overlay">
        <button className="chat-image-overlay-edit" aria-label="编辑图片" disabled={referenceDisabled} title={referenceDisabled ? "等待当前操作完成后即可编辑" : "编辑图片"} onClick={() => onPreview({ ...value, editing: true })}>编辑</button>
        {elementId ? <button className="chat-image-overlay-save" aria-label="已保存 · 查看 Wiki" title="已保存 · 查看 Wiki" disabled={externalBusy} onClick={() => onOpen(elementId)}><BookOpen size={20} strokeWidth={1.8} /></button> : <button className="chat-image-overlay-save" aria-label={saved ? "已删除" : saving ? "正在保存…" : "保存至 Wiki"} title={saved ? "已删除" : saving ? "正在保存…" : "保存至 Wiki"} disabled={saving || externalBusy || Boolean(saved)} onClick={save}><Download size={20} strokeWidth={1.8} /></button>}
      </div>}
    </div>
    {saved?.prompt?.elementId ? <button className="text-button chat-saved-prompt" onClick={() => onOpen(saved.prompt.elementId)}>查看提示词</button>
      : saved?.prompt?.state === "failed" ? <p className="chat-archive-hint">提示词尚未整理完成。<button className="text-button" disabled={saving || externalBusy} onClick={save}>重试提炼提示词</button><span>{saved.prompt.error}</span></p>
      : saved?.prompt && <p className="chat-archive-hint">{saved.prompt.state === "running" ? "正在提炼独立提示词…" : saved.prompt.state === "queued" ? "图片已保存，等待提炼提示词…" : saved.prompt.state === "deleted" ? "提示词记录已删除" : ""}</p>}
    </figure>;
}

function AssistantImage({ image }) {
  const meta = useAuiState((s) => s.message.metadata.custom);
  const event = meta.events.find((e) => e.artifact && chatImageUrl({ artifact: e.artifact, turnId: meta.turnId }) === image);
  return event ? <GeneratedImage artifact={event.artifact} turnId={meta.turnId} saved={meta.saved?.find((s) => s.key === `image:${event.artifact}`)} /> : null;
}

function AssistantTool({ data: events }) {
  const turnId = useAuiState((s) => s.message.metadata.custom.turnId);
  return <details className="chat-tools" open={events.some((event) => event.state === "running" || event.state === "failed")}><summary>工具操作 · {events.length > 1 ? `${events.length} 项` : events[0].command}</summary>
    {events.map((event) => <div key={event.id}>
      <ToolTrace turnId={turnId} eventId={event.id} version={event.detailVersion} command={event.command} state={event.state} error={event.error} progress={event.progress} />
    </div>)}
  </details>;
}

function AssistantProcess({ meta }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (meta.state !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [meta.state]);
  const seconds = Math.max(0, Math.floor(((meta.state === "running" ? now : meta.updatedAt) - meta.createdAt) / 1000));
  const elapsed = Number.isFinite(seconds) ? `${seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ""}${seconds % 60}s` : "";
  const status = meta.state === "running" ? `${meta.stopping ? "正在停止生成" : meta.events.findLast((event) => event.state === "running")?.command || (meta.answer ? "正在继续处理" : "正在等待模型输出")}…` : ({ completed: "回答已完成", interrupted: "生成已停止", failed: "生成失败" })[meta.state];
  return <div className="chat-process" data-state={meta.state}>
    <span role={meta.state === "running" ? "status" : undefined} className={meta.state === "running" ? "chat-active-progress" : undefined}>
      {meta.state === "running" && <span className="chat-busy-dot" />}
      {meta.state === "completed" && elapsed ? `用时 ${elapsed}` : `${status}${elapsed ? ` · ${elapsed}` : ""}`}
    </span>
    <RequestTrace turnId={meta.turnId} version={meta.requestTraceVersion} running={meta.state === "running"} />
  </div>;
}



function AssistantMessage() {
  const meta = useAuiState((s) => s.message.metadata.custom);
  const answer = meta.answer || "";
  const { proposals, changed, setError, externalBusy, onArchive, onOpen, onExtract, onFork, referenceDisabled } = useContext(ChatContext);
  const [saving, setSaving] = useState(false), [draft, setDraft] = useState(null);
  const draftKey = useRef(null);
  const forkKey = useRef(null);
  const actionsMenu = useRef(null);
  useEffect(() => {
    function dismiss(event) {
      const menu = actionsMenu.current;
      if (!menu?.open) return;
      if (event.type === "keydown") {
        if (event.key !== "Escape") return;
        menu.querySelector("summary").focus();
      } else if (menu.contains(event.target)) return;
      menu.open = false;
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, []);
  async function saveDraft() {
    setSaving(true); setError(""); draftKey.current ||= randomUUID();
    try { const value = await post(`turns/${meta.turnId}/draft`, { body: draft, sourceIds: meta.sources.slice(0, 12).map((s) => s.id), requestKey: draftKey.current }); changed(value); setDraft(null); draftKey.current = null; }
    catch (e) { setError(e.message); } finally { setSaving(false); }
  }
  async function saveContent() {
    setSaving(true); setError("");
    try { await onArchive(meta.turnId, { body: draft }); setDraft(null); }
    catch (e) { setError(e.message); } finally { setSaving(false); }
  }
  // assistant-ui inserts a temporary reply before the server supplies its persisted turn.
  if (!meta.turnId) return <MessagePrimitive.Root className="chat-message chat-assistant"><p className="chat-progress" role="status">正在发送…</p></MessagePrimitive.Root>;
  return <MessagePrimitive.Root className="chat-message chat-assistant" data-turn-id={meta.turnId} data-focused={meta.focused || undefined}>
    <AssistantProcess meta={meta} />
    <MessagePrimitive.Parts components={{ Text: Markdown, Image: AssistantImage, data: { by_name: { "wiki-tool": AssistantTool } } }} />
    {meta.error && <p className="wiki-error" role="status">{meta.error}</p>}
    {meta.state !== "running" && <div className="chat-answer-actions">
      {answer && draft === null && <button className="text-button chat-save" disabled={externalBusy} onClick={() => { setDraft(answer); draftKey.current = null; }}><FileText size={13} />保存为 Wiki 内容</button>}
      <details className="chat-answer-menu" ref={actionsMenu} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}>
        <summary aria-label="回答更多操作" title="更多操作"><MoreHorizontal size={18} /></summary>
        <div className="chat-answer-menu-items">
          {(answer || meta.events.some((e) => e.artifact)) && <button className="text-button" disabled={referenceDisabled} onClick={() => { actionsMenu.current.open = false; onExtract(meta.turnId); }}>提取元素建议</button>}
          <button className="text-button" disabled={referenceDisabled} onClick={() => { actionsMenu.current.open = false; forkKey.current ||= randomUUID(); onFork(meta.turnId, forkKey.current); }}><GitBranch size={13} />在新聊天中创建分支</button>
        </div>
      </details>
    </div>}
    {meta.saved?.filter((s) => s.key.startsWith("text:") && s.elementId).map((s) => <button key={s.key} className="text-button" disabled={externalBusy} onClick={() => onOpen(s.elementId)}>查看已保存文字</button>)}
    {draft !== null && <div className="chat-manual-draft"><label className="chat-field">保存内容<textarea aria-label="保存内容" value={draft} rows={6} maxLength={12000} disabled={saving} onChange={(e) => { setDraft(e.target.value); draftKey.current = null; }} /></label><div className="chat-actions"><button className="primary" disabled={saving || externalBusy || !draft.trim()} onClick={saveContent}>保存至 Wiki</button><button disabled={saving || externalBusy || !draft.trim()} onClick={saveDraft}>生成保存建议</button><button className="text-button" disabled={saving} onClick={() => setDraft(null)}>取消</button></div></div>}
    {proposals.filter((p) => p.turnId === meta.turnId).map((p) => <Proposal key={p.id} proposal={p} />)}
  </MessagePrimitive.Root>;
}


function Conversation({ id, newDraft, preference, onPreference, onStarted, selection, onSelectionConsumed, currentIds, onOpen, onChanged, onSessionsChanged, onActivityChange, onForkCreated, onConnection, externalBusy, presentation, catalog, modelsLoading, modelsError, onRefreshModels, imagePreference, onImagePreference }) {
  const [data, setData] = useState(null), [older, setOlder] = useState([]), [olderAvailable, setOlderAvailable] = useState(false);
  const [olderProposals, setOlderProposals] = useState([]);
  const [gap, setGap] = useState(null), [gapLoading, setGapLoading] = useState(false);
  const [savedSources, setSavedSources] = useState([]), [picker, setPicker] = useState(false), [error, setError] = useState(""), [sending, setSending] = useState(false), [connected, setConnected] = useState(false);
  const sources = id ? savedSources : newDraft.sources, setSources = id ? setSavedSources : newDraft.setSources;
  const savedImages = useChatAttachmentDraft(id, data?.session.imageDraft);
  const attachments = id ? savedImages.attachments : newDraft.attachments, setAttachments = id ? savedImages.setAttachments : newDraft.setAttachments;
  const [uploadingImages, setUploadingImages] = useState(false);
  const imageUpload = useRef(null);
  useEffect(() => () => imageUpload.current?.abort(), []);
  const [receivingReference, setReceivingReference] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [pendingImageOptions, setPendingImageOptions] = useState(null);
  const [modelBusy, setModelBusy] = useState(false), [switchingVersion, setSwitchingVersion] = useState(false);
  const viewportRef = useRef(null), versionAnchor = useRef(null);
  const onVersionRendered = useCallback((turnId, node) => {
    const anchor = versionAnchor.current, viewport = viewportRef.current;
    if (!anchor || anchor.turnId !== turnId || !node || !viewport) return;
    const controls = node.querySelector(".chat-versions");
    if (controls) viewport.scrollTo({ top: viewport.scrollTop + controls.getBoundingClientRect().top - anchor.top, behavior: "instant" });
    versionAnchor.current = null;
  }, []);
  const [stopping, setStopping] = useState(false);
  const stopRequest = useRef(null);
  const [preview, setPreview] = useState(null);
  const savedDraft = useChatDraft(id, data?.session.draft);
  const draft = id ? savedDraft : newDraft;
  const sendInFlight = useRef(false);
  const pending = useRef(null), hasLoadedOlder = useRef(false);
  const consumed = useRef(null);
  const focus = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const focusedTurn = Number(focus.get("session")) === id ? Number(focus.get("turn")) : 0;
  const scrolledTo = useRef(0);
  const snapshot = useRef(null);
  useEffect(() => {
    if (!selection || selection.newSession && id || consumed.current === selection || !draft.ready || !savedImages.ready || newDraft.sending || uploadingImages) return;
    consumed.current = selection;
    const elements = selection.elements || [selection.element];
    const combined = [...new Map([...sources, ...elements.map((e) => ({ id: e.id, kind: e.kind, label: e.label || elementLabel(e) }))].map((e) => [e.id, e])).values()];
    const accepted = fitSources(combined);
    setSources(accepted);
    onSelectionConsumed(accepted.map((element) => element.id));
  }, [id, selection, sources, attachments.length, onSelectionConsumed, draft.ready, savedImages.ready, newDraft.sending, uploadingImages]);
  // A POST acknowledgement may arrive after newer SSE data. A new server instance resets the sequence.
  const update = useCallback((value) => {
    const current = snapshot.current;
    if (current && current.streamId === value.streamId && value.revision < current.revision) return;
    if (current && (current.streamId !== value.streamId || current.session.branchRevision !== value.session.branchRevision)) {
      setOlder([]); setOlderProposals([]); setGap(null); setPreview(null);
      hasLoadedOlder.current = false; setOlderAvailable(value.hasOlder);
    }
    snapshot.current = value; setData(value);
  }, []);
  function currentPage(value) { return snapshot.current?.streamId === value.streamId && snapshot.current?.session.branchRevision === value.session.branchRevision; }
  useEffect(() => {
    if (!id) return;
    const stream = new EventSource(apiUrl(`/api/chat/sessions/${id}/events`));
    stream.addEventListener("snapshot", (e) => { const value = JSON.parse(e.data); update(value); onConnection(value.connection); setConnected(true); if (!hasLoadedOlder.current) setOlderAvailable(value.hasOlder); });
    stream.onerror = () => setConnected(false);
    return () => stream.close();
  }, [id, onConnection, update]);
  const turns = useMemo(() => [...new Map([...older, ...(data?.turns || [])].map((t) => [t.id, t])).values()].sort((a, b) => a.id - b.id), [older, data]);
  useEffect(() => {
    if (!focusedTurn || scrolledTo.current === focusedTurn || !turns.some((t) => t.id === focusedTurn)) return;
    let frame, attempts = 0;
    const scroll = () => {
      const node = document.querySelector(`[data-turn-id="${focusedTurn}"]`);
      if (node?.getClientRects().length) { scrolledTo.current = focusedTurn; node.scrollIntoView({ block: "center" }); }
      else if (++attempts < 30) frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [focusedTurn, turns.length]);
  useEffect(() => {
    if (!data || !focusedTurn || scrolledTo.current === focusedTurn || turns.some((t) => t.id === focusedTurn)) return;
    let disposed = false;
    request(`/api/chat/sessions/${id}?around=${focusedTurn}`).then((value) => {
      if (!disposed && currentPage(value)) {
        if (value.requestedVersion) { void selectVersion(value.requestedVersion); return; }
        setOlder((p) => [...p, ...value.turns, ...data.turns]); setOlderProposals((p) => [...p, ...value.proposals, ...data.proposals]);
        hasLoadedOlder.current = true; setOlderAvailable(value.hasOlder);
        if (value.turns.at(-1)?.id < data.turns[0]?.id) setGap({ before: data.turns[0].id, after: value.turns.at(-1).id });
      }
    }).catch((e) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [id, Boolean(data), focusedTurn, data?.session.branchRevision]);
  const running = data?.running || turns.some((t) => t.state === "running");
  useEffect(() => { if (data) onActivityChange(); }, [Boolean(data), running, turns.at(-1)?.id, turns.at(-1)?.state, onActivityChange]);
  const images = useMemo(() => {
    const entries = new Map();
    for (const turn of turns) {
      if (turn.imageEdit && !turn.imageEdit.deleted && !entries.has(turn.imageEdit.artifact)) entries.set(turn.imageEdit.artifact, { turnId: turn.imageEdit.turnId, artifact: turn.imageEdit.artifact });
      for (const event of turn.events) if (event.artifact) entries.set(event.artifact, { turnId: turn.id, artifact: event.artifact, imageEdit: turn.imageEdit });
    }
    return [...entries.values()];
  }, [turns]);
  const composerBlocked = uploadingImages || sending || (!id && newDraft.sending) || switchingVersion || stopping || modelBusy || (id ? !data : !preference || !imagePreference) || !draft.ready || !savedImages.ready || externalBusy;
  const blocked = composerBlocked || imageBusy;
  const imageOptions = pendingImageOptions ?? (id ? data?.session.imageOptions : newDraft.imageOptions ?? (newDraft.directImage ? { executor: "chatgpt-web", direct: true } : newDraft.directImage === false ? { ...imagePreference, direct: false } : imagePreference));
  const directImage = Boolean(imageOptions?.direct);
  const legacyPending = !id && newDraft.pending && !newDraft.imageOptions;
  const imageReady = legacyPending || imageOptions?.executor !== "comfyui" || Boolean(imageOptions.workflowId && imageOptions.prompt && imageOptions.outputNodeId);
  async function selectImageOptions(options) {
    setPendingImageOptions(options); setImageBusy(true); setError("");
    try {
      const value = await request(id ? `/api/chat/sessions/${id}/image-options` : "/api/chat/image-generation/preference", {
        method: "PATCH", body: JSON.stringify(id ? { options, revision: data.session.imageOptionsRevision } : options),
      });
      const saved = id ? value.session.imageOptions : value;
      if (id) update(value); else newDraft.setImageOptions(saved);
      onImagePreference(saved); return true;
    } catch (failure) { setError(failure.message); return false; }
    finally { setPendingImageOptions(null); setImageBusy(false); }
  }
  const hasImages = attachments.length > 0 || sources.some((source) => source.kind === "image");
  const model = id ? data?.session.model || "" : newDraft.model ?? preference?.model ?? "";
  const effort = id ? data?.session.effort || "" : newDraft.effort ?? preference?.effort ?? "";
  async function selectModel(model, effort) {
    setModelBusy(true); setError("");
    try {
      const value = await request(id ? `/api/chat/sessions/${id}` : "/api/chat/model-preference", { method: "PATCH", body: JSON.stringify({ model, effort }) });
      if (id) update(value); else newDraft.setModel(model, effort);
      onPreference({ model, effort }); return true;
    }
    catch (e) { setError(e.message); return false; } finally { setModelBusy(false); }
  }
  async function send(message) {
    if (imageUpload.current) throw new MessageNotSentError("图片正在加入，请稍候");
    if (sendInFlight.current) throw new MessageNotSentError("消息正在发送，请稍候");
    if (!imageReady) throw new MessageNotSentError("请先选择工作流并完成提示词和输出映射");
    const text = directImage ? draft.text : message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    try { checkChatImageCount(sources, attachments); }
    catch (e) { setError(e.message); throw new MessageNotSentError(e.message); }
    // A pre-upgrade pending first send must retain its old wire payload/hash.
    const input = { text, ...(!legacyPending && { imageOptions }), ...(directImage && { directImage: true }), sourceIds: sources.map((s) => s.id), ...(attachments.length && { attachmentIds: attachments.map((image) => image.id) }), model, effort }, key = JSON.stringify(input);
    if (pending.current?.key !== key) pending.current = { key, requestKey: randomUUID(), payload: { ...input, branchRevision: data?.session.branchRevision ?? 0 }, submitted: false };
    const payload = pending.current.payload;
    sendInFlight.current = true; setSending(true); setError("");
    if (!id) newDraft.setSending(true);
    try {
      if (!id) {
        await draft.flush();
        const value = await post("sessions/start", { ...payload, requestKey: await newDraft.prepare(payload) });
        await newDraft.clear(); onStarted(value.session); return;
      }
      // A lost acknowledgement may already have cleared both server drafts and advanced
      // the branch. Replay that exact request before attempting another draft write.
      if (!pending.current.submitted) { await draft.flush(); await savedImages.flush(); }
      pending.current.submitted = true;
      const value = await post(`sessions/${id}/turns`, { ...payload, requestKey: pending.current.requestKey });
      update(value); draft.accept(value.session.draft);
      setSources((current) => current.filter((source) => !payload.sourceIds.includes(source.id)));
      savedImages.accept(value.session.imageDraft);
      pending.current = null; onSessionsChanged();
    }
    catch (e) { setError(e.message); throw new MessageNotSentError(e.message); } finally { sendInFlight.current = false; setSending(false); if (!id) newDraft.setSending(false); }
  }
  async function archive(turnId, value) {
    const saved = await post(`turns/${turnId}/save`, value); onChanged(); return saved;
  }
  async function editMessage(turnId, text, sourceIds, requestKey, attachmentIds) {
    setSending(true); setError("");
    try {
      const value = await post(`turns/${turnId}/edit`, { text, sourceIds, attachmentIds, requestKey, model, effort, branchRevision: data.session.branchRevision });
      update(value); onSessionsChanged();
    } finally { setSending(false); }
  }
  async function selectVersion(turnId) {
    const current = turns.find((turn) => turn.versions?.includes(turnId));
    const controls = viewportRef.current?.querySelector(`[data-user-turn-id="${current?.id}"] .chat-versions`);
    versionAnchor.current = controls ? { turnId, top: controls.getBoundingClientRect().top } : null;
    setSwitchingVersion(true); setError("");
    try { update(await post(`turns/${turnId}/select`, { branchRevision: snapshot.current.session.branchRevision })); }
    catch (e) { versionAnchor.current = null; setError(e.message); } finally { setSwitchingVersion(false); }
  }
  async function fork(turnId, requestKey) {
    setSending(true); setError("");
    try {
      await draft.flush();
      const session = await post(`turns/${turnId}/fork`, { requestKey, branchRevision: data.session.branchRevision });
      onForkCreated(session);
    } catch (e) { setError(e.message); } finally { setSending(false); }
  }
  async function extract(turnId) {
    setSending(true); setError("");
    try { update(await post(`turns/${turnId}/extract`, { requestKey: randomUUID() })); onSessionsChanged(); }
    catch (e) { setError(e.message); } finally { setSending(false); }
  }
  function stop() {
    if (stopRequest.current) return stopRequest.current;
    setStopping(true); setError("");
    stopRequest.current = request(`/api/chat/sessions/${id}/stop`, { method: "POST", body: "{}", signal: AbortSignal.timeout(10000) })
      .then(update)
      .catch((error) => { throw new Error(error.name === "TimeoutError" ? "停止请求未收到响应，尚未确认生成已停止。请重试；若仍无响应，请重启应用。" : error.message); })
      .finally(() => { stopRequest.current = null; setStopping(false); });
    return stopRequest.current;
  }
  async function editImage(text, imageEdit, requestKey) {
    if (running || blocked) throw new Error("请等待当前会话结束后再编辑");
    if (imageOptions?.executor === "comfyui") throw new Error("ComfyUI 改图请将原图作为附件发送，并选择有图片入口的工作流；暂不支持此处的选区编辑");
    setSending(true);
    try {
      const value = await post(`sessions/${id}/turns`, { text, imageEdit, requestKey, sourceIds: [], model, effort, imageOptions: { ...imageOptions, direct: false }, branchRevision: data.session.branchRevision });
      update(value); onSessionsChanged();
      return value.turns.find((turn) => turn.requestKey === requestKey).id;
    } finally { setSending(false); }
  }
  async function loadOlder() {
    try {
      const value = await request(`/api/chat/sessions/${id}?before=${turns[0].id}`);
      if (!currentPage(value)) return;
      hasLoadedOlder.current = true; setOlder((p) => [...value.turns, ...p]); setOlderAvailable(value.hasOlder);
      setOlderProposals((p) => [...new Map([...p, ...value.proposals].map((item) => [item.id, item])).values()]);
    } catch (e) { setError(e.message); }
  }
  async function loadGap() {
    if (!gap || gapLoading) return;
    setGapLoading(true);
    try {
      const value = await request(`/api/chat/sessions/${id}?before=${gap.before}`);
      if (!currentPage(value)) return;
      setOlder((p) => [...p, ...value.turns]); setOlderProposals((p) => [...p, ...value.proposals]);
      setGap(value.turns[0]?.id > gap.after && value.hasOlder ? { ...gap, before: value.turns[0].id } : null);
    } catch (e) { setError(e.message); } finally { setGapLoading(false); }
  }
  async function addCurrent() {
    try {
      const values = await Promise.all(currentIds.slice(0, 12).map((id) => request(`/api/elements/${id}`)));
      setSources(fitSources([...new Map([...sources, ...values.map((e) => ({ id: e.id, kind: e.kind, label: elementLabel(e) }))].map((e) => [e.id, e])).values()]));
    } catch (e) { setError(e.message); }
  }
  async function pasteImages(event) {
    const files = clipboardImages(event.clipboardData);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    if (running || blocked || imageUpload.current || sendInFlight.current) { setError("请等待当前操作完成后再粘贴图片。"); return; }
    if (sources.length + attachments.length + files.length > 12) { setError("最多加入 12 份资料，请移除部分资料后重新粘贴。"); return; }
    if (chatImageCount(sources, attachments) + files.length > maxChatImages) { setError(`本轮图片合计最多 ${maxChatImages} 张，请减少 Wiki 图片或粘贴图片后重试。`); return; }
    if (files.some((file) => file.size > maxImageBytes)) { setError("每张图片必须在 25 MiB 以内。"); return; }
    const upload = new AbortController();
    imageUpload.current = upload; setUploadingImages(true); setError("");
    try {
      for (const file of files) {
        const image = await request("/api/chat/attachments", { method: "POST", headers: {
          "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name || "粘贴图片.png"),
        }, body: file });
        if (upload.signal.aborted) { await request(`/api/chat/attachments/${image.id}`, { method: "DELETE" }); return; }
        setAttachments((current) => [...current, image]);
      }
    } catch (e) {
      if (!upload.signal.aborted) setError(`图片未全部加入：${e.message}。已加入的图片会保留，请重新粘贴未加入的图片。`);
    } finally {
      if (!upload.signal.aborted) { imageUpload.current = null; setUploadingImages(false); }
    }
  }
  function reference(element) {
    if (element.kind === "video") { setError("视频暂不支持作为 AI 资料，可在内容库播放。"); return; }
    if (sources.some((source) => source.id === element.id)) return;
    if (sources.length + attachments.length >= 12) { setError("最多加入 12 份资料，请移除部分资料后重新选择。"); return; }
    try { checkChatImageCount([...sources, element], attachments); }
    catch (e) { setError(e.message); return; }
    setSources((current) => current.some((source) => source.id === element.id) ? current : [...current, { id: element.id, kind: element.kind, label: element.label || elementLabel(element) }].slice(0, 12 - attachments.length));
  }
  function fitSources(values) {
    const accepted = [];
    for (const source of values) {
      if (source.kind === "video") { setError("视频暂不支持作为 AI 资料，可在内容库播放。"); continue; }
      if (accepted.length + attachments.length >= 12) { setError("最多加入 12 份资料，请移除部分资料后重新选择。"); continue; }
      try { checkChatImageCount([...accepted, source], attachments); accepted.push(source); }
      catch (e) { setError(e.message); }
    }
    return accepted;
  }
  async function removeImage(id) {
    try {
      await request(`/api/chat/attachments/${id}`, { method: "DELETE" });
      setAttachments((current) => current.filter((image) => image.id !== id));
    } catch (e) { setError(`图片未移除：${e.message}`); }
  }
  const messages = useMemo(() => turns.flatMap((t) => [
    { id: `u-${t.id}`, role: "user", content: [{ type: "text", text: t.text }], metadata: { custom: { turnId: t.id, versions: t.versions, imageEdit: t.imageEdit, attachments: t.inputAttachments, sources: t.inputSources.map((id) => t.sources.find((source) => source.id === id) || { id, label: `内容 ${id}` }) } } },
    { id: `a-${t.id}`, role: "assistant", content: chatMessageParts(t.answer, t.events).map((part) => part.type === "image" ? { type: "image", image: chatImageUrl({ artifact: part.artifact, turnId: t.id }) } : part),
      status: t.state === "running" ? { type: "running" } : { type: "complete", reason: "stop" },
      metadata: { custom: { turnId: t.id, answer: t.answer, model: t.model, createdAt: t.createdAt, updatedAt: t.updatedAt, sources: t.sources, events: t.events, state: t.state, stopping, error: t.error, saved: t.saved, focused: t.id === focusedTurn, requestTraceVersion: t.requestTraceVersion } } },
  ]), [turns, focusedTurn, stopping]);
  const runtime = useExternalStoreRuntime({ messages, isRunning: running || sending, isDisabled: composerBlocked, isSendDisabled: blocked || !imageReady, onNew: send, onCancel: () => stop().catch((e) => setError(e.message)) });
  useEffect(() => { runtime.thread.composer.setText(draft.text); }, [runtime, draft.text]);
  const proposals = [...new Map([...olderProposals, ...(data?.proposals || [])].map((p) => [p.id, p])).values()].sort((a, b) => b.id - a.id);
  return <ChatContext.Provider value={{ onOpen, onArchive: archive, onExtract: extract, onEdit: editMessage, onSelectVersion: selectVersion, onVersionRendered, onFork: fork, onPreview: setPreview, onReference: reference, referenceDisabled: running || blocked, changed: (proposal) => { setOlderProposals((p) => [...p.filter((item) => item.id !== proposal.id), proposal]); onChanged(); onSessionsChanged(); }, externalBusy, proposals, setError }}>
    <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="chat-thread">
      <ThreadPrimitive.Viewport ref={viewportRef} className="chat-viewport" autoScroll={running || sending} scrollToBottomOnInitialize={!focusedTurn}>
        {olderAvailable && <button className="text-button" onClick={loadOlder}>加载更早消息</button>}
        {gap && <button className="text-button" disabled={gapLoading} onClick={loadGap}>{gapLoading ? "正在加载…" : "加载跳转位置与最近消息之间的会话"}</button>}
        {!turns.length && <div className="chat-empty">{presentation !== "page" && <span className="chat-welcome-mark"><MessageCircle size={28} /></span>}
          {presentation === "page" ? <><h2>新会话</h2>
            <div className="chat-starters">{[
              { title: "查找资料", icon: Search, prompt: "帮我查找 Wiki 中关于…的资料，梳理要点并标明来源。" },
              { title: "整理知识", icon: Network, prompt: "帮我梳理 Wiki 中的内容，建议可以整理的主题、标签和关联。" },
              { title: "生成内容", icon: FileText, prompt: "根据我选择的资料，帮我写一份新笔记，并附上参考来源。" },
            ].map(({ title, icon: Icon, prompt }) => <button key={title} disabled={running || blocked} onClick={() => draft.setText(prompt)}><Icon size={19} /><strong>{title}</strong></button>)}</div>
          </> : <><h3>新会话</h3></>}
        </div>}
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      </ThreadPrimitive.Viewport>
      <div className={`chat-compose-area${receivingReference && !running && !blocked ? " is-receiving-reference" : ""}`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) return;
          event.preventDefault(); event.stopPropagation();
          event.dataTransfer.dropEffect = running || blocked ? "none" : "copy";
          setReceivingReference(!running && !blocked);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setReceivingReference(false); }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) return;
          event.preventDefault(); event.stopPropagation(); setReceivingReference(false);
          if (running || blocked) return;
          const source = readReferenceDrag(event.dataTransfer);
          if (source) reference(source);
        }}>
        {error && <p className="wiki-error" role="alert">{error}<button className="text-button" onClick={() => setError("")}>关闭提示</button></p>}
        {id && !connected && <p className="wiki-muted" role="status">正在连接会话…</p>}
        {running && data?.progressNotice && <p className="chat-progress" role="status">{data.progressNotice}</p>}
        {picker && <ChatSourcePicker selected={sources} limit={12 - attachments.length} imageLimit={maxChatImages - attachments.length} onChange={setSources} busy={running || blocked} onClose={() => setPicker(false)} />}
        <PastedImages images={attachments} onRemove={removeImage} disabled={running || blocked} label="本轮图片附件" />
        {id && savedImages.error && <p className="wiki-error" role="alert">{savedImages.error}<button className="text-button" onClick={savedImages.retry}>重试保存附件草稿</button></p>}
        {sources.length > 0 && <div className="chat-selected" aria-label="本轮选择资料">{sources.map((s) => <span key={s.id} title={s.label}>{s.kind === "image" && <img src={apiUrl(`/api/elements/${s.id}/thumbnail?width=400`)} alt={s.label} />}{s.label.slice(0, 22)}<button className="icon-only" aria-label={`移除资料 ${s.id}`} disabled={running || blocked} onClick={() => setSources((p) => p.filter((x) => x.id !== s.id))}><X size={11} /></button></span>)}</div>}
        {draft.error && <p className="wiki-error" role="alert">草稿尚未保存：{draft.error}<button className="text-button" onClick={draft.retry}>重试保存草稿</button></p>}
        {uploadingImages && <p className="wiki-muted" role="status">正在加入图片附件…</p>}
        <ChatImagePicker options={imageOptions} disabled={running || blocked} onChange={selectImageOptions} />
        <ComposerPrimitive.Root className="chat-composer" onSubmit={(event) => {
          if (draft.text.trim()) return;
          // Images are managed by this application, outside the composer's attachment store.
          event.preventDefault();
          if (!(hasImages || directImage && sources.length) || blocked || running) return;
          void send({ content: [] }).catch(() => {});
        }}><ComposerPrimitive.Input aria-label="会话消息" placeholder="输入你的想法，也可直接粘贴图片" rows={2} maxLength={12000} addAttachmentOnPaste={false} onPaste={pasteImages} disabled={!draft.ready || !savedImages.ready || !id && newDraft.sending || undefined} value={draft.text} onChange={(e) => draft.setText(e.target.value)} onKeyDown={(event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const input = event.currentTarget;
          const cursor = input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd;
          const end = input.value.indexOf("\n", cursor);
          const target = event.key === "ArrowLeft" ? input.value.slice(0, cursor).lastIndexOf("\n") + 1 : end < 0 ? input.value.length : end;
          const anchor = event.shiftKey ? input.selectionDirection === "backward" ? input.selectionEnd : input.selectionStart : target;
          input.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target), target < anchor ? "backward" : "forward");
        }} />
          <div className="chat-composer-footer">
            <div className="chat-composer-sources"><button type="button" className="text-button" aria-label="选择资料" title="选择资料" aria-expanded={picker} disabled={running || blocked} onClick={() => setPicker(!picker)}><Plus size={20} /><span>选择资料{sources.length ? ` · ${sources.length}` : ""}</span></button>{currentIds.length > 0 && <button type="button" className="text-button" disabled={running || blocked} onClick={addCurrent}>加入当前内容</button>}</div>
            {directImage ? <span className="wiki-muted">{imageExecutorDefinition(imageOptions.executor).label}</span> : <ChatModelPicker model={model} effort={effort} catalog={catalog} disabled={running || blocked} loading={modelsLoading} error={modelsError} onChange={selectModel} onRefresh={onRefreshModels} />}
            {running ? <ComposerPrimitive.Cancel aria-label="停止生成" title={stopping ? "正在停止…" : "停止生成"} aria-busy={stopping} disabled={stopping}><Square size={15} fill="currentColor" aria-hidden="true" /></ComposerPrimitive.Cancel> : <button type="submit" className="primary" aria-label="发送消息" disabled={blocked || !imageReady || (!draft.text.trim() && !hasImages && !(directImage && sources.length))}><ArrowUp size={17} /></button>}</div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root></AssistantRuntimeProvider>
    {preview && <ChatImageViewer initial={preview} images={images} turns={turns} progressNotice={data?.progressNotice} stopping={stopping} disabled={running || blocked} onEdit={editImage} onStop={stop} onClose={() => setPreview(null)} />}
  </ChatContext.Provider>;
}

export default function ChatPanel({ selection, onSelectionConsumed, currentIds, onOpen, onClose, onExpand, onChanged, externalBusy, presentation = "dock", visible = true }) {
  const [sessions, setSessions] = useState([]), [id, setId] = useState(undefined), [hasMore, setHasMore] = useState(false);
  const { activity, refresh: refreshActivity } = useChatActivity(id, visible);
  const newDraft = useNewChatDraft();
  const [preference, setPreference] = useState(null);
  const [imagePreference, setImagePreference] = useState(null);
  const [status, setStatus] = useState(null), [checking, setChecking] = useState(false), [error, setError] = useState("");
  const [catalog, setCatalog] = useState(null), [modelsLoading, setModelsLoading] = useState(false), [modelsError, setModelsError] = useState("");
  const isPage = presentation === "page";
  const requestedSession = useRef(selection?.newSession ? null : selection?.session?.id);
  if (selection?.newSession) requestedSession.current = null;
  else if (selection?.session) requestedSession.current = selection.session.id;
  useEffect(() => {
    if (selection?.newSession) { setId(null); return; }
    if (!selection?.session) return;
    setSessions((current) => [selection.session, ...current.filter((session) => session.id !== selection.session.id)]);
    setId(selection.session.id);
  }, [selection]);
  async function refreshModels() {
    setModelsLoading(true); setModelsError("");
    try { setCatalog(await request("/api/chat/models")); }
    catch (e) { setModelsError(e.message); } finally { setModelsLoading(false); }
  }
  async function load(more = false) {
    const value = await request(`/api/chat/sessions${more && sessions.length ? `?before=${sessions.at(-1).id}` : ""}`);
    setSessions((p) => [...new Map([...p, ...value.sessions].map((s) => [s.id, s])).values()].sort((a, b) => b.id - a.id)); setHasMore(value.hasMore);
    return value.sessions;
  }
  useEffect(() => {
    if (!newDraft.ready) return;
    let disposed = false;
    void refreshModels();
    request("/api/chat/image-generation/preference").then(setImagePreference).catch((e) => setError(e.message));
    request("/api/chat/model-preference").then(setPreference).catch((e) => { if (!disposed) setError(e.message); });
    (async () => {
      const entries = await load(); if (disposed) return;
      const params = new URLSearchParams(window.location.hash.split("?")[1] || ""), target = Number(params.get("session"));
      if (requestedSession.current !== undefined) setId(requestedSession.current);
      else if (target) { const selected = await request(`/api/chat/sessions/${target}`); setSessions((p) => [...new Map([...p, selected.session].map((s) => [s.id, s])).values()]); setId(requestedSession.current === undefined ? target : requestedSession.current); }
      else setId(params.has("new") || newDraft.text || newDraft.sources.length || newDraft.attachments.length ? null : entries[0]?.id ?? null);
      const value = await request("/api/chat/status"); if (!disposed) setStatus(value);
      await load();
    })().catch((e) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [newDraft.ready]);
  useEffect(() => {
    const focus = () => {
      const params = new URLSearchParams(window.location.hash.split("?")[1] || ""), target = Number(params.get("session"));
      if (params.has("new")) { requestedSession.current = null; setId(null); return; }
      if (!target) return;
      requestedSession.current = target;
      request(`/api/chat/sessions/${target}`).then((value) => { setSessions((p) => [...new Map([...p, value.session].map((s) => [s.id, s])).values()]); if (requestedSession.current === target) setId(target); }).catch((e) => setError(e.message));
    };
    window.addEventListener("hashchange", focus); return () => window.removeEventListener("hashchange", focus);
  }, []);
  function create() {
    requestedSession.current = null; setId(null);
    if (isPage) window.history.replaceState(null, "", "#agent?new=1");
    request("/api/chat/image-generation/preference").then(setImagePreference).catch((e) => setError(e.message));
    request("/api/chat/model-preference").then(setPreference).catch((e) => setError(e.message));
  }
  function openSession(session) {
    requestedSession.current = session.id;
    setSessions((current) => [...new Map([...current, session].map((entry) => [entry.id, entry])).values()].sort((a, b) => b.id - a.id)); setId(session.id);
    if (isPage) window.history.replaceState(null, "", `#agent?session=${session.id}`);
  }
  function started(session) {
    setSessions((current) => [session, ...current.filter((entry) => entry.id !== session.id)]);
    refreshActivity();
    if (requestedSession.current === null || requestedSession.current === undefined) openSession(session);
  }
  async function probe() { setChecking(true); try { setStatus(await post("probe")); await refreshModels(); } catch (e) { setError(e.message); } finally { setChecking(false); } }
  return <section className={`chat-panel ${isPage ? "chat-page" : ""}`} role={isPage ? "main" : "complementary"} aria-label={isPage ? "Wiki Agent" : "Wiki 对话"} hidden={!visible}>
    <nav className="chat-history" aria-label="会话列表" hidden={!isPage}>
      <button className="chat-history-new" aria-label="新会话" disabled={id === undefined || newDraft.sending} onClick={create}><Plus size={17} />发起新会话</button>
      <p>会话记录</p><div className="chat-history-items">{sessions.map((s) => <div className="chat-history-item" key={s.id}><button title={s.title} disabled={newDraft.sending} aria-current={id === s.id ? "true" : undefined} onClick={() => openSession(s)}><MessageCircle size={14} /><span className="chat-history-title">{s.title}</span>
        {activity[s.id]?.running ? <span className="chat-history-status" role="img" aria-label="正在执行" title="正在执行"><LoaderCircle size={14} className="chat-history-spinner" aria-hidden="true" /></span>
          : activity[s.id]?.unread ? <span className="chat-history-status" role="img" aria-label="已完成，未查看" title="已完成，未查看"><span className="chat-history-unread" /></span> : null}
      </button></div>)}</div>
      {hasMore && <button className="text-button" onClick={() => load(true).catch((e) => setError(e.message))}>更多会话</button>}
    </nav>
    <header className="chat-header"><div><MessageCircle size={isPage ? 22 : 19} />{isPage ? <div><h1>Wiki Agent</h1></div> : <strong>Wiki Agent</strong>}</div><div>
      <button className="icon-only chat-header-new" title="新会话" aria-label="新会话" disabled={id === undefined || newDraft.sending} onClick={create}><Plus size={18} /></button>
      {!isPage && <><button className="icon-only" title="进入 Agent 工作区" aria-label="进入 Agent 工作区" onClick={onExpand}><Maximize2 size={17} /></button><button className="icon-only" aria-label="关闭对话" onClick={onClose}><X size={18} /></button></>}
    </div></header>
    <div className="chat-session-bar"><span className="chat-session-title">{sessions.find((s) => s.id === id)?.title || "新会话"}</span><select aria-label="历史会话" value={id || ""} disabled={newDraft.sending} onChange={(e) => e.target.value ? openSession(sessions.find((s) => s.id === Number(e.target.value))) : create()}><option value="">新会话</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>{hasMore && <button className="text-button chat-session-more" onClick={() => load(true).catch((e) => setError(e.message))}>更多</button>}<div className="chat-connection-actions">
    {status && <details className="chat-connection" open={!status.available || undefined}><summary>{status.available ? "Codex 已连接" : "Codex 连接设置"}</summary><div className="chat-connection-info"><p>{status.message}</p><p>程序、数据目录和默认模型沿用“设置 → Agent 与检索”。可在输入框旁单独选择本会话的模型。</p></div></details>}
    <button className="text-button" disabled={checking} onClick={probe}>{checking ? "检测中…" : "检测连接"}</button></div></div>
    {error && <p className="wiki-error" role="alert">{error}</p>}
    {id === undefined && newDraft.error && <p className="wiki-error" role="alert">{newDraft.error}<button onClick={newDraft.retry}>重试恢复草稿</button></p>}
    {id !== undefined && <Conversation key={id || "new"} id={id} newDraft={newDraft} preference={preference} onPreference={setPreference} onStarted={started} selection={selection?.newSession ? id === null ? selection : null : !selection?.session || selection.session.id === id ? selection : null} onSelectionConsumed={onSelectionConsumed} currentIds={currentIds} onOpen={onOpen} onChanged={onChanged} onConnection={setStatus} onSessionsChanged={() => load().catch((e) => setError(e.message))} externalBusy={externalBusy} presentation={presentation}
      onActivityChange={refreshActivity} onForkCreated={openSession} catalog={catalog} modelsLoading={modelsLoading} modelsError={modelsError} onRefreshModels={refreshModels} imagePreference={imagePreference} onImagePreference={setImagePreference} />}
  </section>;
}
