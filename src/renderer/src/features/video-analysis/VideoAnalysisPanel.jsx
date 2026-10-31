import { useEffect, useRef, useState } from "react";
import { Check, Play, RefreshCw, ScanEye, Square, WandSparkles, X } from "lucide-react";
import { apiUrl, request } from "../../api.js";
import { formatMarkerTime, markerTimeLabel } from "../../../../shared/domain/videoMarkers.js";
import { openSettings } from "../../openSettings.js";
import { Button } from "../../ui/Button.jsx";

const states = { pending: "等待分析", queued: "等待分析", extracting: "正在抽取画面", running: "正在分析", analyzing: "正在分析", indexing: "正在建立索引", ready: "分析完成", succeeded: "分析完成", completed: "分析完成", partial: "部分分析", failed: "分析失败", cancelled: "已取消" };
const activeStates = new Set(["pending", "queued", "extracting", "running", "analyzing", "indexing"]);
const resultStates = { suggested: "AI 建议", applied: "AI 已应用", rejected: "已拒绝", modified: "人工已接管" };

export default function VideoAnalysisPanel({ videoId, revision, onChanged, onSeek, onFindSimilar, onBusyChange, disabled = false, readOnly = false }) {
  const [status, setStatus] = useState(null), [error, setError] = useState(""), [loadError, setLoadError] = useState(""), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [limit, setLimit] = useState(12), [showRejected, setShowRejected] = useState(false);
  const mounted = useRef(false), sequence = useRef(0), locked = useRef(false), signature = useRef(null), changed = useRef(onChanged);
  changed.current = onChanged;
  async function load() {
    const current = ++sequence.current;
    try {
      const next = await request(`/api/video-analysis/status?videoId=${encodeURIComponent(videoId)}`);
      if (!mounted.current || current !== sequence.current) return;
      const nextSignature = JSON.stringify((next.results || []).map((result) => [result.id, result.state, result.revision, result.markerId]));
      if (signature.current !== null && nextSignature !== signature.current) changed.current?.();
      signature.current = nextSignature;
      setStatus(next); setLoadError("");
    } catch (failure) { if (mounted.current && current === sequence.current) setLoadError(failure.message); }
  }
  useEffect(() => {
    mounted.current = true; void load();
    const timer = setInterval(load, 2500);
    return () => { mounted.current = false; sequence.current++; clearInterval(timer); };
  }, [videoId, revision]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  async function mutate(path, body, feedback) {
    if (locked.current || disabled || readOnly) return;
    locked.current = true; setBusy(true); setError(""); setMessage("");
    sequence.current++;
    try {
      const response = await request(path, { method: "POST", body: JSON.stringify(body) });
      if (!mounted.current) return;
      setMessage(response.applied === false ? { "manual-overlap": "已有同类人工标注，已保留人工版本，本条建议未重复应用。", "marker-limit": "时间标注已达上限，建议已保留；可整理现有标注后重试。" }[response.reason] || "本条建议尚未应用，请查看当前标注。" : feedback);
      await load(); changed.current?.();
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { locked.current = false; setBusy(false); }
  }
  const run = status?.run, active = activeStates.has(run?.state), config = status?.config;
  const blocked = busy || disabled, results = (status?.results || []).filter((result) => showRejected || result.state !== "rejected");
  const coverage = Number.isFinite(run?.coverageMs) && Number.isFinite(run?.durationMs) && run.durationMs > 0;
  const needsSetup = Boolean(status && config && !config.enabled && !run && !(status.results || []).length);
  if (needsSetup) {
    return <section className="wiki-video-analysis" aria-label="视频自动标注">
      <header><h2><WandSparkles size={18} />自动画面标注</h2></header>
      <div className="wiki-video-setup" role="status">
        <p>尚未启用自动标注。可先在设置中配置 FFmpeg，或直接手动分析当前视频。</p>
        {!readOnly && <>
          <button type="button" disabled={disabled || blocked || !status} onClick={() => openSettings("video")}>去设置 · 视频与画面检索</button>
          <button type="button" className="text-button" disabled={blocked || !status} onClick={() => mutate(`/api/elements/${videoId}/video-analysis`, { restart: false }, "分析请求已提交，进度会自动更新。")}><WandSparkles size={14} />手动分析此视频</button>
        </>}
      </div>
    </section>;
  }
  return <section className="wiki-video-analysis" aria-label="视频自动标注">
    <header><h2><WandSparkles size={18} />自动画面标注</h2>{!readOnly && <div className="wiki-actions">
      {active ? <button disabled={blocked} onClick={() => mutate(`/api/elements/${videoId}/video-analysis/cancel`, {}, "已请求取消分析，已完成结果保留。") }><Square size={14} />取消分析</button>
        : <><Button variant="primary" type="submit" disabled={blocked || !status} onClick={() => mutate(`/api/elements/${videoId}/video-analysis`, { restart: false }, "分析请求已提交，进度会自动更新。") }><WandSparkles size={15} />{run && ["partial", "failed", "cancelled"].includes(run.state) ? "继续分析" : "分析视频"}</Button>
          {run && <button disabled={blocked} onClick={() => mutate(`/api/elements/${videoId}/video-analysis`, { restart: true }, "重新分析已提交，人工修改会保留。") }><RefreshCw size={14} />重新分析</button>}</>}
    </div>}</header>
    <p className="wiki-muted">按抽样画面生成标签和时间证据。区间为近似定位；可在下方编辑已应用标注。</p>
    {config && <p className="wiki-muted">{config.applyMode === "auto" ? "自动应用：生成后自动加入时间标注。" : "建议模式：生成后可手动应用为时间标注。"}</p>}
    {!status && !loadError && <p className="wiki-muted" role="status">正在读取分析状态…</p>}
    {status?.diagnostic && <p className="wiki-muted">{status.diagnostic}</p>}
    {run && <div className="wiki-analysis-progress" role="status"><strong>{states[run.state] || run.state}</strong>
      {Number.isFinite(run.totalBatches) && run.totalBatches > 0 && <><progress aria-label="视频分析批次进度" max={run.totalBatches} value={run.completedBatches || 0} /><span>{run.completedBatches || 0} / {run.totalBatches} 批次</span></>}
      {coverage && <span>已覆盖 {formatMarkerTime(run.coverageMs)} / {formatMarkerTime(run.durationMs)}</span>}
      {run.state === "partial" && <p>本次预算已用完，尚未覆盖全片。继续分析可处理剩余内容。</p>}
      {run.error && <p className="wiki-error">{run.error}</p>}
    </div>}
    {(error || loadError) && <p className="wiki-error" role="alert">{error || loadError}<button className="text-button" disabled={blocked} onClick={load}>刷新状态</button></p>}
    {message && <p className="wiki-feedback" role="status">{message}</p>}
    {(status?.results || []).some((result) => result.state === "rejected") && <label className="wiki-analysis-toggle"><input type="checkbox" checked={showRejected} onChange={(event) => setShowRejected(event.target.checked)} />显示已拒绝结果</label>}
    {results.slice(0, limit).map((result) => <article className="wiki-analysis-result" key={result.id} data-result-id={result.id}>
      <div className="wiki-marker-heading"><button className="text-button" disabled={disabled} aria-label={`播放 AI 片段：${markerTimeLabel({ ...result, endMs: result.endMs ?? null })}`} onClick={() => onSeek({ startMs: result.startMs, endMs: result.endMs ?? null })}><Play size={14} />约 {markerTimeLabel({ ...result, endMs: result.endMs ?? null })}</button><span className="ai-source">{resultStates[result.state] || result.state}</span></div>
      {result.state === "rejected" ? <p className="wiki-muted">这条结果已拒绝，不再参与当前标签和说明检索。</p> : result.state !== "modified" && <>
        {result.body && <p className="wiki-marker-body">{result.body}</p>}
        <div className="wiki-tags">{(result.tags || []).map((tag) => <span className="wiki-tag" key={tag}>{tag}</span>)}</div>
      </>}
      {result.frameIds?.length > 0 && <details className="wiki-analysis-evidence"><summary>查看画面证据 · {result.frameIds.length} 张</summary><div>{result.frameIds.map((frameId, index) => <button className="wiki-analysis-frame" key={frameId} disabled={disabled} onClick={() => onFindSimilar?.(frameId)} aria-label={`用第 ${index + 1} 张证据查找相似画面`}><img loading="lazy" src={apiUrl(`/api/video-analysis/frames/${encodeURIComponent(frameId)}`)} alt={`片段证据 ${index + 1}`} /><span><ScanEye size={13} />找相似画面</span></button>)}</div></details>}
      {!readOnly && result.state === "suggested" && <div className="wiki-analysis-result-actions"><button disabled={blocked} onClick={() => mutate(`/api/video-analysis/results/${result.id}/accept`, { revision: result.revision }, "已应用为时间标注，可在下方编辑。") }><Check size={14} />应用标注</button><button className="text-button" disabled={blocked} onClick={() => mutate(`/api/video-analysis/results/${result.id}/reject`, { revision: result.revision }, "已拒绝该结果，后续重跑会保留这一决定。") }><X size={14} />拒绝结果</button></div>}
      {result.state === "modified" && <p className="wiki-muted">已保留人工修改，重新分析不会覆盖。</p>}
    </article>)}
    {results.length > limit && <button className="text-button" onClick={() => setLimit((value) => value + 12)}>显示更多分析结果（剩余 {results.length - limit} 条）</button>}
    {status && !results.length && !active && <p className="wiki-muted">还没有可用的自动标注。分析后会在这里显示时间标签与画面证据。</p>}
  </section>;
}
