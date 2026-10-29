import { useEffect, useRef, useState } from 'react';
import WorkflowContentField from './WorkflowContentField.jsx';
import { apiUrl, request } from '../../api.js';
import RuntimeGenerationParameters, { generationParameterConfig } from '../modelAdapters/RuntimeGenerationParameters.jsx';
import { downstreamClosure, executionNode, isRuntimeElement, outputType, safePath } from '../../../../shared/domain/workflow/contracts.js';
import { workflowSteps, stepLabel } from './workflowLabels.js';
import { rerunChanges } from './workflowRerun.js';
import { editableTextParts } from './workflowText.js';

const reuseCookie = 'selfWikiWorkflowReuse';

function readReuseMap() {
  try {
    const entry = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${reuseCookie}=`));
    if (!entry) return {};
    const value = JSON.parse(decodeURIComponent(entry.slice(reuseCookie.length + 1)));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function readReuse(workflowId) {
  const saved = workflowId == null ? null : readReuseMap()[String(workflowId)];
  return Array.isArray(saved) ? [...new Set(saved.filter((id) => typeof id === 'string' && id))] : [];
}

function writeReuse(workflowId, ids) {
  if (workflowId == null) return;
  try {
    const map = readReuseMap();
    const key = String(workflowId);
    delete map[key];
    if (ids.length) map[key] = ids;
    const entries = Object.entries(map);
    const body = encodeURIComponent(JSON.stringify(Object.fromEntries(entries.slice(-40))));
    document.cookie = `${reuseCookie}=${body}; Path=/; Max-Age=31536000; SameSite=Strict`;
  } catch { /* The choice still applies until this page is closed. */ }
}

function applicableReuse(run, definition, ids) {
  const originals = new Map((run?.definition?.nodes || []).map((node) => [node.id, node]));
  const instances = run?.rootInstances || (run?.instances || []).filter((instance) => instance.scope === 'root');
  return [...new Set(ids)].filter((id) => {
    const node = definition?.nodes?.find((item) => item.id === id);
    const original = originals.get(id);
    if (!node || !original) return false;
    if (JSON.stringify(executionNode(node)) !== JSON.stringify(executionNode(original))) return false;
    return instances.some((instance) => instance.nodeId === id && instance.state === 'succeeded' && Object.keys(instance.outputs || {}).length);
  });
}

export function useRerunDraft(run) {
  const [draft, setDraft] = useState(null);
  const [resetKey, setResetKey] = useState(0);
  const [adapters, setAdapters] = useState([]);
  const [reuse, setReuseState] = useState([]);
  const workflowId = useRef(null);
  workflowId.current = run?.workflowId;
  useEffect(() => { let alive = true; request('/api/workflow-node-types').then((r) => { if (alive) setAdapters(r.adapters); }).catch(() => {}); return () => { alive = false; }; }, []);
  useEffect(() => { setDraft(null); setReuseState(readReuse(run?.workflowId)); }, [run?.id]);
  function change(field, value) {
    setDraft((old) => {
      const next = old || { definition: structuredClone(run.definition), inputs: structuredClone(run.inputs) };
      return { ...next, [field]: typeof value === 'function' ? value(next[field]) : value };
    });
  }
  function setReuse(value) {
    setReuseState((old) => {
      const next = [...new Set((typeof value === 'function' ? value(old) : value).filter((id) => typeof id === 'string' && id))];
      writeReuse(workflowId.current, next);
      return next;
    });
  }
  return { draft, adapters, resetKey, reuse, setDefinition: (value) => change('definition', value), setInputs: (value) => change('inputs', value), setReuse, reset: () => { setDraft(null); setResetKey((key) => key + 1); } };
}

export function canEditNode(node, adapters = []) {
  if (!node) return false;
  if (node.type === 'element' && node.config.source === 'upstream') return false;
  if (node.type === 'foreach') return true;
  if (['model', 'agent', 'image.generate'].includes(node.type)) return true;
  return ['input', 'element', 'template'].includes(node.type);
}

function SourceValue({ run, binding }) {
  const [value, setValue] = useState(undefined), [error, setError] = useState('');
  const source = run.rootInstances?.find((instance) => instance.nodeId === binding.nodeId);
  const port = binding.port;
  const id = source?.outputs?.[port] || (port === 'text' ? source?.outputs?.raw || source?.outputs?.value : ['images', 'structured_output'].includes(port) ? source?.outputs?.value : null);
  useEffect(() => { let alive = true; setValue(undefined); setError(''); if (id) request(`/api/workflow-artifacts/${id}?runId=${run.id}`).then((artifact) => { if (alive) setValue(safePath(artifact.type === 'image' ? { artifactId: id } : artifact.value, binding.path || [])); }).catch((e) => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [id, run.id, JSON.stringify(binding.path)]);
  if (!id) return <p>内容由上游步骤提供。</p>;
  if (error) return <p role="alert">{error}</p>;
  if (value === undefined) return <p>读取来源内容…</p>;
  const images = Array.isArray(value) ? value : value?.artifactId ? [value] : [];
  if (images.length && images.every((ref) => ref?.artifactId)) return <div className="workflow-content-images">{images.map((ref, index) => <img key={`${ref.artifactId}:${index}`} alt={`来源图片 ${index + 1}`} src={apiUrl(`/api/workflow-artifacts/${ref.artifactId}/media?runId=${run.id}`)} />)}</div>;
  return <pre className="workflow-source-text">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

function Source({ run, binding }) {
  if (binding.kind === 'constant') return <pre className="workflow-source-text">{String(binding.value ?? '')}</pre>;
  const step = workflowSteps(run.definition).find((s) => s.node.id === binding.nodeId && !s.parentId);
  const source = run.rootInstances?.find((i) => i.nodeId === binding.nodeId);
  return <div className="workflow-content-source"><small>来自 {step ? stepLabel(step) : '循环中的内容'} · 本次原内容</small>{binding.kind === 'output' && <SourceValue run={run} binding={binding} />}{source && <button type="button" className="text-button" onClick={() => document.getElementById(`workflow-step-${source.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>查看来源</button>}</div>;
}

function ComposedText({ run, parts, originalParts = [], label, onChange }) {
  const [opened, setOpened] = useState([]);
  const original = editableTextParts(originalParts);
  const changedAt = (index, text) => text !== (original[index]?.text || '');
  const visibleChange = (before, after) => {
    if (after.startsWith(before) && after.length > before.length) return after.slice(before.length).trim();
    if (before && after.endsWith(before) && after.length > before.length) return after.slice(0, after.length - before.length).trim();
    return after.trim();
  };
  const changes = parts.flatMap((part, index) => part.kind === 'ref' || !changedAt(index, part.text) ? [] : [visibleChange(original[index]?.text || '', part.text)]).filter(Boolean);
  return <div className="workflow-composed-content">
    <p className="workflow-composed-caption">修改后的完整文字。虚线框是这一步可以改的内容，其余是前面步骤这次的原文。</p>
    {!!changes.length && <p className="workflow-composed-change">这次的修改：{changes.join('\n')}</p>}
    <div className="workflow-composed-sheet">{parts.map((part, index) => part.kind === 'ref' ? <Source key={index} run={run} binding={part.ref} /> : !part.text && parts.length > 1 && !opened.includes(index) ? <button key={index} type="button" className="text-button" onClick={() => setOpened((old) => [...old, index])}>{index === 0 ? '在前面添加文字' : '在后面添加文字'}</button> : <label key={index} className="workflow-composed-edit" data-changed={changedAt(index, part.text) ? '' : undefined}><span>{changedAt(index, part.text) ? '已修改' : '可修改'}</span><textarea aria-label={label} rows={Math.min(40, Math.max(2, part.text.split('\n').length + 1))} value={part.text} onChange={(event) => onChange(parts.map((p, i) => i === index ? { kind: 'text', text: event.target.value } : p))} /></label>)}</div>
  </div>;
}

export function WorkflowNodeEdit({ run, nodeId, draft, setDefinition, setInputs, busy, adapters = [], setReuse, reuse: savedReuse }) {
  const { definition, inputs } = draft;
  const reuse = savedReuse ?? draft.reuse ?? [];
  const allSteps = workflowSteps(definition);
  const fields = allSteps.filter((step) => step.id === nodeId);
  function update(node, parent, patch) {
    const replace = (nodes) => nodes.map((n) => n.id === node.id ? { ...n, ...patch } : n);
    setDefinition((old) => ({ ...old, nodes: parent ? old.nodes.map((n) => n.id === parent.id ? { ...n, config: { ...n.config, body: { ...n.config.body, nodes: replace(n.config.body.nodes) } } } : n) : replace(old.nodes) }));
  }
  return <fieldset disabled={busy} className="workflow-node-edit" aria-label={`${stepLabel(allSteps.find((step) => step.id === nodeId))} · 编辑`}>
      {fields.map((step) => {
        const node = step.node, parent = step.parentId ? definition.nodes.find((n) => n.id === step.parentId) : null;
        const label = stepLabel(step), config = node.config;
        if (isRuntimeElement(node) && !parent) return <WorkflowContentField key={step.id} runId={run.id} showLabel={false} label={label} type={outputType(node)} value={Object.hasOwn(inputs, config.parameter) ? inputs[config.parameter] : config.default} onChange={(value) => setInputs((old) => ({ ...old, [config.parameter]: value }))} />;
        if (node.type === 'foreach') return <div key={node.id}><label>列表项数上限<input aria-label="列表项数上限" type="number" min={1} max={1000} value={config.maxItems ?? 1000} onChange={(event) => update(node, parent, { config: { ...config, maxItems: Number(event.target.value) } })} /><small>列表超过上限会报错；试跑仍只处理第一项。</small></label>{allSteps.filter((child) => child.parentId === node.id && ['model', 'image.generate'].includes(child.node.type) && canEditNode(child.node, adapters)).map((child) => <section key={child.id}><h4>{stepLabel(child)} · 本批参数</h4><p>修改作用于每一项，点击统一的“运行”后执行。</p><WorkflowNodeEdit run={run} nodeId={child.id} draft={draft} setDefinition={setDefinition} setInputs={setInputs} busy={busy} adapters={adapters} /></section>)}</div>;
        if (node.type === 'element' || node.type === 'template') {
          if (config.source === 'upstream') return <Source key={node.id} run={run} binding={node.inputs.value} />;
          if (Array.isArray(config.parts)) return <ComposedText key={node.id} run={run} label={`${label} · 文字`} parts={editableTextParts(config.parts)} originalParts={run.definition.nodes.find((item) => item.id === node.id)?.config.parts} onChange={(parts) => update(node, parent, { config: { ...config, parts } })} />;
          const original = run.definition.nodes.find((n) => n.id === node.id);
          const unchanged = JSON.stringify(config) === JSON.stringify(original?.config);
          const value = unchanged && Object.hasOwn(run.inputs, config.parameter) ? run.inputs[config.parameter] : config.default;
          return <WorkflowContentField key={node.id} runId={run.id} showLabel={false} label={`${label} · ${outputType(node) === 'text' ? '文字' : '内容'}`} type={outputType(node)} value={value} onChange={(value) => update(node, parent, { config: { ...config, default: value } })} />;
        }
        const adapter = adapters.find((a) => a.id === (config.adapterId || config.executor));
        const reusable = run.rootInstances?.find((instance) => instance.nodeId === node.id && instance.state === 'succeeded' && Object.keys(instance.outputs).length);
        const configChanged = JSON.stringify(executionNode(node)) !== JSON.stringify(executionNode(run.definition.nodes.find((n) => n.id === node.id) || node));
        const reuseOn = reuse.includes(node.id) && !!reusable && !configChanged;
        return <div key={step.id} className="workflow-rerun-node">
          {!parent && setReuse && <div className="workflow-reuse-control"><label><input type="checkbox" role="switch" aria-label={`复用${label}的已有结果`} checked={reuseOn} disabled={!reusable || configChanged} onChange={(event) => setReuse((old = []) => event.target.checked ? [...old, node.id] : old.filter((id) => id !== node.id))} />复用已有结果，不重新调用</label><small>{!reusable ? '这条运行记录没有成功结果，暂不能复用。' : configChanged ? '本步骤配置已修改，恢复配置后可复用已有结果。' : reuseOn ? `将沿用运行 #${run.id} 的结果，上游修改不会更新此结果。` : '开启后，下次运行沿用这条记录的成功结果。'}</small></div>}
          <fieldset className="workflow-model-parameters" disabled={reuseOn}>
          {(adapter?.parameterFields || []).map((field) => <label key={field.name}>{field.label}<select aria-label={field.label} value={config.parameters?.[field.name] || ''} onChange={(event) => { const parameters = { ...config.parameters }; if (event.target.value) parameters[field.name] = event.target.value; else delete parameters[field.name]; update(node, parent, { config: { ...config, parameters } }); }}>{field.optional && <option value="">使用默认值</option>}{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>)}
          {generationParameterConfig(node) && <RuntimeGenerationParameters node={node} value={generationParameterConfig(node)} onChange={(adapterConfig) => update(node, parent, { config: { ...config, adapterConfig } })} />}
          </fieldset>
        </div>;
      })}
  </fieldset>;
}

export default function WorkflowRerun({ run, draft, reuse: savedReuse, busy, disabled, count = 1, onCountChange, onSubmit, onClose }) {
  const { definition, inputs } = draft || run;
  const [error, setError] = useState('');
  const runtime = definition.nodes.filter(isRuntimeElement);
  const values = Object.fromEntries(runtime.map((node) => [node.config.parameter, Object.hasOwn(inputs, node.config.parameter) ? inputs[node.config.parameter] : node.config.default]));
  const { changed } = rerunChanges(run, definition, values);
  const reuse = new Set(applicableReuse(run, definition, savedReuse ?? draft?.reuse ?? []));
  const execute = downstreamClosure(definition.nodes, changed.length ? changed : definition.nodes.map((node) => node.id), reuse);
  if (reuse.size) for (const node of definition.nodes.filter((node) => ['review', 'library.save'].includes(node.type))) for (const id of downstreamClosure(definition.nodes, [node.id], reuse)) execute.add(id);
  if (changed.length) {
    const instances = run.rootInstances || run.instances.filter((instance) => instance.scope === 'root');
    for (const node of definition.nodes) if (!instances.some((instance) => instance.nodeId === node.id && instance.state === 'succeeded')) {
      for (const id of downstreamClosure(definition.nodes, [node.id], reuse)) execute.add(id);
    }
  }
  const allSteps = workflowSteps(definition), steps = allSteps.filter((step) => step.depth === 0);
  return <section className="workflow-rerun" aria-label="运行设置">
    <fieldset disabled={busy || disabled}>
      <div className="workflow-rerun-summary" role="status"><strong>{reuse.size ? `复用 ${reuse.size} 个 AI 步骤的已有结果` : changed.length ? `已修改 ${changed.length} 个节点` : '未修改，将完整运行'}</strong><details><summary>查看执行范围（{execute.size} 步）</summary><p>将执行：{steps.filter((step) => execute.has(step.node.id)).map(stepLabel).join('、')}</p><p>{reuse.size ? `沿用运行 #${run.id} 中所选 AI 步骤的结果，不重新调用；上游修改不会更新这些结果。` : changed.length ? '其余已完成步骤会复用可用结果。' : '使用本次配置和输入，重新执行全部步骤。'}确认步骤需要重新通过，之后才执行保存。每次运行另建记录，原结果保留。</p></details></div>
      {error && <p role="alert">{error}</p>}
      <div className="workflow-actions workflow-run-toolbar-actions"><label className="workflow-run-count">运行次数<input aria-label="运行次数" type="number" min="1" max="20" step="1" value={count} onChange={(event) => onCountChange(event.target.value)} /></label><button type="button" className="primary" onClick={(event) => { const panel = event.currentTarget.closest('.workflow-run'); if (panel.querySelector('.workflow-node-edit [aria-busy="true"],.workflow-node-edit [aria-invalid="true"]') || !Array.from(panel.querySelectorAll('.workflow-node-edit input,.workflow-node-edit textarea,.workflow-node-edit select,.workflow-run-count input')).every((field) => field.reportValidity())) { setError('请等待图片上传完成，并修正输入内容。'); return; } setError(''); onSubmit({ definition, inputs: values, count, ...(!changed.length && { regenerate: definition.nodes.map((node) => node.id).filter((id) => !reuse.has(id)) }), ...(reuse.size && { reuse: [...reuse] }) }); }}>运行</button>{draft && <button type="button" onClick={() => { setError(''); onClose(); }}>取消修改</button>}</div>
    </fieldset>
  </section>;
}
