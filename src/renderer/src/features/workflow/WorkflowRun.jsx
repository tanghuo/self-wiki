import { useEffect, useState } from 'react';
import { apiUrl, request } from '../../api.js';
import { WorkflowGraphSnapshot } from './WorkflowEditor.jsx';
import { sampleDefinition } from '../../../../shared/domain/workflow/contracts.js';

export const stateLabels = { queued: '排队中', pending: '待执行', running: '执行中', paused: '已暂停', waiting_review: '待检查', needs_attention: '需要处理', succeeded: '成功', partial_failed: '部分失败', failed: '失败', unknown: '结果未知', blocked: '被阻塞', cancelled: '已取消' };
const command = (path, data) => request(path, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), ...data }) });
function Artifact({ id, runId, onValue }) {
  const [artifact, setArtifact] = useState(null), [error, setError] = useState('');
  useEffect(() => { let alive = true; request(`/api/workflow-artifacts/${id}?runId=${runId}`).then((a) => { if (alive) { setArtifact(a); onValue?.(a); } }).catch((e) => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [id, runId]);
  if (error) return <p role="alert">{error}</p>;
  if (!artifact) return <small>读取产物…</small>;
  const image = (id) => <a key={id} href={apiUrl(`/api/workflow-artifacts/${id}/media?runId=${runId}`)} target="_blank" rel="noreferrer"><img alt="工作流图片产物" src={apiUrl(`/api/workflow-artifacts/${id}/media?runId=${runId}`)} /></a>;
  return <div className="workflow-artifact">{artifact.type === 'image' ? image(id) : artifact.type === 'list<image>' ? <div className="workflow-result-images">{artifact.value.map((v) => image(v.artifactId))}</div> : <pre>{typeof artifact.value === 'string' ? artifact.value : JSON.stringify(artifact.value, null, 2)}</pre>}<details><summary>来源与校验信息</summary><small>SHA-256：{artifact.hash}</small><pre>{JSON.stringify(artifact.metadata, null, 2)}</pre></details></div>;
}
function NodeResult({ instance, runId, controlVersion, onAction, expanded = false }) {
  const [open, setOpen] = useState(expanded || instance.state === 'waiting_review' || instance.state === 'unknown'), [editing, setEditing] = useState(''), [original, setOriginal] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [chosen, setChosen] = useState(null), [changed, setChanged] = useState(false);
  useEffect(() => { if (expanded || instance.state === 'waiting_review' || instance.state === 'unknown') setOpen(true); }, [instance.state, expanded]);
  return <div className="workflow-node-result"><button className="workflow-result-heading" aria-expanded={open} onClick={() => setOpen(!open)}><strong>{instance.name || instance.nodeId}</strong><span>{instance.itemId ? `第 ${instance.context.index + 1} 项` : '主流程'}</span><span data-state={instance.state}>{stateLabels[instance.state]}</span></button>
    {instance.error && <p className="workflow-error">{instance.error}</p>}
    {open && <div className="workflow-result-body">{Object.entries(instance.outputs).filter(([port]) => !port.startsWith('image:')).map(([port, id]) => <div key={id}><small>{({ value: '内容', raw: '模型原始回答' })[port] || port}</small><Artifact id={id} runId={runId} onValue={port === 'value' ? (a) => { setOriginal(a); if (!changed) { setEditing(typeof a.value === 'string' ? a.value : ''); setChosen(a.type === 'list<image>' ? a.value.map((v) => v.artifactId) : null); } } : undefined} /></div>)}
      {instance.state === 'waiting_review' && <div className="workflow-review">
        {original?.type === 'text' && <label>修改后接受<textarea aria-label={`检查 ${instance.nodeId} 的文字`} rows={5} value={editing} onChange={(e) => { setEditing(e.target.value); setChanged(true); }} /></label>}
        {original?.type === 'list<image>' && <fieldset><legend>选择接受的图片</legend>{original.value.map((v, index) => <label key={v.artifactId}><input type="checkbox" checked={chosen?.includes(v.artifactId) || false} onChange={(e) => { setChosen((ids) => e.target.checked ? [...(ids || []), v.artifactId] : ids.filter((id) => id !== v.artifactId)); setChanged(true); }} />图片 {index + 1}</label>)}</fieldset>}
        <button disabled={!original} onClick={() => onAction(instance, 'accept', changed ? { value: original.type === 'text' ? editing : original.value.filter((v) => chosen.includes(v.artifactId)) } : {})}>接受并继续</button><button className="danger-quiet" onClick={() => onAction(instance, 'reject')}>拒绝此路径</button>
      </div>}
      {instance.state === 'failed' && <button onClick={() => onAction(instance, 'retry')}>重试此节点</button>}
      {instance.state === 'succeeded' && <button onClick={() => onAction(instance, 'regenerate')}>派生运行：重新执行此节点及下游</button>}
      {instance.state === 'unknown' && <div className="workflow-unknown"><p>远端任务可能已经完成。请先核查远端记录；重新执行可能产生额外调用。</p>{instance.canRecover && <button onClick={() => onAction(instance, 'recover')}>核查并取回结果</button>}<label><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />我已核查，接受重复调用的可能</label><button disabled={!acknowledged} onClick={() => onAction(instance, 'reexecute', { acknowledgeDuplicate: true })}>明确重新执行</button><button onClick={() => onAction(instance, 'abandon')}>放弃未知项</button></div>}
      <details><summary>尝试记录（{instance.attempts.length}）</summary>{instance.attempts.map((a) => <div key={a.id}><p>#{a.number} · {stateLabels[a.state]} · {a.dispatchStarted ? '已记录提交意图' : '本地准备'}</p><pre>{JSON.stringify({ request: a.request, remoteId: a.remoteId, error: a.error, metadata: a.data }, null, 2)}</pre>{Object.entries(a.data.outputs || {}).filter(([, id]) => !Object.values(instance.outputs).includes(id)).map(([port, id]) => <div key={id}><small>历史尝试 {a.number} · {port}</small><Artifact id={id} runId={runId} /></div>)}</div>)}</details>
    </div>}
  </div>;
}
function BatchTable({ runId, instanceId, instance, controlVersion, onAction, selected, setSelected, expanded }) {
  const [offset, setOffset] = useState(0), [batch, setBatch] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, timer;
    async function poll() { try { const b = await request(`/api/workflow-runs/${runId}/batches/${instanceId}?offset=${offset}`); if (alive) { setBatch(b); setError(''); } } catch (e) { if (alive) setError(e.message); } if (alive) timer = setTimeout(poll, 1000); }
    poll(); return () => { alive = false; clearTimeout(timer); };
  }, [runId, instanceId, offset, controlVersion, instance.state]);
  return <section className="workflow-batch"><header><h3>{instance.name || '循环批次结果'} <span data-state={instance.state}>{stateLabels[instance.state]}</span></h3>{instance.error && <p className="workflow-error">{instance.error}</p>}{instance.state === 'failed' && <button onClick={() => onAction(instance, 'retry')}>重试循环</button>}{instance.state === 'succeeded' && <button onClick={() => onAction(instance, 'regenerate')}>派生运行：重新执行此循环及下游</button>}</header>{error && <p role="alert">{error}</p>}{batch && <><div className="workflow-actions"><span>{batch.total ? offset + 1 : 0}–{Math.min(offset + 20, batch.total)} / {batch.total} 项 · 顺序按原始输入</span><button disabled={!offset} onClick={() => setOffset((v) => Math.max(0, v - 20))}>上一页</button><button disabled={offset + 20 >= batch.total} onClick={() => setOffset((v) => v + 20)}>下一页</button></div><table><thead><tr><th>输入项</th><th>原始素材</th><th>状态与结果</th></tr></thead><tbody>{batch.items.map((item) => <tr key={item.itemId}><td>{item.index + 1}</td><td>{item.value?.artifactId ? <Artifact id={item.value.artifactId} runId={runId} /> : <pre>{typeof item.value === 'string' ? item.value : JSON.stringify(item.value, null, 2)}</pre>}</td><td><span data-state={item.state}>{stateLabels[item.state]}</span><details open={expanded || item.state === 'waiting_review' || item.state === 'unknown' ? true : undefined}><summary>查看节点、检查与结果</summary>{Object.entries(item.resultArtifacts || {}).map(([port, ref]) => <div key={port}><small>{port} · 复用结果</small><Artifact id={ref.artifactRef} runId={runId} /></div>)}{item.instances.map((i) => <div key={i.id}>{i.state === 'waiting_review' && <label><input type="checkbox" aria-label={`选择检查 ${i.nodeId} ${item.itemId}`} checked={selected.includes(i.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, i.id] : ids.filter((id) => id !== i.id))} />选择此检查</label>}<NodeResult instance={i} runId={runId} controlVersion={controlVersion} onAction={onAction} /></div>)}</details></td></tr>)}</tbody></table></>}</section>;
}
export default function WorkflowRun({ runId, definition, focusNodeId, onStateChange, onEditVersion, onDerived }) {
  const [run, setRun] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [after, setAfter] = useState(0), [events, setEvents] = useState([]), [selected, setSelected] = useState([]), [showGraph, setShowGraph] = useState(false), [diagnostics, setDiagnostics] = useState(false);
  useEffect(() => { if (run) onStateChange?.(run.id, run.state); }, [run?.id, run?.state, onStateChange]);
  useEffect(() => { setAfter(0); setSelected([]); setRun(null); }, [runId]);
  async function refresh() { const r = await request(`/api/workflow-runs/${runId}?after=${after}&limit=100`); setRun(r); return r; }
  useEffect(() => {
    let alive = true, timer, cursor = 0;
    async function poll() {
      try {
        const [r, e] = await Promise.all([request(`/api/workflow-runs/${runId}?after=${after}&limit=100`), request(`/api/workflow-runs/${runId}/events?after=${cursor}`)]);
        if (!alive) return;
        setRun(r); cursor = e.cursor; setEvents((old) => [...old, ...e.events].slice(-200)); setError('');
      } catch (e) { if (alive) setError(e.message); }
      if (alive) timer = setTimeout(poll, 1000);
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
  return <section className="workflow-run" aria-label="工作流运行"><header><h2>{isSample ? '试跑' : '运行'} #{run.id} <span data-state={run.state}>{stateLabels[run.state]}</span></h2><p>版本 {run.version} · {new Date(run.createdAt).toLocaleString()} {run.parentId && `· 派生自 #${run.parentId}`}</p><div className="workflow-actions">
    {!['succeeded', 'partial_failed', 'failed', 'cancelled'].includes(run.state) && <><button disabled={busy} onClick={() => perform(() => command(`/api/workflow-runs/${run.id}/actions`, { action: run.paused ? 'resume' : 'pause', controlVersion: run.controlVersion }))}>{run.paused ? '继续' : '暂停'}</button><button disabled={busy} onClick={() => perform(() => command(`/api/workflow-runs/${run.id}/actions`, { action: 'cancel', controlVersion: run.controlVersion }))}>取消运行</button></>}
    <button disabled={busy} onClick={() => perform(async () => { const w = await command(`/api/workflow-runs/${run.id}/edit-version`, {}); onEditVersion(w); })}>用此版本编辑</button>
    <button disabled={busy} onClick={() => perform(async () => { const r = await command(`/api/workflow-runs/${run.id}/derive`, { definition: nextDefinition }); onDerived(r.id); })}>{isSample ? '用当前草稿继续试跑' : '用当前草稿派生运行'}</button><button onClick={() => setShowGraph(!showGraph)}>查看运行快照</button>
    {(run.state === 'waiting_review' || !!selected.length) && <button disabled={!selected.length} onClick={() => perform(async () => { await command(`/api/workflow-runs/${runId}/reviews`, { instanceIds: selected, action: 'accept', controlVersion: run.controlVersion }); setSelected([]); })}>接受选中的 {selected.length} 项</button>}
  </div></header>
  {showGraph && <><WorkflowGraphSnapshot definition={run.definition} /><details><summary>定义 JSON</summary><pre className="workflow-code">{JSON.stringify(run.definition, null, 2)}</pre></details></>}
  {error && <p role="alert" className="workflow-error">{error}</p>}
  {roots.filter((i) => run.definition.nodes.some((n) => n.id === i.nodeId && n.type === 'foreach')).map((i) => <BatchTable key={i.id} runId={runId} instanceId={i.id} instance={i} controlVersion={run.controlVersion} onAction={nodeAction} selected={selected} setSelected={setSelected} expanded={i.nodeId === focusNodeId} />)}
  {roots.some((i) => !run.definition.nodes.some((n) => n.id === i.nodeId && n.type === 'foreach')) && <fieldset disabled={busy} className="workflow-run-results"><legend>主流程节点结果</legend>
    {roots.filter((i) => !run.definition.nodes.some((n) => n.id === i.nodeId && n.type === 'foreach')).map((i) => <div key={i.id} className="workflow-result-row">{i.state === 'waiting_review' && <label className="workflow-review-select"><input type="checkbox" aria-label={`选择检查 ${i.nodeId} ${i.itemId || ''}`} checked={selected.includes(i.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, i.id] : ids.filter((id) => id !== i.id))} /></label>}<NodeResult instance={i} runId={runId} controlVersion={run.controlVersion} onAction={nodeAction} expanded={i.nodeId === focusNodeId} /></div>)}
  </fieldset>}<details className="workflow-diagnostics" onToggle={(e) => setDiagnostics(e.currentTarget.open)}><summary>诊断：完整实例列表</summary>{diagnostics && <><div className="workflow-actions"><button disabled={!after} onClick={() => { setAfter(0); setSelected([]); }}>第一页</button><button disabled={run.instances.length < 100} onClick={() => { setAfter(run.nextCursor); setSelected([]); }}>下一页</button></div>{run.instances.map((i) => <NodeResult key={i.id} instance={i} runId={runId} controlVersion={run.controlVersion} onAction={nodeAction} />)}</>}</details><details className="workflow-events"><summary>增量事件（最近 {events.length} 条）</summary><ol>{events.map((e) => <li key={e.id}>#{e.id} {e.type} {e.instanceId ? `节点实例 ${e.instanceId}` : ''} {e.data.state ? stateLabels[e.data.state] : ''}</li>)}</ol></details>
  </section>;
}
