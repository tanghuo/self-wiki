import { useEffect, useRef, useState } from "react";
import { request } from "./api.js";
import OrganizationHistory from "./OrganizationHistory.jsx";
import SemanticSettings from "./SemanticSettings.jsx";
import ImageGenerationSettings from "./ImageGenerationSettings.jsx";

const labels = { queued: "待整理", running: "整理中", succeeded: "整理完成", failed: "整理失败", cancelled: "已取消" };

export default function OrganizationPanel({ elementId, mode = elementId ? "content" : "settings", initialResultId = null, onChanged, onBusyChange, onDirtyChange, onOpen, disabled = false }) {
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
    const timer = setInterval(load, 2500);
    return () => { mounted.current = false; loadSequence.current++; clearInterval(timer); };
  }, [endpoint, focused]);
  useEffect(() => {
    if (focused && status?.results[0]?.id === focused) document.getElementById(`organization-result-${focused}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused, status?.results[0]?.id]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const dirty = Boolean(settings && config && savedConfig && JSON.stringify(config) !== JSON.stringify(savedConfig));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
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
  async function probeImages(executor) {
    if (busy || disabled) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request("/api/chat/image-generation/probe", { method: "POST", body: JSON.stringify({ executor }) });
      if (result.available) setMessage(result.message); else setError(result.message);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const locked = busy || disabled;
  return <section className={settings ? "settings-section" : "organization-panel"} aria-label={settings ? "Agent 自动整理" : elementId ? "内容整理" : "全库整理历史"}>
    {settings && <header className="settings-section-header"><h3>Agent 自动整理</h3></header>}
    {!status && !error && <p role="status">正在读取整理状态…</p>}
    {status && <>
      {settings && <p className="wiki-muted">{status.executor.diagnostic}{status.executor.version && ` · ${status.executor.version}`}</p>}
      {status.configError && <p className="wiki-error" role="alert">{settings ? status.configError : "自动整理配置有误，请前往设置检查。"}</p>}
      {settings && config && <div className="wiki-form-fields">
        <fieldset className="settings-group"><legend>整理策略</legend>
        <label><input type="checkbox" checked={config.enabled} disabled={locked} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />导入后自动整理</label>
        <label>处理方式<select value={config.applyMode} disabled={locked} onChange={(e) => setConfig({ ...config, applyMode: e.target.value })}><option value="suggest">先生成建议</option><option value="auto">自动添加，可事后修正</option></select></label>
        <p className="wiki-muted">自动模式会添加标签、图片识别结果及推断关联，并标记 AI 来源。可从侧栏“整理历史”查看或修正结果。内容由本机 Codex CLI 调用其模型服务分析，需要可用的 CLI 登录。</p>
        <p className="wiki-muted">导入图片或视频后会比较候选画面，视频只取首帧；高度相似时添加双向“相似”关联，可堆叠展示。已有未整理视频会补入队列。仅同角色或画风不算高度相似；视频需要配置 FFmpeg，在“视频与画面检索”中启用视觉索引可扩大候选范围。</p>
        <p className="wiki-muted">文字会先按正文重合和已启用的语义检索查找候选，再核对完整正文；基本相同或等义改写时建立“相似”关联，仅主题相同或关键要求相反不关联。开启自动整理后，新建和修改的文字会自动检查。</p>
        <button type="button" disabled={locked || dirty || Boolean(status.configError)} onClick={() => mutate("enqueue-texts")}>检查已有文字相似关系</button>
        <p className="wiki-muted">按已保存的处理方式逐条整理已有文字，也会检查标签及其他关联；“先生成建议”需在整理历史接受，“自动添加”可事后撤销。</p>
        </fieldset>
        <div className="wiki-actions"><button disabled={locked} onClick={() => mutate("probe")}>检测并启动执行器</button></div>
        <ImageGenerationSettings config={config.imageGeneration} locked={locked} saved={JSON.stringify(config.imageGeneration) === JSON.stringify(savedConfig?.imageGeneration)} onChange={(imageGeneration) => setConfig((current) => ({ ...current, imageGeneration }))} onProbe={probeImages} />
        <details className="settings-advanced">
        <summary>高级设置<span>模型、连接参数与语义检索</span></summary>
        <div className="settings-advanced-content">
        <fieldset className="settings-group"><legend>模型与执行器</legend>
        <label>执行器<select value={config.executor.type} disabled><option value="codex-cli">本机 Codex CLI</option></select></label>
        <label>Codex 程序路径<input value={config.executor.codexCli.executable} disabled={locked} onChange={(e) => executorField("executable", e.target.value)} placeholder="codex" /></label>
        <p className="wiki-muted">默认 codex 会自动查找 PATH；Windows 还会查找常见安装目录及应用旁的便携安装。仅在未找到或需要指定版本时填写绝对路径。</p>
        <label>Codex 数据目录（可选）<input value={config.executor.codexCli.codexHome || ""} disabled={locked} onChange={(e) => executorField("codexHome", e.target.value)} placeholder={status.defaultCodexHome || "留空使用 Wiki 独立目录"} /></label>
        <p className="wiki-muted">留空时，对话与 Codex 桌面端分开保存，并使用本机当前登录。登录失效会暂停自动任务，恢复登录后自动继续。代理等配置修改后，点击检测连接即可生效；自动整理在下一次执行时读取更新。手动指定目录使用该目录自己的配置与登录；切换目录后，旧聊天仍可查看，但可能需要新建会话。</p>
        <label>整理模型（可选）<input value={config.executor.codexCli.model || ""} disabled={locked} onChange={(e) => executorField("model", e.target.value)} placeholder="留空使用 CLI 默认模型" /></label>
        <p className="wiki-muted">用于后台整理、打标签和图片识别；聊天默认使用本机 Codex 的默认模型，也可在会话中单独选择。</p>
        <label>整理超时（秒）<input type="number" min="1" max="1800" value={config.executor.timeoutMs / 1000} disabled={locked} onChange={(e) => setConfig({ ...config, executor: { ...config.executor, timeoutMs: Number(e.target.value) * 1000 } })} /></label>
        <p className="wiki-muted">仅限制后台自动整理。聊天没有整轮时限；长时间未收到新进展时会提示等待，可手动停止。网页版生图每张最多等待 30 分钟。</p>
        <p className="wiki-muted">修改后先保存配置，再检测连接。</p>
        </fieldset>
        <SemanticSettings config={config.embedding} status={status.semantic} locked={locked} onChange={(embedding) => setConfig({ ...config, embedding })} onAction={mutate} />
        <p className="wiki-muted organization-config-path">配置文件：{status.configPath}</p>
        </div>
        </details>
        <div className="wiki-actions organization-save"><button className="primary" disabled={locked} onClick={() => mutate("config", config, "PUT")}>保存整理配置</button></div>
        <p className="wiki-muted">待整理 {status.counts.queued || 0} · 处理中 {status.counts.running || 0} · 失败 {status.counts.failed || 0}</p>
      </div>}
      {elementId && <>
        <div className="wiki-actions"><button disabled={locked || status.jobs.some((j) => j.state === "running")} onClick={() => mutate("enqueue", { elementId })}>整理此内容</button></div>
        {status.jobs.slice(0, 1).map((j) => <p key={j.id} role="status">{labels[j.state]}{j.error && `：${j.error}`}</p>)}
        {status.jobs[0]?.state === "queued" && <>
          <p className="wiki-muted" role="status">全库待整理 {status.counts.queued || 0} 项 · 处理中 {status.counts.running || 0} 项。后台会依次处理，重复点击不会提前。</p>
          {!status.executor.available && <p className={status.workerRunning || status.executor.code === "NOT_CHECKED" ? "wiki-muted" : "wiki-error"} role="status">
            {status.executor.diagnostic}{!status.workerRunning && status.executor.code !== "NOT_CHECKED" && "；请前往设置 → Agent 与检索，检查后重新检测执行器。"}
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
