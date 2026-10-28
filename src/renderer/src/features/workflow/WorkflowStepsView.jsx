import { useEffect, useMemo, useState } from 'react';
import { acceptedTypes, inferGraphTypes, setNodeBinding, canAppendTextReference } from './workflowBindings.js';
import ModelAdapterFields, { newAdapterConfig } from '../modelAdapters/ModelAdapterFields.jsx';
import WorkflowTextField from './WorkflowTextField.jsx';
import WorkflowContentField from './WorkflowContentField.jsx';
import WorkflowOutputs from './WorkflowOutputs.jsx';
import { inputPorts, outputVariables, outputPortName, downstreamClosure, validateDefinition, matchesType, listItemType, isRuntimeElement } from '../../../../shared/domain/workflow/contracts.js';
import { workflowNode, constant, output } from '../../../../shared/domain/workflow/examples.js';
import { variableLabel, nodeDisplayName, workflowSteps, stepLabel, typeLabel, isPreparationInput, workflowIssues } from './workflowLabels.js';

const typeLabels = { text: '文字', number: '数字', boolean: '开关', json: '结构化数据', image: '单张图片', 'list<text>': '多段文字', 'list<number>': '数字列表', 'list<boolean>': '开关列表', 'list<json>': '数据列表', 'list<image>': '多张图片' };
const portLabels = { value: '内容', prompt: '提示词', images: '参考图片', items: '待处理列表', a: '内容一', b: '内容二' };
const hints = { element: '文字或图片：固定内容，或每次运行时填写', model: 'AI 看图或读文字，写出文字', 'image.generate': '按提示词和参考图生成图片', transform: '提取、收集或配对内容（高级）', foreach: '对列表里的每一项做同样的步骤', review: '暂停下来，等你确认、修改或跳过', 'library.save': '执行到这里才存进资料库' };
const addMenu = [
  { type: 'element', label: '内容', group: '开始时提供' },
  { type: 'model', label: 'AI 写文字', group: 'AI 与处理' },
  { type: 'image.generate', label: 'AI 生成图片', group: 'AI 与处理' },
  { type: 'foreach', label: '对每一项重复', group: 'AI 与处理' },
  { type: 'transform', label: '整理数据', group: 'AI 与处理' },
  { type: 'review', label: '我来确认', group: '我来确认' },
  { type: 'library.save', label: '存进资料库', group: '保存' },
];

function defaultConfig(type) {
  if (type === 'element') return { parameter: `content_${crypto.randomUUID().slice(0, 8)}`, source: 'runtime', valueType: 'text', default: '', required: true };
  if (type === 'model') return { outputType: 'text', parameters: {} };
  if (type === 'image.generate') return { parameters: {} };
  if (type === 'foreach') return { itemsType: 'list<image>', maxItems: 1000, captureTypes: {}, body: { nodes: [], outputs: {} } };
  if (type === 'transform') return { operation: 'field', path: [], valueType: 'json' };
  if (type === 'library.save') return { valueType: 'text', tags: ['工作流'], source: '工作流产物' };
  if (type === 'review') return { valueType: 'text' };
  return { valueType: 'text' };
}

function primaryPort(type) {
  if (type === 'model' || type === 'image.generate') return 'prompt';
  if (type === 'foreach') return 'items';
  if (['review', 'library.save', 'preview'].includes(type)) return 'value';
  return null;
}

