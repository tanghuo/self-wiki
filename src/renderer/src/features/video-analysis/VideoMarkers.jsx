import { useEffect, useRef, useState } from "react";
import { Clock, Play, Plus, Search } from "lucide-react";
import useWikiResource from "../../useWikiResource.js";
import WikiPaging from "../../WikiPaging.jsx";
import Dialog from "../../Dialog.jsx";
import VideoMarkerEditor from "./VideoMarkerEditor.jsx";
import { request } from "../../api.js";
import { markerTimeLabel } from "../../../../shared/domain/videoMarkers.js";

export default function VideoMarkers({ videoId, playerRef, initialMarkerId, initialPosition, revision, onChanged, onOpen, onBusyChange, disabled, readOnly }) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [seekRequest, setSeekRequest] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const range = useRef(null);
  const locked = useRef(false);
  const initialJump = useRef(null);
  const completedSeek = useRef(null);
  const initialPositionJump = useRef(null);
  const data = useWikiResource(`/api/elements/${videoId}/markers?${new URLSearchParams({ q, tag, page, pageSize: 12 })}`, `${revision}:${retry}`, 0, 150);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (data.data && page > data.data.pagination.pageCount) setPage(data.data.pagination.pageCount);
  }, [data.data, page]);
  useEffect(() => {
    if (!initialMarkerId || initialJump.current === initialMarkerId) return;
    const controller = new AbortController();
    request(`/api/video-markers/${initialMarkerId}`, { signal: controller.signal }).then((marker) => {
      if (controller.signal.aborted) return;
      initialJump.current = initialMarkerId;
      if (marker.videoId !== videoId) { setError("这条标注不属于当前视频"); return; }
      setSeekRequest({ marker });
    }, (failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [initialMarkerId, videoId]);
  useEffect(() => {
    if (!initialPosition || initialPositionJump.current === initialPosition) return;
    initialPositionJump.current = initialPosition;
    const { startMs, endMs = null } = initialPosition;
    if (!Number.isSafeInteger(startMs) || startMs < 0 || endMs !== null && (!Number.isSafeInteger(endMs) || endMs <= startMs)) {
      setError("片段定位时间无效，请刷新结果后重试"); return;
    }
    setSeekRequest({ marker: { startMs, endMs, id: null } });
  }, [initialPosition]);
  useEffect(() => {
    if (!seekRequest || completedSeek.current === seekRequest) return;
    const player = playerRef.current, marker = seekRequest.marker;
    if (!player) return;
    let cancelled = false;
    function seek() {
      completedSeek.current = seekRequest;
      range.current = null;
      if (Number.isFinite(player.duration) && (marker.startMs >= player.duration * 1000 || marker.endMs > Math.round(player.duration * 1000))) {
        setError("标注时间超出视频时长，请编辑标注后重试"); return;
      }
      setError(""); setActiveId(marker.id);
      range.current = marker.endMs === null ? null : marker;
      player.currentTime = marker.startMs / 1000;
      player.scrollIntoView({ block: "nearest" });
      player.play().catch(() => { if (!cancelled) setError("已定位到标注位置，请点击播放器中的播放按钮"); });
    }
    if (player.readyState >= 1) seek(); else player.addEventListener("loadedmetadata", seek, { once: true });
    return () => { cancelled = true; player.removeEventListener("loadedmetadata", seek); range.current = null; };
  }, [seekRequest, playerRef]);
  useEffect(() => {
    const player = playerRef.current;
    function stop() {
      const marker = range.current;
      if (marker && player.currentTime * 1000 >= marker.endMs) {
        range.current = null; player.pause(); player.currentTime = marker.endMs / 1000;
      }
    }
    function seeked() {
      const marker = range.current;
      if (marker && (player.currentTime * 1000 < marker.startMs - 50 || player.currentTime * 1000 > marker.endMs + 250)) range.current = null;
    }
    player?.addEventListener("timeupdate", stop); player?.addEventListener("seeked", seeked);
    return () => { player?.removeEventListener("timeupdate", stop); player?.removeEventListener("seeked", seeked); range.current = null; };
  }, [playerRef]);
  function changed() { range.current = null; setRetry((value) => value + 1); onChanged(); }
  async function remove() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      await request(`/api/video-markers/${deleting.id}`, { method: "DELETE", body: JSON.stringify({ revision: deleting.revision }) });
      if (range.current?.id === deleting.id) range.current = null;
      setDeleting(null); changed();
    } catch (failure) { setError(failure.message); }
    finally { locked.current = false; setBusy(false); }
  }
  return <section className="wiki-video-markers" aria-label="视频标注">
    <header><h2><Clock size={18} />时间点与片段 {data.data && <small>{data.data.pagination.total}</small>}</h2>{!readOnly && <button disabled={disabled || busy} onClick={() => setEditing({ startMs: Math.round((playerRef.current?.currentTime || 0) * 1000), endMs: null })}><Plus size={15} />标记当前时间</button>}</header>
    <div className="wiki-marker-search"><label className="wiki-search"><Search size={15} /><input aria-label="搜索视频标注" value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} placeholder="搜索标注说明或标签" /></label>{tag && <button onClick={() => { setTag(""); setPage(1); }}>#{tag} ×</button>}</div>
    {data.loading && <p className="wiki-muted" role="status">正在读取标注…</p>}
    {data.error && <p className="wiki-error" role="alert">{data.error}<button onClick={() => setRetry((value) => value + 1)}>重试</button></p>}
    {error && !deleting && <p className="wiki-error" role="alert">{error}</p>}
    {data.data?.markers.map((marker) => <article key={marker.id} className={`wiki-video-marker${activeId === marker.id ? " is-active" : ""}`} data-marker-id={marker.id}>
      <div className="wiki-marker-heading"><button className="text-button" aria-label={`播放标注：${markerTimeLabel(marker)}`} onClick={() => setSeekRequest({ marker })}><Play size={15} />{markerTimeLabel(marker)}</button>{!readOnly && <div><button className="text-button" disabled={disabled || busy} onClick={() => setEditing(marker)}>编辑标注</button><button className="text-button danger-quiet" disabled={disabled || busy} onClick={() => { setError(""); setDeleting(marker); }}>删除标注</button></div>}</div>
      {marker.origin === "ai" && <span className="ai-source">AI 标注 · 编辑后由你管理</span>}
      {marker.origin === "corrected" && <span className="ai-source">人工已接管 · 保留 AI 来源</span>}
      {marker.body && <p className="wiki-marker-body">{marker.body}</p>}
      <div className="wiki-tags">{marker.tags.map((name) => <button key={name} className="wiki-tag" onClick={() => { setTag(name); setPage(1); }} aria-label={`筛选片段标签：${name}`}>{name}</button>)}</div>
      {marker.links.length > 0 && <div className="wiki-marker-links" aria-label="片段关联内容">{marker.links.map((link) => <button className="text-button" key={link.id} disabled={disabled || busy || link.unavailable} onClick={() => onOpen(link.id)}>{link.label}{link.unavailable && "（已移入回收站）"}</button>)}</div>}
    </article>)}
    {data.data && !data.data.markers.length && <p className="wiki-muted">{q || tag ? "没有匹配的标注。" : "还没有时间标注。播放到需要的位置，添加标签、说明或关联资料。"}</p>}
    <WikiPaging pagination={data.data?.pagination} onPage={setPage} disabled={busy || data.loading} />
    {editing && <VideoMarkerEditor key={editing.id || "new"} marker={editing} videoId={videoId} playerRef={playerRef} onClose={() => setEditing(null)} onBusyChange={onBusyChange}
      onSaved={() => { setEditing(null); setPage(1); changed(); }} />}
    {deleting && <Dialog open label="删除视频标注？" className="wiki-dialog" onClose={() => !busy && setDeleting(null)}>
      <header className="wiki-dialog-header"><h2>删除视频标注？</h2></header><p>删除 {markerTimeLabel(deleting)} 的标注、片段标签和片段关联。原视频及关联内容会保留。</p>
      {error && <p className="wiki-error" role="alert">{error}</p>}
      <footer className="wiki-dialog-footer"><button autoFocus disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="danger-quiet" disabled={busy} onClick={remove}>确认删除标注</button></footer>
    </Dialog>}
  </section>;
}
