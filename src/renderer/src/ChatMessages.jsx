import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, Copy, Download, FileText, GitBranch, MoreHorizontal, Network, Pencil, Plus, Search, X } from "lucide-react";
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import RequestTrace, { ToolTrace } from "./ChatTrace.jsx";
import { randomUUID } from "./browserCrypto.js";
import { relationLabel, elementLabel, maxImageBytes } from "../../shared/domain/elements.js";
import { apiUrl, request } from "./api.js";
import TagInput, { readTagInput } from "./TagInput.jsx";
import SourceReference from "./SourceReference.jsx";
import { REFERENCE_DRAG_TYPE, readReferenceDrag } from "./referenceDrag.js";
import ChatSourcePicker from "./ChatSourcePicker.jsx";
import { chatImageUrl } from "./ChatImageViewer.jsx";
import { maxChatImages, chatImageCount, checkChatImageCount } from "../../shared/domain/chat.js";
import { ChatContext, post } from "./chatContext.js";

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
    }}>{!attachments && <span className="chat-sources-label">{label}</span>}{onAdd && <span className="chat-source-drop-hint">可从资料篮拖入本轮；拖动附件调整顺序</span>}{(sources || []).map((s, index) => {
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
          {(answer || meta.events.some((e) => e.artifact)) && <button className="text-button" disabled={referenceDisabled} onClick={() => { actionsMenu.current.open = false; onExtract(meta.turnId); }}>提取内容建议</button>}
          <button className="text-button" disabled={referenceDisabled} onClick={() => { actionsMenu.current.open = false; forkKey.current ||= randomUUID(); onFork(meta.turnId, forkKey.current); }}><GitBranch size={13} />在新聊天中创建分支</button>
        </div>
      </details>
    </div>}
    {meta.saved?.filter((s) => s.key.startsWith("text:") && s.elementId).map((s) => <button key={s.key} className="text-button" disabled={externalBusy} onClick={() => onOpen(s.elementId)}>查看已保存文字</button>)}
    {draft !== null && <div className="chat-manual-draft"><label className="chat-field">保存内容<textarea aria-label="保存内容" value={draft} rows={6} maxLength={12000} disabled={saving} onChange={(e) => { setDraft(e.target.value); draftKey.current = null; }} /></label><div className="chat-actions"><button className="primary" disabled={saving || externalBusy || !draft.trim()} onClick={saveContent}>保存至 Wiki</button><button disabled={saving || externalBusy || !draft.trim()} onClick={saveDraft}>生成保存建议</button><button className="text-button" disabled={saving} onClick={() => setDraft(null)}>取消</button></div></div>}
    {proposals.filter((p) => p.turnId === meta.turnId).map((p) => <Proposal key={p.id} proposal={p} />)}
  </MessagePrimitive.Root>;
}



export { Sources, Markdown, Proposal, PastedImages, UserMessage, GeneratedImage, AssistantImage, AssistantTool, AssistantProcess, AssistantMessage };
