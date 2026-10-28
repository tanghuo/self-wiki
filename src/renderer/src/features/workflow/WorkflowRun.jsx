import { useEffect, useState } from 'react';
import { apiUrl, request } from '../../api.js';
import { WorkflowGraphSnapshot } from './WorkflowEditor.jsx';
import { downstreamClosure, sampleDefinition } from '../../../../shared/domain/workflow/contracts.js';
import { workflowSteps, stepLabel } from './workflowLabels.js';

export const stateLabels = { queued: '排队中', pending: '待执行', running: '执行中', paused: '已暂停', waiting_review: '待检查', needs_attention: '需要处理', succeeded: '成功', partial_failed: '部分失败', failed: '失败', unknown: '结果未知', blocked: '被阻塞', cancelled: '已取消' };
const command = (path, data) => request(path, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), ...data }) });
function resultLabel(instance, definition) {
  const id = !instance.scope || instance.scope === 'root' ? instance.nodeId : `${instance.scope.split('/')[1]}/${instance.nodeId}`;
  const step = workflowSteps(definition).find((item) => item.id === id);
  return step ? stepLabel(step) : instance.name || instance.nodeId;
}
function Artifact({ id, runId, onValue }) {
  const [artifact, setArtifact] = useState(null), [error, setError] = useState('');
  useEffect(() => { let alive = true; request(`/api/workflow-artifacts/${id}?runId=${runId}`).then((a) => { if (alive) { setArtifact(a); onValue?.(a); } }).catch((e) => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [id, runId]);
  if (error) return <p role="alert">{error}</p>;
  if (!artifact) return <small>读取产物…</small>;
  const image = (id) => <a key={id} href={apiUrl(`/api/workflow-artifacts/${id}/media?runId=${runId}`)} target="_blank" rel="noreferrer"><img alt="工作流图片产物" src={apiUrl(`/api/workflow-artifacts/${id}/media?runId=${runId}`)} /></a>;
  return <div className="workflow-artifact">{artifact.type === 'image' ? image(id) : artifact.type === 'list<image>' ? <div className="workflow-result-images">{artifact.value.map((v) => image(v.artifactId))}</div> : <pre>{typeof artifact.value === 'string' ? artifact.value : JSON.stringify(artifact.value, null, 2)}</pre>}<details><summary>来源与校验信息</summary><small>SHA-256：{artifact.hash}</small><pre>{JSON.stringify(artifact.metadata, null, 2)}</pre></details></div>;
}
function countSaves(nodes) {
  return (nodes || []).reduce((count, node) => count + (node.type === 'library.save' ? 1 : 0) + (node.type === 'foreach' ? countSaves(node.config.body?.nodes) : 0), 0);
}
function reviewContinuesToSave(definition, instance) {
  const scoped = !instance.scope || instance.scope === 'root' ? definition : definition.nodes.find((node) => node.id === instance.scope.split('/')[1])?.config.body;
  const nodes = scoped?.nodes || [];
  if (nodes.some((node) => node.type === 'library.save' && downstreamClosure(nodes, [instance.nodeId]).has(node.id))) return true;
  if (instance.scope && instance.scope !== 'root') {
    const loopId = instance.scope.split('/')[1];
    return definition.nodes.some((node) => node.type === 'library.save' && downstreamClosure(definition.nodes, [loopId]).has(node.id));
  }
  return false;
}
function NodeResult({ instance, runId, controlVersion, onAction, expanded = false, definition }) {
  const attention = instance.state === 'waiting_review' || instance.state === 'unknown' || instance.state === 'failed';
  const [open, setOpen] = useState(expanded || attention), [editing, setEditing] = useState(''), [original, setOriginal] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [chosen, setChosen] = useState(null), [changed, setChanged] = useState(false);
  const feedsSave = definition && instance.state === 'waiting_review' && reviewContinuesToSave(definition, instance);
  useEffect(() => { if (expanded || attention) setOpen(true); }, [instance.state, expanded, attention]);
  return <div className="workflow-node-result" data-node-id={instance.nodeId}><button className="workflow-result-heading" aria-expanded={open} onClick={() => setOpen(!open)}><strong>{resultLabel(instance, definition)}</strong><span>{instance.itemId ? `第 ${instance.context.index + 1} 项` : '主流程'}</span><span data-state={instance.state}>{stateLabels[instance.state]}</span></button>
    {instance.error && <p className="workflow-error">{instance.error}</p>}
    {open && <div className="workflow-result-body">{Object.entries(instance.outputs).filter(([port]) => !port.startsWith('image:') && !(port === 'raw' && instance.outputNames?.value === 'text')).map(([port, id]) => <div key={id}><small>{instance.outputNames?.[port] === 'value' ? '内容' : instance.outputNames?.[port] || ({ value: '内容', raw: '模型原始回答' })[port] || port}</small><Artifact id={id} runId={runId} onValue={port === 'value' ? (a) => { setOriginal(a); if (!changed) { setEditing(typeof a.value === 'string' ? a.value : ''); setChosen(a.type === 'list<image>' ? a.value.map((v) => v.artifactId) : null); } } : undefined} /></div>)}
      {instance.state === 'waiting_review' && <div className="workflow-review">
        <p>审核决定这一支还要不要继续。接受不是保存；没有走到保存节点就不会写入内容库。</p>
        <p>{feedsSave ? '此检查之后有保存到内容库的步骤。接受后才会继续执行到保存；拒绝则这一支不会入库。' : '这条路径后面没有保存到内容库的步骤。'}</p>
        {original?.type === 'text' && <label>修改后接受<textarea aria-label={`检查 ${instance.nodeId} 的文字`} rows={5} value={editing} onChange={(e) => { setEditing(e.target.value); setChanged(true); }} /></label>}
        {original?.type === 'list<image>' && <fieldset><legend>选择接受的图片</legend>{original.value.map((v, index) => <label key={v.artifactId}><input type="checkbox" checked={chosen?.includes(v.artifactId) || false} onChange={(e) => { setChosen((ids) => e.target.checked ? [...(ids || []), v.artifactId] : ids.filter((id) => id !== v.artifactId)); setChanged(true); }} />图片 {index + 1}</label>)}</fieldset>}
        <button disabled={!original} onClick={() => onAction(instance, 'accept', changed ? { value: original.type === 'text' ? editing : original.value.filter((v) => chosen.includes(v.artifactId)) } : {})}>接受并继续</button><button className="danger-quiet" onClick={() => onAction(instance, 'reject')}>拒绝此路径</button>
        <small>改过内容再点「接受并继续」会带上修改；没改则接受当前内容。拒绝只停这一支。</small>
      </div>}
      {(instance.state === 'failed' || instance.state === 'unknown') && <section className="workflow-recovery" aria-label="失败恢复">
        {instance.state === 'failed' && <button onClick={() => onAction(instance, 'retry')}>重试此节点</button>}
        {instance.state === 'unknown' && <div className="workflow-unknown"><p>远端任务可能已经完成。请先核查远端记录；重新执行可能产生额外调用。</p>{instance.canRecover && <button onClick={() => onAction(instance, 'recover')}>核查并取回结果</button>}<label><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />我已核查，接受重复调用的可能</label><button disabled={!acknowledged} onClick={() => onAction(instance, 'reexecute', { acknowledgeDuplicate: true })}>明确重新执行</button><button onClick={() => onAction(instance, 'abandon')}>放弃未知项</button></div>}
      </section>}
      {instance.state === 'succeeded' && <div><button onClick={() => onAction(instance, 'regenerate')}>派生运行：重新执行此节点及下游</button><small>会新建一次运行，不会改写这次结果。</small></div>}
      <details><summary>尝试记录（{instance.attempts.length}）</summary>{instance.attempts.map((a) => <div key={a.id}><p>#{a.number} · {stateLabels[a.state]} · {a.dispatchStarted ? '已记录提交意图' : '本地准备'}</p><pre>{JSON.stringify({ request: a.request, remoteId: a.remoteId, error: a.error, metadata: a.data }, null, 2)}</pre>{Object.entries(a.data.outputs || {}).filter(([, id]) => !Object.values(instance.outputs).includes(id)).map(([port, id]) => <div key={id}><small>历史尝试 {a.number} · {port}</small><Artifact id={id} runId={runId} /></div>)}</div>)}</details>
    </div>}
  </div>;
}
function BatchTable({ runId, instanceId, instance, controlVersion, onAction, selected, setSelected, expanded, definition }) {
  const [offset, setOffset] = useState(0), [batch, setBatch] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, timer;
    async function poll() { if (document.hidden) { timer = setTimeout(poll, 2000); return; } try { const b = await request(`/api/workflow-runs/${runId}/batches/${instanceId}?offset=${offset}`); if (alive) { setBatch(b); setError(''); } } catch (e) { if (alive) setError(e.message); } if (alive) timer = setTimeout(poll, 2000); }
    poll(); return () => { alive = false; clearTimeout(timer); };
  }, [runId, instanceId, offset, controlVersion, instance.state]);
  return <section className="workflow-batch"><header><h3>{resultLabel(instance, definition)} <span data-state={instance.state}>{stateLabels[instance.state]}</span></h3>{instance.error && <p className="workflow-error">{instance.error}</p>}{instance.state === 'failed' && <button onClick={() => onAction(instance, 'retry')}>重试循环</button>}{instance.state === 'succeeded' && <div><button onClick={() => onAction(instance, 'regenerate')}>派生运行：重新执行此循环及下游</button><small>会新建一次运行，不会改写这次结果。</small></div>}</header>{error && <p role="alert">{error}</p>}{batch && <><div className="workflow-actions"><span>{batch.total ? offset + 1 : 0}–{Math.min(offset + 20, batch.total)} / {batch.total} 项 · 顺序按原始输入</span><button disabled={!offset} onClick={() => setOffset((v) => Math.max(0, v - 20))}>上一页</button><button disabled={offset + 20 >= batch.total} onClick={() => setOffset((v) => v + 20)}>下一页</button></div><table><thead><tr><th>原始输入</th><th>待审产物</th><th>状态</th><th>选择</th></tr></thead><tbody>{batch.items.map((item) => {
    const attention = item.state === 'waiting_review' || item.state === 'unknown';
    return <tr key={item.itemId}><td>{item.index + 1}{item.value?.artifactId ? <Artifact id={item.value.artifactId} runId={runId} /> : <pre>{typeof item.value === 'string' ? item.value : JSON.stringify(item.value, null, 2)}</pre>}</td><td>{attention ? <small>展开后的审核里查看</small> : <>{Object.entries(item.resultArtifacts || {}).map(([port, ref]) => <div key={port}><small>{port} · 复用结果</small><Artifact id={ref.artifactRef} runId={runId} /></div>)}{item.instances.flatMap((i) => Object.entries(i.outputs).filter(([port]) => !port.startsWith('image:') && !(port === 'raw' && i.outputNames?.value === 'text')).map(([port, id]) => <div key={id}><small>{i.outputNames?.[port] === 'value' ? '内容' : i.outputNames?.[port] || port}</small><Artifact id={id} runId={runId} /></div>))}</>}</td><td><span data-state={item.state}>{stateLabels[item.state]}</span><details open={expanded || attention ? true : undefined}><summary>{attention ? '审核与失败恢复' : '查看节点与恢复'}</summary>{Object.entries(item.resultArtifacts || {}).map(([port, ref]) => <div key={port}><small>{port} · 复用结果</small><Artifact id={ref.artifactRef} runId={runId} /></div>)}{item.instances.map((i) => <NodeResult key={i.id} instance={i} runId={runId} controlVersion={controlVersion} onAction={onAction} definition={definition} />)}</details></td><td>{item.instances.filter((i) => i.state === 'waiting_review').map((i) => <label key={i.id}><input type="checkbox" aria-label={`选择检查 ${i.nodeId} ${item.itemId}`} checked={selected.includes(i.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, i.id] : ids.filter((id) => id !== i.id))} />选择此检查</label>)}</td></tr>;
  })}</tbody></table></>}</section>;
}
export default function WorkflowRun({ runId, definition, focusNodeId, onStateChange, onEditVersion, onDerived, onRun }) {
  const [run, setRun] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [after, setAfter] = useState(0), [events, setEvents] = useState([]), [selected, setSelected] = useState([]), [showGraph, setShowGraph] = useState(false), [diagnostics, setDiagnostics] = useState(false);
  useEffect(() => { if (run) onStateChange?.(run.id, run.state); onRun?.(run); }, [run, onStateChange, onRun]);
  useEffect(() => { setAfter(0); setSelected([]); setRun(null); }, [runId]);
  async function refresh() { const r = await request(`/api/workflow-runs/${runId}?after=${after}&limit=100`); setRun(r); return r; }
  useEffect(() => {
    let alive = true, timer, cursor = 0;
    async function poll() {
      if (document.hidden) { timer = setTimeout(poll, 2000); return; }
      try {
        const [r, e] = await Promise.all([request(`/api/workflow-runs/${runId}?after=${after}&limit=100`), request(`/api/workflow-runs/${runId}/events?after=${cursor}`)]);
        if (!alive) return;
        setRun(r); cursor = e.cursor; setEvents((old) => [...old, ...e.events].slice(-200)); setError('');
      } catch (e) { if (alive) setError(e.message); }
      if (alive) timer = setTimeout(poll, 2000);
    }
    setEvents([]); poll(); return () => { alive = false; clearTimeout(timer); };
  }, [runId, after]);
  async function perform(fn) {
    if (busy) return; setBusy(true); setError('');
    try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!run) return <section className="workflow-run"><p>{error || '读取运行…'}</p></section>;
  const isSample = run.definition.nodes.some((n) => n.config.sampleSize === 1);
  const nextDefinition = isSample ? sampleDefinition(definition) : definition;
  const nodeAction = (instance, action, extra = {}) => perform(async () => {
    if (action === 'regenerate') { const r = await command(`/api/workflow-runs/${runId}/derive`, { definition: nextDefinition, regenerate: [instance.scope === 'root' ? instance.nodeId : instance.scope.split('/')[1]] }); onDerived(r.id); }
    else await command(`/api/workflow-runs/${runId}/nodes/${instance.id}/actions`, { action, controlVersion: run.controlVersion, ...extra });
  });
  const roots = run.rootInstances || run.instances.filter((i) => i.scope === 'root');
  const isLoop = (instance) => run.definition.nodes.some((n) => n.id === instance.nodeId && n.type === 'foreach');
  const rank = (instance) => instance.state === 'waiting_review' ? 0 : instance.state === 'failed' || instance.state === 'unknown' ? 1 : 2;
  const nodeRoots = roots.filter((instance) => !isLoop(instance)).sort((a, b) => rank(a) - rank(b));
  const saveCount = countSaves(run.definition.nodes);
  return <section className="workflow-run" aria-label="工作流运行"><header><h2>{isSample ? '试跑' : '运行'} #{run.id} <span data-state={run.state}>{stateLabels[run.state]}</span></h2><p>版本 {run.version} · {new Date(run.createdAt).toLocaleString()} {run.parentId && `· 派生自 #${run.parentId}`}</p><p>{isSample ? '这是首项试跑，每个批量循环只处理了首项。' : '这是完整运行。'}{saveCount ? ` 有 ${saveCount} 个保存到内容库的步骤，执行到那些步骤才会入库。` : ' 没有保存到内容库的步骤，审核或预览不会创建内容库元素。'}</p><div className="workflow-actions">
    {!['succeeded', 'partial_failed', 'failed', 'cancelled'].includes(run.state) && <><button disabled={busy} onClick={() => perform(() => command(`/api/workflow-runs/${run.id}/actions`, { action: run.paused ? 'resume' : 'pause', controlVersion: run.controlVersion }))}>{run.paused ? '继续' : '暂停'}</button><button disabled={busy} onClick={() => perform(() => command(`/api/workflow-runs/${run.id}/actions`, { action: 'cancel', controlVersion: run.controlVersion }))}>取消运行</button></>}
    {(run.state === 'waiting_review' || !!selected.length) && <button disabled={!selected.length} onClick={() => perform(async () => { await command(`/api/workflow-runs/${runId}/reviews`, { instanceIds: selected, action: 'accept', controlVersion: run.controlVersion }); setSelected([]); })}>接受选中的 {selected.length} 项</button>}
  </div></header>
  {error && <p role="alert" className="workflow-error">{error}</p>}
  {run.state === 'waiting_review' && <p className="workflow-waiting">需要人工处理的内容在下面，图片和文字已展开。接受后继续该分支，不是保存到内容库。</p>}
  {['queued', 'running'].includes(run.state) && <p className="workflow-waiting">正在执行。节点产物和需要处理的事项会显示在下面，不必打开执行详情。</p>}
  {roots.filter(isLoop).map((i) => <BatchTable key={i.id} runId={runId} instanceId={i.id} instance={i} controlVersion={run.controlVersion} onAction={nodeAction} selected={selected} setSelected={setSelected} expanded={i.nodeId === focusNodeId} definition={run.definition} />)}
  {!!nodeRoots.length && <fieldset disabled={busy} className="workflow-run-results"><legend>节点产物</legend><p>这些是节点产物，不是单独声明的最终输出。</p>
    {nodeRoots.map((i) => <div key={i.id} className="workflow-result-row">{i.state === 'waiting_review' && <label className="workflow-review-select"><input type="checkbox" aria-label={`选择检查 ${i.nodeId} ${i.itemId || ''}`} checked={selected.includes(i.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, i.id] : ids.filter((id) => id !== i.id))} /></label>}<NodeResult instance={i} runId={runId} controlVersion={run.controlVersion} onAction={nodeAction} expanded={i.nodeId === focusNodeId} definition={run.definition} /></div>)}
  </fieldset>}<details className="workflow-execution-details"><summary>执行详情</summary><div className="workflow-actions"><button disabled={busy} onClick={() => perform(async () => { const w = await command(`/api/workflow-runs/${run.id}/edit-version`, {}); onEditVersion(w); })}>用此版本编辑</button><button disabled={busy} onClick={() => perform(async () => { const r = await command(`/api/workflow-runs/${run.id}/derive`, { definition: nextDefinition }); onDerived(r.id); })}>{isSample ? '用当前草稿继续试跑' : '用当前草稿派生运行'}</button><button onClick={() => setShowGraph(!showGraph)}>查看运行快照</button></div>
    {showGraph && <><WorkflowGraphSnapshot definition={run.definition} /><details><summary>定义 JSON</summary><pre className="workflow-code">{JSON.stringify(run.definition, null, 2)}</pre></details></>}
    <details className="workflow-diagnostics" onToggle={(e) => setDiagnostics(e.currentTarget.open)}><summary>诊断：完整实例列表</summary>{diagnostics && <><div className="workflow-actions"><button disabled={!after} onClick={() => { setAfter(0); setSelected([]); }}>第一页</button><button disabled={run.instances.length < 100} onClick={() => { setAfter(run.nextCursor); setSelected([]); }}>下一页</button></div>{run.instances.map((i) => <NodeResult key={i.id} instance={i} runId={runId} controlVersion={run.controlVersion} onAction={nodeAction} definition={run.definition} />)}</>}</details>
    <details className="workflow-events"><summary>增量事件（最近 {events.length} 条）</summary><ol>{events.map((e) => <li key={e.id}>#{e.id} {e.type} {e.instanceId ? `节点实例 ${e.instanceId}` : ''} {e.data.state ? stateLabels[e.data.state] : ''}</li>)}</ol></details>
  </details>
  </section>;
}
