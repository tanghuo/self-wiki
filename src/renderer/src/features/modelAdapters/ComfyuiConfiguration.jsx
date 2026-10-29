import { useEffect, useId, useRef, useState } from 'react';
import { request } from '../../api.js';
import { configuredComfyuiWorkflow, maxComfyReferenceImages, maxComfyOutputImages } from '../../../../shared/domain/comfyui.js';
import { comfyuiConfig } from '../../../../shared/domain/comfyui.js';
import Dialog from '../../Dialog.jsx';
import './comfyuiConfiguration.css';
import { alignComfyuiParameters, comfyuiParameterOptions } from '../../../../shared/domain/comfyuiParameters.js';

const parameterNames = { seed: '种子', noise_seed: '噪声种子', steps: '步数', cfg: '提示词强度', denoise: '降噪强度', width: '宽度', height: '高度', batch_size: '生成数量', sampler_name: '采样器', scheduler: '调度器', negative_prompt: '负面提示词', ckpt_name: '模型', unet_name: '扩散模型', clip_name: '文本编码器', vae_name: 'VAE', filename_prefix: '保存文件名前缀', strength_model: 'LoRA 强度' };
const commonParameters = new Set(['batch_size', 'seed', 'noise_seed', 'steps', 'cfg', 'denoise', 'width', 'height', 'sampler_name', 'scheduler', 'strength_model']);
const isCommonParameter = (field) => commonParameters.has(field.input) || /width|height|resolution|aspect|output_size|宽|高|分辨率|画幅|比例/i.test(field.input);

function imageEntries(workflow, outputNodeId) {
  if (!outputNodeId) return [];
  const graph = configuredComfyuiWorkflow({ workflow, outputNodeId }, { requirePrompt: false });
  const seen = new Set(), images = [];
  function visit(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const node = graph[id];
    if (node.class_type === 'LoadImage' && typeof node.inputs.image === 'string') images.push({ nodeId: id, input: 'image' });
    for (const input of Object.values(node.inputs)) if (Array.isArray(input)) visit(String(input[0]));
  }
  visit(outputNodeId);
  return images;
}

