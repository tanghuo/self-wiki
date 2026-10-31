import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { imageExecutors, grokAspectRatios } from "../../shared/domain/imageGeneration.js";
import { request } from "./api.js";
import "./chatImagePicker.css";
import Select from "./Select.jsx";
import { Button } from "./ui/Button.jsx";

const endpoint = "/api/chat/image-generation";
const fieldKey = (field) => JSON.stringify([field.nodeId, field.input]);
const primaryInputs = new Set(["width", "height", "seed", "noise_seed", "steps", "cfg", "denoise", "sampler_name", "scheduler"]);
const parameterNames = { width: "宽度", height: "高度", seed: "种子", noise_seed: "噪声种子", steps: "步数", cfg: "提示词强度", denoise: "降噪强度", sampler_name: "采样器", scheduler: "调度器" };

function Parameter({ field, value, disabled, onChange }) {
  return <label title={field.label}><span>{parameterNames[field.input] || field.input}<small>{field.label.split(" → ")[0]}</small></span>
    {field.type === "COMBO" ? <select aria-label={field.label} value={JSON.stringify(value)} disabled={disabled} onChange={(event) => onChange(JSON.parse(event.target.value))}>
      {field.options.map((option) => <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{String(option)}</option>)}
    </select> : field.type === "BOOLEAN" ? <input aria-label={field.label} type="checkbox" checked={value} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      : field.type === "STRING" ? <textarea aria-label={field.label} value={value} maxLength={12000} rows={2} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
        : <input aria-label={field.label} type="number" value={value} min={field.min} max={field.max} step={field.type === "INT" ? 1 : "any"} disabled={disabled} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} />}
  </label>;
}

