import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl, request } from '../../api.js';
import WorkflowEditor, { WorkflowPlan } from './WorkflowEditor.jsx';
import WorkflowRun, { stateLabels } from './WorkflowRun.jsx';
import WorkflowContentField from './WorkflowContentField.jsx';
import WorkflowTextField from './WorkflowTextField.jsx';
import { outputType, isRuntimeElement, editableDefinition } from '../../../../shared/domain/workflow/contracts.js';
import { inferGraphTypes } from './workflowBindings.js';
import { workflowSteps, stepLabel, stepConnections, isPreparationInput } from './workflowLabels.js';
import './workflow.css';

const post = (path, payload) => request(path, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), ...payload }) });
function defaultInputs(definition) {
  return Object.fromEntries(definition.nodes.filter(isRuntimeElement).map((node) => {
    const type = outputType(node);
    const fallback = node.config.default ?? (type.startsWith('list<') ? [] : type === 'image' ? undefined : type === 'number' ? 0 : type === 'boolean' ? false : type === 'text' ? '' : {});
    return [node.config.parameter, fallback];
  }));
}
function runtimeLabel(node, index, nodes) {
  return stepLabel(workflowSteps({ nodes }).find((step) => step.node.id === node.id && step.depth === 0));
}
function SnapshotImages({ runId, type, value }) {
  const refs = type === 'image' ? value ? [value] : [] : Array.isArray(value) ? value : [];
  if (!refs.length) return <p>没有图片。</p>;
  return <div className="workflow-content-images">{refs.map((ref, index) => <a key={ref.artifactId || index} href={apiUrl(`/api/workflow-artifacts/${ref.artifactId}/media?runId=${runId}`)} target="_blank" rel="noreferrer"><img alt={`本次快照图片 ${index + 1}`} src={apiUrl(`/api/workflow-artifacts/${ref.artifactId}/media?runId=${runId}`)} /></a>)}</div>;
}
function RunSnapshot({ snapshot, fallbackDefinition }) {
  const definition = snapshot?.definition || fallbackDefinition;
  const fields = (definition?.nodes || []).filter(isPreparationInput);
  const sample = definition?.nodes?.some((node) => node.config?.sampleSize === 1);
  return <aside className="workflow-run-snapshot" aria-label="本次输入快照"><h3>{snapshot ? `运行 #${snapshot.id} 的输入` : '本次输入'}</h3><p>{sample ? '这次是首项试跑：每个批量循环只处理首项。' : '这次是完整运行。'}</p>{!snapshot && <p className="workflow-waiting">正在读取这次运行的输入。</p>}{snapshot && !fields.length && <p>本次运行没有需要填写的输入。</p>}{snapshot && fields.map((node, index) => {
    const type = outputType(node), label = runtimeLabel(node, index, definition.nodes);
    const value = Array.isArray(node.config.parts) ? node.config.parts.map((part) => part.kind === 'text' ? part.text : part.ref.value).join('') : snapshot.inputs?.[node.config.parameter];
    const plain = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    return <div key={node.id}><strong>{label}</strong>{type.includes('image') ? <SnapshotImages runId={snapshot.id} type={type} value={value} /> : type === 'text' ? <textarea readOnly aria-label={`${label}（本次快照）`} rows={4} value={value ?? ''} /> : plain ? <input readOnly aria-label={`${label}（本次快照）`} value={String(value)} /> : <pre aria-label={`${label}（本次快照）`}>{JSON.stringify(value, null, 2)}</pre>}</div>;
  })}<p>这是已经提交的快照。改草稿或再次运行会另开一轮，不会改到这次任务。</p></aside>;
}
export default function WorkflowApp() {
  const [list, setList] = useState([]), [workflow, setWorkflow] = useState(null), [definition, setDefinition] = useState(null), [name, setName] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [errors, setErrors] = useState([]), [busy, setBusy] = useState(false), [mode, setMode] = useState('edit'), [runId, setRunId] = useState(null), [inputForm, setInputForm] = useState(false), [inputs, setInputs] = useState({}), [sample, setSample] = useState(false), [dirty, setDirty] = useState(false), [showArchived, setShowArchived] = useState(false), [history, setHistory] = useState([]), [snapshot, setSnapshot] = useState(null);
  const importRef = useRef(null), appRef = useRef(null), inputCards = useRef(new Map());
  const latestSource = useRef(null);
  latestSource.current = { workflow, definition, name };
  const [activeInputId, setActiveInputId] = useState(null);
  const [adapters, setAdapters] = useState([]);
  useEffect(() => { let alive = true; request('/api/workflow-node-types').then((result) => { if (alive) setAdapters(result.adapters); }).catch((reason) => { if (alive) setError(reason.message); }); return () => { alive = false; }; }, []);
  const updateRunState = useCallback((id, state) => setHistory((old) => old.map((entry) => entry.id === id && entry.state !== state ? { ...entry, state } : entry)), []);
  const rememberRun = useCallback((run) => setSnapshot((old) => {
    if (!run) return null;
    if (old && old.id === run.id && JSON.stringify(old.inputs) === JSON.stringify(run.inputs)) return old;
    return { id: run.id, inputs: run.inputs, definition: run.definition };
  }), []);
  const [focusNodeId, setFocusNodeId] = useState(null);
  async function refresh() { setList((await request('/api/workflows')).workflows); }
  useEffect(() => { refresh().catch((reason) => setError(reason.message)); }, []);
  useEffect(() => { const warn = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  function adopt(loaded, extra = {}) {
    const edited = inferGraphTypes(editableDefinition(loaded.definition));
    const source = { workflow: loaded, definition: edited, name: loaded.name, dirty: JSON.stringify(edited) !== JSON.stringify(loaded.definition), history: loaded.runs || [] };
    setWorkflow(source.workflow); setDefinition(source.definition); setName(source.name); setDirty(source.dirty); setHistory(source.history);
    setErrors([]); setNotice(''); setFocusNodeId(null); setInputForm(false); setSnapshot(null); setRunId(extra.runId ?? null); setMode(extra.mode ?? 'edit');
    return source;
  }
  function open(loaded) { return adopt(loaded); }
  function sourceNow() { return { workflow, definition, name, dirty }; }
  async function perform(fn) { if (busy) return; setBusy(true); setError(''); try { await fn(); await refresh(); } catch (reason) { setError(reason.message); } finally { setBusy(false); } }
  async function saveSource(source) {
    assertValidFields();
    const saved = await request(`/api/workflows/${source.workflow.id}`, { method: 'PUT', body: JSON.stringify({ name: source.name, definition: source.definition, revision: source.workflow.revision }) });
    if (latestSource.current.workflow?.id === source.workflow.id) {
      const newerEdits = latestSource.current.definition !== source.definition || latestSource.current.name !== source.name;
      setWorkflow(saved); setDirty(newerEdits); setNotice(newerEdits ? '已保存草稿；保存期间的新修改尚未保存' : '已保存草稿');
    }
    await refresh(); return saved;
  }
  async function save() { return saveSource(sourceNow()); }
  async function launch(isSample, suppliedInputs, source) {
    assertValidFields();
    const missing = source.definition.nodes.filter((node) => node.type === 'element' && node.config.source === 'fixed' && !Array.isArray(node.config.parts) && node.config.default === undefined);
    if (missing.length) throw new Error(`请填写流程素材：${missing.map((node) => stepLabel(workflowSteps(source.definition).find((step) => step.node.id === node.id && step.depth === 0))).join('、')}`);
    const current = source.dirty ? await saveSource(source) : source.workflow;
    if (source.dirty && (latestSource.current.definition !== source.definition || latestSource.current.name !== source.name)) throw new Error('保存期间内容已修改，请重新确认后开始运行');
    const values = {};
    for (const node of source.definition.nodes.filter(isRuntimeElement)) {
      const value = suppliedInputs[node.config.parameter];
      if (value !== undefined) values[node.config.parameter] = value;
    }
    const created = await post(`/api/workflows/${current.id}/runs`, { revision: current.revision, inputs: values, sample: isSample });
    setInputForm(false); setFocusNodeId(null); setRunId(created.id); setMode('run'); setSnapshot(null); setHistory((await request(`/api/workflows/${current.id}`)).runs);
  }
  function beginRun(isSample, source) {
    setError(''); setNotice(''); setSample(isSample);
    const nextInputs = defaultInputs(source.definition);
    setInputs(nextInputs);
    if (isSample || source.definition.nodes.some(isPreparationInput)) { setInputForm(true); setMode('run'); setSnapshot(null); return; }
    return launch(isSample, nextInputs, source);
  }
  async function runFromList(id) { const source = adopt(await request(`/api/workflows/${id}`)); await beginRun(false, source); }
  async function openLatest(id) {
    const loaded = await request(`/api/workflows/${id}`);
    const latest = loaded.runs?.[0];
    adopt(loaded, { mode: latest ? 'run' : 'edit', runId: latest?.id ?? null });
  }
  function runtimeNodes() { return definition.nodes.filter(isRuntimeElement); }
  function exportDefinition() {
    const blob = new Blob([JSON.stringify({ name, definition }, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `${name.replace(/[<>:"/\\|?*]/g, '_') || 'workflow'}.json`; a.click(); URL.revokeObjectURL(url);
  }
  function assertValidFields() {
    if (appRef.current?.querySelector('[aria-busy="true"]')) throw new Error('图片正在添加，请稍候再开始运行');
    const invalid = appRef.current?.querySelector('[aria-invalid="true"], input:invalid, textarea:invalid, select:invalid');
    if (invalid) { invalid.focus(); throw new Error(`请修正 ${invalid.getAttribute('aria-label') || '输入内容'}`); }
  }
  function updateFixed(node, patch) {
    setDefinition((current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, config: { ...item.config, ...patch, parameter: item.config.parameter || `content_${item.id}` } } : item) }));
    setDirty(true); setError('');
  }
  const fixedNodes = (definition?.nodes || []).filter((node) => !isRuntimeElement(node) && isPreparationInput(node));
  const steps = workflowSteps(definition);
  const inputSteps = steps.filter((step) => step.depth === 0 && isPreparationInput(step.node));
  function locateInput(id) {
    const card = inputCards.current.get(id);
    if (!card) return;
    setActiveInputId(id); card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.querySelector('textarea, input:not([type=hidden]), button')?.focus({ preventScroll: true });
  }
  const running = inputForm || mode === 'run';
  return <main ref={appRef} id="main-content" className="workflow-app"><header className="workflow-header"><div><p className="wiki-muted">我的空间 / 工作流</p><h1>{workflow ? name : '工作流'}</h1><p>{workflow ? (inputForm ? '选择输入内容，开始一次新的创作。' : running ? '查看本次进度与结果' : '编辑素材与处理步骤') : '用节点组合素材处理、AI 创作与人工检查。'}</p></div>{!workflow && <div className="workflow-actions"><button disabled={busy} onClick={() => perform(async () => open(await post('/api/workflows', { name: '未命名工作流' })))}>新建空白</button><button disabled={busy} onClick={() => perform(async () => { open(await post('/api/workflows', { name: '批量反推并生图', example: 'describe-images' })); await refresh(); })}>复制内置示例</button><button disabled={busy} onClick={() => importRef.current.click()}>导入</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(e) => { const file = e.target.files[0]; e.target.value = ''; if (!file) return; perform(async () => { if (file.size > 1024 * 1024) throw new Error('定义文件须在 1 MiB 以内'); const value = JSON.parse(await file.text()); open(await post('/api/workflows', { name: value.name || '导入的工作流', definition: value.definition || value })); await refresh(); }); }} /></div>}</header>
    {error && <p className="workflow-error" role="alert">{error}</p>}{notice && <p className="workflow-notice" role="status">{notice}</p>}
    {!workflow ? <section className="workflow-list"><label><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />显示已归档</label>{list.filter((item) => showArchived || !item.archivedAt).map((item) => <article key={item.id}><button className="workflow-list-title" disabled={busy} onClick={() => perform(async () => open(await request(`/api/workflows/${item.id}`)))}><strong>{item.name}</strong><small>{new Date(item.updatedAt).toLocaleString()} · {stateLabels[item.latestState] || '尚未运行'}{item.archivedAt ? ' · 已归档' : ''}</small></button><div className="workflow-list-actions"><button disabled={busy || !!item.archivedAt} onClick={() => perform(() => runFromList(item.id))}>运行</button><button disabled={busy} onClick={() => perform(async () => open(await request(`/api/workflows/${item.id}`)))}>编辑</button><button disabled={busy || !item.latestState} onClick={() => perform(() => openLatest(item.id))}>最近运行</button><details className="workflow-menu"><summary>管理</summary><div><button disabled={busy} onClick={() => perform(async () => { const value = await request(`/api/workflows/${item.id}`); open(await post('/api/workflows', { name: `${value.name} 副本`, definition: value.definition })); await refresh(); })}>复制</button><button disabled={busy} onClick={() => perform(async () => { const value = await request(`/api/workflows/${item.id}`); await request(`/api/workflows/${item.id}`, { method: 'PUT', body: JSON.stringify({ name: value.name, definition: value.definition, revision: value.revision, archived: !value.archivedAt }) }); await refresh(); })}>{item.archivedAt ? '恢复归档' : '归档'}</button></div></details></div></article>)}{!list.length && <div className="workflow-empty"><h2>从空白画布开始</h2><p>也可以复制「批量反推并生图」，修改节点与连线。</p></div>}</section> : <>
      {!inputForm && mode === 'edit' && <div className="workflow-toolbar"><button disabled={busy} onClick={() => perform(async () => { if (dirty) await save(); setWorkflow(null); setDefinition(null); })}>← 列表</button><input aria-label="工作流名称" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} /><span className="workflow-save-state">{dirty ? '未保存' : '已保存'}</span><button disabled={busy} onClick={() => perform(save)}>保存</button><button disabled={busy} onClick={() => perform(async () => { const report = await post(`/api/workflows/${workflow.id}/validate`, { definition }); setErrors(report.errors); setNotice(report.valid ? `校验通过 · 最多 ${report.maxCalls} 次外部调用，${report.maxInstances} 个节点实例` : '请修复校验问题'); })}>校验</button><button className="workflow-primary" disabled={busy || !!workflow.archivedAt} onClick={() => perform(() => beginRun(false, sourceNow()))}>运行</button><button disabled={busy || !!workflow.archivedAt || !definition.nodes.some((node) => node.type === 'foreach')} title="每个批量循环只处理首项，其他节点正常执行" onClick={() => perform(() => beginRun(true, sourceNow()))}>首项试跑</button><details className="workflow-menu"><summary>管理</summary><div><button onClick={exportDefinition}>导出定义</button><button disabled={busy} onClick={() => perform(async () => { const saved = await request(`/api/workflows/${workflow.id}`, { method: 'PUT', body: JSON.stringify({ name, definition, revision: workflow.revision, archived: !workflow.archivedAt }) }); setWorkflow(saved); setDirty(false); await refresh(); })}>{workflow.archivedAt ? '恢复归档' : '归档'}</button></div></details></div>}
      {!inputForm && mode === 'edit' && <p className="workflow-mode-note">{definition.nodes.some((node) => node.type === 'foreach') ? '运行会执行全部步骤。首项试跑时，每个批量循环只处理首项，其他节点正常执行。' : '运行会执行当前草稿里的全部步骤。'}</p>}
      {!inputForm && <div className="workflow-view-tabs"><span>{mode === 'run' ? '当前：运行' : '当前：编辑'}</span><button aria-pressed={mode === 'edit'} onClick={() => { setInputForm(false); setMode('edit'); }}>编辑草稿</button><button aria-pressed={mode === 'run'} disabled={!runId} onClick={() => setMode('run')}>查看运行</button>{mode === 'run' && <button className="workflow-primary" disabled={busy || !!workflow.archivedAt} onClick={() => perform(() => beginRun(false, sourceNow()))}>再次运行</button>}<label>运行历史<select aria-label="运行历史" value={runId || ''} onChange={(e) => { setSnapshot(null); setRunId(Number(e.target.value)); setMode('run'); setInputForm(false); }} onFocus={() => request(`/api/workflows/${workflow.id}`).then((loaded) => setHistory(loaded.runs)).catch((reason) => setError(reason.message))}><option value="">选择运行…</option>{history.map((entry) => <option key={entry.id} value={entry.id}>#{entry.id} · v{entry.version} · {stateLabels[entry.state]}</option>)}</select></label></div>}
      {inputForm && <div className="workflow-workbench"><div className="workflow-workbench-bar"><button disabled={busy} onClick={() => perform(async () => { if (dirty) await save(); setWorkflow(null); setDefinition(null); })}>← 列表</button><span>准备运行</span></div><section className="workflow-workbench-columns" aria-label="运行工作台"><section className="workflow-input-form" aria-label="填写运行内容"><div className="workflow-input-heading"><span className="workflow-step">{sample ? '首项试跑' : '新建运行'}</span><h2>{runtimeNodes().length || fixedNodes.length ? '准备本次素材' : '准备就绪'}</h2><p>{runtimeNodes().length ? '选择或填写本次要处理的内容，' : '使用已配置的素材，'}点击「开始{sample ? '试跑' : '运行'}」。</p></div>{sample && <div><p>下列循环各取输入列表的第一项；其余节点正常执行，参考图片保留全部。</p><ul>{definition.nodes.filter((node) => node.type === 'foreach').map((node) => <li key={node.id}>{node.name || '批量循环'}：{definition.nodes.find((source) => source.id === node.inputs?.items?.nodeId)?.name || '输入列表'}的第 1 项（空列表不执行）</li>)}</ul></div>}{!runtimeNodes().length && <p>请检查下方流程素材，确认后开始运行。</p>}<div className="workflow-preparation-fields">{inputSteps.map((step) => {
        const node = step.node, runtime = isRuntimeElement(node), label = stepLabel(step);
        const { sources, targets, sourceLabel } = stepConnections(step, steps);
        return <section key={node.id} ref={(element) => { if (element) inputCards.current.set(node.id, element); else inputCards.current.delete(node.id); }} className="workflow-preparation-card" data-node-id={node.id} data-active={activeInputId === node.id} onFocusCapture={() => setActiveInputId(node.id)} aria-label={label + '的输入'}>
          <header><strong>{label}</strong><span>{sourceLabel}</span></header><code className="workflow-node-identity">节点：{node.id}</code>
          {sources.length > 0 && <p className="workflow-input-connection">来自：{sources.map(stepLabel).join('、')}</p>}
          {targets.length > 0 && <p className="workflow-input-connection">用于：{targets.map(stepLabel).join('、')}</p>}
          {!runtime && <small className="workflow-input-save-note">修改会随本次运行保存到工作流草稿</small>}
          <WorkflowContentField showImageHelp label={label} type={outputType(node)} value={runtime ? inputs[node.config.parameter] : node.config.default}
            renderText={!runtime && outputType(node) === 'text' ? (text) => <WorkflowTextField allowReferences={false} label={label} parts={node.config.parts || [{ kind: 'text', text }]} nodes={definition.nodes} selected={node.id} onChange={(parts) => updateFixed(node, { parts })} /> : undefined}
            onChange={(value) => runtime ? setInputs((all) => ({ ...all, [node.config.parameter]: value })) : updateFixed(node, { default: value, parts: undefined })} />
        </section>;
      })}</div><div className="workflow-actions workflow-input-actions"><button className="workflow-primary" disabled={busy} onClick={() => perform(() => launch(sample, inputs, sourceNow()))}>开始{sample ? '试跑' : '运行'}</button><button disabled={busy} onClick={() => { setInputForm(false); setMode('edit'); }}>返回编辑</button></div></section><aside className="workflow-plan" aria-label="执行前状态"><WorkflowPlan definition={definition} activeNodeId={activeInputId} onLocate={locateInput} /><div className="workflow-plan-footer"><strong>进度与结果</strong><p>开始运行后，在这里查看处理进度和生成内容。</p></div></aside></section></div>}
      {/* Stay mounted while hidden so a run does not drop the canvas selection or undo stack. */}
      <div hidden={inputForm || mode !== 'edit'}><WorkflowEditor key={workflow.id} active={!inputForm && mode === 'edit'} definition={definition} adapters={adapters} errors={errors} onPreview={history.length ? (nodeId, scope) => { setFocusNodeId(scope || nodeId); setRunId(history[0].id); setInputForm(false); setMode('run'); setNotice('显示最近一次运行的结果；未运行的草稿修改不会反映在这里。'); } : undefined} onChange={(next) => { setDefinition(next); setDirty(true); }} /></div>
      {!inputForm && mode === 'run' && runId && <div className="workflow-workbench-columns"><RunSnapshot snapshot={snapshot} fallbackDefinition={definition} /><WorkflowRun key={runId} runId={runId} focusNodeId={focusNodeId} onStateChange={updateRunState} onRun={rememberRun} definition={definition} onEditVersion={(loaded) => { open(loaded); refresh(); }} onDerived={(id) => { setSnapshot(null); setRunId(id); setInputForm(false); setMode('run'); }} /></div>}
    </>}

  </main>;
}
