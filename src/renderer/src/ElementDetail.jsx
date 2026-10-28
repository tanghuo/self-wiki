import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, LoaderCircle, Pencil, Copy, Link2, Unlink, Trash2, Download, Monitor, Plus, History, X, MoreHorizontal } from "lucide-react";
import { apiUrl, request } from "./api.js";
import { recordElementUsage } from "./elementUsage.js";
import useWikiResource from "./useWikiResource.js";
import ElementCard from "./ElementCard.jsx";
import { elementLabel, elementKindLabels, relationLabel } from "../../shared/domain/elements.js";
import SessionPreview from "./SessionPreview.jsx";
import ElementEditor from "./ElementEditor.jsx";
import RelationPicker from "./RelationPicker.jsx";
import RelationRenameDialog from "./RelationRenameDialog.jsx";
import WikiPaging from "./WikiPaging.jsx";
import TagRelationCards from "./TagRelationCards.jsx";
import TagRelationMembers from "./TagRelationMembers.jsx";
import AiSource from "./AiSource.jsx";
import OrganizationPanel from "./OrganizationPanel.jsx";
import Dialog from "./Dialog.jsx";
import RelatedContent from "./RelatedContent.jsx";
import ImageDescription from "./ImageDescription.jsx";
import DetailImage from "./DetailImage.jsx";
import EmbeddedPrompt from "./EmbeddedPrompt.jsx";
import VideoMarkerReferences from "./VideoMarkerReferences.jsx";
import VisualMatches from "./VisualMatches.jsx";
import VideoDetailBlocks from "./features/video-analysis/VideoDetailBlocks.jsx";