// toolbarTarget: when given, the executor controls render there (the composer toolbar); hints and the workflow panel stay above the composer.
export default function ChatImagePicker({ options, chatEngine, disabled, onChange, toolbarTarget }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(options);
  const [stored, setStored] = useState(null), [record, setRecord] = useState(null), [listing, setListing] = useState(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const operation = useRef(0), trigger = useRef(null);
  useEffect(() => () => { operation.current++; }, []);
  useEffect(() => {
    let disposed = false;
    setStored(null);
    if (options?.workflowId) request(`${endpoint}/workflows/${options.workflowId}`).then((value) => { if (!disposed) setStored(value); }).catch(() => {});
    return () => { disposed = true; };
  }, [options?.workflowId]);
  const locked = disabled || busy, executor = imageExecutors.find((entry) => entry.id === options?.executor);
  async function refresh() {
    const sequence = ++operation.current;
    setBusy(true); setError("");
    try {
      const value = await request(`${endpoint}/workflows`);
      if (operation.current === sequence) setListing(value);
    } catch (failure) { if (operation.current === sequence) setError(failure.message); }
    finally { if (operation.current === sequence) setBusy(false); }
  }
  async function show() {
    setOpen(true); setDraft(options); setRecord(stored); setError("");
    const sequence = ++operation.current;
    setBusy(true);
    try {
      const [list, saved] = await Promise.all([request(`${endpoint}/workflows`), options.workflowId ? request(`${endpoint}/workflows/${options.workflowId}`) : null]);
      if (operation.current === sequence) { setListing(list); setRecord(saved); }
    } catch (failure) { if (operation.current === sequence) setError(failure.message); }
    finally { if (operation.current === sequence) setBusy(false); }
  }
  async function load(body) {
    const sequence = ++operation.current;
    setBusy(true); setError("");
    try {
      const value = await request(`${endpoint}/workflows/load`, { method: "POST", body: JSON.stringify(body) });
      if (sequence !== operation.current) return;
      setRecord(value);
      // Re-selecting an unchanged revision keeps its mapping and parameters.
      setDraft((current) => current.workflowId === value.id ? current : { executor: "comfyui", workflowId: value.id, prompt: value.prompt, outputNodeId: value.outputNodeId, parameters: [], ...value.options, direct: current.direct });
    } catch (failure) { if (operation.current === sequence) setError(failure.message); }
    finally { if (operation.current === sequence) setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError("");
    try { if (await onChange(draft)) { setStored(record); setOpen(false); trigger.current?.focus(); } }
    finally { setBusy(false); }
  }
  function parameter(field, value) {
    setDraft((current) => ({ ...current, parameters: [...(current.parameters || []).filter((entry) => fieldKey(entry) !== fieldKey(field)), ...(value === field.value ? [] : [{ nodeId: field.nodeId, input: field.input, value }])] }));
  }
  const fields = record?.fields.filter((field) => !(draft?.prompt?.nodeId === field.nodeId && draft.prompt.input === field.input)) || [];
  const renderField = (field) => <Parameter key={fieldKey(field)} field={field} value={draft.parameters.find((entry) => fieldKey(entry) === fieldKey(field))?.value ?? field.value} disabled={locked} onChange={(value) => parameter(field, value)} />;
  const toolbar = <div className="chat-image-toolbar">
    <span className="chat-image-executor"><span aria-hidden="true">生图</span><Select aria-label="生图方式" placement="top" value={options?.executor || "codex-cli"} disabled={locked} onChange={async (executor) => {
      if (await onChange({ executor, direct: executor !== "codex-cli" && Boolean(options?.direct) })) { setOpen(false); setRecord(null); }
    }} options={imageExecutors.filter((entry) => chatEngine !== "grok-build" || entry.id !== "codex-cli").map((entry) => ({ value: entry.id, label: entry.label }))} /></span>
    {chatEngine === "grok-build" && options?.executor === "grok-build" && !options.direct && <span className="wiki-muted">随当前 Grok 会话生图</span>}
    {options?.executor === "grok-build" && <Select aria-label="Grok 图片比例" placement="top" value={options.aspectRatio || "auto"} disabled={locked}
      onChange={(aspectRatio) => void onChange({ ...options, aspectRatio })} options={grokAspectRatios.map((ratio) => ({ value: ratio, label: ratio === "auto" ? "自动比例" : ratio }))} />}
    {options?.executor === "comfyui" && <button type="button" ref={trigger} className="chat-workflow-trigger" aria-label="工作流与参数" aria-expanded={open} disabled={locked} onClick={() => open ? setOpen(false) : void show()}>
      {stored?.name || (options.workflowId ? `工作流 #${options.workflowId}` : "选择工作流")} · 参数
    </button>}
    <label className="chat-direct-image"><input type="checkbox" checked={Boolean(options?.direct)} disabled={locked} onChange={(event) => {
      const direct = event.target.checked;
      void onChange({ ...options, executor: direct && options.executor === "codex-cli" ? "chatgpt-web" : options.executor, direct });
    }} />原文直发生图</label>
  </div>;
  return <div className="chat-image-control" onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    {toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar}
    {options?.direct && <p className="wiki-muted chat-direct-hint">{options.executor === "comfyui"
      ? "文字留空沿用工作流提示词；填写文字或选择文字素材则替换提示词。可直接发送一张图片，工作流需有唯一图片入口。种子使用参数面板中的数值。"
      : options.executor === "grok-build" ? "文案原样交给 Grok Build；文字素材依次附在文案后，Grok 负责调用图片工具。附图时进行编辑或融合，最多 8 张；单图编辑保留原图比例。每次独立执行，连续改图需附上上一张结果。"
        : `原文直接发送到 ${executor?.label}。文字素材依次附在文案后；延续当前会话的网页对话。`}</p>}
    {options?.executor === "comfyui" && !options.workflowId && !open && <p className="wiki-muted">选择已保存的工作流后即可生成图片。</p>}
    {open && options?.executor === "comfyui" && <section className="chat-workflow-panel" aria-label="ComfyUI 工作流设置">
      <div className="chat-workflow-heading"><strong>ComfyUI 工作流</strong><button type="button" disabled={busy} onClick={() => setOpen(false)}>收起</button></div>
      {listing && <p className="wiki-muted">读取自 {listing.baseUrl}</p>}
      <div className="chat-workflow-list"><label>已保存的工作流<select aria-label="ComfyUI 工作流" disabled={locked} value={record?.path && listing?.workflows.some((entry) => entry.path === record.path) ? record.path : ""} onChange={(event) => { if (event.target.value) void load({ path: event.target.value }); }}>
        <option value="">请选择工作流</option>{listing?.workflows.map((entry) => <option key={entry.path} value={entry.path}>{entry.name}</option>)}
      </select></label><button type="button" disabled={locked} onClick={refresh}>刷新列表</button></div>
      {listing && !listing.workflows.length && <p className="wiki-muted">尚无已保存的工作流。请在 ComfyUI 保存后刷新；未保存的画布不会出现在列表中。</p>}
      {busy && <p role="status">正在读取或保存…</p>}
      {error && <p className="wiki-error" role="alert">{error}</p>}
      {record && draft && <>
        <p className="wiki-muted">当前：{record.name} · {record.baseUrl}</p>
        {listing && record.baseUrl !== listing.baseUrl && <p className="wiki-muted">此工作流仍使用上面的原服务地址。更新当前工作流后，才会改用设置中的新地址。</p>}
        {record.path && <button type="button" disabled={locked} onClick={() => load({ path: record.path })}>更新当前工作流</button>}
        <div className="chat-workflow-mapping">
          <label>提示词写入字段<select aria-label="提示词写入字段" value={draft.prompt ? JSON.stringify(draft.prompt) : ""} disabled={locked} onChange={(event) => {
            const prompt = event.target.value ? JSON.parse(event.target.value) : null;
            setDraft((current) => ({ ...current, prompt, parameters: current.parameters.filter((entry) => !prompt || fieldKey(entry) !== fieldKey(prompt)) }));
          }}><option value="">请选择正向提示词字段</option>{record.fields.filter((field) => field.type === "STRING").map((field) => <option key={fieldKey(field)} value={JSON.stringify({ nodeId: field.nodeId, input: field.input })}>{field.label}</option>)}</select></label>
          <label>图片输出节点<select aria-label="图片输出节点" value={draft.outputNodeId} disabled={locked} onChange={(event) => setDraft((current) => ({ ...current, outputNodeId: event.target.value }))}>
            <option value="">请选择保存或预览节点</option>{record.outputs.map((output) => <option key={output.nodeId} value={output.nodeId}>{output.label}</option>)}
          </select></label>
        </div>
        <div className="chat-workflow-parameters">{fields.filter((field) => primaryInputs.has(field.input)).map(renderField)}</div>
        <details><summary>更多参数（模型、负面提示词等）</summary><div className="chat-workflow-parameters">{fields.filter((field) => !primaryInputs.has(field.input)).map(renderField)}</div></details>
        <p className="wiki-muted">选项保存在本会话中。种子沿用工作流的随机或固定模式；手动修改种子后使用固定值，恢复工作流参数可恢复原模式。更新工作流后需重新检查映射。每次应输出一张图片。</p>
        <div className="chat-workflow-actions"><button type="button" disabled={locked} onClick={() => setDraft((current) => ({ ...current, parameters: [] }))}>恢复工作流参数</button><Button variant="primary" disabled={locked || !draft.prompt || !draft.outputNodeId} onClick={apply}>应用到本会话</Button></div>
      </>}
    </section>}
  </div>;
}
