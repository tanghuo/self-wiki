import { useEffect, useRef, useState } from "react";
import { ScanEye } from "lucide-react";
import { request } from "../../api.js";
import { Button } from "../../ui/Button.jsx";

export default function VideoAnalysisSettings({ onBusyChange, onDirtyChange, onChanged, registerSave }) {
  const [status, setStatus] = useState(null), [config, setConfig] = useState(null), [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const locked = useRef(false), mounted = useRef(false);
  const dirty = Boolean(config && saved && JSON.stringify(config) !== JSON.stringify(saved));
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    request("/api/video-analysis/status", { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) { setStatus(next); setConfig(next.config); setSaved(next.config); }
    }, (failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => { mounted.current = false; controller.abort(); };
  }, []);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { registerSave?.(dirty ? { save: () => mutate("/api/video-analysis/config", config, "PUT"), discard: () => setConfig(saved) } : null); });
  useEffect(() => () => registerSave?.(null), [registerSave]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function mutate(path, body, method = "POST") {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!mounted.current) return;
      if (method === "PUT") { setConfig(result.config || result); setSaved(result.config || result); onChanged?.(); }
      const next = await request("/api/video-analysis/status");
      if (!mounted.current) return;
      setStatus(next);
      setMessage(method === "PUT" ? "视频与画面检索配置已保存。" : path.endsWith("/rebuild") ? "视觉索引任务已提交，后台会继续处理。" : path.endsWith("/status") ? "视觉索引状态已刷新。" : result.diagnostic || "依赖检测完成，请查看下方状态。");
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  function field(key, value) { setConfig((current) => ({ ...current, [key]: value })); }
  function visualField(key, value) { setConfig((current) => ({ ...current, visual: { ...current.visual, [key]: value } })); }
  return <section className="settings-section wiki-video-analysis-settings" aria-label="视频与画面检索设置">
    <header className="settings-section-header"><ScanEye size={19} /><h3>视频与画面检索</h3></header>
    {!config && !error && <p role="status">正在读取视频配置…</p>}
    {config && <form onSubmit={(event) => { event.preventDefault(); void mutate("/api/video-analysis/config", config, "PUT"); }}>
      <div className="wiki-form-fields">
        <fieldset className="settings-group"><legend>自动画面标注</legend>
          <label><input type="checkbox" checked={config.enabled} disabled={busy} onChange={(event) => field("enabled", event.target.checked)} />自动分析未处理的视频（含已有视频）</label>
          <label>标注模式<select aria-label="视频标注模式" value={config.applyMode} disabled={busy} onChange={(event) => field("applyMode", event.target.value)}><option value="suggest">先生成建议</option><option value="auto">自动应用，可事后纠正</option></select></label>
                    <div className="wiki-video-settings-grid"><label>FFmpeg 程序路径<input aria-label="FFmpeg 程序路径" required value={config.ffmpeg} disabled={busy} onChange={(event) => field("ffmpeg", event.target.value)} /></label><label>ffprobe 程序路径<input aria-label="ffprobe 程序路径" required value={config.ffprobe} disabled={busy} onChange={(event) => field("ffprobe", event.target.value)} /></label></div>
                    <details><summary>采样与任务预算</summary><div className="wiki-video-settings-grid">
            <label>补帧间隔（毫秒）<input type="number" required min="250" max="10000" step="1" value={config.frameIntervalMs} disabled={busy} onChange={(event) => field("frameIntervalMs", Number(event.target.value))} /></label>
            <label>每次最多抽取帧数<input type="number" required min="8" max="1000" step="1" value={config.maxFrames} disabled={busy} onChange={(event) => field("maxFrames", Number(event.target.value))} /></label>
            <label>每次最多分析批次<input type="number" required min="1" max="200" step="1" value={config.maxBatches} disabled={busy} onChange={(event) => field("maxBatches", Number(event.target.value))} /></label>
            <label>任务超时（毫秒）<input type="number" required min="1000" max="600000" step="1000" value={config.timeoutMs} disabled={busy} onChange={(event) => field("timeoutMs", Number(event.target.value))} /></label>
          </div><p className="wiki-muted">达到预算会显示“部分分析”，可在视频详情继续处理。抽样可能遗漏短暂事件，时间范围为近似定位。</p></details>
        </fieldset>
        <fieldset className="settings-group"><legend>视觉相似检索</legend>
          <label><input type="checkbox" checked={config.visual.enabled} disabled={busy} onChange={(event) => visualField("enabled", event.target.checked)} />启用图片与视频帧视觉索引</label>
                    <label>视觉服务地址<input aria-label="视觉服务地址" type="url" required value={config.visual.baseUrl} disabled={busy} onChange={(event) => visualField("baseUrl", event.target.value)} /></label>
          <label>视觉模型<input aria-label="视觉模型" required value={config.visual.model} disabled={busy} onChange={(event) => visualField("model", event.target.value)} /></label>
          <div className="wiki-video-settings-grid"><label>模型修订<input aria-label="视觉模型修订" required value={config.visual.revision} disabled={busy} onChange={(event) => visualField("revision", event.target.value)} /></label><label>视觉请求超时（毫秒）<input type="number" required min="1000" max="1800000" step="1000" value={config.visual.timeoutMs} disabled={busy} onChange={(event) => visualField("timeoutMs", Number(event.target.value))} /></label></div>
                  </fieldset>
        <div className="wiki-actions">{!registerSave && <Button variant="primary" type="submit" disabled={busy || !dirty}>保存视频配置</Button>}<button type="button" disabled={busy || dirty} title={dirty ? "先保存改动，再检测依赖" : undefined} onClick={() => mutate("/api/video-analysis/probe")}>检测视频依赖</button><button type="button" disabled={busy || dirty || !saved?.visual.enabled} title={dirty ? "先保存改动，再更新索引" : !saved?.visual.enabled ? "先开启画面检索并保存" : undefined} onClick={() => mutate("/api/visual-index/rebuild", { mode: "missing" })}>建立 / 更新视觉索引</button></div>
        {dirty && <p className="wiki-muted">改完后先点底部「保存」，再检测依赖或更新索引。</p>}
      </div>
    </form>}
    {status?.diagnostic && <p className="wiki-muted">{status.diagnostic}</p>}
    {status?.visual && <div className="wiki-analysis-progress"><strong>视觉索引 · {status.visual.ready ? "服务就绪" : "服务未就绪"}</strong>{status.visual.diagnostic && <p className="wiki-muted">{status.visual.diagnostic}</p>}{Number.isFinite(status.visual.indexed) && <span>已索引 {status.visual.indexed} 项{Number.isFinite(status.visual.pending) && ` · 待处理 ${status.visual.pending} 项`}</span>}<button className="text-button" disabled={busy} onClick={() => mutate("/api/visual-index/status", undefined, "GET")}>刷新索引状态</button></div>}
    {error && <p className="wiki-error" role="alert">{error}</p>}
    {message && <p className="wiki-feedback" role="status">{message}</p>}
  </section>;
}
