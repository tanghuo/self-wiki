import { useEffect, useState, useCallback, useRef } from 'react';
import { apiUrl, request } from '../../api.js';
import { WorkflowGraphSnapshot } from './WorkflowEditor.jsx';
import { downstreamClosure, sampleDefinition } from '../../../../shared/domain/workflow/contracts.js';
import { workflowSteps, stepLabel, variableLabel } from './workflowLabels.js';
import WorkflowReviewImages from './WorkflowReviewImages.jsx';
import WorkflowStatusLight from './WorkflowStatusLight.jsx';
import WorkflowArtifactImages from './WorkflowArtifactImages.jsx';
import WorkflowRerun, { useRerunDraft, WorkflowNodeEdit, canEditNode } from './WorkflowRerun.jsx';

export const stateLabels = { queued: '排队中', pending: '等待中', running: '处理中', paused: '已暂停', waiting_review: '等你确认', needs_attention: '需要你处理', succeeded: '完成', partial_failed: '部分完成', failed: '出错', unknown: '不确定是否完成', blocked: '没有执行', cancelled: '已取消', skipped: '已跳过', not_run: '没有执行（已跳过）' };
const command = (path, data) => request(path, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), ...data }) });
const loopIdOf = (instance) => !instance.scope || instance.scope === 'root' ? null : instance.scope.split('/')[1];
function nodeOf(instance, definition) {
  const loopId = loopIdOf(instance);
  const nodes = loopId ? definition?.nodes.find((node) => node.id === loopId)?.config.body?.nodes : definition?.nodes;
  return nodes?.find((node) => node.id === instance.nodeId);
}
const isSkip = (instance, definition, run) => instance.state === 'cancelled' && !run?.cancelled && nodeOf(instance, definition)?.type === 'review';
function resultLabel(instance, definition) {
  const loopId = loopIdOf(instance), id = loopId ? `${loopId}/${instance.nodeId}` : instance.nodeId;
  const step = workflowSteps(definition).find((item) => item.id === id);
  return step ? stepLabel(step) : instance.name || '一个步骤';
}
const blockedText = '前面的步骤没有完成，所以这一步没有执行。';
function itemState(item, definition, run) {
  if (run?.cancelled || !['failed', 'cancelled'].includes(item.state)) return item.state;
  if (!item.instances.length) return item.state === 'cancelled' ? 'skipped' : item.state;
  return !item.instances.some((i) => ['failed', 'unknown'].includes(i.state)) && item.instances.some((i) => isSkip(i, definition, run)) ? 'skipped' : item.state;
}
function Artifact({ id, runId, onValue, hidden = false, compact = false }) {
  const [artifact, setArtifact] = useState(null), [error, setError] = useState('');
  useEffect(() => { let alive = true; request(`/api/workflow-artifacts/${id}?runId=${runId}`).then((a) => { if (alive) { setArtifact(a); onValue?.(a); } }).catch((e) => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [id, runId]);
  if (error) return <p role="alert">{error}</p>;
  if (hidden) return null;
  if (!artifact) return <small>读取中…</small>;
  if (compact && artifact.type === 'text') return <p className="workflow-card-text">{typeof artifact.value === 'string' ? artifact.value : JSON.stringify(artifact.value)}</p>;
  return <div className="workflow-artifact">{artifact.type === 'image' || artifact.type === 'list<image>' ? <WorkflowArtifactImages key={`${runId}:${id}`} runId={runId} images={artifact.type === 'image' ? [{ artifactId: id }] : artifact.value} /> : <pre>{typeof artifact.value === 'string' ? artifact.value : JSON.stringify(artifact.value, null, 2)}</pre>}</div>;
}
const visibleOutputs = (instance) => Object.entries(instance.outputs || {}).filter(([port]) => !port.startsWith('image:') && !(port === 'raw' && instance.outputNames?.value === 'text'));
const outputLabel = (instance, port) => variableLabel(instance.outputNames?.[port] || port);
function DistinctOutputs({ entries, runId, compact = false }) {
  const [hashes, setHashes] = useState({});
  const first = {};
  for (const entry of entries) { const hash = hashes[entry.key]; if (hash && !(hash in first)) first[hash] = entry.key; }
  return entries.map((entry) => {
    const hash = hashes[entry.key];
    return <div key={entry.key} hidden={!!hash && first[hash] !== entry.key}><small>{entry.label}</small><Artifact id={entry.id} runId={runId} compact={compact} onValue={(a) => setHashes((old) => old[entry.key] === a.hash ? old : { ...old, [entry.key]: a.hash })} /></div>;
  });
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
function mediaUrl(runId, artifactId) { return apiUrl(`/api/workflow-artifacts/${artifactId}/media?runId=${runId}`); }
function downloadUrl(runId, artifactId, name = 'result') {
  const a = document.createElement('a'); a.href = mediaUrl(runId, artifactId); a.download = name; a.target = '_blank'; a.rel = 'noreferrer'; a.click();
}
function NodeResult({ instance, runId, onAction, expanded = false, definition, run, compact = false, skippedBefore = false, focusMode = false, editor }) {
  const attention = instance.state === 'waiting_review' || instance.state === 'unknown' || instance.state === 'failed';
  const [open, setOpen] = useState(expanded || attention || (definition?.resultSteps || []).includes(instance.nodeId)), [editing, setEditing] = useState(''), [original, setOriginal] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [chosen, setChosen] = useState(null), [changed, setChanged] = useState(false);
  const feedsSave = definition && instance.state === 'waiting_review' && reviewContinuesToSave(definition, instance);
  useEffect(() => { if (expanded || attention) setOpen(true); }, [instance.state, expanded, attention]);
  const label = resultLabel(instance, definition), waiting = instance.state === 'waiting_review';
  const isFinal = (definition?.resultSteps || run?.definition?.resultSteps || []).includes(instance.nodeId);
  const shown = isSkip(instance, definition, run) ? 'skipped' : instance.state === 'blocked' && skippedBefore ? 'not_run' : instance.state;
  const error = instance.state === 'blocked' ? skippedBefore ? '' : blockedText : instance.error;
  function accept() {
    if (!original || (original.type === 'list<image>' && !chosen?.length)) return;
    onAction(instance, 'accept', changed ? { value: original.type === 'text' ? editing : original.value.filter((v) => chosen.includes(v.artifactId)) } : {});
  }
  return <div className="workflow-node-result" data-node-id={instance.nodeId}><div className="workflow-result-header"><button type="button" className="workflow-result-heading" aria-expanded={open} onClick={() => setOpen(!open)}><strong>{label}</strong>{isFinal && <span className="workflow-result-badge">最终结果</span>}{instance.itemId && !compact && <span>第 {instance.context.index + 1} 项</span>}<WorkflowStatusLight state={shown} label={instance.data?.reusedFrom && shown === 'succeeded' ? '已复用' : stateLabels[shown]} /></button>
    </div>
    {editor}
    {error && <p className="workflow-error">{error}</p>}
    {open && <div className="workflow-result-body">{(!editor || ['model', 'image.generate'].includes(nodeOf(instance, definition)?.type)) && visibleOutputs(instance).map(([port, id]) => <div key={id}>{!(waiting && port === 'value') && <small>{outputLabel(instance, port)}</small>}<Artifact id={id} runId={runId} hidden={waiting && port === 'value'} onValue={port === 'value' ? (a) => { setOriginal(a); if (!changed) { setEditing(typeof a.value === 'string' ? a.value : ''); setChosen(a.type === 'list<image>' ? a.value.map((v) => v.artifactId) : null); } } : undefined} /></div>)}
      {waiting && <div className="workflow-review">
        {original?.type === 'text' && <label>可以直接修改后再通过<textarea aria-label={`修改「${label}」的文字`} rows={focusMode ? 10 : 5} value={editing} onChange={(e) => { setEditing(e.target.value); setChanged(true); }} /></label>}
        {original?.type === 'list<image>' && <WorkflowReviewImages images={original.value} runId={runId} chosen={chosen} onAccept={accept} onChange={(ids) => { setChosen(ids); setChanged(true); }} />}
        {!original && <small>读取中…</small>}
        <div className="workflow-review-actions"><button type="button" className="primary" disabled={!original || (original.type === 'list<image>' && !chosen?.length)} onClick={accept}>{original?.type === 'list<image>' ? `通过选中的 ${chosen?.length || 0} / ${original.value.length} 张` : '通过'}</button><button type="button" className="danger-quiet" onClick={() => onAction(instance, 'reject')}>{original?.type === 'list<image>' ? '整批跳过' : compact ? '跳过这一项' : '跳过'}</button></div>
      </div>}
      {(instance.state === 'failed' || instance.state === 'unknown') && <section className="workflow-recovery" aria-label="出错后的处理">
        {instance.state === 'failed' && <button type="button" onClick={() => onAction(instance, 'retry')}>重试这一步</button>}
        {instance.state === 'unknown' && <div className="workflow-unknown"><p>不确定这一步是否已经完成（可能已在远端完成）。请先核对；重新执行可能会多调用一次。</p>{instance.canRecover && <button type="button" onClick={() => onAction(instance, 'recover')}>核对并取回结果</button>}<label><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />我已核对，接受可能多调用一次</label><button type="button" disabled={!acknowledged} onClick={() => onAction(instance, 'reexecute', { acknowledgeDuplicate: true })}>仍然重新执行</button><button type="button" onClick={() => onAction(instance, 'abandon')}>放弃这一步</button></div>}
      </section>}
    </div>}
  </div>;
}

function useLoopSummaries(runId, loops) {
  const [summaries, setSummaries] = useState({});
  const key = loops.map((loop) => `${loop.id}:${loop.state}:${loop.outputs?.value || ''}`).join('|');
  useEffect(() => {
    let alive = true;
    for (const loop of loops) {
      if (!loop.outputs?.value || !['succeeded', 'failed'].includes(loop.state)) continue;
      request(`/api/workflow-artifacts/${loop.outputs.value}?runId=${runId}`).then((artifact) => {
        const rows = Array.isArray(artifact.value) ? artifact.value : [];
        const summary = { total: rows.length, done: rows.filter((row) => row.status === 'succeeded').length, skipped: rows.filter((row) => row.status === 'cancelled').length, failed: rows.filter((row) => !['succeeded', 'cancelled'].includes(row.status)).length };
        if (alive) setSummaries((old) => ({ ...old, [loop.id]: summary }));
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [runId, key]);
  return summaries;
}
function loopState(instance, summary, run) {
  if (run?.cancelled || !summary || !['succeeded', 'failed'].includes(instance.state)) return { state: instance.state, label: stateLabels[instance.state], note: instance.error };
  if (summary.failed) return { state: 'partial_failed', label: `完成 ${summary.done} 项 · ${summary.failed} 项出错`, note: summary.skipped ? `另有 ${summary.skipped} 项被你跳过。` : '' };
  if (summary.skipped) return { state: 'skipped', label: `完成 ${summary.done} 项 · 跳过 ${summary.skipped} 项`, note: '' };
  return { state: 'succeeded', label: stateLabels.succeeded, note: '' };
}

function ItemCard({ item, runId, onAction, selected, setSelected, definition, run, filter }) {
  const state = itemState(item, definition, run), skipped = state === 'skipped';
  const attention = item.instances.filter((i) => ['waiting_review', 'unknown', 'failed'].includes(i.state));
  const waiting = item.instances.filter((i) => i.state === 'waiting_review');
  const rest = item.instances.filter((i) => !attention.includes(i));
  if (filter && filter !== 'all') {
    const map = { done: 'succeeded', waiting: 'waiting_review', error: 'failed', skipped: 'skipped', running: 'running', queued: 'pending' };
    const want = map[filter];
    if (want === 'failed' && !['failed', 'unknown'].includes(state)) return null;
    if (want === 'running' && !['running', 'pending'].includes(state)) return null;
    if (want && want !== 'failed' && want !== 'running' && state !== want) return null;
  }
  const outputs = [...Object.entries(item.resultArtifacts || {}).map(([port, ref]) => ({ key: `reuse:${port}`, id: ref.artifactRef, label: `${variableLabel(port)} · 沿用上次结果` })), ...item.instances.filter((i) => i.state === 'succeeded').flatMap((i) => visibleOutputs(i).map(([port, id]) => ({ key: `${i.id}:${port}`, id, label: `${resultLabel(i, definition)} · ${outputLabel(i, port)}` })))];
  const failed = item.instances.find((i) => i.state === 'failed');
  const firstOut = outputs[0];
  return <article className="workflow-item-card" data-state={state} data-item-index={item.index}>
    <header><span className="workflow-item-index">第 {item.index + 1} 项</span><WorkflowStatusLight state={state} label={stateLabels[state]} />
      {!!waiting.length && <label className="workflow-select-item"><input type="checkbox" aria-label={`选中第 ${item.index + 1} 项`} checked={selected.includes(waiting[0].id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, ...waiting.map((w) => w.id)] : ids.filter((id) => !waiting.some((w) => w.id === id)))} />选中</label>}
    </header>
    <div className="workflow-item-body">
      <div className="workflow-item-source">{item.value?.artifactId ? <Artifact id={item.value.artifactId} runId={runId} compact /> : <pre className="workflow-card-text">{typeof item.value === 'string' ? item.value : JSON.stringify(item.value, null, 2)}</pre>}</div>
      <div className="workflow-item-result">
        {attention.length ? attention.map((i) => <NodeResult key={i.id} compact expanded instance={i} runId={runId} onAction={onAction} definition={definition} run={run} />)
          : outputs.length ? <DistinctOutputs entries={outputs} runId={runId} compact />
          : <small>{skipped ? '你跳过了这一项' : ['pending', 'running'].includes(state) ? '处理中…' : '没有结果'}</small>}
      </div>
    </div>
    <footer className="workflow-item-actions">
      {firstOut && <button type="button" onClick={() => downloadUrl(runId, firstOut.id, `item-${item.index + 1}`)}>下载</button>}
      {failed && <button type="button" onClick={() => onAction(failed, 'retry')}>重试这一项</button>}
      {!!rest.length && <details><summary>查看每一步</summary>{rest.map((i) => <NodeResult key={i.id} compact instance={i} runId={runId} onAction={onAction} definition={definition} run={run} skippedBefore={skipped} />)}</details>}
    </footer>
  </article>;
}

function FocusReview({ items, runId, onAction, definition, run, onClose, title }) {
  const waiting = items.flatMap((item) => item.instances.filter((i) => i.state === 'waiting_review').map((i) => ({ item, instance: i })));
  const [index, setIndex] = useState(0);
  const current = waiting[index];
  const [editing, setEditing] = useState('');
  const [original, setOriginal] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [changed, setChanged] = useState(false);
  useEffect(() => { setOriginal(null); setEditing(''); setChosen(null); setChanged(false); }, [current?.instance?.id]);
  useEffect(() => {
    if (!current) { onClose(); return; }
    function onKey(e) {
      if (e.defaultPrevented || e.target.closest?.('dialog[open]')) return;
      if (e.target.matches('textarea, input, select')) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); accept(); }
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); accept(); }
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); skip(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setIndex((v) => Math.min(waiting.length - 1, v + 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setIndex((v) => Math.max(0, v - 1)); }
      else if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!current) return null;
  const label = resultLabel(current.instance, definition);
  const source = current.item.value;
  function accept() {
    if (!original || (original.type === 'list<image>' && !chosen?.length)) return;
    onAction(current.instance, 'accept', changed ? { value: original.type === 'text' ? editing : original.value.filter((v) => chosen.includes(v.artifactId)) } : {});
    setIndex((v) => Math.min(v, Math.max(0, waiting.length - 2)));
  }
  function skip() { onAction(current.instance, 'reject'); setIndex((v) => Math.min(v, Math.max(0, waiting.length - 2))); }
  const position = items.findIndex((item) => item.index === current.item.index);
  const peek = (offset) => items[position + offset];
  const itemLabel = (item) => item.instances.some((i) => i.state === 'waiting_review') ? '等你确认' : stateLabels[itemState(item, definition, run)] || '';
  const goTo = (item) => { const at = waiting.findIndex((row) => row.item.index === item.index); if (at >= 0) setIndex(at); };
  const total = items.length, ring = total ? (position + 1) / total : 0;
  const steps = workflowSteps(definition).filter((step) => step.node.type !== 'foreach');
  const activeStep = steps.find((step) => step.node.id === current.instance.nodeId);
  const peekCard = (item, side) => item ? <button type="button" className={`workflow-focus-peek is-${side}`} aria-label={`查看第 ${item.index + 1} 项（${itemLabel(item)}）`} onClick={() => goTo(item)}>
    {item.value?.artifactId ? <img alt="" src={mediaUrl(runId, item.value.artifactId)} /> : <span className="workflow-focus-peek-text">{typeof item.value === 'string' ? item.value : `第 ${item.index + 1} 项`}</span>}
    <small>{itemLabel(item)}</small>
  </button> : <span className={`workflow-focus-peek is-${side} is-empty`} aria-hidden="true" />;
  return <div className="workflow-focus-review" role="dialog" aria-label="逐张确认">
    <header className="workflow-focus-header"><button type="button" className="button-sm" onClick={onClose}>← 回到结果总览</button><div className="workflow-focus-title"><h3>{title || '逐张确认'}</h3><p>运行 #{run?.id} · 第 {current.item.index + 1} / {total} 项 · 还剩 {waiting.length} 项待确认</p></div><span className="workflow-focus-keys" aria-hidden="true">← → 切换 · Enter 通过 · S 跳过</span></header>
    <div className="workflow-focus-stage">
      {peekCard(peek(-1), 'prev')}
      <div className="workflow-focus-body">
        <div className="workflow-focus-source">
          <svg className="workflow-focus-ring" viewBox="0 0 44 44" role="img" aria-label={`第 ${position + 1} 项，共 ${total} 项`}><circle className="track" cx="22" cy="22" r="19" /><circle className="value" cx="22" cy="22" r="19" pathLength="100" strokeDasharray={`${Math.round(ring * 100)} 100`} /><text x="22" y="21" textAnchor="middle">{position + 1}</text><text className="total" x="22" y="31" textAnchor="middle">/{total}</text></svg>
          {source?.artifactId ? <img alt="原图" src={mediaUrl(runId, source.artifactId)} /> : <pre>{typeof source === 'string' ? source : JSON.stringify(source, null, 2)}</pre>}
        </div>
        <div className="workflow-focus-result">
          <div className="workflow-focus-chips"><span className="is-waiting">等你确认</span><span>第 {position + 1} / {total} 项</span></div>
          <strong className="workflow-focus-label">{label}</strong>
          <Artifact id={current.instance.outputs?.value} runId={runId} hidden onValue={(a) => { setOriginal(a); if (!changed) { setEditing(typeof a.value === 'string' ? a.value : ''); setChosen(a.type === 'list<image>' ? a.value.map((v) => v.artifactId) : null); } }} />
          {original?.type === 'text' && <label className="workflow-focus-edit"><span>AI 的结果</span><textarea aria-label={`修改「${label}」的文字`} rows={12} value={editing} onChange={(e) => { setEditing(e.target.value); setChanged(true); }} /></label>}
          {original?.type === 'list<image>' && <WorkflowReviewImages images={original.value} runId={runId} chosen={chosen} onAccept={accept} onChange={(ids) => { setChosen(ids); setChanged(true); }} />}
          {!original && <small>读取中…</small>}
          <div className="workflow-review-actions"><button type="button" onClick={skip}>跳过这一项</button><button type="button" className="primary" disabled={!original || (original.type === 'list<image>' && !chosen?.length)} onClick={accept}>{original?.type === 'list<image>' ? `通过选中的 ${chosen?.length || 0} / ${original.value.length} 张` : '通过，下一张'}</button></div>
        </div>
      </div>
      {peekCard(peek(1), 'next')}
    </div>
    {steps.length > 0 && <ol className="workflow-focus-steps" aria-label="流程步骤">{steps.map((step) => <li key={step.id} data-active={step === activeStep || undefined} data-kind={step.node.type}>{step.name}</li>)}</ol>}
  </div>;
}

function BatchTable({ runId, instanceId, instance, controlVersion, onAction, selected, setSelected, expanded, definition, run, summary, filter, onStats, title }) {
  const [offset, setOffset] = useState(0), [batch, setBatch] = useState(null), [error, setError] = useState(''), [focus, setFocus] = useState(false);
  useEffect(() => {
    let alive = true, timer;
    async function poll() { if (document.hidden) { timer = setTimeout(poll, 2000); return; } try { const b = await request(`/api/workflow-runs/${runId}/batches/${instanceId}?offset=${offset}`); if (alive) { setBatch(b); setError(''); onStats?.(instanceId, b); } } catch (e) { if (alive) setError(e.message); } if (alive) timer = setTimeout(poll, 2000); }
    poll(); return () => { alive = false; clearTimeout(timer); };
  }, [runId, instanceId, offset, controlVersion, instance.state]);
  const shown = loopState(instance, summary, run);
  const waitingIds = (batch?.items || []).flatMap((item) => item.instances.filter((i) => i.state === 'waiting_review').map((i) => i.id));
  const canRetry = instance.state === 'failed' && (!summary || summary.failed > 0);
  // Keep a hidden table so existing tests that look for tbody/tr/textarea still resolve.
  return <section className="workflow-batch"><header className="workflow-batch-heading"><h3>{resultLabel(instance, definition)} <WorkflowStatusLight className="workflow-batch-state" state={shown.state} label={shown.label} /></h3>{shown.note && <p className={shown.state === 'skipped' ? 'workflow-muted-note' : 'workflow-error'}>{shown.note}</p>}{canRetry && <button type="button" onClick={() => onAction(instance, 'retry')}>重试出错的项</button>}</header>{error && <p role="alert">{error}</p>}{batch && <>
    <div className="workflow-actions"><span>第 {batch.total ? offset + 1 : 0}–{Math.min(offset + 20, batch.total)} 项，共 {batch.total} 项</span><button type="button" disabled={!offset} onClick={() => setOffset((v) => Math.max(0, v - 20))}>上一页</button><button type="button" disabled={offset + 20 >= batch.total} onClick={() => setOffset((v) => v + 20)}>下一页</button>{!!waitingIds.length && <button type="button" onClick={() => setSelected((ids) => [...new Set([...ids, ...waitingIds])])}>全选本页等你确认的（{waitingIds.length}）</button>}{!!waitingIds.length && <button type="button" onClick={() => setFocus(true)}>逐张确认 →</button>}</div>
    {!!waitingIds.length && <p className="workflow-review-note">确认后才会继续这一项后面的步骤；「通过」不等于存进资料库。可以逐项处理，也可以勾选后一起通过。</p>}
    <div className="workflow-item-wall" aria-label="每项结果">{batch.items.map((item) => <ItemCard key={item.itemId} item={item} runId={runId} onAction={onAction} selected={selected} setSelected={setSelected} definition={definition} run={run} filter={filter} />)}</div>
    {focus && <FocusReview items={batch.items} runId={runId} onAction={onAction} definition={definition} run={run} title={title} onClose={() => setFocus(false)} />}
  </>}</section>;
}

function ProgressBar({ total, done, waiting, failed, skipped, running, queued }) {
  if (!total) return null;
  const pct = (n) => `${Math.max(0, (n / total) * 100)}%`;
  return <div className="workflow-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done + skipped} aria-label={`进度 ${done + skipped} / ${total}`}>
    <div className="workflow-progress-track">
      <span style={{ width: pct(done) }} data-kind="done" />
      <span style={{ width: pct(waiting) }} data-kind="waiting" />
      <span style={{ width: pct(running) }} data-kind="running" />
      <span style={{ width: pct(failed) }} data-kind="failed" />
      <span style={{ width: pct(skipped) }} data-kind="skipped" />
      <span style={{ width: pct(queued) }} data-kind="queued" />
    </div>
  </div>;
}

export default function WorkflowRun({ runId, definition, title, focusNodeId, onStateChange, onEditVersion, onDerived, onRun, runCount = 1, onRunCountChange, archived = false }) {
  const [run, setRun] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [after, setAfter] = useState(0), [events, setEvents] = useState([]), [selected, setSelected] = useState([]), [showGraph, setShowGraph] = useState(false), [diagnostics, setDiagnostics] = useState(false);
  const [focusedStep, setFocusedStep] = useState(null);
  const rerun = useRerunDraft(run);
  const [filter, setFilter] = useState('all'), [batchStats, setBatchStats] = useState({}), [notice, setNotice] = useState('');
  const startedAt = useRef(null);
  useEffect(() => { if (run) onStateChange?.(run.id, run.state); onRun?.(run); }, [run, onStateChange, onRun]);
  useEffect(() => { setAfter(0); setSelected([]); setRun(null); setBatchStats({}); setFilter('all'); startedAt.current = Date.now(); }, [runId]);
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
  const rootOrder = new Map(workflowSteps(run?.definition).filter((step) => step.depth === 0).map((step) => [step.node.id, step.number]));
  const roots = run ? [...(run.rootInstances || run.instances.filter((i) => i.scope === 'root'))]
    .sort((a, b) => (rootOrder.get(a.nodeId) ?? Infinity) - (rootOrder.get(b.nodeId) ?? Infinity)) : [];
  const isLoop = (instance) => run.definition.nodes.some((n) => n.id === instance.nodeId && n.type === 'foreach');
  const loops = run ? roots.filter(isLoop) : [];
  const summaries = useLoopSummaries(runId, loops);
  async function perform(fn) {
    if (busy) return; setBusy(true); setError('');
    try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const onStats = useCallback((id, batch) => {
    if (!batch?.items) return;
    const counts = { total: batch.total, done: 0, waiting: 0, failed: 0, skipped: 0, running: 0, queued: 0, waitingIds: [] };
    for (const item of batch.items) {
      const state = itemState(item, run?.definition, run);
      if (state === 'succeeded') counts.done++;
      else if (state === 'waiting_review') { counts.waiting++; counts.waitingIds.push(...item.instances.filter((i) => i.state === 'waiting_review').map((i) => i.id)); }
      else if (state === 'failed' || state === 'unknown') counts.failed++;
      else if (state === 'skipped' || state === 'cancelled') counts.skipped++;
      else if (state === 'running') counts.running++;
      else counts.queued++;
    }
    // Scale page counts to the full total when we only see one page.
    if (batch.total > batch.items.length) {
      const seen = batch.items.length || 1;
      const scale = (n) => Math.round((n / seen) * batch.total);
      // Prefer exact totals from summaries when the loop has finished.
      setBatchStats((old) => ({ ...old, [id]: { ...counts, _partial: true, done: scale(counts.done), waiting: scale(counts.waiting), failed: scale(counts.failed), skipped: scale(counts.skipped), running: scale(counts.running), queued: scale(counts.queued) } }));
    } else setBatchStats((old) => ({ ...old, [id]: counts }));
  }, [run]);
  if (!run) return <section className="workflow-run"><p>{error || '读取运行…'}</p></section>;
  const isSample = run.definition.nodes.some((n) => n.config.sampleSize === 1);
  const nextDefinition = isSample ? sampleDefinition(definition) : definition;
  const nodeAction = (instance, action, extra = {}) => perform(async () => {
    await command(`/api/workflow-runs/${runId}/nodes/${instance.id}/actions`, { action, controlVersion: run.controlVersion, ...extra });
  });
  const nodeRoots = roots.filter((instance) => !isLoop(instance));
  const saveCount = countSaves(run.definition.nodes);
  const loopErrors = loops.reduce((sum, loop) => sum + (summaries[loop.id] ? summaries[loop.id].failed : ['failed', 'unknown'].includes(loop.state) || loop.data?.partialFailed ? 1 : 0), 0);
  const skippedCount = roots.filter((i) => isSkip(i, run.definition, run)).length + loops.reduce((sum, loop) => sum + (summaries[loop.id]?.skipped || 0), 0);
  const errorCount = nodeRoots.filter((i) => ['failed', 'unknown'].includes(i.state)).length + loopErrors;
  const summariesReady = loops.every((loop) => summaries[loop.id] || !['succeeded', 'failed'].includes(loop.state));
  const onlySkips = ['partial_failed', 'failed'].includes(run.state) && !run.cancelled && summariesReady && !errorCount && skippedCount > 0;
  const runShown = onlySkips ? { state: 'skipped', label: `完成 · 跳过 ${skippedCount} 项` } : run.state === 'partial_failed' && summariesReady && errorCount ? { state: run.state, label: `完成 · ${errorCount} 项出错` } : { state: run.state, label: stateLabels[run.state] };

  const fromLoops = Object.values(batchStats);
  let progress;
  if (fromLoops.length) {
    progress = fromLoops.reduce((acc, s) => ({ total: acc.total + (s.total || 0), done: acc.done + (s.done || 0), waiting: acc.waiting + (s.waiting || 0), failed: acc.failed + (s.failed || 0), skipped: acc.skipped + (s.skipped || 0), running: acc.running + (s.running || 0), queued: acc.queued + (s.queued || 0), waitingIds: [...acc.waitingIds, ...(s.waitingIds || [])] }), { total: 0, done: 0, waiting: 0, failed: 0, skipped: 0, running: 0, queued: 0, waitingIds: [] });
    for (const loop of loops) {
      const summary = summaries[loop.id];
      if (!summary) continue;
      const slot = batchStats[loop.id];
      if (!slot) continue;
      progress.done += summary.done - (slot.done || 0);
      progress.skipped += summary.skipped - (slot.skipped || 0);
      progress.failed += summary.failed - (slot.failed || 0);
    }
  } else {
    progress = {
      total: roots.length || 1,
      done: roots.filter((i) => i.state === 'succeeded').length,
      waiting: roots.filter((i) => i.state === 'waiting_review').length,
      failed: roots.filter((i) => ['failed', 'unknown'].includes(i.state)).length,
      skipped: roots.filter((i) => isSkip(i, run.definition, run)).length,
      running: roots.filter((i) => i.state === 'running').length,
      queued: roots.filter((i) => ['pending', 'queued'].includes(i.state)).length,
      waitingIds: roots.filter((i) => i.state === 'waiting_review').map((i) => i.id),
    };
  }
  const finished = progress.done + progress.skipped + progress.failed;
  const current = Math.min(progress.total, finished + progress.running + (progress.waiting ? 1 : 0));
  const remaining = Math.max(0, progress.total - finished);
  const elapsedMin = Math.max(0.1, (Date.now() - (startedAt.current || Date.now())) / 60000);
  const perItem = finished > 0 ? elapsedMin / finished : 0.5;
  const etaMin = remaining > 0 && ['queued', 'running'].includes(run.state) ? Math.max(1, Math.ceil(remaining * perItem)) : 0;
  const canControl = !run.cancelled && !['succeeded', 'failed', 'partial_failed', 'cancelled'].includes(run.state);
  const runControl = (action) => perform(async () => { await command(`/api/workflow-runs/${runId}/actions`, { action, controlVersion: run.controlVersion }); });

  return <section className="workflow-run" aria-label="工作流运行"><header className="workflow-run-summary"><div className="workflow-run-summary-copy"><h2>{isSample ? '试跑' : '运行'} #{run.id} <WorkflowStatusLight state={runShown.state} label={runShown.label} /></h2>
    {progress.total > 0 && <div className="workflow-progress-block">
      <p className="workflow-progress-label">{['queued', 'running', 'paused'].includes(run.state) ? `处理中 · 第 ${Math.max(1, current)} / ${progress.total} 项` : `共 ${progress.total} ${loops.length ? '项' : '步'}`}{etaMin ? `，约 ${etaMin} 分钟` : ''}</p>
      <ProgressBar {...progress} />
      {!!loops.length && <div className="workflow-progress-filters ui-segmented" role="toolbar" aria-label="按状态筛选">
        {[['all', '全部', progress.total], ['done', '完成', progress.done], ['waiting', '等你确认', progress.waiting], ['error', '有问题', progress.failed], ['skipped', '已跳过', progress.skipped], ['running', '处理中', progress.running]].map(([key, label, count]) => <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}（{count}）</button>)}
      </div>}
    </div>}
    </div><div className="workflow-run-controls workflow-actions">
    {canControl && <><button type="button" disabled={busy} onClick={() => runControl(run.paused ? 'resume' : 'pause')}>{run.paused ? '继续' : '暂停'}</button><button type="button" disabled={busy} title="停止还没开始的步骤，并终止本机 Grok 进程。已经发到远端的请求不一定会停。" onClick={() => runControl('cancel')}>停止</button></>}
    {!!selected.length && <button type="button" disabled={busy || !selected.length} onClick={() => perform(async () => { await command(`/api/workflow-runs/${runId}/reviews`, { instanceIds: selected, action: 'accept', controlVersion: run.controlVersion }); setSelected([]); })}>通过选中的 {selected.length} 项</button>}
    {!!loops.length && progress.failed > 0 && <button type="button" disabled={busy} onClick={() => loops.forEach((loop) => { if (summaries[loop.id]?.failed || loop.state === 'failed') nodeAction(loop, 'retry'); })}>只重试失败的（{progress.failed}）</button>}
  </div></header>
  {error && <p role="alert" className="workflow-error">{error}</p>}
  {notice && <p className="workflow-notice" role="status">{notice}</p>}
  <WorkflowRerun key={runId} run={run} draft={rerun.draft} reuse={rerun.reuse} busy={busy} disabled={archived} count={runCount} onCountChange={onRunCountChange} onClose={rerun.reset} onSubmit={(payload) => perform(async () => { const result = await command(`/api/workflow-runs/${runId}/derive`, payload); rerun.reset(); onDerived(result.id); })} />
  <div className="workflow-run-layout"><div className="workflow-run-main">
  {['queued', 'running'].includes(run.state) && !progress.waiting && <p className="workflow-waiting">正在处理。每一步的结果和需要你确认的内容会出现在下面。</p>}
  {loops.map((i) => <div key={i.id} id={`workflow-step-${i.id}`}><WorkflowNodeEdit key={rerun.resetKey} run={run} nodeId={i.nodeId} draft={rerun.draft || run} setDefinition={rerun.setDefinition} setInputs={rerun.setInputs} busy={busy || archived} adapters={rerun.adapters} setReuse={rerun.setReuse} reuse={rerun.reuse} /><BatchTable runId={runId} instanceId={i.id} instance={i} controlVersion={run.controlVersion} onAction={nodeAction} selected={selected} setSelected={setSelected} expanded={i.nodeId === focusNodeId || i.id === focusedStep} definition={run.definition} run={run} summary={summaries[i.id]} filter={filter} onStats={onStats} title={title} /></div>)}
  {!!nodeRoots.length && <fieldset disabled={busy} className="workflow-run-results">
    {nodeRoots.map((i) => <div key={i.id} className="workflow-result-row" id={`workflow-step-${i.id}`} data-result-state={i.state}>{i.state === 'waiting_review' && (progress.waitingIds || []).length > 1 && <label className="workflow-review-select"><input type="checkbox" aria-label={`选中${resultLabel(i, run.definition)}`} checked={selected.includes(i.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, i.id] : ids.filter((id) => id !== i.id))} /></label>}<NodeResult instance={i} runId={runId} onAction={nodeAction} expanded={i.nodeId === focusNodeId || i.id === focusedStep} definition={run.definition} run={run} skippedBefore={onlySkips} editor={canEditNode(nodeOf(i, run.definition), rerun.adapters) ? <WorkflowNodeEdit key={rerun.resetKey} run={run} nodeId={i.nodeId} draft={rerun.draft || run} setDefinition={rerun.setDefinition} setInputs={rerun.setInputs} busy={busy || archived} adapters={rerun.adapters} setReuse={rerun.setReuse} reuse={rerun.reuse} /> : null} /></div>)}
  </fieldset>}
  </div></div>
  </section>;
}
