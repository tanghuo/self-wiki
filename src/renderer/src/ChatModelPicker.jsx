import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, RefreshCw, RotateCcw, Zap } from "lucide-react";

const effortNames = { none: "无", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大", ultra: "超高" };
export default function ChatModelPicker({ model, effort, catalog, disabled, loading, error, onChange, onRefresh }) {
  const [panel, setPanel] = useState(null), [draft, setDraft] = useState(null);
  const root = useRef(null), trigger = useRef(null);
  const selected = catalog?.models.find((m) => m.id === (model || catalog.defaultModel));
  const levels = selected?.supportedReasoningEfforts || [];
  const defaultEffort = !levels.length || levels.some((e) => e.reasoningEffort === catalog?.defaultEffort) ? catalog?.defaultEffort : "";
  const effective = effort || defaultEffort || selected?.defaultReasoningEffort || "";
  const label = selected?.label || model || catalog?.defaultModel || "默认模型";
  const index = Math.max(0, levels.findIndex((e) => e.reasoningEffort === effective));
  const current = draft ?? index;
  function close() { setPanel(null); setDraft(null); trigger.current?.focus(); }
  useEffect(() => {
    if (!panel) return;
    function outside(e) { if (!root.current?.contains(e.target)) { setPanel(null); setDraft(null); } }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [panel]);
  useEffect(() => { if (disabled) { setPanel(null); setDraft(null); } }, [disabled]);
  async function save(nextModel, nextEffort) { if (await onChange(nextModel, nextEffort)) close(); }
  return <div className="chat-model-control" ref={root} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
    <button type="button" className="chat-model-trigger" ref={trigger} aria-label="模型与努力等级" aria-expanded={Boolean(panel)} aria-haspopup="dialog" disabled={disabled} onClick={() => setPanel(panel ? null : "effort")}>
      <span>{label}</span><span className="chat-effort-label">{effortNames[effective] || effective || "默认"}</span><ChevronDown size={15} />
    </button>
    {panel && <div className={`chat-model-popover ${panel === "models" ? "chat-model-list" : ""}`} role="dialog" aria-label={panel === "models" ? "选择模型" : "调整努力等级"}>
      {panel === "models" ? <>
        <header><span>选择模型</span><button type="button" className="icon-only" aria-label="刷新模型列表" disabled={loading} onClick={onRefresh}><RefreshCw size={16} className={loading ? "chat-model-loading" : ""} /></button></header>
        <div role="group" aria-label="会话模型">
          <button type="button" aria-pressed={!model} onClick={() => save("", "")}><span>默认<small>跟随本机 Codex 配置</small></span>{!model && <Check size={17} />}</button>
          {model && !selected && <button type="button" aria-pressed="true" onClick={() => setPanel("effort")}>{model}<Check size={17} /></button>}
          {catalog?.models.map((m) => <button type="button" key={m.id} aria-pressed={model === m.id} onClick={() => save(m.id, "")}><span>{m.label}</span>{model === m.id && <Check size={17} />}</button>)}
        </div>
      </> : <>
        <header className="chat-effort-header">
          <Zap size={18} />
          <button type="button" className="chat-model-select" aria-label="选择模型" onClick={() => setPanel("models")}>
            <span className="chat-effort-heading">{effortNames[levels[current]?.reasoningEffort] || effective || "默认"}<ChevronRight size={17} /></span>
            <span className="chat-model-name">{label}</span>
          </button>
          <button type="button" className="icon-only" aria-label="恢复默认努力等级" onClick={() => save(model, "")}><RotateCcw size={17} /></button>
        </header>
        {levels.length > 0 ? <div className="chat-effort-slider">
          <input type="range" aria-label="努力等级" aria-valuetext={effortNames[levels[current]?.reasoningEffort] || levels[current]?.reasoningEffort} min="0" max={levels.length - 1} step="1" value={current} disabled={levels.length === 1} style={{ "--effort-progress": levels.length > 1 ? current / (levels.length - 1) : 0 }} onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={(e) => save(model, levels[Number(e.currentTarget.value)].reasoningEffort)} onKeyUp={(e) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) save(model, levels[Number(e.currentTarget.value)].reasoningEffort); }} />
          <div className="chat-effort-ticks" aria-hidden="true">{levels.map((e, i) => <span key={e.reasoningEffort} data-filled={i < current} data-selected={i === current} style={{ left: `${levels.length > 1 ? i / (levels.length - 1) * 100 : 0}%` }} />)}</div>
        </div> : <p className="wiki-muted">{loading ? "正在读取努力等级…" : "此模型未提供可选努力等级"}</p>}
      </>}
      {error && <p className="chat-model-error" role="status">{error}<button type="button" className="text-button" onClick={onRefresh} disabled={loading}>重试</button></p>}
    </div>}
  </div>;
}
