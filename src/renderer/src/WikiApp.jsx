import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, X, Trash2, Search, Plus, Upload, Network, MoreHorizontal, ListChecks, LayoutGrid, PanelsTopLeft, MessageCircle } from "lucide-react";
import { apiUrl, request } from "./api.js";
import useWikiResource from "./useWikiResource.js";
import MediaStackCard from "./MediaStackCard.jsx";
import MediaStackDialog from "./MediaStackDialog.jsx";
import TagFilter from "./TagFilter.jsx";
import { elementLabel } from "../../shared/domain/elements.js";
import ElementDetail from "./ElementDetail.jsx";
import ElementEditor from "./ElementEditor.jsx";
import useWikiList from "./useWikiList.js";
import WikiGrid from "./WikiGrid.jsx";
import WindowedWikiGrid from "./WindowedWikiGrid.jsx";
import AddContentDialog from "./AddContentDialog.jsx";
import { ConfirmDialog, EmptyState, PageHeader } from "./ui/index.js";
import WikiSidebar, { contentSections, wikiSections as tabs } from "./WikiSidebar.jsx";
import CanvasBoundary from "./CanvasBoundary.jsx";
import WikiContextMenu from "./WikiContextMenu.jsx";
import { isEditableTarget, modKey, overlayOpen } from "./shortcuts.js";
import { appendMediaDrafts, clipboardMedia, savedContentStatus, textDraft } from "./contentDrafts.js";
import Select from "./Select.jsx";
import ViewMenu from "./ViewMenu.jsx";

