import { useEffect, useRef, useState } from "react";
import { Check, Clock, Search, X } from "lucide-react";
import Dialog from "../../Dialog.jsx";
import TagInput, { readTagInput } from "../../TagInput.jsx";
import WikiPaging from "../../WikiPaging.jsx";
import useWikiResource from "../../useWikiResource.js";
import { request } from "../../api.js";
import { randomUUID } from "../../browserCrypto.js";
import { elementLabel } from "../../../../shared/domain/elements.js";
import { formatMarkerTime, maxMarkerBody, parseMarkerTime, videoMarkerInput } from "../../../../shared/domain/videoMarkers.js";

export default function VideoMarkerEditor({ videoId, marker, playerRef, onClose, onSaved, onBusyChange }) {
  const [start, setStart] = useState(formatMarkerTime(marker.startMs));
  const [end, setEnd] = useState(marker.endMs == null ? "" : formatMarkerTime(marker.endMs));
  const [body, setBody] = useState(marker.body || "");
  const [tags, setTags] = useState({ tags: marker.tags || [], draft: "" });
  const [links, setLinks] = useState(marker.links || []);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const requestKey = useRef(randomUUID());
  const locked = useRef(false);
  const snapshot = JSON.stringify({ start, end, body, tags, links: links.map((link) => link.id) });
  const initial = useRef(snapshot);
  const dirty = !marker.id || snapshot !== initial.current;
  const results = useWikiResource(choosing ? `/api/elements?${new URLSearchParams({ q, page, pageSize: 12 })}` : null, 0, 0, 200);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  function close() { if (locked.current) return; if (dirty) setDiscard(true); else onClose(); }
  function capture(setValue) { setValue(formatMarkerTime(Math.round((playerRef.current?.currentTime || 0) * 1000))); }
  async function save(event) {
    event.preventDefault(); if (locked.current) return;
    setError("");
    let payload;
    try {
      payload = videoMarkerInput({ startMs: parseMarkerTime(start), endMs: end.trim() ? parseMarkerTime(end) : null, body,
        tags: readTagInput(tags, marker.tags || []), targetIds: links.map((link) => link.id), ...(marker.id ? { revision: marker.revision } : { requestKey: requestKey.current }) }, { update: Boolean(marker.id), existingTags: marker.tags || [] });
      const duration = playerRef.current?.duration;
      if (Number.isFinite(duration) && (payload.startMs >= duration * 1000 || payload.endMs > Math.round(duration * 1000))) throw new Error("标注时间超出视频时长，请调整开始或结束时间");
    } catch (failure) { setError(failure.message); return; }
    locked.current = true; setBusy(true);
    try {
      const saved = await request(marker.id ? `/api/video-markers/${marker.id}` : `/api/elements/${videoId}/markers`, { method: marker.id ? "PUT" : "POST", body: JSON.stringify(payload) });
      onSaved(saved);
    } catch (failure) { setError(failure.message); }
    finally { locked.current = false; setBusy(false); }
  }
  return <><Dialog open label={marker.id ? "编辑视频标注" : "新增视频标注"} className="wiki-dialog wiki-marker-editor" onClose={close}>
    <form onSubmit={save}>
      <header className="wiki-dialog-header"><h2>{marker.id ? "编辑视频标注" : "新增视频标注"}</h2><button type="button" className="icon-only" aria-label="关闭视频标注" onClick={close} disabled={busy}><X size={18} /></button></header>
      <div className="wiki-form-fields">
        <div className="wiki-marker-times">
          <label>开始时间<input aria-label="标注开始时间" value={start} disabled={busy} onChange={(event) => setStart(event.target.value)} placeholder="02:15.5" /><button type="button" className="text-button" disabled={busy} onClick={() => capture(setStart)}><Clock size={14} />使用当前播放时间</button></label>
          <label>结束时间（可选）<input aria-label="标注结束时间" value={end} disabled={busy} onChange={(event) => setEnd(event.target.value)} placeholder="留空标记一个时间点" /><button type="button" className="text-button" disabled={busy} onClick={() => capture(setEnd)}><Clock size={14} />使用当前播放时间</button></label>
        </div>
        <p className="wiki-muted">支持 秒、分:秒、时:分:秒。填写结束时间后，播放到片段末尾自动暂停。</p>
        <label>说明<textarea aria-label="标注说明" rows={3} maxLength={maxMarkerBody} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} placeholder="记录这一刻，或说明这段内容值得参考的地方" /></label>
        <TagInput label="片段标签" value={tags} onChange={setTags} disabled={busy} existingTags={marker.tags || []} />
        <div className="wiki-marker-links"><strong>关联内容 · {links.length} / 12</strong>{links.map((link) => <div key={link.id}><span>{link.label}{link.unavailable && "（已移入回收站）"}</span><button type="button" className="icon-only" disabled={busy} aria-label={`移除片段关联：${link.label}`} onClick={() => setLinks((current) => current.filter((item) => item.id !== link.id))}><X size={14} /></button></div>)}</div>
        <button type="button" className="text-button" disabled={busy} onClick={() => setChoosing(!choosing)}>{choosing ? "收起内容选择" : "选择关联内容"}</button>
        {choosing && <section className="wiki-marker-picker" aria-label="片段关联选择">
          <label className="wiki-search"><Search size={16} /><input aria-label="搜索片段关联内容" value={q} disabled={busy} onChange={(event) => { setQ(event.target.value); setPage(1); }} placeholder="搜索文字、文件名或标签" /></label>
          {results.loading && <p role="status">正在读取内容…</p>}
          {results.error && <p role="alert" className="wiki-error">{results.error}</p>}
          <div className="wiki-pick-list">{results.data?.elements.filter((element) => element.id !== videoId).map((element) => {
            const chosen = links.some((link) => link.id === element.id), label = elementLabel(element);
            return <button type="button" key={element.id} disabled={busy || !chosen && links.length >= 12} aria-label={`关联片段到：${label}`} aria-pressed={chosen} onClick={() => setLinks((current) => chosen ? current.filter((link) => link.id !== element.id) : [...current, { id: element.id, label }])}><span>{label}</span>{chosen && <Check size={15} />}</button>;
          })}</div>
          <WikiPaging pagination={results.data?.pagination} onPage={setPage} disabled={busy || results.loading} />
        </section>}
        {error && <p className="wiki-error" role="alert">{error}</p>}
      </div>
      <footer className="wiki-dialog-footer"><button type="button" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy}>{busy ? "正在保存…" : "保存标注"}</button></footer>
    </form>
  </Dialog>{discard && <Dialog open label="放弃标注修改？" className="wiki-dialog" onClose={() => setDiscard(false)}>
    <header className="wiki-dialog-header"><h2>放弃标注修改？</h2></header><p>未保存的时间、说明、标签和关联会被丢弃。</p>
    <footer className="wiki-dialog-footer"><button autoFocus onClick={() => setDiscard(false)}>继续编辑</button><button className="danger-quiet" onClick={onClose}>放弃修改</button></footer>
  </Dialog>}</>;
}
