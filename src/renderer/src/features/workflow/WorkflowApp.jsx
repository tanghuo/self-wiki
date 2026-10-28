import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../../api.js';
import WorkflowEditor from './WorkflowEditor.jsx';
import WorkflowRun, { stateLabels } from './WorkflowRun.jsx';
import WorkflowContentField from './WorkflowContentField.jsx';
import { outputType, isRuntimeElement, editableDefinition } from '../../../../shared/domain/workflow/contracts.js';
import { inferGraphTypes } from './workflowBindings.js';
import './workflow.css';

const post = (path, payload) => request(path, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), ...payload }) });
export default function WorkflowApp() {
  const [list, setList] = useState([]), [workflow, setWorkflow] = useState(null), [definition, setDefinition] = useState(null), [name, setName] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [errors, setErrors] = useState([]), [busy, setBusy] = useState(false), [mode, setMode] = useState('edit'), [runId, setRunId] = useState(null), [inputForm, setInputForm] = useState(false), [inputs, setInputs] = useState({}), [sample, setSample] = useState(false), [dirty, setDirty] = useState(false), [showArchived, setShowArchived] = useState(false), [history, setHistory] = useState([]);
  const importRef = useRef(null);
  const [adapters, setAdapters] = useState([]);
  useEffect(() => { let alive = true; request('/api/workflow-node-types').then((result) => { if (alive) setAdapters(result.adapters); }).catch((error) => { if (alive) setError(error.message); }); return () => { alive = false; }; }, []);
  const updateRunState = useCallback((id, state) => setHistory((old) => old.map((entry) => entry.id === id && entry.state !== state ? { ...entry, state } : entry)), []);
  const [focusNodeId, setFocusNodeId] = useState(null);
  async function refresh() { setList((await request('/api/workflows')).workflows); }
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);
  useEffect(() => { const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  function open(w) {
    const edited = inferGraphTypes(editableDefinition(w.definition));
    setWorkflow(w); setDefinition(edited); setName(w.name); setDirty(JSON.stringify(edited) !== JSON.stringify(w.definition)); setErrors([]); setRunId(null); setFocusNodeId(null); setMode('edit'); setHistory(w.runs || []); setInputForm(false); setNotice('');
  }
  async function perform(fn) { if (busy) return; setBusy(true); setError(''); try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  async function save() {
    const saved = await request(`/api/workflows/${workflow.id}`, { method: 'PUT', body: JSON.stringify({ name, definition, revision: workflow.revision }) });
    setWorkflow(saved); setDirty(false); setNotice('已保存草稿'); await refresh(); return saved;
  }
  function prepareRun(isSample) {
    setSample(isSample);
    setInputs(Object.fromEntries(definition.nodes.filter(isRuntimeElement).map((n) => [n.config.parameter, n.config.default ?? (outputType(n).startsWith('list<') ? [] : outputType(n) === 'image' ? undefined : outputType(n) === 'number' ? 0 : outputType(n) === 'boolean' ? false : outputType(n) === 'text' ? '' : {})])));
    if (isSample || definition.nodes.some(isRuntimeElement)) setInputForm(true);
    else perform(() => startRun(isSample, {}));
  }
  async function startRun(isSample = sample, suppliedInputs = inputs) {
    const w = dirty ? await save() : workflow;
    const values = {};
    for (const n of definition.nodes.filter(isRuntimeElement)) {
      const value = suppliedInputs[n.config.parameter];
      if (value !== undefined) values[n.config.parameter] = value;
    }
    const r = await post(`/api/workflows/${w.id}/runs`, { revision: w.revision, inputs: values, sample: isSample });
    setInputForm(false); setFocusNodeId(null); setRunId(r.id); setMode('run'); setHistory((await request(`/api/workflows/${w.id}`)).runs); await refresh();
  }
  function exportDefinition() {
    const blob = new Blob([JSON.stringify({ name, definition }, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `${name.replace(/[<>:"/\\|?*]/g, '_') || 'workflow'}.json`; a.click(); URL.revokeObjectURL(url);
  }
  return <main id="main-content" className="workflow-app"><header className="workflow-header"><div><p className="wiki-muted">我的空间 / 工作流</p><h1>工作流</h1><p>用节点组合素材处理、AI 创作与人工检查。</p></div><div className="workflow-actions"><button disabled={busy} onClick={() => perform(async () => open(await post('/api/workflows', { name: '未命名工作流' })))}>新建空白</button><button disabled={busy} onClick={() => perform(async () => { open(await post('/api/workflows', { name: '批量反推并生图', example: 'describe-images' })); await refresh(); })}>复制内置示例</button><button disabled={busy} onClick={() => importRef.current.click()}>导入</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(e) => { const file = e.target.files[0]; e.target.value = ''; if (!file) return; perform(async () => { if (file.size > 1024 * 1024) throw new Error('定义文件须在 1 MiB 以内'); const value = JSON.parse(await file.text()); open(await post('/api/workflows', { name: value.name || '导入的工作流', definition: value.definition || value })); await refresh(); }); }} /></div></header>
    {error && <p className="workflow-error" role="alert">{error}</p>}{notice && <p className="workflow-notice" role="status">{notice}</p>}
    {!workflow ? <section className="workflow-list"><label><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />显示已归档</label>{list.filter((w) => showArchived || !w.archivedAt).map((w) => <article key={w.id}><button className="workflow-list-title" disabled={busy} onClick={() => perform(async () => open(await request(`/api/workflows/${w.id}`)))}><strong>{w.name}</strong><small>{new Date(w.updatedAt).toLocaleString()} · {stateLabels[w.latestState] || '尚未运行'}{w.archivedAt ? ' · 已归档' : ''}</small></button><button disabled={busy} onClick={() => perform(async () => { const value = await request(`/api/workflows/${w.id}`); open(await post('/api/workflows', { name: `${value.name} 副本`, definition: value.definition })); await refresh(); })}>复制</button></article>)}{!list.length && <div className="workflow-empty"><h2>从空白画布开始</h2><p>也可以复制「批量反推并生图」，修改节点与连线。</p></div>}</section> : <>
      <div className="workflow-toolbar"><button disabled={busy} onClick={() => perform(async () => { if (dirty) await save(); setWorkflow(null); setDefinition(null); })}>← 列表</button><input aria-label="工作流名称" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} /><span>{dirty ? '未保存' : `草稿 r${workflow.revision}`}</span><button disabled={busy} onClick={() => perform(save)}>保存</button><button disabled={busy} onClick={() => perform(async () => { const report = await post(`/api/workflows/${workflow.id}/validate`, { definition }); setErrors(report.errors); setNotice(report.valid ? `校验通过 · 最多 ${report.maxCalls} 次外部调用，${report.maxInstances} 个节点实例` : '请修复校验问题'); })}>校验</button><button disabled={busy || !!workflow.archivedAt} onClick={() => prepareRun(false)}>运行</button><button disabled={busy || !!workflow.archivedAt || !definition.nodes.some((n) => n.type === 'foreach')} title="每个批量循环只处理首项，其他节点正常执行" onClick={() => prepareRun(true)}>首项试跑</button><button onClick={exportDefinition}>导出定义</button><button disabled={busy} onClick={() => perform(async () => { const saved = await request(`/api/workflows/${workflow.id}`, { method: 'PUT', body: JSON.stringify({ name, definition, revision: workflow.revision, archived: !workflow.archivedAt }) }); setWorkflow(saved); setDirty(false); await refresh(); })}>{workflow.archivedAt ? '恢复归档' : '归档'}</button></div>
      <div className="workflow-view-tabs"><button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑草稿</button><button aria-pressed={mode === 'run'} disabled={!runId} onClick={() => setMode('run')}>查看运行</button><label>运行历史<select aria-label="运行历史" value={runId || ''} onChange={(e) => { setRunId(Number(e.target.value)); setMode('run'); }} onFocus={() => request(`/api/workflows/${workflow.id}`).then((w) => setHistory(w.runs)).catch((e) => setError(e.message))}><option value="">选择运行…</option>{history.map((r) => <option key={r.id} value={r.id}>#{r.id} · v{r.version} · {stateLabels[r.state]}</option>)}</select></label></div>
      {inputForm && <section className="workflow-input-form"><h2>{sample ? '首项试跑：每个批量循环只处理首项' : '本次运行的内容'}</h2><p>这里只显示设为「运行时提供」的内容。图片和资料库文字会保存独立快照。</p>{sample && <div><p>下列循环各取输入列表的第一项；其余节点正常执行，参考图片保留全部。</p><ul>{definition.nodes.filter((n) => n.type === 'foreach').map((n) => <li key={n.id}>{n.name || '批量循环'}：{definition.nodes.find((source) => source.id === n.inputs?.items?.nodeId)?.name || '输入列表'}的第 1 项（空列表不执行）</li>)}</ul></div>}{!definition.nodes.some(isRuntimeElement) && <p>所有内容已在画布中配置，可直接开始。</p>}{definition.nodes.filter(isRuntimeElement).map((n) => <WorkflowContentField key={n.id} label={n.name || '内容'} type={outputType(n)} value={inputs[n.config.parameter]} onChange={(value) => setInputs((all) => ({ ...all, [n.config.parameter]: value }))} />)}<div className="workflow-actions"><button disabled={busy} onClick={() => perform(() => startRun())}>开始{sample ? '试跑' : '运行'}</button><button disabled={busy} onClick={() => setInputForm(false)}>关闭输入表单</button></div></section>}
      {mode === 'edit' && <WorkflowEditor key={workflow.id} definition={definition} adapters={adapters} errors={errors} onPreview={history.length ? (nodeId, scope) => { setFocusNodeId(scope || nodeId); setRunId(history[0].id); setMode('run'); setNotice('显示最近一次运行的结果；未运行的草稿修改不会反映在这里。'); } : undefined} onChange={(d) => { setDefinition(d); setDirty(true); }} />}
      {mode === 'run' && runId && <WorkflowRun key={runId} runId={runId} focusNodeId={focusNodeId} onStateChange={updateRunState} definition={definition} onEditVersion={(w) => { open(w); refresh(); }} onDerived={(id) => { setRunId(id); setMode('run'); }} />}
    </>}

  </main>;
}