export default function ElementDetail({ id, contextId, markerId, videoPosition, navigation, prepared, relationPage: page, onRelationPage: setPage, restoreScroll = 0, externalRevision = 0, externalBusy = false, onBusyChange, onBack, onOpen, onChanged, onTrashed, onAddReference, onContentContextMenu, readOnly = false, headerActions }) {
  const [revision, setRevision] = useState(0);
  const [modal, setModal] = useState("");
  const [organizationResultId, setOrganizationResultId] = useState(null);
  const organizationEntry = useRef(null);
  const [selectedTag, setSelectedTag] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [relationKind, setRelationKind] = useState(null);
  const [busy, setBusy] = useState(false);
  const videoPlayer = useRef(null);
  const visualMatches = useRef(null);
  const [seekPosition, setSeekPosition] = useState(videoPosition || null);
  const [visualFrameRequest, setVisualFrameRequest] = useState(null);
  const retainedVideo = useRef(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [imageReady, setImageReady] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageAttempt, setImageAttempt] = useState(0);
  const restoredScroll = useRef(false);
  const [currentId, setCurrentId] = useState(id);
  const changedElement = currentId !== id;
  if (changedElement) {
    // Keep the DOM shell and focus, but do not carry drafts or media state to another item.
    setCurrentId(id); setRevision(0); setModal(""); setOrganizationResultId(null);
    setSelectedTag(null); setRenaming(null); setRelationKind(null); setBusy(false);
    setSeekPosition(videoPosition || null); setVisualFrameRequest(null);
    setMessage(""); setError(""); setImageReady(false); setImageFailed(false); setImageAttempt(0);
    retainedVideo.current = null; restoredScroll.current = false;
  }
  const resourceRevision = `${changedElement ? 0 : revision}:${externalRevision}`;
  const detail = useWikiResource(`/api/elements/${id}`, resourceRevision, 0, 0, prepared?.element);
  const related = useWikiResource(`/api/elements/${id}/relations?page=${page}`, resourceRevision, 0, 0, page === 1 ? prepared?.relations : null);
  if (detail.data?.kind === "video") retainedVideo.current = detail.data;
  const element = detail.data || (detail.loading ? retainedVideo.current : null);
  const canOrganize = element && !readOnly && !element.record && !element.localOnly;
  useEffect(() => { setSeekPosition(videoPosition || null); }, [videoPosition]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useLayoutEffect(() => {
    // Starting at the top needs no data; finish before reading or workspace restoration can begin.
    if (restoreScroll !== 0 || restoredScroll.current) return;
    restoredScroll.current = true;
    window.scrollTo(0, 0);
  }, [id, restoreScroll]);
  useEffect(() => {
    if (!detail.data || !related.data || restoredScroll.current || (detail.data.kind === "image" && !imageReady)) return;
    restoredScroll.current = true;
    const frame = requestAnimationFrame(() => window.scrollTo(0, restoreScroll));
    return () => cancelAnimationFrame(frame);
  }, [detail.data, related.data, restoreScroll, imageReady]);
  function refresh() { setRevision((n) => n + 1); onChanged(); }
  function openOrganization(resultId = null) {
    setOrganizationResultId(resultId); setModal("organization");
  }
  function closeOrganization() {
    if (busy) return;
    setModal("");
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) organizationEntry.current?.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    if (related.data && page > related.data.pagination.pageCount) setPage(related.data.pagination.pageCount);
  }, [related.data, page]);
  async function mutate(path, method, after) {
    if (busy || externalBusy) return;
    setBusy(true); setError(""); setMessage("");
    try { await request(path, { method }); after(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(element.body); setMessage("文字已复制"); recordElementUsage(element.id, "copy"); }
    catch { setError("复制失败，请选中文字后手动复制"); }
  }
  async function setMaterial(material) {
    if (busy || externalBusy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await request("/api/elements/material", { method: "PATCH", body: JSON.stringify({ ids: [id], material }) });
      refresh(); setMessage(material ? "已设为资料" : "已取消资料标记");
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function setWallpaper() {
    if (busy || externalBusy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await window.wikiDesktop.setWallpaper(element.id);
      if (!result?.ok) throw new Error(result?.error || "设置桌面壁纸失败");
      setMessage("已设为桌面壁纸");
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <section className="wiki-detail" data-kind={element?.kind} aria-label="内容详情">
    <div className="wiki-detail-sticky-navigation">
      <button className="text-button button-sm wiki-back" onClick={onBack} disabled={busy}><ArrowLeft size={14} />返回</button>
      {element && navigation && <nav className="wiki-detail-navigation" aria-label="浏览相邻内容" aria-busy={navigation.switching || undefined}>
        <button className="text-button" onClick={navigation.switching ? undefined : navigation.previous} aria-disabled={navigation.switching || undefined} disabled={busy || externalBusy || !navigation.previous}><ChevronLeft size={17} />上一条</button>
        <span className="wiki-detail-navigation-progress" role="status" aria-label={navigation.switching ? "正在切换内容" : navigation.loading ? "正在读取下一条" : undefined}>{(navigation.switching || navigation.loading) && <LoaderCircle size={16} />}</span>
        <button className="text-button" onClick={navigation.switching ? undefined : navigation.next} aria-disabled={navigation.switching || undefined} disabled={busy || externalBusy || !navigation.next}>下一条<ChevronRight size={17} /></button>
      </nav>}
      {headerActions && <div className="wiki-detail-nav-actions">{headerActions}</div>}
    </div>
    <div className="wiki-detail-toolbar" inert={navigation?.switching || undefined}>
      {element && <div className="wiki-actions">{!readOnly && !element.record && <button onClick={() => setModal("edit")} disabled={busy || externalBusy}><Pencil size={15} />编辑</button>}
        {!readOnly && !element.localOnly && ["text", "image", "video"].includes(element.kind) && <label className="wiki-material-filter"><input type="checkbox" checked={Boolean(element.material)} disabled={busy || externalBusy} onChange={(event) => setMaterial(event.target.checked)} />用作资料{element.kind === "video" && <span className="wiki-material-note">（仅库内筛选；视频不能发给 Agent）</span>}</label>}
        {!readOnly && onAddReference && element.kind !== "video" && <button disabled={busy || externalBusy} onClick={() => onAddReference(element)}><Plus size={15} />加入资料</button>}
        {element.kind === "image" && <a className="button" href={apiUrl(`/api/elements/${id}/download`)} download><Download size={15} />保存原图</a>}
        {element.kind === "video" && <a className="button" href={apiUrl(`/api/elements/${id}/download`)} download><Download size={15} />保存原视频</a>}
        {!readOnly && <details className="library-menu wiki-detail-menu" onKeyDown={(event) => { if (event.key === "Escape" && event.currentTarget.open) { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary aria-label="更多内容操作" title="更多操作"><MoreHorizontal size={18} /></summary>
          <div className="menu-panel">
            {element.kind === "image" && window.wikiDesktop?.setWallpaper && <button disabled={busy || externalBusy} onClick={setWallpaper}><Monitor size={15} />设为桌面壁纸</button>}
            <button className="danger-quiet" aria-label="移入回收站" onClick={(event) => { event.currentTarget.closest("details").open = false; mutate(`/api/elements/${id}`, "DELETE", () => onTrashed(element)); }} disabled={busy || externalBusy}><Trash2 size={15} /><span>移入回收站</span></button>
          </div>
        </details>}
      </div>}
    </div>
    <div className="wiki-detail-body" inert={navigation?.switching || undefined}>
    {navigation?.error && <p className="wiki-error" role="alert">后续内容加载失败：{navigation.error}<button disabled={busy || externalBusy} onClick={navigation.retry}>重试加载</button></p>}
    {detail.loading && !detail.data && <p className="wiki-muted" role="status">正在读取内容…</p>}
    {detail.error && <p className="wiki-error" role="alert">{detail.error}<button onClick={refresh}>重试</button></p>}
    {element && <>
      <header className="wiki-detail-header">
        <span className="wiki-eyebrow">{elementKindLabels[element.kind]}</span><h1 title={elementLabel(element)}>{elementLabel(element)}</h1>
      </header>
      <div className="wiki-detail-info" data-kind={element.kind}>
        <div className="wiki-detail-browse">
          <div className="wiki-tags wiki-detail-tags" aria-label="内容标签">{element.tags?.length ? element.tags.map((tag) => <span className="wiki-tag" key={tag}>{tag}<AiSource resultId={element.aiTags?.find((a) => a.name === tag)?.resultId} onOpen={canOrganize ? openOrganization : undefined} disabled={busy || externalBusy} /></span>) : <span className="wiki-muted">暂无标签</span>}{!readOnly && <button className="text-button" onClick={() => setModal("tags")} disabled={busy || externalBusy}>{element.tags?.length ? <Pencil size={14} /> : <Plus size={14} />}{element.tags?.length ? "编辑标签" : "添加标签"}</button>}</div>
        </div>
        <div className="wiki-detail-metadata">
          <div className="wiki-element-meta">保存于 {new Date(element.createdAt).toLocaleString("zh-CN")}{element.image && ` · ${(element.image.byteSize / 1024).toFixed(1)} KB · 原图`}{element.video && ` · ${(element.video.byteSize / 1024 / 1024).toFixed(1)} MiB · 原视频`}{element.kind !== "session" && ` · ${{ manual: "手动添加", chat: "会话保存", unknown: "添加来源未记录" }[element.creationSource || "unknown"]}`}</div>
          {canOrganize && <button ref={organizationEntry} className="text-button wiki-organization-entry" onClick={() => openOrganization()} disabled={busy || externalBusy} aria-haspopup="dialog"><History size={14} />整理记录</button>}
        </div>
      </div>
      <div className="wiki-detail-layout" data-kind={element.kind}>
        <div className="wiki-detail-content">
          {element.kind === "image" ? <DetailImage key={`${id}:${element.image.url}:${imageAttempt}`} src={apiUrl(`${element.image.url}?attempt=${imageAttempt}`)} alt={elementLabel(element)}
            onContextMenu={(event) => { if (!busy && !externalBusy) onContentContextMenu?.(event, element); }}
            onLoad={() => { setImageReady(true); setImageFailed(false); }} onError={() => { setImageReady(true); setImageFailed(true); }} />
            : element.kind === "video" ? <VideoDetailBlocks id={id} element={element} videoPlayer={videoPlayer} revision={revision} externalRevision={externalRevision} refresh={refresh} setSeekPosition={setSeekPosition} setVisualFrameRequest={setVisualFrameRequest} visualMatchesRef={visualMatches} seekPosition={seekPosition} markerId={markerId} onOpen={onOpen} setBusy={setBusy} externalBusy={externalBusy} readOnly={readOnly} /> : element.kind === "session" ? <SessionPreview element={element} contextId={contextId} /> : <div className="wiki-text-document">
              <div className="wiki-text-actions">{!readOnly && !element.record && <button className="text-button" onClick={() => setModal("edit")} disabled={busy || externalBusy}><Pencil size={15} />编辑文字</button>}<button className="text-button" onClick={copy}><Copy size={15} />复制文字</button></div>
              {element.body ? <pre>{element.body}</pre> : <p className="wiki-muted">{readOnly ? "暂无正文" : "可以关联图片或文字。"}</p>}
            </div>}
          {imageFailed && <p className="wiki-error" role="alert">原图无法加载。如文件缺失，请从备份恢复。<button onClick={() => { setImageReady(false); setImageFailed(false); setImageAttempt((n) => n + 1); }}>重新加载图片</button></p>}
          {element.kind === "image" && <EmbeddedPrompt key={id} id={id} />}
          {element.kind === "image" && !element.record && !element.localOnly && <ImageDescription key={id} id={id} revision={`${revision}:${externalRevision}`}
            readOnly={readOnly} disabled={busy || externalBusy} onBusyChange={setBusy} onChanged={refresh} />}
        </div>
        <section className="wiki-related" aria-label="关联内容">
          {["image", "video"].includes(element.kind) && !element.record && !element.localOnly && <div ref={visualMatches}><VisualMatches key={id} elementId={id} frameRequest={visualFrameRequest} revision={`${revision}:${externalRevision}`} onOpen={onOpen} onClearFrame={() => setVisualFrameRequest(null)} disabled={busy || externalBusy} readOnly={readOnly} /></div>}
          {element.videoReferenceCount > 0 && <VideoMarkerReferences id={id} revision={`${revision}:${externalRevision}`} onOpen={onOpen} disabled={busy || externalBusy} />}
          <header><h2><Link2 size={18} />关联内容 {related.data && <span>{related.data.pagination.total}</span>}</h2>{!readOnly && <button onClick={() => { setRelationKind(element.kind); setModal("relate"); }} disabled={busy || externalBusy}><Link2 size={16} />添加关联</button>}</header>
          {related.loading && !related.data && <p className="wiki-muted" role="status">正在读取关联…</p>}
          {related.error && <p className="wiki-error" role="alert">{related.error}<button onClick={refresh}>重试</button></p>}
          {related.data?.relations.length === 0 && !related.data?.tagRelations?.length && <div className="wiki-empty-inline">{readOnly ? "还没有关联。" : "还没有关联。把参考图、文字或人物连接到这里。"}</div>}
          <RelatedContent key={`${id}:${page}`} currentId={id} relations={related.data?.relations} paged={related.data?.pagination.pageCount > 1}
            hasTagRelations={related.data?.tagRelations?.length > 0}
            tagCards={<TagRelationCards relations={related.data?.tagRelations} busy={busy || externalBusy} readOnly={readOnly} onOpen={setSelectedTag} onRename={setRenaming} onRemove={(tagId) => mutate(`/api/tag-relations/${tagId}`, "DELETE", refresh)} />}
            renderRelation={(relation) => { const { id: relationId, element: target } = relation; return <div className={`wiki-related-item is-${target.kind}`} key={relationId}>
            <div className="wiki-relation-heading">{!readOnly && !relation.tagRelationId
              ? <button className="wiki-relation-label wiki-relation-rename text-button" disabled={busy || externalBusy} onClick={() => setRenaming(relation)} title="点击重命名" aria-label={`重命名关联：${elementLabel(target)}`}><span>{relationLabel(relation, id)}</span><Pencil size={12} aria-hidden="true" /></button>
              : <p className="wiki-relation-label">{relation.tagRelationId ? `${relationLabel({ ...relation, targetTag: undefined }, id)} · 通过 #${relation.targetTag} 关联` : relationLabel(relation, id)}</p>}<AiSource resultId={relation.aiResultId} modified={Boolean(relation.aiModified)} onOpen={canOrganize ? openOrganization : undefined} disabled={busy || externalBusy} />
              {!readOnly && !relation.tagRelationId && <details className="wiki-relation-menu"><summary aria-label={`关联操作：${elementLabel(target)}`} title="关联操作"><MoreHorizontal size={16} /></summary><div><button className="text-button" disabled={busy || externalBusy} onClick={() => mutate(`/api/relations/${relationId}`, "DELETE", refresh)} aria-label={`解除关联：${elementLabel(target)}`}><Unlink size={13} />解除关联</button></div></details>}
            </div>
            <ElementCard element={target} onOpen={onOpen} disabled={busy} />
            {relation.tagRelationId && <p className="wiki-muted">通过标签关联 · 在来源内容管理</p>}
          </div>; }} />
          <WikiPaging pagination={related.data?.pagination} onPage={setPage} disabled={busy} />
        </section>
      </div>
    </>}
    {error && <p className="wiki-error" role="alert">{error}</p>}
    {message && <p className="wiki-feedback" role="status">{message}</p>}
    {modal === "organization" && <Dialog open label="整理记录" className="wiki-dialog organization-dialog" onClose={closeOrganization}>
      <header className="wiki-dialog-header"><h2>整理记录</h2><button className="icon-only" aria-label="关闭整理记录" disabled={busy} onClick={closeOrganization}><X size={18} /></button></header>
      {element?.kind === "video" && <p className="wiki-muted">整理会比较视频首帧与候选图片、视频首帧，确认后建立“相似”关联。首帧相似不代表整段视频相同。</p>}
      <OrganizationPanel key={id} elementId={id} initialResultId={organizationResultId} onChanged={refresh} onBusyChange={setBusy} disabled={externalBusy} />
    </Dialog>}
    {["edit", "tags"].includes(modal) && element && <ElementEditor key={`${id}:${modal}`} tagsOnly={modal === "tags"} element={element} onBusyChange={setBusy} onClose={() => setModal("")} onSaved={() => { setModal(""); refresh(); setMessage(modal === "tags" ? "标签已更新" : "内容已更新"); }} />}
    {modal === "relate" && <RelationPicker sourceId={id} sourceKind={relationKind} onClose={() => setModal("")} onChanged={refresh} />}
    {renaming && <RelationRenameDialog currentId={id} relation={renaming} busy={busy || externalBusy} onBusyChange={setBusy} onClose={() => setRenaming(null)} onSaved={() => { setRenaming(null); refresh(); setMessage("关联名称已更新"); }} />}
    {selectedTag && <TagRelationMembers key={selectedTag.id} relation={selectedTag} revision={`${revision}:${externalRevision}`} onClose={() => setSelectedTag(null)} onOpen={(targetId) => { setSelectedTag(null); onOpen(targetId); }} />}
    </div>
  </section>;
}
