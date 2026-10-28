import { useEffect, useRef, useState } from "react";
import { Image, Play, RefreshCw, ScanEye, Search, X } from "lucide-react";
import { apiUrl, request } from "../../api.js";
import useWikiResource from "../../useWikiResource.js";
import { markerTimeLabel } from "../../../../shared/domain/videoMarkers.js";
import { openSettings } from "../../openSettings.js";

export default function VisualMatches({ elementId, frameRequest, revision, onOpen, onClearFrame, disabled = false, readOnly = false }) {
  const [query, setQuery] = useState(""), [submitted, setSubmitted] = useState(""), [retry, setRetry] = useState(0);
  const [rejecting, setRejecting] = useState(null), [error, setError] = useState("");
  const locked = useRef(false);
  const lastFrameRequest = useRef(frameRequest);
  const frameId = frameRequest?.frameId;
  useEffect(() => {
    if (lastFrameRequest.current === frameRequest) return;
    lastFrameRequest.current = frameRequest;
    setQuery(""); setSubmitted(""); setError("");
  }, [frameRequest]);
  const params = new URLSearchParams({ ...(elementId ? { elementId } : {}), ...(submitted ? { q: submitted } : frameId ? { frameId } : {}) });
  const response = useWikiResource(`/api/visual-search?${params}`, `${revision}:${retry}`);
  const matches = response.data?.matches || [];
  async function reject(match) {
    if (locked.current || disabled || readOnly || !elementId) return;
    locked.current = true; setRejecting(match.elementId); setError("");
    try {
      await request("/api/visual-search/rejections", { method: "POST", body: JSON.stringify({ sourceId: elementId, targetId: match.elementId }) });
      setRetry((value) => value + 1);
    } catch (failure) { setError(failure.message); }
    finally { locked.current = false; setRejecting(null); }
  }
  const diagnostic = response.data?.diagnostic || "";
  const visualOff = /视觉索引未启用/.test(diagnostic);
  return <section className="wiki-visual-matches" aria-label="相似画面">
    <header><h2><ScanEye size={18} />相似画面</h2><button className="text-button" aria-label="刷新相似画面" disabled={response.loading || disabled} onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />刷新</button></header>
    {visualOff ? <div className="wiki-video-setup" role="status">
      <p>画面相似需要启用视觉索引；仍可用文字搜索已有片段说明。</p>
      {!readOnly && <button type="button" disabled={disabled} onClick={() => openSettings("video")}>去设置 · 视频与画面检索</button>}
    </div> : <p className="wiki-muted">根据画面寻找图片与视频片段，点击视频结果可跳转到对应时间。</p>}
    {frameId && !submitted && <div className="wiki-visual-source"><img src={apiUrl(`/api/video-analysis/frames/${encodeURIComponent(frameId)}`)} alt="当前查询的证据画面" /><span>以这张画面查找</span><button className="text-button" disabled={disabled} onClick={onClearFrame}><X size={14} />使用整份内容</button></div>}
    <form className="wiki-visual-query" onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()); }}><label className="wiki-search"><Search size={15} /><input aria-label="用文字搜索画面" placeholder="也可以描述要找的画面" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button disabled={disabled}>搜索</button></form>
    {submitted && <button className="text-button" onClick={() => { setQuery(""); setSubmitted(""); }}>返回当前内容的相似画面</button>}
    {response.loading && <p className="wiki-muted" role="status">正在查找相似画面…</p>}
    {(error || response.error) && <p className="wiki-error" role="alert">{error || response.error}</p>}
    {response.data?.diagnostic && <p className="wiki-muted">{response.data.diagnostic}</p>}
    {matches.length > 0 && <div className="wiki-visual-match-list">{matches.map((match, index) => {
      const position = match.kind === "video" && Number.isFinite(match.startMs) ? { startMs: match.startMs, endMs: match.endMs ?? null } : null;
      const time = position ? markerTimeLabel(position) : "";
      return <article className="wiki-visual-match-item" key={`${match.elementId}:${match.frameId || index}`}><button className="wiki-visual-match" disabled={disabled} aria-label={`打开相似内容：${match.label}${time ? ` · ${time}` : ""}`} onClick={() => onOpen(match.elementId, undefined, match.markerId, position)}>
        {match.thumbnailUrl ? <img loading="lazy" src={apiUrl(match.thumbnailUrl)} alt="" /> : <span className="wiki-visual-placeholder">{match.kind === "video" ? <Play size={24} /> : <Image size={24} />}</span>}
        <span><strong>{match.label}</strong><small>{match.kind === "video" ? "视频片段" : "图片"}{time && ` · 约 ${time}`}</small></span>
      </button>{!readOnly && elementId && <button className="text-button" disabled={disabled || rejecting !== null} aria-label={`不再推荐：${match.label}`} onClick={() => reject(match)}>{rejecting === match.elementId ? "正在保存…" : "不再推荐"}</button>}</article>;
    })}</div>}
    {response.data && !matches.length && <p className="wiki-muted">暂无相似结果。</p>}
  </section>;
}
