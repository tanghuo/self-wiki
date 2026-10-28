import { useEffect, useRef, useState } from 'react';
import { request } from '../../api.js';
import { configuredComfyuiWorkflow, maxComfyWorkflowBytes, maxComfyReferenceImages } from '../../../../shared/domain/comfyui.js';

function WorkflowParameter({ field, value, onChange }) {
  const label = `工作流参数 ${field.label}`;
  if (field.type === 'BOOLEAN') return <label><input aria-label={label} type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />{field.label}</label>;
  if (field.type === 'COMBO') return <label>{field.label}<select aria-label={label} value={JSON.stringify(value)} onChange={(event) => onChange(JSON.parse(event.target.value))}>{!field.options.some((option) => option === value) && <option value={JSON.stringify(value)}>{String(value)}（当前值）</option>}{field.options.map((option) => <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{String(option)}</option>)}</select></label>;
  if (field.type === 'INT' || field.type === 'FLOAT') return <label>{field.label}<input aria-label={label} type="number" min={field.min} max={field.max} step={field.type === 'INT' ? 1 : field.step || 'any'} defaultValue={value} key={value} onBlur={(event) => {
    const control = event.target, number = control.valueAsNumber;
    if (control.value !== '' && control.validity.valid && Number.isFinite(number) && (field.type !== 'INT' || Number.isSafeInteger(number))) { control.setCustomValidity(''); onChange(number); }
    else { control.value = String(value); control.setCustomValidity(''); }
  }} /></label>;
  const props = { 'aria-label': label, value, maxLength: 12000, onChange: (event) => onChange(event.target.value) };
  return <label>{field.label}{field.multiline ? <textarea {...props} /> : <input {...props} />}</label>;
}
export default function ComfyuiConfiguration({ value = {}, onChange, adapterId }) {
  const endpoint = '/api/workflows/adapters/' + encodeURIComponent(adapterId);
  const operation = useRef(0);
  const describedGraph = useRef(null);
  useEffect(() => () => { operation.current++; }, []);
  const [listing, setListing] = useState(null), [record, setRecord] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let alive = true; request(endpoint + '/workflows').then((result) => { if (alive) setListing(result); }).catch((failure) => { if (alive) setError(failure.message); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (!value.workflow || describedGraph.current === value.workflow) return;
    let alive = true;
    describedGraph.current = value.workflow;
    setRecord(null);
    request(`${endpoint}/load`, { method: 'POST', body: JSON.stringify({ workflow: value.workflow, name: value.workflowName }) }).then((result) => {
      if (alive) setRecord({ ...result, workflow: value.workflow });
    }).catch((failure) => { if (alive) setError(`读取参数定义失败：${failure.message}`); });
    return () => { alive = false; if (describedGraph.current === value.workflow) describedGraph.current = null; };
  }, [value.workflow, value.workflowName]);
  async function refresh() { setBusy(true); setError(''); try { setListing(await request(endpoint)); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }
  async function load(payload) {
    const sequence = ++operation.current;
    setBusy(true); setError('');
    try {
      const result = await request(`${endpoint}/load`, { method: 'POST', body: JSON.stringify(payload) });
      if (sequence !== operation.current) return;
      describedGraph.current = result.workflow;
      setRecord(result);
      const candidates = result.fields.filter((field) => field.type === 'STRING' && ['text', 'prompt', 'positive'].includes(field.input));
      const outputNodeId = result.outputs.length === 1 ? result.outputs[0].nodeId : '';
      const reachable = outputNodeId ? configuredComfyuiWorkflow({ workflow: result.workflow, outputNodeId, prompt: null, imageInputs: [] }, { requirePrompt: false }) : {};
      const images = Object.keys(reachable).filter((id) => reachable[id].class_type === 'LoadImage' && typeof reachable[id].inputs.image === 'string');
      onChange({ workflow: result.workflow, workflowName: result.name.replace(/[\r\n\0]/g, ' ').slice(0, 240), promptMode: 'input', prompt: candidates.length === 1 ? { nodeId: candidates[0].nodeId, input: candidates[0].input } : null, outputNodeId, imageInputs: images.length === 1 ? [{ nodeId: images[0], input: 'image' }] : [] });
    } catch (failure) { if (sequence === operation.current) setError(failure.message); } finally { if (sequence === operation.current) setBusy(false); }
  }
  const graph = value.workflow || {};
  const label = (id) => `${graph[id]?._meta?.title || graph[id]?.class_type || '节点'} · #${id}`;
  const fields = Object.entries(graph).flatMap(([nodeId, node]) => node.class_type === 'LoadImage' ? [] : Object.entries(node.inputs).filter(([, field]) => typeof field === 'string').map(([input]) => ({ nodeId, input })));
  const outputIds = record?.workflow === value.workflow ? record.outputs.map((entry) => entry.nodeId) : Object.keys(graph).filter((id) => ['SaveImage', 'PreviewImage'].includes(graph[id].class_type) || id === value.outputNodeId);
  let reachable = graph;
  try { if (value.outputNodeId) reachable = configuredComfyuiWorkflow({ ...value, prompt: null, imageInputs: [] }, { requirePrompt: false }); } catch { /* Incomplete choices are validated before execution. */ }
  const images = Object.keys(reachable).filter((id) => graph[id].class_type === 'LoadImage' && typeof graph[id].inputs.image === 'string');
  const mappings = value.imageInputs || [];
  const patch = (fields) => onChange({ ...value, ...fields });
  const parameters = (record?.workflow === value.workflow ? record.fields : []).filter((field) => reachable[field.nodeId] && graph[field.nodeId]?.class_type !== 'LoadImage' && !(value.promptMode !== 'workflow' && value.prompt?.nodeId === field.nodeId && value.prompt.input === field.input));
  function changeParameter(field, nextValue) {
    const node = graph[field.nodeId];
    const nextGraph = { ...graph, [field.nodeId]: { ...node, inputs: { ...node.inputs, [field.input]: nextValue } } };
    describedGraph.current = nextGraph;
    setRecord((previous) => ({ ...previous, workflow: nextGraph }));
    patch({ workflow: nextGraph });
  }
  return <fieldset className="workflow-binding" disabled={busy}><legend>ComfyUI 工作流与映射</legend>
    <label>已保存的工作流<select aria-label="ComfyUI 工作流" value={record?.workflow === value.workflow && record.path ? record.path : listing?.workflows.some((entry) => entry.path === value.workflowName) ? value.workflowName : ''} onChange={(event) => { if (event.target.value) load({ path: event.target.value }); }}><option value="">选择 ComfyUI 中已保存的工作流…</option>{listing?.workflows.map((entry) => <option key={entry.path} value={entry.path}>{entry.name}</option>)}</select></label>
    <button onClick={refresh}>刷新工作流列表</button>
    {listing && !listing.workflows.length && <p>没有已保存的工作流，请先在 ComfyUI 中保存后刷新。</p>}
    <label>导入 API 工作流<input type="file" accept=".json,application/json" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { if (file.size > maxComfyWorkflowBytes) throw new Error('工作流最多 512 KiB'); await load({ workflow: JSON.parse(await file.text()), name: file.name }); } catch (failure) { setError(failure.message); } }} /></label>
    {busy && <p role="status">正在读取 ComfyUI…</p>}{error && <p role="alert">{error}</p>}
    {!!Object.keys(graph).length && <>
      <strong>当前工作流：{value.workflowName || '已导入的工作流'}</strong>
      <label>图片输出节点<select aria-label="ComfyUI 图片输出节点" value={value.outputNodeId || ''} onChange={(event) => patch({ outputNodeId: event.target.value })}><option value="">选择图片输出…</option>{outputIds.map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></label>
      <label>提示词来源<select aria-label="ComfyUI 提示词来源" value={value.promptMode || 'input'} onChange={(event) => patch({ promptMode: event.target.value, ...(event.target.value === 'workflow' && { prompt: null }) })}><option value="input">用本节点提示词替换指定字段</option><option value="workflow">沿用工作流原有提示词</option></select></label>
      {value.promptMode !== 'workflow' && <label>提示词写入字段<select aria-label="ComfyUI 提示词字段" value={value.prompt ? JSON.stringify(value.prompt) : ''} onChange={(event) => patch({ prompt: event.target.value ? JSON.parse(event.target.value) : null })}><option value="">选择要替换的文本字段…</option>{fields.map((field) => <option key={JSON.stringify(field)} value={JSON.stringify(field)}>{label(field.nodeId)} → {field.input}</option>)}</select></label>}
      <h4>参考图映射（按上游图片列表顺序）</h4>
      {value.imageInputs === undefined && <p>旧配置仅在存在唯一 LoadImage 时自动匹配一张图；请在此明确选择入口。</p>}
      {mappings.map((entry, index) => <div key={index}><label>第 {index + 1} 张参考图<select aria-label={`第 ${index + 1} 张参考图入口`} value={entry.nodeId} onChange={(event) => patch({ imageInputs: mappings.map((item, i) => i === index ? { nodeId: event.target.value, input: 'image' } : item) })}><option value="">选择 LoadImage 图片入口…</option>{images.map((id) => <option key={id} value={id} disabled={mappings.some((item, i) => i !== index && item.nodeId === id)}>{label(id)} → image</option>)}</select></label><button onClick={() => patch({ imageInputs: mappings.filter((_item, i) => i !== index) })}>移除第 {index + 1} 张映射</button></div>)}
      <button disabled={mappings.length >= Math.min(maxComfyReferenceImages, images.length)} onClick={() => patch({ imageInputs: [...mappings, { nodeId: '', input: 'image' }] })}>添加参考图映射</button>
      <p>只有一个候选的入口会自动填写，仍可修改；多个候选时需要选择。这里的映射不会创建画布连线。</p>
      <p>最多 8 张，每张对应一个不同的 LoadImage.image。未传参考图时保留工作流原图片；传图时数量必须与映射一致。</p>
      <details><summary>工作流参数（{parameters.length}）</summary>
        <p>修改当前节点保存的工作流参数。数字修改后离开输入框生效，超出范围会恢复原值。提示词替换字段与图片入口在上方配置。</p>
        {!record && !error && <p>正在读取参数定义…</p>}
        {parameters.map((field) => <WorkflowParameter key={`${field.nodeId}:${field.input}`} field={field} value={graph[field.nodeId].inputs[field.input]} onChange={(nextValue) => changeParameter(field, nextValue)} />)}
      </details>
    </>}
  </fieldset>;
}