function autoBind(node, previous, parent) {
  const port = primaryPort(node.type);
  if (!port) return node;
  if (parent && ['model', 'image.generate'].includes(node.type) && listItemType(parent.config.itemsType) === 'image') {
    const images = acceptedTypes(node, 'images', 'list<image>');
    if (images.includes('image') || images.includes('list<image>')) node = { ...node, inputs: { ...node.inputs, images: { kind: 'item' } } };
  }
  if (parent && port === 'value' && ['review', 'library.save'].includes(node.type) && previous) {
    return { ...node, inputs: { ...node.inputs, value: output(previous.id) } };
  }
  if (previous) {
    const vars = outputVariables(previous);
    const preferred = vars.find((v) => v.port === 'value' || v.port === 'text' || v.name === 'text') || vars[0];
    if (preferred) {
      const binding = { kind: 'output', nodeId: previous.id, port: preferred.port, path: preferred.path || [] };
      if (port === 'prompt' && node.type === 'model') {
        return { ...node, inputs: { ...node.inputs, prompt: binding, images: node.inputs?.images || constant([]) } };
      }
      return { ...node, inputs: { ...node.inputs, [port]: binding } };
    }
  }
  if (parent && port === 'value') return { ...node, inputs: { ...node.inputs, value: { kind: 'item' } } };
  return node;
}

function InsertPicker({ nodes, selected, parent, accepts, onPick, onClose }) {
  const unavailable = downstreamClosure(nodes, [selected]);
  const start = nodes.filter((n) => !unavailable.has(n.id) && isPreparationInput(n));
  const previous = nodes.filter((n) => !unavailable.has(n.id) && !isPreparationInput(n) && n.id !== selected);
  const scoped = parent ? [
    ...(accepts.includes(listItemType(parent.config.itemsType)) ? [{ label: '这一项', binding: { kind: 'item' }, tone: 'item' }] : []),
    ...(accepts.includes('number') ? [{ label: '这一项的序号', binding: { kind: 'index' }, tone: 'item' }] : []),
    ...(accepts.includes('text') ? [{ label: '这一项的编号', binding: { kind: 'itemId' }, tone: 'item' }] : []),
    ...Object.keys(parent.config.captureTypes || {}).filter((key) => accepts.includes(parent.config.captureTypes[key])).map((key) => ({ label: `循环外：${parent.captureLabels?.[key] || key}`, binding: { kind: 'capture', name: key }, tone: 'capture' })),
  ] : [];
  const asChoices = (list, tone) => list.flatMap((n) => outputVariables(n).filter((v) => accepts.includes(v.type)).map((v) => ({ label: `${nodeDisplayName(n)} · ${variableLabel(v)}`, binding: { kind: 'output', nodeId: n.id, port: v.port, path: v.path }, tone })));
  const groups = [
    { title: '开始时提供', items: asChoices(start, 'start') },
    { title: '当前循环', items: scoped },
    { title: '前面步骤的结果', items: asChoices(previous, 'prev') },
  ].filter((g) => g.items.length);
  return <div className="workflow-insert-picker" role="listbox" aria-label="插入内容">
    <header><strong>搜索可用内容</strong><button type="button" onClick={onClose}>关闭</button></header>
    {!groups.length && <p>没有可插入的内容。</p>}
    {groups.map((group) => <div key={group.title}><h4>{group.title}</h4><div className="workflow-insert-pills">{group.items.map((item, i) => <button type="button" key={i} data-tone={item.tone} onClick={() => { onPick(item.binding); onClose(); }}>{item.label}</button>)}</div></div>)}
  </div>;
}

function BindingPill({ label, value, type, nodes, selected, parent, onChange }) {
  const [open, setOpen] = useState(false);
  const accepts = acceptedTypes(nodes.find((n) => n.id === selected), label, type);
  let text = '＋插入内容';
  if (value?.kind === 'item') text = '这一项';
  else if (value?.kind === 'index') text = '这一项的序号';
  else if (value?.kind === 'itemId') text = '这一项的编号';
  else if (value?.kind === 'capture') text = `循环外：${parent?.captureLabels?.[value.name] || value.name}`;
  else if (value?.kind === 'output' && value.nodeId) {
    const source = nodes.find((n) => n.id === value.nodeId);
    text = source ? `${nodeDisplayName(source)} · ${variableLabel(outputVariables(source).find((v) => v.port === value.port) || { name: value.port })}` : '（来源已失效）';
  } else if (value?.kind === 'constant' || value?.kind === 'text') text = '直接填写';
  return <div className="workflow-binding-pill">
    <span className="workflow-binding-port">{portLabels[label] || label}</span>
    <button type="button" className="workflow-pill" data-kind={value?.kind || 'empty'} onClick={() => setOpen(!open)}>{text}</button>
    {value?.kind === 'output' && <button type="button" className="workflow-pill-clear" onClick={() => onChange(null)} aria-label={`清除${portLabels[label] || label}`}>×</button>}
    {open && <InsertPicker nodes={nodes} selected={selected} parent={parent} accepts={accepts} onPick={onChange} onClose={() => setOpen(false)} />}
  </div>;
}

