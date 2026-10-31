import RelationFields from "./RelationFields.jsx";
import { useEffect, useRef, useState } from "react";
import { Search, X, Link2, FileText, Video, Check, Tag, ZoomIn } from "lucide-react";
import { DialogFrame } from "./ui/ConfirmDialog.jsx";
import { apiUrl, request } from "./api.js";
import useWikiResource from "./useWikiResource.js";
import WikiPaging from "./WikiPaging.jsx";
import TagInput, { readTagInput } from "./TagInput.jsx";
import { maxElementBody, elementLabel } from "../../shared/domain/elements.js";
import VideoPlayer from "./VideoPlayer.jsx";
import Select from "./Select.jsx";
import { Button } from "./ui/Button.jsx";

export default function RelationPicker({ sourceId, targetId, onClose, onChanged }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [filterTag, setFilterTag] = useState("");
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState("existing");
  const [semantics, setSemantics] = useState({ name: "", direction: "symmetric", reverseName: "" });
  const { name } = semantics;
  const [body, setBody] = useState("");
  const [tags, setTags] = useState({ tags: [], draft: "" });
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState([]);
  const [showSelected, setShowSelected] = useState(false);
  const [preview, setPreview] = useState(null);
  const [selectedTags, setSelectedTags] = useState([]);
  const [tagSearch, setTagSearch] = useState("");
  const resultsContainer = useRef(null);
  const choosing = !targetId && mode === "existing";
  const tagResults = useWikiResource(!targetId && mode !== "new" ? "/api/tags" : null, retry);
  const tagQuery = tagSearch.trim().toLowerCase();
  const matchingTags = tagResults.data?.tags.filter((tag) => tag.toLowerCase().includes(tagQuery) || tagResults.data.aliases?.some((a) => a.name === tag && a.alias.toLowerCase().includes(tagQuery))) || [];
  const results = useWikiResource(choosing && !showSelected ? `/api/elements?${new URLSearchParams({ q, kind, tag: filterTag, page, pageSize: 36, scope: "active" })}` : null, retry);
  const selectedIds = selected.map((element) => element.id);
  const candidates = results.data?.elements.filter((element) => element.id !== sourceId) || [];
  const visible = showSelected ? selected : candidates;
  const allImages = selected.length > 0 && selected.every((element) => element.kind === "image");
  useEffect(() => { resultsContainer.current?.scrollTo(0, 0); }, [q, kind, filterTag, page, showSelected, mode]);

  function toggleTag(value) {
    setSelectedTags((current) => current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]);
  }

  function toggleElement(element) {
    setError("");
    setSelected((current) => current.some((entry) => entry.id === element.id)
      ? current.filter((entry) => entry.id !== element.id)
      : current.length < 100 ? [...current, element] : current);
  }

  function selectPage() {
    const additions = candidates.filter((element) => !selectedIds.includes(element.id));
    if (selected.length + additions.length > 100) {
      setError(`最多选择 100 项，还能选择 ${100 - selected.length} 项，请逐项勾选。`);
      return;
    }
    setError("");
    setSelected((current) => [...current, ...additions]);
  }

  async function connectSelected() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await request("/api/relations/batch", { method: "POST", body: JSON.stringify({ sourceId, ...semantics,
        ...(mode === "tags" ? { targetTags: selectedTags } : { targetIds: selectedIds }) }) });
      onChanged(); onClose();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function connect(id) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      let target = id || targetId;
      if (!target) {
        const element = saved || await request("/api/elements", { method: "POST", body: JSON.stringify({ body, tags: readTagInput(tags) }) });
        target = element.id; setSaved(element); onChanged();
      }
      await request("/api/relations", { method: "POST", body: JSON.stringify({ sourceId, targetId: target, ...semantics }) });
      onChanged(); onClose();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <><DialogFrame bare label="添加关联" className={`wiki-dialog wiki-relation-dialog ${choosing ? "is-choosing" : ""}`} onClose={() => !busy && onClose()} title="添加关联" description={choosing ? "勾选需要关联的内容，选好后一次保存。" : undefined} closeLabel="关闭关联选择" busy={busy} footer={<><span className="wiki-muted" role="status">{choosing ? `已选 ${selected.length} ${allImages ? "张图片" : "项内容"}` : mode === "tags" ? `已选 ${selectedTags.length} 个标签` : "文字独立保存，关系连接双方"}</span>{targetId ? <Button variant="primary" type="submit" disabled={busy} onClick={() => connect(targetId)}>{busy ? "正在关联…" : "保存关联"}</Button> : mode === "tags" || choosing ? <Button variant="primary" type="submit" disabled={busy || !(mode === "tags" ? selectedTags.length : selected.length)} onClick={connectSelected}>{busy ? "正在关联…" : mode === "tags" ? "保存关联" : `关联这 ${selected.length} ${allImages ? "张图片" : "项内容"}`}</Button> : mode === "new" && <Button variant="primary" type="submit" form="wiki-new-related" disabled={busy || (!saved && !body.trim())}><Link2 size={16} />{busy ? "正在关联…" : saved ? "重试关联" : "保存并关联"}</Button>}</>}>
    <div className="wiki-relation-controls">
      {!targetId && <div className="wiki-segment ui-segmented" role="group" aria-label="关联方式"><button aria-pressed={mode === "existing"} disabled={busy} onClick={() => setMode("existing")}>选择已有内容</button><button aria-pressed={mode === "tags"} disabled={busy} onClick={() => setMode("tags")}>按标签关联</button><button aria-pressed={mode === "new"} disabled={busy} onClick={() => setMode("new")}>新建文字</button></div>}
      <RelationFields value={semantics} onChange={setSemantics} disabled={busy} targetLabel={mode === "tags" ? "所选标签下的内容" : "所选内容"} />
      {choosing && <>
        <div className="wiki-relation-filters">
          <label className="wiki-search"><Search size={17} /><input aria-label="搜索可关联内容" placeholder="搜索文字或文件名" value={q} disabled={busy || showSelected} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></label>
          <Select aria-label="筛选关联内容类型" value={kind} disabled={busy || showSelected} onChange={(next) => { setKind(next); setPage(1); }} options={[{ value: "", label: "全部类型" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "text", label: "文字" }, { value: "session", label: "会话" }]} />
          <Select aria-label="筛选关联内容标签" value={filterTag} disabled={busy || showSelected} onChange={(next) => { setFilterTag(next); setPage(1); }} options={[{ value: "", label: "全部标签" }, ...Array.from(new Set([...(tagResults.data?.tags || []), ...(filterTag ? [filterTag] : [])])).map((tag) => ({ value: tag, label: tag }))]} />
        </div>
        <div className="wiki-relation-tools">
          <span className="wiki-muted">{showSelected ? "展示全部已选内容，不受筛选影响" : "可跨页选择，最多 100 项"}</span>
          {!showSelected && <button className="text-button" disabled={busy || results.loading || !candidates.some((element) => !selectedIds.includes(element.id))} onClick={selectPage}>全选当前页</button>}
          <button className="text-button" aria-pressed={showSelected} disabled={busy} onClick={() => setShowSelected(!showSelected)}>{showSelected ? "返回全部" : "只看已选"}</button>
        </div>
      </>}
    </div>
    <div className="wiki-form-fields wiki-relation-body" ref={resultsContainer}>
      {targetId ? <p className="wiki-muted">填写这两份内容之间的关系名称，然后保存。</p> : choosing ? <>
        {!showSelected && results.loading && <p className="wiki-muted" role="status">正在查找…</p>}
        {!showSelected && results.error && <p className="wiki-error" role="alert">{results.error}<button onClick={() => setRetry((n) => n + 1)}>重试</button></p>}
        {tagResults.error && <p className="wiki-error" role="alert">标签列表读取失败<button onClick={() => setRetry((n) => n + 1)}>重试</button></p>}
        <div className="wiki-relation-grid">
          {visible.map((element) => <article key={element.id} className="wiki-relation-card">
            <button className="wiki-relation-pick" disabled={busy || (selected.length >= 100 && !selectedIds.includes(element.id))} aria-pressed={selectedIds.includes(element.id)} onClick={() => toggleElement(element)} aria-label={`选择：${elementLabel(element)}`}>
              {element.kind === "image" ? <span className="wiki-relation-image"><img src={apiUrl(element.image.url)} alt="" loading="lazy" /></span> : <span className="wiki-relation-text">{element.kind === "video" ? <Video size={20} /> : <FileText size={20} />}<span>{element.body || elementLabel(element)}</span></span>}
              <span className="wiki-relation-check" aria-hidden="true">{selectedIds.includes(element.id) && <Check size={14} />}</span>
              <span className="wiki-relation-caption" title={elementLabel(element)}>{elementLabel(element)}</span>
            </button>
            {["image", "video"].includes(element.kind) && <button className="icon-only wiki-relation-zoom" aria-label={`放大预览：${elementLabel(element)}`} title="放大预览" disabled={busy} onClick={() => setPreview(element)}><ZoomIn size={17} /></button>}
          </article>)}
        </div>
        {!visible.length && (showSelected || results.data) && <p className="wiki-empty-inline">{showSelected ? "还没有选中内容，返回全部后勾选。" : "没有匹配的内容，试试其他关键词、类型或标签。"}</p>}
        {!showSelected && <WikiPaging pagination={results.data?.pagination} onPage={setPage} disabled={busy} />}
      </> : mode === "tags" ? <>
        <p className="wiki-muted">关系应用于所选标签下的全部内容。之后加入该标签的内容也会自动带上此关联（不含自己）。</p>
        <label className="wiki-search"><Search size={17} /><input aria-label="搜索可关联标签" placeholder="搜索标签" value={tagSearch} disabled={busy} onChange={(e) => setTagSearch(e.target.value)} /></label>
        {tagResults.loading && <p role="status" className="wiki-muted">正在读取标签…</p>}
        {tagResults.error && <p role="alert" className="wiki-error">{tagResults.error}<button onClick={() => setRetry((n) => n + 1)}>重试</button></p>}
        <div className="wiki-pick-list">{matchingTags.map((tag) => <button key={tag} aria-label={`选择标签：${tag}`} aria-pressed={selectedTags.includes(tag)} disabled={busy || (selectedTags.length >= 30 && !selectedTags.includes(tag))} onClick={() => toggleTag(tag)}><Tag size={18} /><span>{tag}</span>{selectedTags.includes(tag) && <Check size={16} />}</button>)}</div>
        {tagResults.data && !matchingTags.length && <p className="wiki-muted">没有匹配的 tag，请先给内容添加标签。</p>}
      </> : <form id="wiki-new-related" onSubmit={(e) => { e.preventDefault(); connect(); }}>
        <label>文字<textarea rows={6} value={body} maxLength={maxElementBody} disabled={busy || Boolean(saved)} onChange={(e) => setBody(e.target.value)} placeholder="保存提示词，或者记录一点想法" /></label>
        <TagInput value={tags} onChange={setTags} disabled={busy || Boolean(saved)} />
        {saved && <p className="wiki-muted">文字已保存。若关联失败，可直接重试，不会重复创建。</p>}
      </form>}
    </div>
    {choosing && selected.length > 0 && <section className="wiki-relation-selection" aria-label="已选关联内容">
      <div className="wiki-relation-selection-heading"><strong>已选 {selected.length} 项</strong><button className="text-button" disabled={busy} onClick={() => { setSelected([]); setError(""); }}>清空选择</button></div>
      <div className="wiki-relation-selected-strip">{selected.map((element) => <button key={element.id} disabled={busy} aria-label={`移除已选：${elementLabel(element)}`} title={`移除：${elementLabel(element)}`} onClick={() => toggleElement(element)}>
        {element.kind === "image" ? <img src={apiUrl(element.image.url)} alt="" loading="lazy" /> : <span>{elementLabel(element)}</span>}<X size={12} aria-hidden="true" />
      </button>)}</div>
    </section>}
    {error && <p className="wiki-error wiki-relation-error" role="alert">{error}</p>}
  </DialogFrame>{preview && <RelationMediaPreview key={preview.id} element={preview} selected={selectedIds.includes(preview.id)} disabled={busy || (selected.length >= 100 && !selectedIds.includes(preview.id))} onToggle={() => toggleElement(preview)} onClose={() => setPreview(null)} />}</>;
}

function RelationMediaPreview({ element, selected, disabled, onToggle, onClose }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const label = element.kind === "video" ? "视频预览" : "图片预览";
  return <DialogFrame bare label={label} className="wiki-dialog wiki-relation-preview" onClose={onClose} title={<>{label}</>} closeLabel={`关闭${label}`} footer={<><span>{elementLabel(element)}</span><button disabled={disabled} aria-pressed={selected} onClick={onToggle}>{selected ? <Check size={16} /> : <Link2 size={16} />}{selected ? "取消选择" : element.kind === "video" ? "选择这个视频" : "选择这张图片"}</button></>}>
    <div className="wiki-relation-preview-image">{element.kind === "video" ? <VideoPlayer element={element} /> : <img src={apiUrl(`${element.image.url}?attempt=${attempt}`)} alt={elementLabel(element)} onError={() => setFailed(true)} />}{failed && <p className="wiki-error" role="alert">图片无法加载<button onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>重新加载图片</button></p>}</div>
  </DialogFrame>;
}
