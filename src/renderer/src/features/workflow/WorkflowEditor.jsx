import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, applyNodeChanges, useUpdateNodeInternals } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { acceptedTypes, inferGraphTypes, setNodeBinding, canAppendTextReference } from './workflowBindings.js';
import ModelAdapterFields, { newAdapterConfig } from '../modelAdapters/ModelAdapterFields.jsx';
import WorkflowTextField from './WorkflowTextField.jsx';
import { variableLabel, nodeDisplayName, workflowSteps, stepLabel, stepConnections, isPreparationInput, typeLabel } from './workflowLabels.js';
import WorkflowContentField from './WorkflowContentField.jsx';
import WorkflowOutputs from './WorkflowOutputs.jsx';
import { nodeTypes as catalog, inputPorts, outputVariables, outputBindingType, outputPortName, downstreamClosure, bindings, validateDefinition, matchesType, listItemType, bindingHandle, isRuntimeElement } from '../../../../shared/domain/workflow/contracts.js';
import { workflowNode, constant, output } from '../../../../shared/domain/workflow/examples.js';

const options = ['text', 'number', 'boolean', 'json', 'image', 'list<text>', 'list<number>', 'list<boolean>', 'list<json>', 'list<image>'];
const typeLabels = { text: '文字', number: '数字', boolean: '开关', json: '结构化数据', image: '单张图片', 'list<text>': '多段文字', 'list<number>': '数字列表', 'list<boolean>': '开关列表', 'list<json>': '数据列表', 'list<image>': '多张图片' };
const portLabels = { value: '内容', prompt: '提示词', images: '参考图片', items: '待处理列表', a: '内容一', b: '内容二' };
const hints = { agent: '仅使用指定应用工具；无 Shell 和项目文件权限', element: '文字或图片：固定内容，或每次运行时填写', template: '拼接文字和前面步骤的结果', model: 'AI 看图或读文字，写出文字', 'image.generate': '按提示词和参考图生成图片', transform: '提取、收集或配对内容（高级）', foreach: '对列表里的每一项做同样的步骤', review: '暂停下来，等你确认、修改或跳过；通过不等于保存', preview: '查看前面步骤的结果', 'library.save': '执行到这里才存进资料库' };
const palette = [{ type: 'element', label: typeLabel('element'), hint: hints.element }, ...catalog.filter((n) => !['input', 'element', 'preview', 'template'].includes(n.type)).map((n) => ({ ...n, label: typeLabel(n.type), hint: hints[n.type] }))];
const paletteGroups = [{ title: '内容', types: ['element'] }, { title: 'AI 与处理', types: ['model', 'agent', 'image.generate', 'foreach', 'transform'] }, { title: '我来确认', types: ['review'] }, { title: '保存', types: ['library.save'] }];
const labels = Object.fromEntries(catalog.map((n) => [n.type, typeLabel(n.type)]));
export function WorkflowPlan({ definition, onLocate, activeNodeId, scope = null }) {
  // Numbers always come from the whole flow so a loop's steps keep the numbers shown on the canvas.
  const allSteps = workflowSteps(definition), steps = scope ? allSteps.filter((step) => step.parentId === scope) : allSteps;
  const reviews = steps.filter((step) => step.node.type === 'review');
  const saves = steps.filter((step) => step.node.type === 'library.save');
  return <div className="workflow-plan-body"><h3>{scope ? '循环里的步骤' : '处理流程'} <small>共 {steps.length} 步</small></h3>{steps.length ? <ol>{steps.map((step) => {
    const { sources, targets } = stepConnections(step, allSteps);
    const editable = step.depth === 0 && isPreparationInput(step.node);
    const text = step.node.config.parts?.map((part) => part.kind === 'text' ? part.text : '').join('') || (typeof step.node.config.default === 'string' ? step.node.config.default : '');
    return <li key={step.id} data-node-id={step.id} data-active={activeNodeId === step.id} style={{ marginLeft: step.depth * 16 }}><span className="workflow-plan-number" aria-hidden="true">{step.number}</span><div>{editable && onLocate ? <button className="workflow-plan-locate" aria-label={'定位' + stepLabel(step)} onClick={() => onLocate(step.id)}>{step.name}</button> : <strong>{step.name}</strong>}{['element', 'template'].includes(step.node.type) && !isPreparationInput(step.node) && <small>运行时自动使用前面步骤的结果，不用填写</small>}{sources.length > 0 && <small>来自：{sources.map(stepLabel).join('、')}</small>}{targets.length > 0 && <small>用于：{targets.map(stepLabel).join('、')}</small>}{text.trim() && <small className="workflow-plan-excerpt">{text.trim().slice(0, 90)}</small>}{!sources.length && !targets.length && <small>{hints[step.node.type] || '内容'}</small>}</div></li>;
  })}</ol> : <p>{scope ? '循环里还没有步骤，从左侧添加。' : '还没有步骤，请返回修改流程添加。'}</p>}</div>;
}
function LoopOutputSelect({ nodes, value, onChange }) {
  const choices = nodes.flatMap((node) => outputVariables(node).map((v) => ({ label: `${nodeDisplayName(node)} / ${variableLabel(v)}（${typeLabels[v.type] || v.type}）`, ref: { kind: 'output', nodeId: node.id, port: v.port, path: v.path } })));
  const index = choices.findIndex((v) => v.ref.nodeId === value.nodeId && v.ref.port === outputPortName(nodes.find((n) => n.id === value.nodeId), value.port) && JSON.stringify(v.ref.path) === JSON.stringify(value.path || []));
  return <select aria-label="循环输出变量" value={index} onChange={(e) => onChange(choices[Number(e.target.value)].ref)}><option value={-1} disabled>原来的结果已不存在，请重新选择</option>{choices.map((v, i) => <option key={i} value={i}>{v.label}</option>)}</select>;
}
function FlowNode({ data, selected }) {
  const n = data.node, ports = inputPorts(n);
  const contentNode = ['element', 'input'].includes(n.type);
  const kind = contentNode ? n.config.valueType?.includes('image') ? '图片' : typeLabels[n.config.valueType] || '文字' : labels[n.type];
  const title = nodeDisplayName(n);
  const runtime = n.type === 'input' || n.type === 'element' && n.config.source === 'runtime';
  const imageContent = contentNode && n.config.valueType?.includes('image');
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(n.id); }, [n.id, n.config.parts, n.config.outputType, n.config.source, n.config.valueType, n.config.default, n.inputs, updateNodeInternals]);
  return <div className={`workflow-node ${selected ? 'selected' : ''} ${data.hasIssue ? 'has-issue' : ''}`}>
    {data.stepNumber && <small className="workflow-canvas-step">第 {data.stepNumber} 步</small>}{data.hasIssue && <small className="workflow-node-issue">需要处理</small>}
    {title !== kind && <small>{kind}</small>}<strong>{title}</strong>
    {runtime && <small>每次运行时填写</small>}
    {n.type === 'element' && n.config.source === 'fixed' && n.config.valueType === 'text' && !n.config.parts && <p className="workflow-node-excerpt">{typeof n.config.default === 'string' ? n.config.default.slice(0, 100) || '填写文字' : n.config.default?.elementId ? '已选资料库文字' : '填写文字'}</p>}
    {n.type === 'element' && n.config.parts && <p className="workflow-node-excerpt">{n.config.parts.map((p) => p.kind === 'text' ? p.text : '【引用】').join('').slice(0, 100)}</p>}
    {imageContent && n.config.source === 'fixed' && <p className="workflow-node-excerpt">{Array.isArray(n.config.default) ? n.config.default.length ? `已选 ${n.config.default.length} 张` : '选择图片' : n.config.default ? '已选 1 张' : '选择图片'}</p>}
    {contentNode && !imageContent && Array.isArray(n.config.default) && <small>已选 {n.config.default.length} 项</small>}
    <div className="workflow-node-inputs">{Object.keys(ports).map((key) => <div key={key}><Handle type="target" position={Position.Left} id={key} /><span>{data.portNames?.[key] || portLabels[key] || key}</span></div>)}{n.type === 'foreach' && <div><Handle type="target" position={Position.Left} id="capture:new" /><span>＋带入循环外的内容</span></div>}</div>
    {(n.type === 'template' || n.type === 'element' && n.config.source === 'fixed') && n.config.parts?.map((part, i) => part.kind === 'ref' && <div key={i} className="workflow-template-handle"><Handle type="target" position={Position.Left} id={`template:${i}`} /><span>引用 {n.config.parts.slice(0, i + 1).filter((p) => p.kind === 'ref').length}</span></div>)}
    {canAppendTextReference(n) && <div className="workflow-template-handle"><Handle type="target" position={Position.Left} id="template:new" aria-label="接入文字" /><span>＋接入文字</span></div>}
    {Object.entries(n.inputs || {}).flatMap(([port, b]) => b?.kind === 'text' ? b.parts.map((p, i) => p.kind === 'ref' && <div key={`${port}:${i}`} className="workflow-template-handle"><Handle type="target" position={Position.Left} id={`text:${port}:${i}`} /><span>{portLabels[port] || port} · 引用 {i + 1}</span></div>) : [])}
    <div className="workflow-node-outputs">{outputVariables(n).filter((v) => !v.path.length).map((v) => <div key={v.port}><span title={v.port}>{variableLabel(v)}</span><Handle type="source" position={Position.Right} id={v.port} aria-label={`输出 ${v.name}`} /></div>)}</div>
    {n.type === 'foreach' && <button className="nodrag" onClick={() => data.enter(n.id)}>打开循环里的步骤 →</button>}
  </div>;
}
const flowTypes = { workflow: FlowNode };
function WorkflowEdge(props) {
  const { deleteElements } = useReactFlow();
  const [path, labelX, labelY] = getBezierPath(props);
  return <>
    <BaseEdge id={props.id} path={path} label={props.label} labelX={labelX} labelY={labelY} style={props.style} markerStart={props.markerStart} markerEnd={props.markerEnd} interactionWidth={props.interactionWidth} />
    {props.selected && <EdgeLabelRenderer><button type="button" className="workflow-edge-delete nodrag nopan" style={{ transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY - 12}px)` }} onClick={(event) => { event.stopPropagation(); deleteElements({ edges: [{ id: props.id }] }); }}>× 删除连线</button></EdgeLabelRenderer>}
  </>;
}
const edgeTypes = { default: WorkflowEdge };
export function WorkflowGraphSnapshot({ definition }) {
  const [scope, setScope] = useState(null);
  const parent = definition.nodes.find((n) => n.id === scope), graph = parent?.config.body || definition;
  const numbers = new Map(workflowSteps(definition).map((step) => [step.id, step.number]));
  const nodes = graph.nodes.map((n, index) => ({ id: n.id, type: 'workflow', position: n.position || { x: index * 260, y: 0 }, data: { node: n, enter: setScope, stepNumber: numbers.get(scope ? scope + '/' + n.id : n.id) } }));
  const edges = graph.nodes.flatMap((n) => bindings(n).filter(({ binding }) => binding?.kind === 'output' && binding.nodeId).map(({ field, binding }, i) => ({ id: `${n.id}:${i}`, source: binding.nodeId, sourceHandle: outputPortName(graph.nodes.find((source) => source.id === binding.nodeId), binding.port), target: n.id, targetHandle: bindingHandle(field) })));
  return <div className="workflow-frozen-graph"><button disabled={!parent} onClick={() => setScope(null)}>主流程</button><span>{parent ? parent.name || parent.id : '这次运行用的流程（只读）'}</span><div style={{ height: 420 }}><ReactFlow key={scope || 'root'} nodes={nodes} edges={edges} nodeTypes={flowTypes} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} fitView fitViewOptions={{ maxZoom: 1, padding: 0.2 }}><Background /><Controls /></ReactFlow></div></div>;
}
function defaultConfig(type) {
  if (type === 'element') return { parameter: `content_${crypto.randomUUID().slice(0, 8)}`, source: 'fixed', valueType: 'text', default: '' };
  if (type === 'input') return { parameter: `input_${Date.now()}`, valueType: 'text', required: true, default: '' };
  if (type === 'template') return { parts: [{ kind: 'text', text: '' }] };
  if (['model', 'agent'].includes(type)) return { outputType: 'text', parameters: {} };
  if (type === 'image.generate') return { parameters: {} };
  if (type === 'foreach') return { itemsType: 'list<image>', maxItems: 1000, captureTypes: {}, body: { nodes: [], outputs: {} } };
  if (type === 'transform') return { operation: 'field', path: [], valueType: 'json' };
  if (type === 'library.save') return { valueType: 'text', tags: [], source: '工作流产物' };
  return { valueType: 'text' };
}
function JsonField({ label, value, onChange }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2)), [error, setError] = useState('');
  return <label>{label}<textarea className="workflow-code" value={text} rows={6} onChange={(e) => { setText(e.target.value); try { const v = JSON.parse(e.target.value); onChange(v); setError(''); } catch { setError('JSON 尚未完整'); } }} />{error && <small role="status">{error}</small>}</label>;
}
function BindingField({ label, displayLabel, value, type, nodes, selected, parent, onChange }) {
  const mode = value?.kind === 'text' ? 'constant' : value?.kind || 'unbound';
  const source = nodes.find((n) => n.id === value?.nodeId);
  const target = nodes.find((n) => n.id === selected);
  const accepts = acceptedTypes(target, label, type);
  const unavailable = downstreamClosure(nodes, [selected]);
  const choices = nodes.filter((n) => !unavailable.has(n.id)).flatMap((n) => outputVariables(n).filter((v) => accepts.includes(v.type)).map((v) => ({ label: `${nodeDisplayName(n)} / ${variableLabel(v)} (${typeLabels[v.type] || v.type})`, binding: { kind: 'output', nodeId: n.id, port: v.port, path: v.path } })));
  const scoped = parent ? [
    ...(accepts.includes(listItemType(parent.config.itemsType)) ? [{ label: '这一项', binding: { kind: 'item' } }] : []),
    ...(accepts.includes('number') ? [{ label: '这一项的序号', binding: { kind: 'index' } }] : []),
    ...(accepts.includes('text') ? [{ label: '这一项的编号', binding: { kind: 'itemId' } }] : []),
    ...Object.keys(parent.config.captureTypes || {}).filter((key) => accepts.includes(parent.config.captureTypes[key])).map((key) => ({ label: `循环外：${parent.captureLabels?.[key] || key}`, binding: { kind: 'capture', name: key } })),
  ] : [];
  const all = [...choices, ...scoped];
  const choiceIndex = all.findIndex(({ binding }) => binding.kind === value?.kind && (binding.kind === 'output' ? binding.nodeId === value.nodeId && binding.port === outputPortName(source, value.port) && JSON.stringify(binding.path) === JSON.stringify(value.path || []) : binding.kind !== 'capture' || binding.name === value.name));
  const textParts = value?.kind === 'text' ? value.parts : value?.kind === 'constant' || !value || value.kind === 'output' && !value.nodeId ? [{ kind: 'text', text: typeof value?.value === 'string' ? value.value : '' }] : [{ kind: 'ref', ref: value }];
  const setTextParts = (parts) => onChange(parts.some((p) => p.kind === 'ref') ? { kind: 'text', parts } : constant(parts.map((p) => p.text).join('')));
  if (type === 'text' && ['model', 'agent', 'image.generate'].includes(target?.type) && label === 'prompt') return <WorkflowTextField label="提示词" parts={textParts} nodes={nodes} selected={selected} parent={parent} onChange={setTextParts} />;
  return <fieldset className="workflow-binding"><legend>{displayLabel || portLabels[label] || label}</legend>
    <select aria-label={`${label}输出变量`} value={choiceIndex >= 0 ? String(choiceIndex) : mode === 'constant' ? 'constant' : ''} onChange={(e) => onChange(e.target.value === 'constant' ? constant(type.startsWith('list<') ? [] : type === 'number' ? 0 : type === 'boolean' ? false : type === 'json' ? {} : '') : all[Number(e.target.value)].binding)}>
      <option value="" disabled>{value?.nodeId ? '来源不可用，重新选择…' : type.includes('image') ? '＋选择参考图片来源' : '选择内容来源…'}</option>
      {type !== 'image' && <option value="constant">{type.includes('image') ? '不使用参考图片' : '直接填写'}</option>}
      {!!choices.length && <optgroup label="前面步骤的结果">{choices.map((choice, i) => <option key={i} value={i}>{choice.label}</option>)}</optgroup>}
      {!!scoped.length && <optgroup label="循环里">{scoped.map((choice, i) => <option key={i} value={choices.length + i}>{choice.label}</option>)}</optgroup>}
    </select>
    {choiceIndex >= 0 && <button onClick={() => onChange(type === 'list<image>' ? constant([]) : output(''))}>断开{portLabels[label] || label}</button>}
    {mode === 'constant' && !type.includes('image') && (type === 'text' ? <WorkflowTextField label={`${label}固定值`} parts={textParts} nodes={nodes} selected={selected} parent={parent} onChange={setTextParts} /> : type === 'number' ? <input aria-label={`${label}固定值`} type="number" value={value?.value ?? 0} onChange={(e) => onChange(constant(Number(e.target.value)))} /> : type === 'boolean' ? <select value={String(value?.value ?? false)} onChange={(e) => onChange(constant(e.target.value === 'true'))}><option>false</option><option>true</option></select> : <JsonField key={`${selected}:${label}:constant`} label="JSON 值" value={value?.value ?? (type.startsWith('list<') ? [] : {})} onChange={(v) => onChange(constant(v))} />)}
  </fieldset>;
}
export default function WorkflowEditor({ definition, onChange, onPreview, issues = [], locate = null, adapters = [], active = true }) {
  const [scope, setScope] = useState(null), [selected, setSelected] = useState(null), [search, setSearch] = useState(''), [selectedIds, setSelectedIds] = useState([]);
  const [history, setHistory] = useState([]), [future, setFuture] = useState([]);
  const [nodeViews, setNodeViews] = useState({});
  const [selectedEdgeIds, setSelectedEdgeIds] = useState([]);
  const reconnecting = useRef(null);
  useEffect(() => {
    const cancel = (event) => { if (event.key === 'Escape' && reconnecting.current) reconnecting.current.cancelled = true; };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, []);
  const clipboard = useRef(null), flow = useRef(null), wrapper = useRef(null), flowNodeCache = useRef(new Map()), wasActive = useRef(active);
  useEffect(() => {
    if (!active || wasActive.current) { wasActive.current = active; return; }
    wasActive.current = active;
    const frame = requestAnimationFrame(() => { flow.current?.fitView({ padding: 0.2, maxZoom: 1 }); window.dispatchEvent(new Event('resize')); });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  const enterScope = useCallback((id) => { setScope(id); setSelected(null); setSelectedIds([]); setSelectedEdgeIds([]); }, []);
  useEffect(() => {
    // Jump to the step named by a problem in the issue list, entering its loop when needed.
    if (!locate || !active) return;
    const inScope = locate.scope ? definition.nodes.find((n) => n.id === locate.scope)?.config.body?.nodes : definition.nodes;
    if (!inScope?.some((n) => n.id === locate.nodeId)) return;
    setScope(locate.scope || null); setSelected(locate.nodeId); setSelectedIds([locate.nodeId]); setSelectedEdgeIds([]);
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => flow.current?.fitView({ nodes: [{ id: locate.nodeId }], padding: 0.6, maxZoom: 1, duration: 200 })));
    return () => cancelAnimationFrame(frame);
  }, [locate, active]);
  const parentNode = scope && definition.nodes.find((n) => n.id === scope);
  const parent = parentNode && { ...parentNode, captureLabels: Object.fromEntries(Object.keys(parentNode.config.captureTypes || {}).map((key) => [key, definition.nodes.find((n) => n.id === parentNode.inputs?.[key]?.nodeId)?.name || key])) };
  const graph = parent?.config.body || definition;
  useEffect(() => {
    // Reframe when the graph gains/loses nodes, never while dragging or typing.
    const frame = requestAnimationFrame(() => flow.current?.fitView({ padding: 0.2, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [graph.nodes.length, scope]);
  function commit(next) { setHistory((h) => [...h.slice(-49), definition]); setFuture([]); onChange(next); }
  function updateGraph(nextGraph) { nextGraph = inferGraphTypes(nextGraph, parent); commit(parent ? { ...definition, nodes: definition.nodes.map((n) => n.id === scope ? { ...n, config: { ...n.config, body: nextGraph } } : n) } : nextGraph); }
  function updateNode(id, patch) { updateGraph({ ...graph, nodes: graph.nodes.map((n) => n.id === id ? { ...n, ...patch } : n) }); }
  function setConfig(id, patch) { const n = graph.nodes.find((n) => n.id === id); updateNode(id, { config: { ...n.config, ...patch } }); }
  function changeValueType(node, type) {
    const config = { ...node.config, valueType: type };
    if (type !== 'text') delete config.parts;
    if (['input', 'element'].includes(node.type)) {
      if (Object.hasOwn(config, 'default') && !matchesType(config.default, type)) delete config.default;
      if (!type.startsWith('list<')) delete config.allowEmpty;
      if (node.type === 'element' && type === 'list<image>') config.allowEmpty = false;
    }
    if (!parent && !config.parameter && node.type === 'element') config.parameter = `content_${crypto.randomUUID().slice(0, 8)}`;
    updateNode(node.id, { config });
  }
  function setElementText(node, parts) {
    const config = { ...node.config };
    if (parent || parts.some((part) => part.kind === 'ref')) { config.parts = parts; delete config.default; }
    else { delete config.parts; config.default = parts.map((part) => part.text).join(''); config.parameter ||= `content_${crypto.randomUUID().slice(0, 8)}`; }
    updateNode(node.id, { config });
  }
  function add(type, position) {
    if (parent && ['input', 'foreach'].includes(type)) return;
    const id = `n_${crypto.randomUUID().slice(0, 8)}`, node = workflowNode(id, type, defaultConfig(type), {}, position || { x: graph.nodes.length * 280, y: 0 });
    if (['model', 'agent', 'image.generate'].includes(type)) { const adapter = adapters.find((entry) => entry.nodeType === type); if (!adapter) return; node.config = newAdapterConfig(adapter); }
    if (parent && type === 'element') node.config = { source: 'fixed', valueType: 'text', parts: [{ kind: 'text', text: '' }] };
    node.name = labels[type]; updateGraph({ ...graph, nodes: [...graph.nodes, node] }); setSelected(id);
  }
  function bind(id, handle, binding) {
    updateGraph({ ...graph, nodes: graph.nodes.map((node) => node.id === id ? setNodeBinding(node, handle, binding) : node) });
  }
  function disconnectEdges(disconnected) {
    setSelectedEdgeIds((ids) => ids.filter((id) => !disconnected.some((edge) => edge.id === id)));
    let changed = false;
    const nodes = graph.nodes.map((node) => {
      let next = node;
      for (const edge of disconnected.filter((e) => e.target === node.id)) {
        if (!bindings(next).some(({ field, binding }) => binding?.kind === 'output' && binding.nodeId === edge.source && bindingHandle(field) === edge.targetHandle)) continue;
        next = setNodeBinding(next, edge.targetHandle, null); changed = true;
      }
      return next;
    });
    if (changed) updateGraph({ ...graph, nodes });
  }
  const issueIds = useMemo(() => new Set(issues.filter((issue) => (issue.scope || null) === (scope || null)).map((issue) => issue.nodeId)), [issues, scope]);
  const flowNodes = useMemo(() => {
    const stepNumbers = new Map(workflowSteps(definition).map((step) => [step.id, step.number]));
    const viewFor = (id) => nodeViews[`${scope || 'root'}:${id}`] || {};
    const groups = (graph.layout?.groups || []).map((g) => {
      const members = graph.nodes.filter((n) => g.nodeIds.includes(n.id));
      const left = Math.min(...members.map((n) => n.position?.x || 0)), top = Math.min(...members.map((n) => n.position?.y || 0));
      return members.length ? { id: g.id, type: 'group', ...viewFor(g.id), position: { x: left - 25, y: top - 40 }, data: { label: g.name }, draggable: false, selectable: false, style: { width: Math.max(...members.map((n) => n.position?.x || 0)) - left + 260, height: Math.max(...members.map((n) => n.position?.y || 0)) - top + 220, zIndex: -1, background: '#a8875312', border: '1px dashed #a8875388' } } : null;
    }).filter(Boolean);
    return [...groups, ...graph.nodes.map((n) => {
      const key = `${scope || 'root'}:${n.id}`, view = viewFor(n.id), previous = flowNodeCache.current.get(key), selected = selectedIds.includes(n.id);
      const stepNumber = stepNumbers.get(scope ? scope + '/' + n.id : n.id);
      const portNames = n.type === 'foreach' ? Object.fromEntries(Object.keys(n.config.captureTypes || {}).map((key) => [key, graph.nodes.find((source) => source.id === n.inputs?.[key]?.nodeId)?.name || key])) : undefined;
      const hasIssue = issueIds.has(n.id);
      if (previous?.data.node === n && previous.data.stepNumber === stepNumber && previous.data.hasIssue === hasIssue && previous.selected === selected && previous.measured === view.measured && previous.dragging === view.dragging && JSON.stringify(previous.data.portNames) === JSON.stringify(portNames)) return previous;
      const node = { id: n.id, type: 'workflow', ...view, position: n.position || { x: 0, y: 0 }, selected, data: { node: n, enter: enterScope, portNames, stepNumber, hasIssue } };
      flowNodeCache.current.set(key, node);
      return node;
    })];
  }, [definition.nodes, graph.nodes, graph.layout?.groups, nodeViews, scope, selectedIds, enterScope, issueIds]);
  const edges = useMemo(() => graph.nodes.flatMap((n) => bindings(n).filter(({ binding }) => binding?.kind === 'output' && binding.nodeId).map(({ field, binding }, index) => ({ id: `${scope || 'root'}:${n.id}:${field}:${index}`, selected: selectedEdgeIds.includes(`${scope || 'root'}:${n.id}:${field}:${index}`), source: binding.nodeId, sourceHandle: outputPortName(graph.nodes.find((source) => source.id === binding.nodeId), binding.port), target: n.id, targetHandle: bindingHandle(field), label: binding.path?.length ? binding.path.join('.') : undefined, reconnectable: true, interactionWidth: 28, data: { field } }))), [graph, scope, selectedEdgeIds]);
  const current = graph.nodes.find((n) => n.id === selected), ports = current && inputPorts(current);
  function remove(ids) { updateGraph({ ...graph, nodes: graph.nodes.filter((n) => !ids.includes(n.id)) }); setSelected(null); }
  function paste() {
    if (!clipboard.current?.length) return;
    const mapping = Object.fromEntries(clipboard.current.map((n) => [n.id, `n_${crypto.randomUUID().slice(0, 8)}`]));
    const clones = structuredClone(clipboard.current);
    for (const n of clones) { n.id = mapping[n.id]; if (['element', 'input'].includes(n.type)) n.config.parameter = `content_${crypto.randomUUID().slice(0, 8)}`; n.name = `${n.name || n.id} 副本`; n.position = { x: (n.position?.x || 0) + 50, y: (n.position?.y || 0) + 50 }; for (const { binding } of bindings(n)) if (mapping[binding?.nodeId]) binding.nodeId = mapping[binding.nodeId]; }
    updateGraph({ ...graph, nodes: [...graph.nodes, ...clones] });
  }
  function undo() { if (!history.length) return; setFuture((f) => [definition, ...f]); onChange(history.at(-1)); setHistory((h) => h.slice(0, -1)); }
  function redo() { if (!future.length) return; setHistory((h) => [...h, definition]); onChange(future[0]); setFuture((f) => f.slice(1)); }
  // Stay mounted so undo and selection survive a run, but omit the canvas while inactive so its labels are not in the document.
  if (!active) return null;
  return <div className="workflow-editor" ref={wrapper} onKeyDown={(e) => { if (!(e.ctrlKey || e.metaKey) || e.target.closest('input,textarea,select')) return; if (e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); } if (e.key === 'c') { e.preventDefault(); clipboard.current = graph.nodes.filter((n) => selectedIds.includes(n.id)); } if (e.key === 'v') { e.preventDefault(); paste(); } }}>
    <aside className="workflow-palette"><h3>添加步骤</h3><input aria-label="搜索步骤" placeholder="搜索步骤…" value={search} onChange={(e) => setSearch(e.target.value)} />{paletteGroups.map((group) => {
      const items = palette.filter((n) => group.types.includes(n.type) && n.label.includes(search) && (!parent || n.type !== 'foreach'));
      return items.length ? <div className="workflow-palette-group" key={group.title}><h4>{group.title}</h4>{items.map((n) => <button disabled={['model', 'agent', 'image.generate'].includes(n.type) && !adapters.some((entry) => entry.nodeType === n.type)} draggable key={n.type} onDragStart={(e) => e.dataTransfer.setData('application/workflow-node', n.type)} title="添加这一步" onClick={(event) => { if (event.detail <= 1) add(n.type); }}>{n.label}<small>{n.hint}</small></button>)}</div> : null;
    })}</aside>
    <div className="workflow-canvas-column"><div className="workflow-canvas-toolbar"><button disabled={!parent} onClick={() => { setScope(null); setSelected(null); }}>主流程</button><span>{parent ? `「${nodeDisplayName(parent)}」里的步骤` : '画布'}</span><button disabled={!history.length} onClick={undo}>撤销</button><button disabled={!future.length} onClick={redo}>重做</button><button disabled={!selectedIds.length} onClick={() => { clipboard.current = graph.nodes.filter((n) => selectedIds.includes(n.id)); }}>复制所选</button><button onClick={paste}>粘贴</button><button disabled={!selectedEdgeIds.length} onClick={() => disconnectEdges(edges.filter((edge) => selectedEdgeIds.includes(edge.id)))}>断开连线</button><button disabled={selectedIds.length < 2} onClick={() => updateGraph({ ...graph, layout: { ...graph.layout, groups: [...(graph.layout?.groups || []), { id: `group_${crypto.randomUUID()}`, name: '节点组', nodeIds: selectedIds }] } })}>分组</button><button disabled={!graph.layout?.groups?.some((g) => g.nodeIds.some((id) => selectedIds.includes(id)))} onClick={() => updateGraph({ ...graph, layout: { ...graph.layout, groups: graph.layout.groups.filter((g) => !g.nodeIds.some((id) => selectedIds.includes(id))) } })}>取消分组</button></div>
      <div className="workflow-canvas" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={(e) => { e.preventDefault(); const type = e.dataTransfer.getData('application/workflow-node'); if (palette.some((n) => n.type === type)) add(type, flow.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY })); }}>
        <ReactFlow nodes={flowNodes} edges={edges} nodeTypes={flowTypes} edgeTypes={edgeTypes} onInit={(instance) => { flow.current = instance; }} fitView fitViewOptions={{ maxZoom: 1, padding: 0.2 }} minZoom={0.15} maxZoom={2} deleteKeyCode={['Backspace', 'Delete']} edgesReconnectable reconnectRadius={12}
          onEdgeClick={(event, edge) => { event.stopPropagation(); setSelectedEdgeIds([edge.id]); setSelectedIds([]); setSelected(null); event.currentTarget.focus?.(); }}
          onReconnectStart={(_event, edge) => { reconnecting.current = { edge, connected: false }; }}
          onReconnect={(edge, connection) => {
            if (!reconnecting.current || reconnecting.current.cancelled) return;
            reconnecting.current.connected = true;
            const moved = edge.source === connection.source && edge.sourceHandle === connection.sourceHandle ? bindings(graph.nodes.find((node) => node.id === edge.target)).find(({ field }) => bindingHandle(field) === edge.targetHandle)?.binding : null;
            const binding = moved || { ...output(connection.source), port: connection.sourceHandle || 'value' };
            const nodes = graph.nodes.map((node) => node.id === edge.target ? setNodeBinding(node, edge.targetHandle, null) : node).map((node) => node.id === connection.target ? setNodeBinding(node, connection.targetHandle, binding) : node);
            setSelectedEdgeIds([]); updateGraph({ ...graph, nodes });
          }}
          onReconnectEnd={(event, edge, _type, state) => {
            const attempt = reconnecting.current; reconnecting.current = null;
            if (attempt && !attempt.cancelled && !attempt.connected && event.key !== 'Escape' && !state.toNode && ['mouseup', 'pointerup', 'touchend'].includes(event.type)) disconnectEdges([edge]);
          }}
          selectionOnDrag onNodeClick={(_e, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)}
          onNodeDragStart={() => { setHistory((h) => [...h.slice(-49), definition]); setFuture([]); }}
          onNodesChange={(changes) => {
            const selections = changes.filter((c) => c.type === 'select');
            if (selections.length) setSelectedIds((ids) => { const next = new Set(ids); for (const c of selections) c.selected ? next.add(c.id) : next.delete(c.id); return next.size === ids.length && ids.every((id) => next.has(id)) ? ids : [...next]; });
            const updated = applyNodeChanges(changes, flowNodes);
            // React Flow hides nodes with missing measurements. Keep measured sizes
            // and dragging flags in view state instead of dropping them on each move
            // or serializing these transient fields into the workflow definition.
            setNodeViews((previous) => {
              let next = previous;
              for (const change of changes) {
                if (!['dimensions', 'position'].includes(change.type)) continue;
                const node = updated.find((n) => n.id === change.id);
                if (!node) continue;
                const key = `${scope || 'root'}:${node.id}`, old = previous[key] || {};
                const sameSize = old.measured?.width === node.measured?.width && old.measured?.height === node.measured?.height;
                if (sameSize && old.dragging === node.dragging) continue;
                if (next === previous) next = { ...previous };
                next[key] = { measured: sameSize ? old.measured : node.measured, dragging: node.dragging };
              }
              return next;
            });
            const moves = changes.filter((c) => c.type === 'position');
            if (!moves.length) return;
            let moved = false;
            const next = { ...graph, nodes: graph.nodes.map((n) => {
              const position = updated.find((p) => p.id === n.id)?.position;
              if (!position || position.x === n.position?.x && position.y === n.position?.y) return n;
              moved = true; return { ...n, position };
            }) };
            if (!moved) return;
            if (parent) onChange({ ...definition, nodes: definition.nodes.map((n) => n.id === scope ? { ...n, config: { ...n.config, body: next } } : n) }); else onChange(next);
          }}
          onEdgesChange={(changes) => setSelectedEdgeIds((ids) => { const next = new Set(ids); for (const change of changes) if (change.type === 'select') change.selected ? next.add(change.id) : next.delete(change.id); return next.size === ids.length && ids.every((id) => next.has(id)) ? ids : [...next]; })}
          onNodesDelete={(ns) => remove(ns.map((n) => n.id))} onEdgesDelete={disconnectEdges}
          onConnect={(edge) => { if (edge.source === edge.target) return; bind(edge.target, edge.targetHandle, { ...output(edge.source), port: edge.sourceHandle || 'value' }); if (edge.targetHandle === 'template:new') setSelected(edge.target); }}
          isValidConnection={(edge) => {
            const from = graph.nodes.find((n) => n.id === edge.source), to = graph.nodes.find((n) => n.id === edge.target);
            if (!from || !to || from.id === to.id) return false;
            const expected = /^(template|text):/.test(edge.targetHandle || '') ? 'text' : inputPorts(to)[edge.targetHandle];
            const previous = reconnecting.current?.edge;
            const retained = previous?.source === edge.source && previous.sourceHandle === edge.sourceHandle ? bindings(graph.nodes.find((node) => node.id === previous.target)).find(({ field }) => bindingHandle(field) === previous.targetHandle)?.binding : null;
            const binding = retained || { ...output(from.id), port: edge.sourceHandle || 'value' };
            const actual = outputBindingType(from, binding);
            const inferred = !/^(template|text):/.test(edge.targetHandle || '') && acceptedTypes(to, edge.targetHandle, expected).includes(actual);
            if (!actual || !inferred && actual !== expected) return false;
            const copy = { ...graph, nodes: graph.nodes.map((node) => {
              const oldEdge = reconnecting.current?.edge;
              let next = oldEdge?.target === node.id ? setNodeBinding(node, oldEdge.targetHandle, null) : node;
              if (node.id === to.id) next = setNodeBinding(next, edge.targetHandle, binding);
              return next;
            }) };
            return !validateDefinition(parent ? { ...definition, nodes: definition.nodes.map((n) => n.id === scope ? { ...n, config: { ...n.config, body: copy } } : n) } : copy).errors.some((e) => e.message.includes('循环依赖'));
          }}><Background /><Controls /><MiniMap /></ReactFlow>
      </div>
    </div>
    <aside className="workflow-inspector"><h3>{current ? '这一步的设置' : parent ? '循环概览' : '流程概览'}</h3>{current ? <>
      <button disabled={!onPreview} title={onPreview ? '显示最近一次运行，不会执行新调用' : '先运行流程，再查看节点结果'} onClick={() => onPreview(current.id, scope)}>查看最近运行结果</button><label>显示名称<input value={current.name || ''} onChange={(e) => updateNode(current.id, { name: e.target.value })} /></label><small>给这一步起个好懂的名字。留空时只显示类型。</small>
      {current.type === 'review' && <p>运行到这里会暂停，等你确认、修改或跳过。通过只是让后面的步骤继续，不会自动存进资料库。</p>}
      {current.type === 'library.save' && <p>只有执行到这一步时，才会把结果存进资料库。</p>}
      {current.type === 'element' ? <><label>内容种类<select aria-label="内容种类" value={current.config.valueType?.includes('image') ? 'image' : current.config.valueType || 'text'} onChange={(e) => changeValueType(current, e.target.value === 'image' ? 'list<image>' : e.target.value)}>{[...new Set(['text', ...(!parent ? ['image'] : []), ...(!['text', 'image', 'list<image>'].includes(current.config.valueType || 'text') ? [current.config.valueType] : [])])].map((t) => <option key={t} value={t}>{t === 'image' ? '图片' : typeLabels[t]}</option>)}</select></label></> : current.type === 'input' && <label>内容类型<select aria-label="内容类型" value={current.config.valueType || 'text'} onChange={(e) => changeValueType(current, e.target.value)}>{(current.type === 'review' ? ['text', 'list<image>'] : current.type === 'library.save' ? ['text', 'image', 'list<image>'] : options).map((t) => <option key={t} value={t}>{typeLabels[t]}</option>)}</select></label>}
      {['review', 'preview', 'library.save'].includes(current.type) && <p>内容类型：{current.inputs?.value ? typeLabels[current.config.valueType] || current.config.valueType : '选好内容来源后自动确定'}</p>}
      {current.type === 'element' && <>
        <label>内容来源<select aria-label="内容来源" value={current.config.source} onChange={(e) => { const source = e.target.value, config = { ...current.config, source }; if (source === 'runtime' && config.parts) { config.default = config.parts.filter((p) => p.kind === 'text').map((p) => p.text).join(''); delete config.parts; } config.parameter ||= `content_${crypto.randomUUID().slice(0, 8)}`; updateNode(current.id, { config, inputs: source === 'upstream' ? current.inputs : {} }); }}><option value="fixed">{current.config.parts?.some((p) => p.kind === 'ref') ? '文字与前面步骤的结果' : '固定内容'}</option><option value="runtime" disabled={!!parent || current.config.parts?.some((p) => p.kind === 'ref')}>每次运行时填写</option>{current.config.source === 'upstream' && <option value="upstream">前面步骤的结果（旧流程）</option>}</select></label>
        {current.config.source !== 'upstream' && (parent && current.config.valueType === 'text' ? <WorkflowTextField label="内容" parts={current.config.parts || [{ kind: 'text', text: current.config.default || '' }]} nodes={graph.nodes} selected={current.id} parent={parent} onChange={(parts) => setElementText(current, parts)} /> : <WorkflowContentField key={`${current.id}:${current.config.valueType}`} label={current.config.source === 'fixed' ? '内容' : '预填内容（可选）'} type={current.config.valueType || 'text'} value={current.config.default} renderText={current.config.source === 'fixed' ? (text) => <WorkflowTextField label="内容" parts={current.config.parts || [{ kind: 'text', text }]} nodes={graph.nodes} selected={current.id} parent={parent} onChange={(parts) => setElementText(current, parts)} /> : undefined} onChange={(value) => { const config = { ...current.config }; delete config.parts; config.parameter ||= `content_${crypto.randomUUID().slice(0, 8)}`; if (value === undefined) delete config.default; else config.default = value; updateNode(current.id, { config }); }} />)}
      </>}
      {['model', 'agent', 'image.generate'].includes(current.type) && <ModelAdapterFields node={current} adapters={adapters} onChange={(config) => { const inputs = Object.fromEntries(Object.entries(current.inputs || {}).filter(([key]) => Object.hasOwn(config.adapterInputs || {}, key))); updateNode(current.id, { config, inputs }); }} />}
      {current.type === 'transform' && <label>操作<select aria-label="操作" value={current.config.operation} onChange={(e) => updateNode(current.id, { inputs: {}, config: { ...current.config, operation: e.target.value, valueType: e.target.value === 'field' ? 'json' : ['zip', 'successes'].includes(e.target.value) ? 'list<json>' : e.target.value === 'list' ? 'list<text>' : 'text', ...(e.target.value === 'nth' ? { index: 0 } : {}) } })}>{Object.entries({ ...(current.config.operation === 'concat' ? { concat: '文字拼接（旧配置）' } : {}), field: '提取字段', list: '收集为列表', nth: '取列表中的一项', zip: '按顺序配对', successes: '只保留成功项' }).map(([op, label]) => <option key={op} value={op}>{label}</option>)}</select></label>}
      {current.type === 'transform' && <>
        {['concat', 'list'].includes(current.config.operation) && <><div>{(current.config.keys || ['a', 'b']).map((key, index, keys) => <div key={key}><span>输入 {index + 1}</span><button disabled={keys.length <= 1} onClick={() => { const inputs = { ...current.inputs }; delete inputs[key]; updateNode(current.id, { config: { ...current.config, keys: keys.filter((k) => k !== key) }, inputs }); }}>移除输入 {index + 1}</button></div>)}<button disabled={(current.config.keys || ['a', 'b']).length >= 20} onClick={() => { const keys = current.config.keys || ['a', 'b']; let index = 1; while (keys.includes('part_' + index)) index++; setConfig(current.id, { keys: [...keys, 'part_' + index] }); }}>添加输入</button></div>{current.config.operation === 'concat' && <label>分隔文字<input value={current.config.separator || ''} onChange={(e) => setConfig(current.id, { separator: e.target.value })} /></label>}</>}
        {current.config.operation === 'nth' && <label>取第几项（从 1 开始）<input type="number" min={1} value={(current.config.index || 0) + 1} onChange={(e) => setConfig(current.id, { index: Number(e.target.value) - 1 })} /></label>}
        {current.config.operation === 'field' && <label>字段路径（以 / 分隔）<input value={(current.config.path || []).join('/')} onChange={(e) => setConfig(current.id, { path: e.target.value ? e.target.value.split('/') : [] })} /></label>}
      </>}
      {Object.entries(ports || {}).map(([port, type]) => <BindingField key={`${current.id}:${port}`} label={port} displayLabel={current.type === 'foreach' && port !== 'items' ? (() => { const source = graph.nodes.find((n) => n.id === current.inputs?.[port]?.nodeId); return source ? nodeDisplayName(source) : '带入的内容'; })() : /^part_/.test(port) ? '输入 ' + (Object.keys(ports).indexOf(port) + 1) : undefined} type={type} value={current.inputs?.[port]} nodes={graph.nodes} selected={current.id} parent={parent} onChange={(v) => bind(current.id, port, v)} />)}
      <WorkflowOutputs key={`${current.id}:${current.config.outputType}`} node={current} onChange={(config) => updateNode(current.id, { config })} />
      {current.type === 'foreach' && <><p>列表内容：{typeLabels[current.config.itemsType] || '连接列表后自动确定'}</p><label>最多处理几项<input type="number" min={1} max={1000} value={current.config.maxItems} onChange={(e) => setConfig(current.id, { maxItems: Number(e.target.value) })} /></label><h4>带入循环的内容</h4><select aria-label="带入循环的内容" value="" onChange={(event) => bind(current.id, 'capture:new', JSON.parse(event.target.value))}><option value="">＋带入内容</option>{graph.nodes.filter((node) => !downstreamClosure(graph.nodes, [current.id]).has(node.id)).flatMap((node) => outputVariables(node).map((v) => <option key={`${node.id}:${v.name}`} value={JSON.stringify({ kind: 'output', nodeId: node.id, port: v.port, path: v.path })}>{nodeDisplayName(node)} / {variableLabel(v)}</option>))}</select>{Object.entries(current.config.captureTypes || {}).map(([key, type]) => <div key={key}><p>{(() => { const source = graph.nodes.find((n) => n.id === current.inputs?.[key]?.nodeId); return source ? nodeDisplayName(source) : '已断开的内容'; })()}：{current.inputs?.[key] ? typeLabels[type] || type : '选好内容来源后自动确定'}</p><button onClick={() => { const captureTypes = { ...current.config.captureTypes }, inputs = { ...current.inputs }; delete captureTypes[key]; delete inputs[key]; updateNode(current.id, { config: { ...current.config, captureTypes }, inputs }); }}>移除此内容</button></div>)}<button onClick={() => { setScope(current.id); setSelected(null); }}>编辑循环里的步骤</button></>}
      <details className="workflow-advanced"><summary>高级设置</summary><small>内部标识：{current.id}</small>{current.type === 'transform' && current.config.operation === 'field' && <label>提取结果类型<select aria-label="提取结果类型" value={current.config.valueType || 'json'} onChange={(e) => changeValueType(current, e.target.value)}>{options.map((t) => <option key={t} value={t}>{typeLabels[t]}</option>)}</select><small>无法从结构化数据的字段路径确定结果类型时，可在此指定。</small></label>}{['input', 'element'].includes(current.type) && <label>参数标识<input value={current.config.parameter || ''} onChange={(e) => setConfig(current.id, { parameter: e.target.value })} /></label>}{current.type === 'input' && !['text', 'number', 'boolean', 'image', 'list<image>'].includes(current.config.valueType || 'text') && <JsonField key={`${current.id}:${current.config.valueType}:default`} label="默认值 JSON" value={current.config.default ?? (current.config.valueType?.startsWith('list<') ? [] : {})} onChange={(v) => setConfig(current.id, { default: v })} />}<JsonField key={`${current.id}:${current.config.valueType}:advanced`} label="完整配置 JSON" value={current.config} onChange={(v) => updateNode(current.id, { config: v })} /></details>
      <button className="danger-quiet" onClick={() => remove([current.id])}>删除这一步</button>
    </> : <><p>点选一个步骤来修改它。按住 Shift 可框选多个；Ctrl/Cmd + C、V 复制粘贴，Z 撤销。</p><WorkflowPlan definition={definition} scope={scope} />{parent && <><h4>循环返回的结果</h4>{Object.entries(graph.outputs || {}).map(([key, b], index) => <label key={key}>结果 {index + 1}<LoopOutputSelect nodes={graph.nodes} value={b} onChange={(binding) => updateGraph({ ...graph, outputs: { ...graph.outputs, [key]: binding } })} /><button onClick={() => { const outputs = { ...graph.outputs }; delete outputs[key]; updateGraph({ ...graph, outputs }); }}>删除</button></label>)}<button disabled={!graph.nodes.length} onClick={() => updateGraph({ ...graph, outputs: { ...graph.outputs, [`output_${Object.keys(graph.outputs || {}).length + 1}`]: output(graph.nodes.at(-1).id) } })}>添加返回结果</button></>}</>}
      {(() => { const own = current ? issues.filter((issue) => issue.nodeId === current.id && (issue.scope || null) === (scope || null)) : []; return own.length ? <div className="workflow-errors" role="alert"><strong>这一步还需要处理</strong>{own.map((issue) => <p key={issue.key}>{issue.message}</p>)}</div> : null; })()}
    </aside>
  </div>;
}