function StepCard({ step, definition, selected, onSelect, onChange, onRemove, adapters, parent, graph, updateNode, bind, issues, showInResults, onToggleResult }) {
  const node = step.node;
  const open = selected === node.id;
  const ownIssues = issues.filter((issue) => issue.nodeId === node.id && (issue.scope || null) === (step.parentId || null));
  const ports = inputPorts(node);
  return <article className={`workflow-step-card ${open ? 'is-open' : ''} ${ownIssues.length ? 'has-issue' : ''}`} data-node-id={node.id} data-depth={step.depth}>
    <button type="button" className="workflow-step-card-head" onClick={() => onSelect(open ? null : node.id)}>
      <span className="workflow-plan-number">{step.number}</span>
      <div><strong>{step.name}</strong><small>{hints[node.type] || typeLabel(node.type)}</small></div>
      {ownIssues.length ? <span className="workflow-node-issue">需要处理</span> : null}
      {showInResults && <span className="workflow-result-badge">结果里显示</span>}
    </button>
    {open && <div className="workflow-step-card-body">
      <label>显示名称<input aria-label="显示名称" value={node.name || ''} onChange={(e) => updateNode(node.id, { name: e.target.value })} /></label>
      {onToggleResult && <label className="workflow-show-result"><input type="checkbox" checked={!!showInResults} onChange={(e) => onToggleResult(node.id, e.target.checked)} />在结果里显示这一步</label>}
      {node.type === 'element' && <>
        <label>内容种类<select aria-label="内容种类" value={node.config.valueType?.includes('image') ? 'image' : node.config.valueType || 'text'} onChange={(e) => {
          const type = e.target.value === 'image' ? 'list<image>' : e.target.value;
          const config = { ...node.config, valueType: type }; if (type !== 'text') delete config.parts;
          if (Object.hasOwn(config, 'default') && !matchesType(config.default, type)) delete config.default;
          updateNode(node.id, { config });
        }}><option value="text">文字</option>{!parent && <option value="image">图片</option>}</select></label>
        <label>内容来源<select aria-label="内容来源" value={node.config.source || 'fixed'} onChange={(e) => updateNode(node.id, { config: { ...node.config, source: e.target.value, parameter: node.config.parameter || `content_${crypto.randomUUID().slice(0, 8)}` } })}>
          <option value="fixed">固定内容</option><option value="runtime" disabled={!!parent}>每次运行时填写</option>
        </select></label>
        {node.config.source !== 'upstream' && <WorkflowContentField label={node.config.source === 'fixed' ? '内容' : '预填内容（可选）'} type={node.config.valueType || 'text'} value={node.config.default}
          renderText={node.config.source === 'fixed' && (node.config.valueType || 'text') === 'text' ? (text) => <WorkflowTextField label="内容" parts={node.config.parts || [{ kind: 'text', text }]} nodes={graph.nodes} selected={node.id} parent={parent} onChange={(parts) => {
            const config = { ...node.config }; if (parts.some((p) => p.kind === 'ref')) { config.parts = parts; delete config.default; } else { delete config.parts; config.default = parts.map((p) => p.text).join(''); } updateNode(node.id, { config });
          }} /> : undefined}
          onChange={(value) => { const config = { ...node.config }; delete config.parts; if (value === undefined) delete config.default; else config.default = value; updateNode(node.id, { config }); }} />}
      </>}
      {['model', 'image.generate'].includes(node.type) && <ModelAdapterFields node={node} adapters={adapters} onChange={(config) => updateNode(node.id, { config, inputs: Object.fromEntries(Object.entries(node.inputs || {}).filter(([key]) => Object.hasOwn(config.adapterInputs || {}, key))) })} />}
      {Object.entries(ports || {}).map(([port, type]) => (
        <div key={port} className="workflow-step-binding">
          <BindingPill label={port} type={type} value={node.inputs?.[port]} nodes={graph.nodes} selected={node.id} parent={parent} onChange={(v) => bind(node.id, port, v)} />
          {port === 'prompt' && (node.inputs?.prompt?.kind === 'constant' || node.inputs?.prompt?.kind === 'text' || !node.inputs?.prompt) && (
            <WorkflowTextField label="提示词" parts={node.inputs?.prompt?.kind === 'text' ? node.inputs.prompt.parts : [{ kind: 'text', text: typeof node.inputs?.prompt?.value === 'string' ? node.inputs.prompt.value : '' }]} nodes={graph.nodes} selected={node.id} parent={parent}
              onChange={(parts) => bind(node.id, 'prompt', parts.some((p) => p.kind === 'ref') ? { kind: 'text', parts } : constant(parts.map((p) => p.text).join('')))} />
          )}
        </div>
      ))}
      <WorkflowOutputs node={node} onChange={(config) => updateNode(node.id, { config })} />
      {ownIssues.length > 0 && <div className="workflow-errors" role="alert"><strong>这一步还需要处理</strong>{ownIssues.map((issue) => <p key={issue.key}>{issue.message}</p>)}</div>}
      <div className="workflow-step-card-actions"><button type="button" className="danger-quiet" onClick={() => onRemove(node.id)}>删除这一步</button></div>
    </div>}
  </article>;
}