const WikiCanvas = lazy(() => import("./WikiCanvas.jsx"));
export default function WikiApp({ onBusyChange, readOnly = false, workspaceNavigation, initialTab = "all", tabRequest, onTabChange, onAddReference, onAskAgent, agentOpen = false, onContextChange, openRequest, externalRevision = 0, onChanged, searchRequest }) {
  const [tab, setTab] = useState(initialTab);
  const [view, setView] = useState(() => { try { return localStorage.getItem("wikiContentView") === "grid" ? "grid" : "masonry"; } catch { return "masonry"; } });
  const [stackSimilar, setStackSimilar] = useState(() => { try { return localStorage.getItem("wikiStackSimilar") === "true"; } catch { return false; } });
  const [stackHint, setStackHint] = useState("");
  const [mediaStackId, setMediaStackId] = useState(null);
  const [cardWidth, setCardWidth] = useState(() => {
    try {
      const width = Number(localStorage.getItem("wikiMasonryCardWidth"));
      return Number.isFinite(width) && width >= 200 && width <= 560 && width % 20 === 0 ? width : 320;
    } catch { return 320; }
  });
  const [q, setQ] = useState("");
  const [materialOnly, setMaterialOnly] = useState(() => { try { return localStorage.getItem("wikiMaterialOnly") === "true"; } catch { return false; } });
  const [textSort, setTextSort] = useState(() => { try { return localStorage.getItem("wikiTextSort") === "usage" ? "usage" : "updated"; } catch { return "updated"; } });
  useEffect(() => { try { localStorage.setItem("wikiTextSort", textSort); } catch { /* Sorting remains available without storage. */ } }, [textSort]);
  const [tags, setTags] = useState([]);
  const [tagMatch, setTagMatch] = useState("any");
  const [revision, setRevision] = useState(0);
  const [stack, setStack] = useState([]);
  const [backMenu, setBackMenu] = useState(null);
  const [editing, setEditing] = useState(null);
  const [detailScroll, setDetailScroll] = useState(0);
  const [creation, setCreation] = useState(null);
  const [creationBusy, setCreationBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailNavigation, setDetailNavigation] = useState(null);
  const navigationRequest = useRef(null);
  const [canvasBusy, setCanvasBusy] = useState(false);
  const [canvasAdded, setCanvasAdded] = useState([]);
  const [imports, setImports] = useState([]);
  const [lastDeleted, setLastDeleted] = useState([]);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState("");
  const [purgeConfirmation, setPurgeConfirmation] = useState(null);
  const [purgeConfirmPhrase, setPurgeConfirmPhrase] = useState("");
  const [purgeNotice, setPurgeNotice] = useState("");
  const [cleanupRetry, setCleanupRetry] = useState(null);
  const [dragging, setDragging] = useState(false);
  const files = useRef(null);
  const writeLock = useRef(false);
  const savedScroll = useRef([]);
  const lastOpenRequest = useRef(null);
  const lastTabRequest = useRef(null);
  const resourceRevision = revision + externalRevision;
  useEffect(() => {
    if (readOnly) return;
    const refreshUsage = () => setRevision((value) => value + 1);
    window.addEventListener("element-usage-recorded", refreshUsage);
    return () => window.removeEventListener("element-usage-recorded", refreshUsage);
  }, [readOnly]);
  const query = new URLSearchParams({ q, kind: ["text", "image", "video"].includes(tab) ? tab : "", scope: tab === "trash" ? "trash" : "library" });
  if (tab === "text" && !readOnly) query.set("sort", textSort);
  if (materialOnly && tab !== "trash") query.set("material", "1");
  tags.forEach((tag) => query.append("tag", tag));
  if (tags.length > 1) query.set("tagMatch", tagMatch);
  const stacking = stackSimilar && !managing && ["all", "text", "image", "video"].includes(tab);
  if (stacking) query.set("stackSimilar", "1");
  if (!readOnly && tab !== "trash") query.set("semantic", "1");
  const list = useWikiList(tab === "canvas" ? null : `/api/elements?${query}`, resourceRevision, q.trim() ? 350 : 0, !stack.length && tab !== "canvas" && !busy && !creation);
  const hasCollapsedMembers = stacking && list.data?.totalElements > list.data?.pagination.total;
  const availableTags = useWikiResource("/api/tags", resourceRevision);
  const browsingElements = list.data?.elements.length ? list.data.elements : list.data?.possible || [];
  const browsingIndex = stack.length === 1 && tab !== "canvas" ? browsingElements.findIndex((element) => element.id === stack[0].id) : -1;
  const atLoadedEnd = browsingIndex >= 0 && browsingIndex === browsingElements.length - 1 && list.hasMore;
  useEffect(() => {
    if (atLoadedEnd && !list.loading && !list.error) void list.loadMore();
  }, [atLoadedEnd, list.loading, list.error, list.data]);
  useEffect(() => {
    setDetailNavigation(null);
    return () => { navigationRequest.current?.abort(); navigationRequest.current = null; };
  }, [stack, resourceRevision]);
  async function navigateDetail(id) {
    if (!id || busy || detailBusy || creationBusy || canvasBusy || navigationRequest.current) return;
    const controller = new AbortController();
    navigationRequest.current = controller;
    setBackMenu(null); setDetailNavigation({ id, loading: true, error: "" });
    try {
      const [element, relations] = await Promise.all([
        request(`/api/elements/${id}`, { signal: controller.signal }),
        request(`/api/elements/${id}/relations?page=1`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      if (element.kind === "image") {
        const image = new Image();
        const cancel = () => { image.src = ""; };
        controller.signal.addEventListener("abort", cancel, { once: true });
        image.src = apiUrl(`${element.image.url}?attempt=0`);
        // Broken originals still open the detail, where the image error offers a retry.
        try { await image.decode(); } catch { /* Render the normal image error state. */ }
        finally { controller.signal.removeEventListener("abort", cancel); }
      }
      if (controller.signal.aborted) return;
      setDetailScroll(0);
      setStack([{ id, page: 1, prepared: { element, relations, revision: resourceRevision } }]);
    } catch (failure) {
      if (!controller.signal.aborted) setDetailNavigation({ id, loading: false, error: failure.message });
    } finally {
      controller.abort();
      if (navigationRequest.current === controller) navigationRequest.current = null;
    }
  }
  useEffect(() => {
    const aliases = availableTags.data?.aliases;
    if (!aliases?.length) return;
    setTags((current) => {
      const next = [...new Set(current.map((name) => aliases.find((a) => a.alias.toLowerCase() === name.toLowerCase())?.name || name))];
      return next.length === current.length && next.every((name, i) => name === current[i]) ? current : next;
    });
  }, [availableTags.data]);
  function refresh() { setRevision((n) => n + 1); onChanged?.(); }
  useEffect(() => { onTabChange?.(tab); }, [tab, onTabChange]);
  useEffect(() => { onContextChange?.(selected.size ? [...selected] : stack.length ? [stack.at(-1).id] : []); }, [selected, stack, onContextChange]);
  useEffect(() => {
    if (!tabRequest || lastTabRequest.current === tabRequest) return;
    lastTabRequest.current = tabRequest;
    // Returning to the current category keeps the user's search and detail context.
    if (tabRequest.key !== tab) chooseTab(tabRequest.key);
  }, [tabRequest]);
  useEffect(() => {
    if (!openRequest || lastOpenRequest.current === openRequest) return;
    lastOpenRequest.current = openRequest; open(openRequest.id, openRequest.contextId);
  }, [openRequest]);
  const searchInput = useRef(null), lastSearchRequest = useRef(null);
  useEffect(() => {
    if (!searchRequest || lastSearchRequest.current === searchRequest) return;
    lastSearchRequest.current = searchRequest;
    if (stack.length && !busy && !detailBusy) { setBackMenu(null); setStack([]); savedScroll.current = []; window.scrollTo(0, 0); }
    // Wait for the list (or canvas) to become visible before moving focus.
    const timer = setTimeout(() => {
      const input = tab === "canvas" ? document.querySelector('[aria-label="搜索画布内容"]') : searchInput.current;
      if (input && !input.disabled) { input.focus(); input.select(); }
    }, 60);
    return () => clearTimeout(timer);
  }, [searchRequest]);
  const keyboardState = useRef({});
  keyboardState.current = { stack, busy: busy || detailBusy || creationBusy || canvasBusy, backMenu, editing, creation, browsingIndex, browsingElements };
  useEffect(() => {
    function keydown(event) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const state = keyboardState.current;
      if (!state.stack.length || state.busy || state.backMenu || state.editing || state.creation || overlayOpen() || isEditableTarget(event.target)) return;
      if (event.target.closest?.(".chat-panel, .reference-tray")) return;
      if (event.key === "Escape") { event.preventDefault(); back(); return; }
      if (state.stack.length === 1 && state.browsingIndex >= 0 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        const next = state.browsingElements[state.browsingIndex + (event.key === "ArrowLeft" ? -1 : 1)];
        if (next) { event.preventDefault(); void navigateDetail(next.id); }
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const organizationRefreshAllowed = useRef(false);
  organizationRefreshAllowed.current = !list.refreshing && !list.loading && !busy && !detailBusy && !canvasBusy && !creationBusy;
  useEffect(() => {
    if (readOnly) return;
    const controller = new AbortController(); let previous = null, loading = false;
    async function poll() {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const value = await request("/api/organization/revision", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (previous === null) previous = value.revision;
        else if (previous !== value.revision && organizationRefreshAllowed.current && !document.querySelector("dialog[open]")) {
          previous = value.revision; refresh();
        }
      } catch { /* Organizer status must not interrupt normal browsing. */ }
      finally { loading = false; }
    }
    void poll(); const timer = setInterval(poll, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [readOnly, onChanged]);
  useEffect(() => { try { localStorage.setItem("wikiContentView", view); } catch { /* Browsing still works when preferences cannot be saved. */ } }, [view]);
  useEffect(() => { try { localStorage.setItem("wikiStackSimilar", String(stackSimilar)); } catch { /* Keep browsing if preferences cannot be saved. */ } }, [stackSimilar]);
  useEffect(() => { try { localStorage.setItem("wikiMaterialOnly", String(materialOnly)); } catch { /* Keep browsing if preferences cannot be saved. */ } }, [materialOnly]);
  useEffect(() => { try { localStorage.setItem("wikiMasonryCardWidth", String(cardWidth)); } catch { /* Browsing still works when preferences cannot be saved. */ } }, [cardWidth]);
  useEffect(() => { onBusyChange(busy || detailBusy || creationBusy || canvasBusy); }, [busy, detailBusy, creationBusy, canvasBusy, onBusyChange]);
  const selectionFilter = `${tab}:${q}:${JSON.stringify(tags)}:${tags.length > 1 ? tagMatch : "any"}:${stacking}:${materialOnly}`;
  const previousSelectionFilter = useRef(selectionFilter);
  useEffect(() => {
    if (previousSelectionFilter.current === selectionFilter) return;
    previousSelectionFilter.current = selectionFilter; setSelected(new Set());
  }, [selectionFilter]);
  useEffect(() => {
    if (!purgeNotice) return;
    const timer = setTimeout(() => setPurgeNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [purgeNotice]);
  useEffect(() => {
    let cancelled = false, reading = false, pasteVersion = 0;
    let shortcutTimer;
    const blocked = () => readOnly || writeLock.current || busy || detailBusy || canvasBusy || creationBusy || (document.querySelector("dialog[open]") && !creation);
    function paste(event) {
      pasteVersion++;
      clearTimeout(shortcutTimer);
      if (event.defaultPrevented || blocked()) return;
      const pasted = clipboardMedia(event.clipboardData);
      if (pasted.length) { event.preventDefault(); selectFiles(pasted); }
    }
    function pasteShortcut(event) {
      if (event.defaultPrevented || event.repeat || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)
        || event.code !== "KeyV" || blocked() || !navigator.clipboard?.read) return;
      // Inputs retain native paste handling, including the chat composer's attachments.
      if (event.target.closest?.("input, textarea, select, [contenteditable], .chat-panel")) return;
      // Keep native file/video paste, but recover when a non-editable target
      // does not receive a paste event at all.
      clearTimeout(shortcutTimer);
      const version = pasteVersion;
      shortcutTimer = setTimeout(() => readClipboard(version), 150);
    }
    async function readClipboard(version) {
      if (cancelled || blocked() || version !== pasteVersion) return;
      if (reading) return;
      reading = true;
      try {
        const items = await navigator.clipboard.read();
        const images = [];
        for (const item of items) {
          const type = item.types.find((value) => value.startsWith("image/"));
          if (type) images.push(new File([await item.getType(type)], `粘贴图片.${type.split("/")[1]}`, { type }));
        }
        if (cancelled || blocked() || version !== pasteVersion) return;
        if (images.length) { setError(""); selectFiles(images); }
        else setError("剪贴板里没有可读取的图片。请复制图片本身，或点「添加内容」导入文件。");
      } catch (failure) {
        if (!cancelled && version === pasteVersion) setError(`无法读取剪贴板图片：${failure.message}。可以点「添加内容」导入文件。`);
      } finally { reading = false; }
    }
    window.addEventListener("paste", paste);
    window.addEventListener("keydown", pasteShortcut);
    return () => {
      cancelled = true;
      clearTimeout(shortcutTimer);
      window.removeEventListener("paste", paste);
      window.removeEventListener("keydown", pasteShortcut);
    };
  }, [readOnly, busy, detailBusy, canvasBusy, creationBusy, creation]);

  function finishManaging() { setManaging(false); setSelected(new Set()); }
  function toggleSelected(id) {
    if (writeLock.current) return;
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function open(id, contextId, markerId, videoPosition) {
    setBackMenu(null);
    finishManaging();
    setPurgeNotice(""); setError("");
    setDetailScroll(0);
    savedScroll.current.push(window.scrollY);
    setStack((current) => [...current, { id, page: 1, contextId, markerId, videoPosition }]);
    window.scrollTo(0, 0);
  }
  function back() {
    setBackMenu(null);
    const scroll = savedScroll.current.pop() || 0;
    setDetailScroll(scroll);
    setStack((current) => current.slice(0, -1));
    if (stack.length === 1) requestAnimationFrame(() => window.scrollTo(0, scroll));
  }
  function chooseTab(key) {
    setBackMenu(null);
    finishManaging();
    setImports([]); setPurgeNotice(""); setError(""); setLastDeleted([]);
    setTab(key); setStack([]); savedScroll.current = []; setQ("");
    window.scrollTo(0, 0);
  }
  function selectFiles(chosen) {
    if (readOnly || writeLock.current || busy || detailBusy || canvasBusy || creationBusy || !chosen.length) return;
    if (!creation) setImports([]);
    const selectedFiles = Array.from(chosen);
    setCreation((current) => appendMediaDrafts(current, selectedFiles));
    if (files.current) files.current.value = "";
  }
  function addContent() { finishManaging(); setImports([]); setCanvasAdded([]); setCreation({ entries: [textDraft()], tags: { tags: [], draft: "" } }); }
  async function editText(element) {
    if (readOnly || writeLock.current || busy || detailBusy || canvasBusy || creationBusy || element.kind !== "text" || element.record) return;
    writeLock.current = true; setBusy(true); setError(""); setPurgeNotice("");
    try { setEditing(await request(`/api/elements/${element.id}`)); }
    catch (failure) { setError(failure.message); }
    finally { writeLock.current = false; setBusy(false); }
  }
  function recordDeletion(elements) {
    setLastDeleted(elements);
    const ids = new Set(elements.map((element) => element.id));
    setImports((rows) => rows.filter((row) => !ids.has(row.id)));
    refresh();
  }
  async function setMaterial(ids, material) {
    if (readOnly || writeLock.current || !ids.length) return;
    writeLock.current = true; setBusy(true); setError(""); setPurgeNotice("");
    try {
      // Match the API's bounded batch size even when many pages are selected.
      for (let offset = 0; offset < ids.length; offset += 100) {
        await request("/api/elements/material", { method: "PATCH", body: JSON.stringify({ ids: ids.slice(offset, offset + 100), material }) });
        setSelected((current) => { const next = new Set(current); ids.slice(offset, offset + 100).forEach((id) => next.delete(id)); return next; });
      }
      setPurgeNotice(material ? "已设为资料" : "已取消资料标记");
    } catch (failure) { setError(`资料标记修改未全部完成：${failure.message}。未完成项保留选中，可重试。`); }
    finally { refresh(); writeLock.current = false; setBusy(false); }
  }
  async function trashSelected() {
    if (readOnly || writeLock.current || list.loading || !managing) return;
    const chosen = (list.data?.elements || []).filter((element) => selected.has(element.id));
    if (!chosen.length) return;
    writeLock.current = true; setBusy(true); setError("");
    const deleted = [], failed = [];
    try {
      for (const element of chosen) {
        try { await request(`/api/elements/${element.id}`, { method: "DELETE" }); deleted.push(element); }
        catch (failure) { failed.push({ id: element.id, message: failure.message }); }
      }
      if (deleted.length) recordDeletion(deleted);
      setSelected(new Set(failed.map((entry) => entry.id)));
      if (failed.length) setError(`${failed.length} 条未删除：${failed[0].message}。未删除内容仍保留选中，可重试。`);
    } finally { writeLock.current = false; setBusy(false); }
  }
  async function purgeTrash(retry) {
    const payload = retry === true ? cleanupRetry : purgeConfirmation;
    if (readOnly || writeLock.current || !payload) return;
    writeLock.current = true; setBusy(true); setError(""); setPurgeNotice("");
    try {
      const result = await request("/api/trash/purge", { method: "POST", body: JSON.stringify(payload) });
      const deleted = new Set(result.deleted);
      setLastDeleted((current) => current.filter((element) => !deleted.has(element.id)));
      setImports((current) => current.filter((row) => !deleted.has(row.id)));
      setSelected(new Set(result.failed.map((entry) => entry.id)));
      setPurgeNotice(`已永久删除 ${deleted.size} 条内容。`);
      setCleanupRetry(result.historyCleanupFailed?.length ? { ids: result.deleted.length ? result.deleted : payload.ids, ...(payload.all ? { all: true, ids: undefined } : {}) } : null);
      if (result.failed.length || result.cleanupFailed.length || result.historyCleanupFailed?.length) setError([
        result.failed.length ? `${result.failed.length} 条删除失败：${result.failed[0].message}。可重试。` : "",
        result.cleanupFailed.length ? `${result.cleanupFailed.length} 个原文件未能清理，内容记录已删除；请关闭应用后运行离线文件清理工具。` : "",
        result.historyCleanupFailed?.length ? `${result.historyCleanupFailed.length} 份历史文件尚未清理，可以重试。` : "",
      ].filter(Boolean).join(" "));
      refresh();
    } catch (failure) { setError(failure.message); refresh(); }
    finally { setPurgeConfirmation(null); setPurgeConfirmPhrase(""); writeLock.current = false; setBusy(false); }
  }
  function contentSaved(element, entry) {
    setImports((rows) => [...rows, { name: entry.file?.name || elementLabel(element), status: savedContentStatus(element), id: element.id }]);
    if (tab === "canvas") setCanvasAdded((current) => [...new Set([...current, element.id])]);
    refresh();
  }
  function completeCreation(elements) {
    setCreation(null);
    if (tab !== "canvas" && elements.length === 1 && elements[0].kind === "text") {
      if (tab === "trash") setTab("all");
      open(elements[0].id);
    }
  }
  async function restore(ids) {
    if (readOnly || writeLock.current) return;
    writeLock.current = true; setBusy(true); setError("");
    const restored = new Set(), failed = [];
    try {
      for (const id of ids) {
        try { await request(`/api/elements/${id}/restore`, { method: "POST" }); restored.add(id); }
        catch (failure) { failed.push(failure.message); }
      }
      if (restored.size) { setLastDeleted((current) => current.filter((element) => !restored.has(element.id))); refresh(); }
      if (failed.length) setError(`${failed.length} 条恢复失败：${failed[0]}`);
    } finally { writeLock.current = false; setBusy(false); }
  }
  // 「问 Agent」 lives in each page header (library, canvas, detail) as a secondary action — no breadcrumb bar.
  const askAgent = !readOnly && onAskAgent ? <button className="wiki-ask-agent" data-agent-trigger aria-expanded={agentOpen} disabled={busy || detailBusy || creationBusy || canvasBusy} onClick={onAskAgent} title="打开对话：可附带当前打开的内容或资料篮中的资料"><MessageCircle size={16} />问 Agent</button> : null;
  return <div className="wiki-shell" onContextMenu={(event) => {
    setBackMenu(null);
    const card = event.target.closest("[data-element-id]");
    const element = !stack.length && card && [...(list.data?.elements || []), ...(list.data?.possible || [])].find((entry) => String(entry.id) === card.dataset.elementId);
    if (element && !element.deletedAt && !busy && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      setBackMenu({ x: event.clientX, y: event.clientY, element });
      return;
    }
    if (!stack.length || document.querySelector("dialog[open]") || window.getSelection()?.toString()
      || event.target.closest(".wiki-sidebar, a, button, input, textarea, select, summary, img, video, audio, pre, [contenteditable], [role='menu']")) return;
    event.preventDefault();
    setBackMenu({ x: event.clientX, y: event.clientY });
  }} onDragOver={(e) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); if (!readOnly && !busy && !detailBusy && !canvasBusy) setDragging(true); }
  }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }} onDrop={(e) => {
    e.preventDefault(); setDragging(false); selectFiles(e.dataTransfer.files);
  }}>
    <WikiSidebar activeTab={tab} onChooseTab={chooseTab} busy={busy || detailBusy || creationBusy || canvasBusy} readOnly={readOnly}>{workspaceNavigation}</WikiSidebar>
    <main id="main-content" data-tab={tab} data-c-surface={stack.length ? "detail" : tab === "canvas" ? "canvas" : ["all", "image", "video", "text", "trash"].includes(tab) ? "library" : "page"} className={`wiki-main ${stack.length ? "is-detail" : ""} ${tab === "canvas" && !stack.length ? "is-canvas" : ""} ${view === "masonry" && tab !== "canvas" && !stack.length ? "is-masonry" : ""}`}>
      <div className="toast-region">
        {lastDeleted.length > 0 && <div className="wiki-deletion-feedback" role="status"><span>{lastDeleted.length === 1 ? `“${elementLabel(lastDeleted[0])}”已移入回收站` : `${lastDeleted.length} 条内容已移入回收站`}</span><button className="text-button" disabled={busy || detailBusy} onClick={() => restore(lastDeleted.map((element) => element.id))}>撤销删除</button><button className="icon-only" aria-label="关闭删除提示" disabled={busy} onClick={() => setLastDeleted([])}><X size={16} /></button></div>}
        {stackHint && <p className="wiki-toast" role="status"><CheckCircle2 size={17} aria-hidden="true" /><span>{stackHint}</span><button className="icon-only button-sm" aria-label="关闭提示" onClick={() => setStackHint("")}><X size={16} /></button></p>}
        {purgeNotice && <p className="wiki-toast" role="status"><CheckCircle2 size={17} aria-hidden="true" /><span>{purgeNotice}</span><button className="icon-only button-sm" aria-label="关闭提示" onClick={() => setPurgeNotice("")}><X size={16} /></button></p>}
      </div>
      {error && <p className="wiki-error" role="alert">{error}<button onClick={() => setError("")}>关闭提示</button></p>}
      {cleanupRetry && <button disabled={busy} onClick={() => purgeTrash(true)}>有文件没删干净，点此再试</button>}
      {stack.length === 0 && imports.length > 0 && <section className="wiki-imports" aria-label="保存结果"><header><strong>保存结果</strong><button className="text-button" disabled={busy || creationBusy} onClick={() => setImports([])}>收起</button></header><ul>{imports.map((row, index) => <li key={index}><span>{row.name}</span><span>{row.status}</span><button className="text-button" disabled={busy || detailBusy || creationBusy} onClick={() => open(row.id)} aria-label={`查看保存结果：${row.name}`}>查看</button></li>)}</ul></section>}
      {tab === "canvas" && <div hidden={stack.length > 0}><CanvasBoundary onBack={() => chooseTab("all")}><Suspense fallback={<p className="wiki-muted">正在打开画布…</p>}><WikiCanvas headerActions={askAgent} quietAdd={agentOpen} readOnly={readOnly} revision={resourceRevision} addedIds={canvasAdded} visible={stack.length === 0} externalBusy={busy || detailBusy || Boolean(creation)} onChanged={refresh} onBusyChange={setCanvasBusy} onAdd={addContent} onOpen={open} /></Suspense></CanvasBoundary></div>}
      <div hidden={stack.length > 0 || tab === "canvas"}>
        <PageHeader className="wiki-page-header" title={tabs.find((t) => t.key === tab).label}
          subtitle={tab === "trash" ? "移入回收站的内容可以恢复；清空回收站或永久删除后不可恢复。" : undefined}
          actions={!readOnly && (tab === "trash"
            ? <button className="danger-quiet" disabled={busy || list.loading} onClick={() => { setPurgeConfirmPhrase(""); setPurgeConfirmation({ all: true }); }}><Trash2 size={16} />清空回收站</button>
            : <>{askAgent}<button className={agentOpen ? "" : "primary"} disabled={busy} onClick={addContent}><Plus size={16} />添加内容</button></>)} />
        <div className="wiki-toolbar">{["all", "image", "video", "text"].includes(tab) && <div className="wiki-type-chips" role="group" aria-label="快速筛选">{contentSections.filter((section) => section.key !== "canvas").map((section) => <button type="button" key={section.key} aria-label={`快速筛选：${section.label}`} aria-pressed={tab === section.key} disabled={busy} onClick={() => chooseTab(section.key)}>{section.key === "all" ? "全部" : section.label}</button>)}</div>}<label className="wiki-search"><Search size={18} aria-hidden="true" /><input ref={searchInput} aria-label="搜索内容" aria-keyshortcuts="Control+K Meta+K /" value={q} disabled={busy} onChange={(e) => { setQ(e.target.value); }}
            onKeyDown={(event) => { if (event.key === "Escape" && q) { event.preventDefault(); event.stopPropagation(); setQ(""); } }} placeholder={readOnly || tab === "trash" ? "搜索文字或文件名…" : "搜索文字、文件名或描述画面…"} />{!q && <kbd className="wiki-search-hint" aria-hidden="true">{modKey} K</kbd>}</label><TagFilter aliases={availableTags.data?.aliases || []} tags={availableTags.data?.tags || []} selected={tags} match={tagMatch} disabled={busy} onChange={(next) => { setTags(next); }} />{tags.length > 1 && <Select className="wiki-tag-match" aria-label="标签匹配方式" value={tagMatch} disabled={busy} onChange={setTagMatch} options={[{ value: "any", label: "任意匹配" }, { value: "all", label: "全部匹配" }]} />}<span>{list.data ? (list.data.possible?.length ? "0 条明确匹配" : hasCollapsedMembers ? `${list.data.pagination.total} 项 · ${list.data.totalElements} 条内容` : `${list.data.pagination.total} 条内容`) : "正在读取…"}</span>
          {tab === "text" && !readOnly && <Select className="wiki-text-sort" aria-label="文字排序" title="使用次数 = 引用次数 + 复制次数（全部历史记录）" value={textSort} disabled={busy} onChange={setTextSort}
            options={[{ value: "updated", label: "最近更新" }, { value: "usage", label: "使用次数从多到少" }]} />}
          <ViewMenu disabled={busy} changed={materialOnly && tab !== "trash" || !stackSimilar && ["all", "text", "image", "video"].includes(tab)}>
            <div className="wiki-view-menu-row"><span>布局</span>
              <div className="wiki-view-switch ui-segmented" role="group" aria-label="内容视图">
                <button type="button" aria-label="网格视图" title="网格视图" aria-pressed={view === "grid"} disabled={busy} onClick={() => setView("grid")}><LayoutGrid size={16} /><span>网格</span></button>
                <button type="button" aria-label="瀑布流视图" title="瀑布流视图" aria-pressed={view === "masonry"} disabled={busy} onClick={() => setView("masonry")}><PanelsTopLeft size={16} /><span>瀑布流</span></button>
              </div>
            </div>
            {view === "masonry" && <label className="wiki-size-control wiki-view-menu-row">
              <span>图片大小</span><input aria-label="瀑布流图片大小" type="range" min="200" max="560" step="20" value={cardWidth} disabled={busy} onChange={(event) => setCardWidth(Number(event.target.value))} /><span>{cardWidth}px</span>
            </label>}
            {["all", "text", "image", "video"].includes(tab) && <button type="button" className="wiki-stack-toggle" aria-pressed={stackSimilar} disabled={busy || managing}
              title={readOnly ? "按相似关联堆叠" : "按相似关联堆叠，文字优先显示最常用的一条，图片和视频显示最新添加的内容"} onClick={() => setStackSimilar((value) => {
                const next = !value;
                if (next) {
                  try {
                    if (localStorage.getItem("wikiStackSimilarSeen") !== "1") {
                      localStorage.setItem("wikiStackSimilarSeen", "1");
                      setStackHint("已按「相似」关联收起重复内容，角标表示组内条数。可随时在此关闭。");
                      setTimeout(() => setStackHint(""), 8000);
                    }
                  } catch { /* ignore */ }
                }
                return next;
              })}><span>堆叠相似内容</span><i aria-hidden="true" /></button>}
            {tab !== "trash" && <label className="wiki-material-filter"><input type="checkbox" checked={materialOnly} disabled={busy} onChange={(event) => setMaterialOnly(event.target.checked)} />仅看资料</label>}
          </ViewMenu>
          {!readOnly && !managing && <details className="library-menu wiki-list-menu" onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.open = false; }}>
            <summary aria-label="更多操作" title="更多操作"><MoreHorizontal size={18} /></summary>
            <div className="menu-panel"><button disabled={busy || list.loading || !list.data?.elements.length} onClick={(event) => { event.currentTarget.closest("details").open = false; setSelected(new Set()); setManaging(true); }}><ListChecks size={16} />批量管理</button></div>
          </details>}
        </div>
        {managing && <div className="wiki-batch-toolbar" role="region" aria-label="批量管理">
          <span>已选 {selected.size} 项</span>
          {stackSimilar && <span className="wiki-muted">已展开堆叠，逐项选择内容</span>}
          <button className="text-button" disabled={busy || list.loading || !list.data?.elements.length} onClick={() => setSelected(new Set(list.data.elements.map((element) => element.id)))}>全选已加载内容</button>
          <button className="text-button" disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>清空选择</button>
          {tab !== "trash" && <><button disabled={busy || list.loading || !selected.size} onClick={() => setMaterial([...selected], true)}>设为资料</button><button disabled={busy || list.loading || !selected.size} onClick={() => setMaterial([...selected], false)}>取消资料标记</button></>}
          <button className="danger-quiet" disabled={busy || list.loading || !selected.size} onClick={() => { if (tab === "trash") { setPurgeConfirmPhrase(""); setPurgeConfirmation({ ids: [...selected] }); } else trashSelected(); }}><Trash2 size={15} />{busy ? "正在处理…" : tab === "trash" ? "永久删除选中项" : "移入回收站"}</button>
          <button className="text-button" disabled={busy} onClick={finishManaging}>退出管理</button>
        </div>}
        {availableTags.error && <p className="wiki-error" role="alert">标签列表读取失败<button onClick={refresh}>重试</button></p>}
        {list.data?.searchNotice && <p className="wiki-muted" role="status">{list.data.searchNotice}</p>}
        {list.error && <p className="wiki-error" role="alert">{list.error}<button onClick={list.retry}>重试</button></p>}
        {list.loading && !list.data && <div className="wiki-list-loading" role="status"><p className="wiki-muted"><span className="spinner" aria-hidden="true" />正在读取内容…</p>
          <div className="wiki-skeleton-grid" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <span key={index} className="skeleton" />)}</div></div>}
        {list.data?.elements.length === 0 && !list.data?.possible?.length && <EmptyState className="wiki-empty" icon={tab === "trash" ? Trash2 : Network}
          title={q || tags.length ? "没有找到相关内容" : tab === "trash" ? "回收站是空的" : readOnly ? "暂无共享内容" : "还没有内容"}
          actions={q || tags.length ? <button onClick={() => { setQ(""); setTags([]); }}>清空筛选</button> : null}>{q || tags.length ? "试试其他关键词或标签，或清空筛选。" : tab === "trash" ? "移入回收站的内容会保留在这里，可以随时恢复。" : readOnly ? "本机保存内容后即可在这里浏览。" : "把图片、视频拖到这里，或者点右上角的「添加内容」。"}</EmptyState>}
        <WindowedWikiGrid key={query.toString()} masonry={view === "masonry"} cardWidth={cardWidth}>{list.data?.elements.map((element, index) => <MediaStackCard key={element.id} element={element} loading={index < 8 ? "eager" : "lazy"} onOpen={open} onShowStack={setMediaStackId} onRestore={(id) => restore([id])} onSelect={managing ? toggleSelected : undefined} selected={selected.has(element.id)} disabled={busy} />)}</WindowedWikiGrid>
        <div className="wiki-load-more" ref={list.sentinel}>
          {list.data && (list.loading ? <span className="wiki-muted" role="status">正在读取更多内容…</span> : list.hasMore ? <button className="text-button" disabled={busy} onClick={list.error ? list.retry : list.loadMore}>{list.error ? "重试加载" : "加载更多"}</button> : list.data.elements.length > 0 ? <span className="wiki-muted" role="status">已显示全部 {list.data.elements.length} {hasCollapsedMembers ? "项" : "条内容"}</span> : null)}
        </div>
        {list.data?.possible?.length > 0 && <section aria-label="可能相关">
          <h2>可能相关 <small>（{list.data.possible.length} 条）</small></h2>
          <p className="wiki-muted">没有找到明确匹配。以下内容由相似度推荐，可能不完全符合搜索条件。</p>
          <WikiGrid masonry={view === "masonry"} cardWidth={cardWidth}>{list.data.possible.map((element, index) => <MediaStackCard key={element.id} element={element} loading={index < 8 ? "eager" : "lazy"} onOpen={open} onShowStack={setMediaStackId} disabled={busy} />)}</WikiGrid>
        </section>}
      </div>
      {stack.length > 0 && <ElementDetail readOnly={readOnly} externalBusy={busy} key={stack.length} id={stack.at(-1).id} relationPage={stack.at(-1).page} externalRevision={resourceRevision}
        prepared={stack.at(-1).prepared?.revision === resourceRevision ? stack.at(-1).prepared : undefined}
        navigation={browsingIndex < 0 ? undefined : {
          previous: browsingIndex > 0 ? () => navigateDetail(browsingElements[browsingIndex - 1].id) : undefined,
          next: browsingIndex + 1 < browsingElements.length ? () => navigateDetail(browsingElements[browsingIndex + 1].id) : undefined,
          loading: atLoadedEnd && list.loading,
          switching: detailNavigation?.loading,
          error: detailNavigation?.error || (atLoadedEnd ? list.error : ""),
          retry: detailNavigation?.error ? () => navigateDetail(detailNavigation.id) : list.retry,
        }}
        contextId={stack.at(-1).contextId || stack.at(-2)?.id}
        markerId={stack.at(-1).markerId}
        videoPosition={stack.at(-1).videoPosition}
        onRelationPage={(value) => setStack((current) => current.map((entry, i) => i === current.length - 1 ? { ...entry, page: value } : entry))}
        restoreScroll={detailScroll} onBusyChange={setDetailBusy} onBack={back} onOpen={open} onChanged={refresh} onAddReference={onAddReference}
        onContentContextMenu={(event, element) => { event.preventDefault(); event.stopPropagation(); setBackMenu({ x: event.clientX, y: event.clientY, element }); }}
        headerActions={askAgent} onTrashed={(element) => { recordDeletion([element]); setStack([]); savedScroll.current = []; }} />}
    </main>
    {mediaStackId && <MediaStackDialog id={mediaStackId} revision={resourceRevision} readOnly={readOnly} onClose={() => setMediaStackId(null)} onOpen={(id) => { setMediaStackId(null); open(id); }} />}
    {backMenu && <WikiContextMenu menu={backMenu} onClose={() => setBackMenu(null)} onSetMaterial={readOnly ? undefined : (element) => setMaterial([element.id], !element.material)} onAddReference={readOnly ? undefined : onAddReference} onEdit={readOnly ? undefined : editText} onBack={back} disabled={busy || detailBusy} onNotice={setPurgeNotice} onError={setError} />}
    {editing && <ElementEditor key={editing.id} element={editing} onBusyChange={setBusy} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); setPurgeNotice("文字已更新"); }} />}
    {!readOnly && <input ref={files} hidden type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov" aria-label="导入图片或视频文件" onChange={(e) => selectFiles(e.target.files)} />}
    {creation && <AddContentDialog value={creation} onChange={setCreation} onChooseFiles={() => files.current.click()}
      onClose={() => setCreation(null)} onBusyChange={setCreationBusy} onSaved={contentSaved} onComplete={completeCreation} />}
    {purgeConfirmation && <ConfirmDialog label="确认永久删除" title={purgeConfirmation.all ? "清空回收站？" : `永久删除选中的 ${purgeConfirmation.ids.length} 项？`}
      busy={busy} busyLabel="正在删除…" confirmDisabled={purgeConfirmPhrase !== "永久删除"}
      confirmLabel={purgeConfirmation.all ? "清空回收站" : `永久删除 ${purgeConfirmation.ids.length} 项`}
      onCancel={() => { setPurgeConfirmation(null); setPurgeConfirmPhrase(""); }} onConfirm={purgeTrash}>
      <p>{purgeConfirmation.all ? "回收站里的所有内容都会被永久删除，包括还没加载、或被当前搜索和标签筛选隐藏的内容。" : "选中的内容会被永久删除。"}原始图片和视频文件、视频标注、对话里的副本和关联也会一起删除，无法恢复。内容库里的其他内容不受影响。</p>
      <label className="wiki-purge-confirm"><span>输入「永久删除」以确认</span><input value={purgeConfirmPhrase} onChange={(e) => setPurgeConfirmPhrase(e.target.value)} autoFocus disabled={busy} placeholder="永久删除" autoComplete="off" spellCheck={false} /></label>
    </ConfirmDialog>}
    {dragging && <div className="wiki-drop-overlay"><Upload size={42} /><h2>松开后加入待保存内容</h2></div>}
  </div>;
}