function WorkflowParameter({ field, value, onChange }) {
  const [draft, setDraft] = useState(String(value)), [error, setError] = useState('');
  const id = useId();
  useEffect(() => { setDraft(String(value)); setError(''); }, [value]);
  const label = `工作流参数 ${field.label}`;
  const display = parameterNames[field.input] || field.input;
  if (field.type === 'BOOLEAN') return <label title={field.label}><input aria-label={label} type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />{display}</label>;
  if (field.type === 'COMBO') return <label title={field.label}>{display}<select aria-label={label} value={JSON.stringify(value)} onChange={(event) => onChange(JSON.parse(event.target.value))}>{!field.options.some((option) => option === value) && <option value={JSON.stringify(value)}>{String(value)}（当前值）</option>}{field.options.map((option) => <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{String(option)}</option>)}</select></label>;
  if (field.type === 'INT' || field.type === 'FLOAT') return <label title={field.label}>{display}<small id={`${id}-range`}>{field.type === 'INT' ? '整数' : '数字'} · {field.min ?? '不限'} ～ {field.max ?? '不限'}</small><input aria-label={label} aria-describedby={`${id}-range${error ? ` ${id}-error` : ''}`} aria-invalid={!!error} type="number" min={field.min} max={field.max} step={field.type === 'INT' ? 1 : field.step || 'any'} value={draft} onChange={(event) => {
    const control = event.target, number = control.valueAsNumber;
    setDraft(control.value);
    if (control.value !== '' && control.validity.valid && Number.isFinite(number) && (field.type !== 'INT' || Number.isSafeInteger(number))) { setError(''); onChange(number); }
    else setError(control.value === '' ? '请输入数值' : field.min != null && number < field.min ? `不能小于 ${field.min}` : field.max != null && number > field.max ? `不能大于 ${field.max}` : field.type === 'INT' ? '请输入范围内的整数' : '请输入符合步长的数值');
  }} />{error && <span id={`${id}-error`} role="alert" className="workflow-field-error">{error}</span>}</label>;
  const props = { 'aria-label': label, value, maxLength: 12000, onChange: (event) => onChange(event.target.value) };
  return <label title={field.label}>{display}{field.multiline ? <textarea {...props} /> : <input {...props} />}</label>;
}
function ComfyuiEditor({ value = {}, onChange, adapterId, onBusyChange, parametersOnly = false }) {
  const endpoint = '/api/workflows/adapters/' + encodeURIComponent(adapterId);
  const operation = useRef(0);
  const describedGraph = useRef(null);
  useEffect(() => () => { operation.current++; }, []);
  const [listing, setListing] = useState(null), [record, setRecord] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => { let alive = true; request(endpoint + '/workflows').then((result) => { if (alive) setListing(result); }).catch((failure) => { if (alive) setError(failure.message); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (!value.workflow || !value.workflowName || describedGraph.current === value.workflow) return;
    let alive = true;
    describedGraph.current = value.workflow;
    setRecord(null);
    request(`${endpoint}/load`, { method: 'POST', body: JSON.stringify({ path: value.workflowName }) }).then((result) => {
      if (!alive) return;
      let restored = false;
      const workflow = Object.fromEntries(Object.entries(value.workflow).map(([id, node]) => {
        if (!node._meta?.seedControls && result.workflow[id]?.class_type === node.class_type && result.workflow[id]._meta?.seedControls) {
          restored = true;
          return [id, { ...node, _meta: { ...node._meta, seedControls: result.workflow[id]._meta.seedControls } }];
        }
        return [id, node];
      }));
      const nextWorkflow = alignComfyuiParameters(restored ? workflow : value.workflow, result.fields);
      describedGraph.current = nextWorkflow;
      if (alive) setRecord({ ...result, workflow: nextWorkflow,
        fields: result.fields.filter((field) => value.workflow[field.nodeId]?.class_type === result.workflow[field.nodeId]?.class_type && typeof value.workflow[field.nodeId]?.inputs[field.input] === typeof field.value),
        outputs: result.outputs.filter((output) => value.workflow[output.nodeId]?.class_type === result.workflow[output.nodeId]?.class_type),
      });
      if (!value.outputNodeId && result.outputNodeId) onChange({ ...value, workflow: nextWorkflow, outputNodeId: result.outputNodeId, prompt: value.prompt || result.prompt, imageInputs: imageEntries(nextWorkflow, result.outputNodeId).slice(0, maxComfyReferenceImages) });
      else if (nextWorkflow !== value.workflow) onChange({ ...value, workflow: nextWorkflow });
    }).catch((failure) => { if (alive) setError(`读取参数定义失败：${failure.message}`); });
    return () => { alive = false; if (describedGraph.current === value.workflow) describedGraph.current = null; };
  }, [value.workflow, value.workflowName]);
  async function refresh() { setBusy(true); setError(''); try { setListing(await request(endpoint + '/workflows')); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }
  async function load(payload) {
    const sequence = ++operation.current;
    setBusy(true); setError('');
    try {
      const result = await request(`${endpoint}/load`, { method: 'POST', body: JSON.stringify(payload) });
      if (sequence !== operation.current) return;
      const workflow = alignComfyuiParameters(result.workflow, result.fields);
      describedGraph.current = workflow;
      setRecord({ ...result, workflow });
      const outputNodeId = result.outputNodeId;
      onChange({ workflow, workflowName: result.name.replace(/[\r\n\0]/g, ' ').slice(0, 240), promptMode: 'input', prompt: result.prompt, outputNodeId, imageInputs: imageEntries(workflow, outputNodeId).slice(0, maxComfyReferenceImages) });
    } catch (failure) { if (sequence === operation.current) setError(failure.message); } finally { if (sequence === operation.current) setBusy(false); }
  }
  const graph = value.workflow || {};
  const label = (id) => `${graph[id]?._meta?.title || graph[id]?.class_type || '节点'} · #${id}`;
  const outputIds = record?.workflow === value.workflow ? record.outputs.map((entry) => entry.nodeId) : Object.keys(graph).filter((id) => ['SaveImage', 'PreviewImage'].includes(graph[id].class_type) || id === value.outputNodeId);
  let reachable = graph;
  try { if (value.outputNodeId) reachable = configuredComfyuiWorkflow({ ...value, prompt: null, imageInputs: [] }, { requirePrompt: false }); } catch { /* Incomplete choices are validated before execution. */ }
  const images = value.outputNodeId ? imageEntries(graph, value.outputNodeId).map((entry) => entry.nodeId) : [];
  const fields = Object.entries(reachable).flatMap(([nodeId, node]) => node.class_type === 'LoadImage' ? [] : Object.entries(node.inputs).filter(([, field]) => typeof field === 'string').map(([input]) => ({ nodeId, input })));
  const mappings = value.imageInputs || [];
  const patch = (fields) => onChange({ ...value, ...fields });
  const parameters = (record?.workflow === value.workflow ? record.fields : []).filter((field) => reachable[field.nodeId] && graph[field.nodeId]?.class_type !== 'LoadImage' && !(value.promptMode !== 'workflow' && value.prompt?.nodeId === field.nodeId && value.prompt.input === field.input));
  const renderParameter = (parameter) => {
    const field = parameter.input === 'batch_size' ? { ...parameter, min: Math.max(1, parameter.min ?? 1), max: Math.min(maxComfyOutputImages, parameter.max ?? maxComfyOutputImages) } : parameter;
    return <div key={`${field.nodeId}:${field.input}`}><WorkflowParameter field={{ ...field, options: comfyuiParameterOptions(field, graph[field.nodeId].inputs) }} value={graph[field.nodeId].inputs[field.input]} onChange={(nextValue) => changeParameter(field, nextValue)} />{['seed', 'noise_seed'].includes(field.input) && <label>种子模式<select aria-label={`种子模式 ${field.label}`} value={graph[field.nodeId]._meta?.seedControls?.[field.input]?.mode || 'fixed'} onChange={(event) => changeSeedMode(field, event.target.value)}><option value="randomize">每次随机</option><option value="fixed">固定</option>{['increment', 'decrement'].includes(graph[field.nodeId]._meta?.seedControls?.[field.input]?.mode) && <option value={graph[field.nodeId]._meta.seedControls[field.input].mode}>递增/递减（请选择随机或固定）</option>}</select></label>}</div>;
  };
  function changeSeedMode(field, mode) {
    const node = graph[field.nodeId];
    const nextGraph = { ...graph, [field.nodeId]: { ...node, _meta: { ...node._meta, seedControls: { ...node._meta?.seedControls, [field.input]: { mode, min: Math.max(0, field.min ?? 0), max: Math.min(Number.MAX_SAFE_INTEGER, field.max ?? Number.MAX_SAFE_INTEGER) } } } } };
    describedGraph.current = nextGraph;
    setRecord((previous) => ({ ...previous, workflow: nextGraph }));
    patch({ workflow: nextGraph });
  }
  function changeParameter(field, nextValue) {
    const node = graph[field.nodeId];
    const nextGraph = alignComfyuiParameters({ ...graph, [field.nodeId]: { ...node, inputs: { ...node.inputs, [field.input]: nextValue } } }, record?.fields || []);
    describedGraph.current = nextGraph;
    setRecord((previous) => ({ ...previous, workflow: nextGraph }));
    patch({ workflow: nextGraph });
  }
  return <fieldset className={`comfyui-editor${parametersOnly ? ' comfyui-runtime-editor' : ''}`} disabled={busy}><legend hidden>ComfyUI 工作流配置</legend>
    {!parametersOnly && <section className="comfyui-section comfyui-workflow-choice"><h3>工作流</h3>
    <label>已保存的工作流<select aria-label="ComfyUI 工作流" value={record?.workflow === value.workflow && record.path ? record.path : listing?.workflows.some((entry) => entry.path === value.workflowName) ? value.workflowName : ''} onChange={(event) => { if (event.target.value) load({ path: event.target.value }); }}><option value="">选择 ComfyUI 中已保存的工作流…</option>{listing?.workflows.map((entry) => <option key={entry.path} value={entry.path}>{entry.name}</option>)}</select></label>
    <button onClick={refresh}>刷新工作流列表</button>
    {listing && !listing.workflows.length && <p>没有已保存的工作流，请先在 ComfyUI 中保存后刷新。</p>}
    {busy && <p role="status">正在读取 ComfyUI…</p>}{error && <p role="alert">{error}</p>}
    </section>}
    {parametersOnly && <>{busy && <p role="status">正在读取参数定义…</p>}{error && <p role="alert">{error}</p>}</>}
    {!!Object.keys(graph).length && <>
      {!parametersOnly && <section className="comfyui-section"><h3>提示词与图片</h3>
      <label>生成结果<select aria-label="ComfyUI 图片输出节点" value={value.outputNodeId || ''} onChange={(event) => patch({ outputNodeId: event.target.value, imageInputs: imageEntries(graph, event.target.value).slice(0, maxComfyReferenceImages) })}><option value="">有多个输出，请选择用于保存图片的节点…</option>{outputIds.map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></label>
      <label>提示词来源<select aria-label="ComfyUI 提示词来源" value={value.promptMode || 'input'} onChange={(event) => patch({ promptMode: event.target.value, ...(event.target.value === 'workflow' && { prompt: null }), ...(event.target.value === 'input' && !value.prompt && record?.prompt && { prompt: record.prompt }) })}><option value="input">使用本节点的上游提示词</option><option value="workflow">沿用工作流原有提示词</option></select></label>
      {value.promptMode !== 'workflow' && <label>提示词写入字段<select aria-label="ComfyUI 提示词字段" value={value.prompt ? JSON.stringify(value.prompt) : ''} onChange={(event) => patch({ prompt: event.target.value ? JSON.parse(event.target.value) : null })}><option value="">选择要替换的文本字段…</option>{fields.map((field) => <option key={JSON.stringify(field)} value={JSON.stringify(field)}>{label(field.nodeId)} → {field.input}</option>)}</select></label>}
      <h4>参考图片</h4>
      <p>{images.length ? `该输出使用 ${images.length} 个图片入口。上游图片按下方顺序送入；未提供图片时沿用工作流原图。` : value.outputNodeId ? '该输出没有参考图片入口。' : '先选择生成结果，再识别参考图片入口。'}</p>
      {value.imageInputs === undefined && <p>旧配置仅在存在唯一 LoadImage 时自动匹配一张图；请在此明确选择入口。</p>}
      {mappings.map((entry, index) => <div key={index}><label>第 {index + 1} 张参考图<select aria-label={`第 ${index + 1} 张参考图入口`} value={entry.nodeId} onChange={(event) => patch({ imageInputs: mappings.map((item, i) => i === index ? { nodeId: event.target.value, input: 'image' } : item) })}><option value="">选择 LoadImage 图片入口…</option>{images.map((id) => <option key={id} value={id} disabled={mappings.some((item, i) => i !== index && item.nodeId === id)}>{label(id)} → image</option>)}</select></label><button onClick={() => patch({ imageInputs: mappings.filter((_item, i) => i !== index) })}>移除第 {index + 1} 张映射</button></div>)}
      <button disabled={mappings.length >= Math.min(maxComfyReferenceImages, images.length)} onClick={() => { const nodeId = images.find((id) => !mappings.some((entry) => entry.nodeId === id)); if (nodeId) patch({ imageInputs: [...mappings, { nodeId, input: 'image' }] }); }}>添加参考图映射</button>
      <span>已配置 {mappings.filter((entry) => images.includes(entry.nodeId)).length} / {Math.min(maxComfyReferenceImages, images.length)} 个参考图入口</span>
      </section>}
      <section className="comfyui-section comfyui-parameters"><h3>生成参数</h3><p>「生成数量」设为多张时，会逐张生成并汇总结果，最多 {maxComfyOutputImages} 张；随机种子每张重新取值，固定种子可能生成相同图片。生成后可逐张选择保留。</p>
        {parametersOnly && <p>沿用本次的提示词、参考图和工作流。尺寸由工作流控制：选择「跟随参考图」时以图片为准；要用自定义宽高，请同时调整对应的尺寸来源或分辨率档位。</p>}
        {!record && !error && <p>正在读取参数定义…</p>}
        <div className="comfyui-parameter-grid">
        {parameters.filter(isCommonParameter).map(renderParameter)}
        </div>
        <details className="comfyui-more-parameters"><summary>更多参数 · 模型与保存设置（{parameters.filter((field) => !isCommonParameter(field)).length}）</summary><div className="comfyui-parameter-grid">{parameters.filter((field) => !isCommonParameter(field)).map(renderParameter)}</div></details>
      </section>
    </>}
  </fieldset>;
}

export default function ComfyuiConfiguration({ value = {}, onChange, adapterId, parametersOnly = false, buttonLabel = '配置 ComfyUI', applyLabel = '应用到节点' }) {
  const [draft, setDraft] = useState(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function close() { setDraft(null); setError(''); }
  function apply(event) {
    const invalid = event.currentTarget.closest('dialog').querySelector('[aria-invalid="true"]');
    if (invalid) { setError('请修正标记的参数后应用。'); for (let parent = invalid.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; invalid.focus(); return; }
    try {
      const { promptMode, ...mapping } = draft;
      const config = comfyuiConfig(mapping);
      configuredComfyuiWorkflow(config, { requirePrompt: draft.promptMode !== 'workflow' });
      onChange(draft); close();
    } catch (failure) { setError(failure.message); }
  }
  return <>
    <div className="comfyui-summary">
      <strong>{value.workflowName || '尚未选择 ComfyUI 工作流'}</strong>
      {value.workflow && <small>{value.promptMode === 'workflow' ? '沿用原提示词' : '使用上游提示词'} · {value.imageInputs?.filter((entry) => entry.nodeId).length || 0} 个参考图入口</small>}
      <button type="button" onClick={() => { setDraft(structuredClone(value)); setError(''); }}>{buttonLabel}</button>
    </div>
    {draft && <Dialog open label={parametersOnly ? '本次生图参数' : '配置 ComfyUI'} className="comfyui-dialog" onClose={close} onKeyDown={(event) => event.stopPropagation()}>
      <header className="comfyui-dialog-header"><div><h2>{parametersOnly ? '本次生图参数' : '配置 ComfyUI'}</h2><p>{parametersOnly ? '只用于新一次运行，不修改流程默认值或已有结果。固定 seed 和相同输入可能生成相同图片。' : '选择已保存的工作流，设置本节点的输入与生成参数。'}</p></div><button type="button" aria-label="关闭 ComfyUI 配置" onClick={close}>关闭</button></header>
      <div className="comfyui-dialog-body"><ComfyuiEditor value={draft} onChange={(next) => { setDraft(next); setError(''); }} adapterId={adapterId} onBusyChange={setBusy} parametersOnly={parametersOnly} /></div>
      <footer className="comfyui-dialog-footer">{error && <p role="alert">{error}</p>}<button type="button" onClick={close}>取消</button><button type="button" className="primary" disabled={busy} onClick={apply}>{applyLabel}</button></footer>
    </Dialog>}
  </>;
}