export default function WorkflowStepsView({ definition, onChange, adapters = [], issues = [], locate = null, onPreview }) {
  const [selected, setSelected] = useState(null);
  const [menuFor, setMenuFor] = useState(null); // null | 'root' | loopId
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);

  const steps = useMemo(() => workflowSteps(definition), [definition]);
  const resultIds = new Set(definition.resultSteps || []);

  function commit(next) { setHistory((h) => [...h.slice(-49), definition]); setFuture([]); onChange(inferGraphTypes(next)); }
  function undo() { if (!history.length) return; setFuture((f) => [definition, ...f]); onChange(history.at(-1)); setHistory((h) => h.slice(0, -1)); }
  function redo() { if (!future.length) return; setHistory((h) => [...h, definition]); onChange(future[0]); setFuture((f) => f.slice(1)); }

  function updateInScope(scopeId, updater) {
    if (!scopeId) { commit(updater(definition)); return; }
    commit({ ...definition, nodes: definition.nodes.map((n) => n.id === scopeId ? { ...n, config: { ...n.config, body: updater(n.config.body || { nodes: [], outputs: {} }) } } : n) });
  }

  function graphOf(scopeId) {
    if (!scopeId) return definition;
    return definition.nodes.find((n) => n.id === scopeId)?.config.body || { nodes: [], outputs: {} };
  }

  function parentOf(scopeId) {
    if (!scopeId) return null;
    const node = definition.nodes.find((n) => n.id === scopeId);
    if (!node) return null;
    return { ...node, captureLabels: Object.fromEntries(Object.keys(node.config.captureTypes || {}).map((key) => [key, definition.nodes.find((n) => n.id === node.inputs?.[key]?.nodeId)?.name || key])) };
  }

  function add(type, scopeId) {
    if (scopeId && ['foreach'].includes(type)) return;
    const graph = graphOf(scopeId);
    const parent = parentOf(scopeId);
    const id = `n_${crypto.randomUUID().slice(0, 8)}`;
    let node = workflowNode(id, type, defaultConfig(type), {}, { x: 0, y: graph.nodes.length * 120 });
    if (['model', 'image.generate'].includes(type)) {
      const adapter = adapters.find((entry) => entry.nodeType === type);
      if (!adapter) return;
      node.config = newAdapterConfig(adapter);
    }
    if (parent && type === 'element') node.config = { source: 'fixed', valueType: 'text', parts: [{ kind: 'text', text: '' }] };
    node.name = typeLabel(type);
    const previous = graph.nodes.at(-1);
    node = autoBind(node, previous, parent);
    // If foreach and previous is a list-producing element, bind items
    if (type === 'foreach' && previous && listItemType(previous.config?.valueType || '')) {
      node = { ...node, inputs: { ...node.inputs, items: output(previous.id) }, config: { ...node.config, itemsType: previous.config.valueType } };
    }
    updateInScope(scopeId, (g) => ({ ...g, nodes: [...g.nodes, node] }));
    setSelected(id);
    setMenuFor(null);
  }

  function updateNode(scopeId, id, patch) {
    updateInScope(scopeId, (g) => ({ ...g, nodes: g.nodes.map((n) => n.id === id ? { ...n, ...patch } : n) }));
  }

  function bind(scopeId, id, handle, binding) {
    updateInScope(scopeId, (g) => ({ ...g, nodes: g.nodes.map((n) => n.id === id ? setNodeBinding(n, handle, binding) : n) }));
  }

  function remove(scopeId, id) {
    updateInScope(scopeId, (g) => ({ ...g, nodes: g.nodes.filter((n) => n.id !== id) }));
    if (selected === id) setSelected(null);
  }

  function toggleResult(id, on) {
    const current = new Set(definition.resultSteps || []);
    if (on) current.add(id); else current.delete(id);
    commit({ ...definition, resultSteps: [...current] });
  }

  useEffect(() => { if (locate?.nodeId) setSelected(locate.nodeId); }, [locate]);

  const rootSteps = steps.filter((s) => s.depth === 0);
  const report = validateDefinition(definition);

  function renderAdd(scopeId) {
    const open = menuFor === (scopeId || 'root');
    return <div className="workflow-add-step">
      <button type="button" className="workflow-add-step-btn" onClick={() => setMenuFor(open ? null : (scopeId || 'root'))}>{scopeId ? '＋在循环里再加一步' : '＋添加一步'}</button>
      {open && <div className="workflow-add-menu" role="menu">{addMenu.filter((item) => !(scopeId && item.type === 'foreach')).map((item) => (
        <button type="button" key={item.type} role="menuitem" disabled={['model', 'image.generate'].includes(item.type) && !adapters.some((a) => a.nodeType === item.type)} onClick={() => add(item.type, scopeId || null)}>
          <strong>{item.label}</strong><small>{hints[item.type]}</small>
        </button>
      ))}</div>}
    </div>;
  }

  function renderStep(step) {
    const scopeId = step.parentId || null;
    const graph = graphOf(scopeId);
    const parent = parentOf(scopeId);
    if (step.node.type === 'foreach') {
      const inner = steps.filter((s) => s.parentId === step.node.id);
      return <div key={step.id} className="workflow-foreach-box" data-node-id={step.node.id}>
        <header className="workflow-foreach-head">
          <span className="workflow-plan-number">{step.number}</span>
          <div>
            <strong>对「{(() => { const src = definition.nodes.find((n) => n.id === step.node.inputs?.items?.nodeId); return src ? nodeDisplayName(src) : '列表'; })()}」里的每一项，依次做</strong>
            <small>共 {inner.length} 步；其中一项出错不影响其它项</small>
          </div>
          <button type="button" className="danger-quiet" onClick={() => remove(null, step.node.id)}>删除循环</button>
        </header>
        <div className="workflow-foreach-bind">
          <BindingPill label="items" type={step.node.config.itemsType || 'list<image>'} value={step.node.inputs?.items} nodes={definition.nodes} selected={step.node.id} parent={null}
            onChange={(v) => bind(null, step.node.id, 'items', v)} />
          <label>显示名称<input aria-label="显示名称" value={step.node.name || ''} onChange={(e) => updateNode(null, step.node.id, { name: e.target.value })} /></label>
        </div>
        <div className="workflow-foreach-body">
          {inner.map((child) => (
            <StepCard key={child.id} step={child} definition={definition} selected={selected} onSelect={setSelected}
              adapters={adapters} parent={parent} graph={graph} issues={issues} showInResults={resultIds.has(child.node.id)}
              onToggleResult={toggleResult}
              updateNode={(id, patch) => updateNode(step.node.id, id, patch)}
              bind={(id, handle, binding) => bind(step.node.id, id, handle, binding)}
              onRemove={(id) => remove(step.node.id, id)} />
          ))}
          {renderAdd(step.node.id)}
        </div>
      </div>;
    }
    return <StepCard key={step.id} step={step} definition={definition} selected={selected} onSelect={setSelected}
      adapters={adapters} parent={parent} graph={graph} issues={issues} showInResults={resultIds.has(step.node.id)}
      onToggleResult={toggleResult}
      updateNode={(id, patch) => updateNode(scopeId, id, patch)}
      bind={(id, handle, binding) => bind(scopeId, id, handle, binding)}
      onRemove={(id) => remove(scopeId, id)} />;
  }

  const prep = rootSteps.filter((s) => isPreparationInput(s.node));
  const rest = rootSteps.filter((s) => !isPreparationInput(s.node));

  return <div className="workflow-steps-view">
    <div className="workflow-steps-main">
      <div className="workflow-steps-toolbar">
        <button type="button" disabled={!history.length} onClick={undo}>撤销</button>
        <button type="button" disabled={!future.length} onClick={redo}>重做</button>
        <span className="workflow-steps-hint">从上往下读，像菜谱；新步骤会自动接上上一步的结果。</span>
      </div>
      {!!prep.length && <section className="workflow-steps-section"><h3>开始时，请提供</h3>{prep.map(renderStep)}</section>}
      {!!rest.length && <section className="workflow-steps-section"><h3>{prep.length ? '然后' : '步骤'}</h3>{rest.map(renderStep)}</section>}
      {!rootSteps.length && <div className="workflow-steps-empty"><h3>还没有步骤</h3><p>点下面的按钮添加第一步；也可以先从首页选一个模板。</p></div>}
      {renderAdd(null)}
    </div>
    <aside className="workflow-steps-side" aria-label="运行预览与检查">
      <div className="workflow-steps-preview">
        <h3>运行时你会看到的表单</h3>
        {prep.length ? <ul className="workflow-form-preview">{prep.map((step) => <li key={step.id}><strong>{step.name}</strong><small>{step.node.config.source === 'runtime' ? '每次运行时填写' : '固定内容'} · {typeLabels[step.node.config.valueType] || step.node.config.valueType || '文字'}</small></li>)}</ul> : <p>不需要填写内容，可以直接开始。</p>}
      </div>
      <div className="workflow-steps-check" data-ok={report.valid || undefined}>
        <h3>检查结果</h3>
        {report.valid ? <p className="workflow-check-ok">可以运行 · 最多调用 AI {report.maxCalls} 次</p> : <ul>{workflowIssues(definition, report.errors).map((issue) => <li key={issue.key}><button type="button" onClick={() => setSelected(issue.nodeId)}>{issue.label}</button> {issue.message}</li>)}</ul>}
      </div>
      {onPreview && selected && <button type="button" onClick={() => { const step = steps.find((s) => s.node.id === selected); onPreview(selected, step?.parentId || null); }}>查看这一步最近运行结果</button>}
      <div className="workflow-plan-body"><h3>处理流程 <small>共 {steps.length} 步</small></h3><ol>{steps.map((step) => <li key={step.id} style={{ marginLeft: step.depth * 16 }}><span className="workflow-plan-number">{step.number}</span><strong>{step.name}</strong></li>)}</ol></div>
    </aside>
  </div>;
}
