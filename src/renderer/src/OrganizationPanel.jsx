import { useEffect, useRef, useState } from "react";
import { mergeEdits } from "./settingsMerge.js";
import { request } from "./api.js";
import OrganizationHistory from "./OrganizationHistory.jsx";
import SemanticSettings from "./SemanticSettings.jsx";
import ImageGenerationSettings from "./ImageGenerationSettings.jsx";
import ChatEngineSettings from "./ChatEngineSettings.jsx";
import { Button } from "./ui/Button.jsx";

const labels = { queued: "待整理", running: "整理中", succeeded: "整理完成", failed: "整理失败", cancelled: "已取消" };

export default function OrganizationPanel({ elementId, mode = elementId ? "content" : "settings", focus = "all", initialResultId = null, onChanged, onBusyChange, onDirtyChange, onOpen, disabled = false, registerSave }) {
  const settings = mode === "settings";
  const [pages, setPages] = useState([]), [focused, setFocused] = useState(initialResultId);
  const [status, setStatus] = useState(null), [config, setConfig] = useState(null);
  const [savedConfig, setSavedConfig] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const changed = useRef(onChanged), previous = useRef(null), mounted = useRef(true), loadSequence = useRef(0);
  changed.current = onChanged;
  const params = new URLSearchParams();
  if (elementId) params.set("elementId", elementId);
  if (pages.length) params.set("before", pages.at(-1));
  const endpoint = `/api/organization/status?${params}`;
  async function load() {
    const sequence = ++loadSequence.current;
    try {
      const next = await request(endpoint);
      if (!mounted.current) return;
      if (focused) {
        const r = await request(`/api/organization/results/${focused}`);
        next.results = [{ ...r, elementId: r.element_id, createdAt: r.created_at }];
        next.nextBefore = null;
      }
      if (!mounted.current || sequence !== loadSequence.current) return;
      const signature = JSON.stringify(next.results.map((r) => [r.id, r.undone, r.actions.map((a) => [a.state, a.editable, a.correction])]));
      if (previous.current !== null && previous.current !== signature) changed.current?.();
      previous.current = signature;
      setStatus(next); setConfig((current) => current || next.config); setSavedConfig((current) => current || next.config);
    } catch (failure) { if (mounted.current) setError(failure.message); }
  }
  useEffect(() => {
    mounted.current = true; previous.current = null; void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 2500);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; loadSequence.current++; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [endpoint, focused]);
  useEffect(() => {
    if (focused && status?.results[0]?.id === focused) document.getElementById(`organization-result-${focused}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused, status?.results[0]?.id]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const dirty = Boolean(settings && config && savedConfig && JSON.stringify(config) !== JSON.stringify(savedConfig));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  // Settings saves through the dialog's single save bar. Two panels (连接 / 整理) edit the same config,
  // so only the fields edited here are applied on top of the latest saved config.
  async function saveConfig() {
    const latest = (await request("/api/organization/status").catch(() => null))?.config || savedConfig;
    return mutate("config", mergeEdits(latest, savedConfig, config), "PUT");
  }
  useEffect(() => { registerSave?.(dirty ? { save: saveConfig, discard: () => setConfig(savedConfig) } : null); });
  useEffect(() => () => registerSave?.(null), [registerSave]);
  async function mutate(route, body = {}, method = "POST") {
    if (busy || disabled) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (route === "enqueue-texts") {
        let cursor = {}, count = 0;
        do {
          const batch = await request("/api/organization/enqueue-texts", { method: "POST", body: JSON.stringify(cursor) });
          count += batch.count;
          cursor = { after: batch.nextAfter, throughId: batch.throughId };
          setMessage(`已安排 ${count} 条文字检查…`);
        } while (cursor.after !== null);
        await load();
        setMessage(`已安排 ${count} 条文字检查，已有待处理任务会复用。可在整理历史查看结果。`);
        return;
      }
      const result = await request(`/api/organization/${route}`, { method, body: JSON.stringify(body) });
      if (route === "config") { setConfig(result.config); setSavedConfig(result.config); }
      await load();
      if (route === "correct" || route.startsWith("results/")) changed.current?.();
      if (route === "enqueue") { setMessage("整理请求已提交，进度会自动更新。"); return result; }
      setMessage(route === "correct" ? `已修改 ${result.changed} 项` : route.endsWith("/undo") && result.skipped ? `已撤销 ${result.removed} 项，保留 ${result.skipped} 项后续修改` : route.startsWith("semantic/") ? "操作已完成" : "已保存"); return result;
    }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  function executorField(key, value) { setConfig((c) => ({ ...c, executor: { ...c.executor, codexCli: { ...c.executor.codexCli, [key]: key === "executable" ? value : value || null } } })); }
  function grokField(key, value) { setConfig((c) => ({ ...c, executor: { ...c.executor, grokBuild: { ...(c.executor.grokBuild || { executable: "grok", model: "grok-4.7" }), [key]: value } } })); }
  function setExecutorType(type) { setConfig((c) => ({ ...c, executor: { ...c.executor, type } })); }
  async function probeImages(executor) {
    if (busy || disabled) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request("/api/chat/image-generation/probe", { method: "POST", body: JSON.stringify({ executor }) });
      if (result.available) setMessage(result.message); else setError(result.message);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function probeChat() {
    if (busy || disabled) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request("/api/chat/probe", { method: "POST", body: "{}" });
      if (result.available) setMessage(result.message); else setError(result.message);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const locked = busy || disabled;
  const grok = config?.executor?.grokBuild || { executable: "grok", model: "grok-4.7" };
  const grokMode = config?.executor?.type === "grok-build";
  const executorSelect = config && <label>整理程序<select aria-label="整理程序" value={config.executor.type} disabled={locked} onChange={(e) => setExecutorType(e.target.value)}><option value="codex-cli">本机 Codex CLI</option><option value="grok-build">本机 Grok Build</option></select></label>;
  return <section className={settings ? "settings-section" : "organization-panel"} aria-label={settings ? (focus === "connection" ? "Agent 连接" : focus === "organization" ? "自动整理与检索" : "Agent 自动整理") : elementId ? "内容整理" : "全库整理历史"}>
    {settings && focus === "all" && <header className="settings-section-header"><h3>Agent 自动整理</h3></header>}
    {!status && !error && <p role="status">正在读取整理状态…</p>}
    {status && <>
            {status.configError && <p className="wiki-error" role="alert">{settings ? status.configError : "自动整理配置有误，请前往设置检查。"}</p>}
      {settings && config && <div className="wiki-form-fields">
        {(focus === "all" || focus === "connection") && <>
        {focus === "connection" && <header className="settings-section-header"><h3>Agent 连接</h3></header>}
                <ChatEngineSettings value={config.chat} locked={locked} onChange={(chat) => setConfig((current) => ({ ...current, chat }))} />
        <button type="button" disabled={locked || dirty} title={dirty ? "先保存改动，再检测连接" : undefined} onClick={probeChat}>检测聊天连接</button>
        <div className="wiki-actions"><button disabled={locked} onClick={() => mutate("probe")}>检测并启动整理程序</button></div>
        <fieldset className="settings-group"><legend>连接参数</legend>
        {focus === "connection" && executorSelect}
        {focus === "connection" && grokMode && <>
        <label>Grok 程序路径<input aria-label="Grok 程序路径" value={grok.executable} disabled={locked} onChange={(e) => grokField("executable", e.target.value)} placeholder="grok" /></label>
        <label>整理模型<input aria-label="整理模型" value={grok.model} disabled={locked} onChange={(e) => grokField("model", e.target.value)} placeholder="grok-4.7" /></label>
        </>}
        <label>Codex 程序路径<input value={config.executor.codexCli.executable} disabled={locked} onChange={(e) => executorField("executable", e.target.value)} placeholder="codex" /></label>
                <label>Codex 数据目录（可选）<input value={config.executor.codexCli.codexHome || ""} disabled={locked} onChange={(e) => executorField("codexHome", e.target.value)} placeholder={status.defaultCodexHome || "留空则使用独立目录"} /></label>
                </fieldset>
        {focus === "connection" && !registerSave && <div className="wiki-actions organization-save"><Button variant="primary" type="submit" disabled={locked} onClick={() => mutate("config", config, "PUT")}>保存连接配置</Button></div>}
        </>}
        {(focus === "all" || focus === "organization") && <>
        {focus === "organization" && <header className="settings-section-header"><h3>自动整理与检索</h3></header>}
        {focus === "organization" && <div className="wiki-actions"><button disabled={locked} onClick={() => mutate("probe")}>检测并启动整理程序</button></div>}
        <fieldset className="settings-group"><legend>整理策略</legend>
        <label><input type="checkbox" checked={config.enabled} disabled={locked} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />导入后自动整理</label>
        <label>处理方式<select value={config.applyMode} disabled={locked} onChange={(e) => setConfig({ ...config, applyMode: e.target.value })}><option value="suggest">先生成建议</option><option value="auto">自动添加</option></select></label>
                <button type="button" disabled={locked || dirty || Boolean(status.configError)} title={dirty ? "先保存改动" : status.configError ? "整理配置有误，先修正" : undefined} onClick={() => mutate("enqueue-texts")}>检查已有文字相似关系</button>
        </fieldset>
        <ImageGenerationSettings config={config.imageGeneration} locked={locked} saved={JSON.stringify(config.imageGeneration) === JSON.stringify(savedConfig?.imageGeneration)} onChange={(imageGeneration) => setConfig((c) => ({ ...c, imageGeneration }))} onProbe={probeImages} />
        <details className="settings-advanced" open={focus === "organization" ? undefined : undefined}>
        <summary>模型、超时与语义检索</summary>
        <div className="settings-advanced-content">
        <fieldset className="settings-group"><legend>模型与程序</legend>
        {executorSelect}
        {grokMode ? <>
        <label>Grok 程序路径<input aria-label="Grok 程序路径" value={grok.executable} disabled={locked} onChange={(e) => grokField("executable", e.target.value)} placeholder="grok" /></label>
        <p className="wiki-muted">先在本机运行 grok login。这个模型用于自动整理、图片描述和视频画面分析。对话模型在「Agent 连接」里另设。</p>
        <label>整理模型<input aria-label="整理模型" value={grok.model} disabled={locked} onChange={(e) => grokField("model", e.target.value)} placeholder="grok-4.7" /></label>
        </> : <>
        {focus === "organization" && <>
        <label>Codex 程序路径<input value={config.executor.codexCli.executable} disabled={locked} onChange={(e) => executorField("executable", e.target.value)} placeholder="codex" /></label>
        <label>Codex 数据目录（可选）<input value={config.executor.codexCli.codexHome || ""} disabled={locked} onChange={(e) => executorField("codexHome", e.target.value)} placeholder={status.defaultCodexHome || ""} /></label>
        </>}
        <label className="lan-sharing-checkbox"><input type="checkbox" checked={config.executor.codexCli.allowShell === true} disabled={locked} onChange={(e) => setConfig((c) => ({ ...c, executor: { ...c.executor, codexCli: { ...c.executor.codexCli, allowShell: e.target.checked } } }))} />允许 Agent 在会话目录运行命令（高级）</label>
        <label>整理模型（可选）<input value={config.executor.codexCli.model || ""} disabled={locked} onChange={(e) => executorField("model", e.target.value)} placeholder="留空使用 CLI 默认模型" /></label>
        </>}
        <label>整理超时（秒）<input type="number" min="1" max="1800" value={config.executor.timeoutMs / 1000} disabled={locked} onChange={(e) => setConfig({ ...config, executor: { ...config.executor, timeoutMs: Number(e.target.value) * 1000 } })} /></label>
        </fieldset>
        <SemanticSettings config={config.embedding} status={status.semantic} locked={locked} onChange={(embedding) => setConfig({ ...config, embedding })} onAction={mutate} />
        <p className="wiki-muted organization-config-path">配置文件：{status.configPath}</p>
        </div>
        </details>
        {!registerSave && <div className="wiki-actions organization-save"><Button variant="primary" type="submit" disabled={locked} onClick={() => mutate("config", config, "PUT")}>保存整理配置</Button></div>}
        <p className="wiki-muted">待整理 {status.counts.queued || 0} · 处理中 {status.counts.running || 0} · 失败 {status.counts.failed || 0}</p>
        </>}
      </div>}
{elementId && <>
        <div className="wiki-actions"><button disabled={locked || status.jobs.some((j) => j.state === "running")} onClick={() => mutate("enqueue", { elementId })}>整理此内容</button></div>
        {status.jobs.slice(0, 1).map((j) => <p key={j.id} role="status">{labels[j.state]}{j.error && `：${j.error}`}</p>)}
        {status.jobs[0]?.state === "queued" && <>
          <p className="wiki-muted" role="status">全库待整理 {status.counts.queued || 0} 项 · 处理中 {status.counts.running || 0} 项。后台会依次处理，重复点击不会提前。</p>
          {!status.executor.available && <p className={status.workerRunning || status.executor.code === "NOT_CHECKED" ? "wiki-muted" : "wiki-error"} role="status">
            {status.executor.diagnostic}{!status.workerRunning && status.executor.code !== "NOT_CHECKED" && "；请前往设置 → Agent 连接，检查后重新检测整理程序。"}
          </p>}
        </>}
      </>}
      {!settings && <>
        {focused && <button disabled={locked} onClick={() => setFocused(null)}>返回整理记录</button>}
        <OrganizationHistory key={`${endpoint}:${focused}`} results={status.results} locked={locked} mutate={mutate} initialExpandedId={focused} onOpen={onOpen} />
        {!focused && (pages.length > 0 || status.nextBefore) && <div className="wiki-actions organization-pagination"><button disabled={locked || !pages.length} onClick={() => setPages((p) => p.slice(0, -1))}>较新的记录</button><button disabled={locked || !status.nextBefore} onClick={() => setPages((p) => [...p, status.nextBefore])}>更早的记录</button></div>}
      </>}
    </>}
    {error && <p role="alert" className="wiki-error">{error}</p>}
    {message && <p role="status" className="wiki-muted">{message}</p>}
  </section>;
}
