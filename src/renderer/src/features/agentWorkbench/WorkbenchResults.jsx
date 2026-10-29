import { useEffect, useState } from 'react';
import { apiUrl, request } from '../../api.js';

const base = '/api/agent';
function TextArtifact({ id, sessionId }) {
  const [text, setText] = useState('加载文字…');
  useEffect(() => { let live = true; fetch(apiUrl(base + '/artifacts/' + id + '/content?sessionId=' + sessionId)).then(r => { if (!r.ok) throw new Error('无法读取产物'); return r.text(); }).then(value => { if (live) setText(value.slice(0, 64000)); }).catch(error => { if (live) setText(error.message); }); return () => { live = false; }; }, [id, sessionId]);
  return <pre>{text}</pre>;
}

const states = { pending: '等待批准', approved: '已批准', rejected: '已拒绝', expired: '已过期', queued: '等待资源', running: '执行中', succeeded: '已保存', failed: '失败', cancelled: '已取消', unknown: '结果待核查', accepted: '已采纳' };
export function CommandOutput({ turnId, value }) {
  const [pages, setPages] = useState(null), [error, setError] = useState('');
  async function more() {
    try {
      const page = await request(`${base}/turns/${turnId}/commands/${value.commandId}/output?offset=${pages?.next || 0}`);
      setPages(previous => ({ ...page, output: (previous?.output || '') + page.output }));
    } catch (error) { setError(error.message); }
  }
  return <details open><summary>命令输出 · 退出码 {value.exitCode ?? '未知'}</summary><pre>{pages?.output ?? value.output}</pre>{value.truncated && <p>宿主输出达到 1 MiB 上限。</p>}{value.commandId && !pages?.done && <button onClick={more}>{pages ? '加载更多输出' : '从头查看输出'}</button>}{error && <p role="alert">{error}</p>}</details>;
}
export default function WorkbenchResults({ detail, busy, act, refresh, attach, onOpen }) {
  const sessionId = detail.session.id;
  const post = async (route, body) => { const result = await request(`${base}${route}${route.includes('?') ? '&' : '?'}sessionId=${sessionId}`, { method: 'POST', body: JSON.stringify(body || {}) }); await refresh(); return result; };
  const [saved, setSaved] = useState({});
  return <aside className="workbench-results" aria-label="任务与产物">
    {(detail.operations || []).filter(operation => operation.state === 'pending').map(operation => <section className="workbench-approval" aria-label={operation.kind === 'workflow.submit' ? '待批准工作流任务' : '待批准图片任务'} key={operation.id}>
      <h3>{operation.kind === 'workflow.submit' ? `运行工作流：${operation.input.name}` : operation.kind === 'task.retry' ? '重新执行任务' : operation.kind === 'image.edit' ? '修改图片' : '生成图片'}</h3>
      <p>执行器：{operation.executor.id} · {operation.executor.settings?.model || '已冻结工作流快照'}</p><p className="workbench-prompt">{operation.input.prompt || '以原有输入再执行一次，将创建新的尝试。'}</p>
      {operation.executor.id === 'workflow' && operation.input.submission && <p>{operation.input.name} · 第 {operation.input.submission.revision} 版 · 最多 {operation.input.maxCalls} 次 AI 调用 · {operation.input.steps.map(step => step.name).join(' → ')}</p>}{!!operation.input.referenceArtifactIds?.length && <p>使用 {operation.input.referenceArtifactIds.length} 张已保存的参考图。</p>}
      <p>批准后可能消耗账号额度或产生费用；上游未提供费用预估。{new Date(operation.expiresAt).toLocaleTimeString()} 到期。</p>
      <div className="workbench-actions">{['reject', 'allow'].map(decision => <button key={decision} disabled={busy} onClick={() => act(() => post(`/operations/${operation.id}/decision`, { decision, hash: operation.hash, requestKey: crypto.randomUUID() }))}>{decision === 'allow' ? '批准并执行' : '拒绝任务'}</button>)}</div>
    </section>)}
    {(detail.proposals || []).map(proposal => <section className="workbench-approval" key={proposal.id} aria-label="Wiki 建议"><h3>Wiki 建议 · {states[proposal.state]}</h3><p>{proposal.payload.reason}</p>{proposal.payload.body && <pre>{proposal.payload.body}</pre>}{proposal.payload.tags && <p>标签：{proposal.payload.tags.join('、')}</p>}{proposal.payload.name && <p>关系：{proposal.payload.name}</p>}{proposal.payload.elementId && <button onClick={() => onOpen?.(proposal.payload.elementId)}>查看原内容</button>}{proposal.state === 'pending' && <div className="workbench-actions">{['reject', 'accept'].map(decision => <button key={decision} disabled={busy} onClick={() => act(() => post(`/sessions/${sessionId}/proposals/${proposal.id}/decision`, { decision, requestKey: crypto.randomUUID() }))}>{decision === 'accept' ? '采纳建议' : '拒绝建议'}</button>)}</div>}</section>)}
    {(detail.tasks || []).map(task => <section className="workbench-task" key={task.id} aria-label={task.executor.id === 'workflow' ? '工作流任务' : '图片任务'}><h3>{task.executor.id === 'workflow' ? '工作流任务' : '图片任务'} · {states[task.state]}</h3><p>{task.data.progress}</p>{task.data.workflowRunId && <a href={`#workflow?run=${task.data.workflowRunId}`}>打开原工作流运行</a>}{task.data.error && <p role="alert">{task.data.error}</p>}{task.state === 'unknown' && <p>可能已在上游执行。核查只尝试取回；重新执行需要再次批准，可能再次计费。</p>}<div className="workbench-actions">{['queued', 'running'].includes(task.state) && <button disabled={busy} onClick={() => act(() => post(`/tasks/${task.id}/cancel`, { revision: task.revision, requestKey: crypto.randomUUID() }))}>{task.executor.id === 'workflow' ? '取消工作流任务' : '取消图片任务'}</button>}{task.state === 'unknown' && <button disabled={busy} onClick={() => act(() => post(`/tasks/${task.id}/reconcile`, { requestKey: crypto.randomUUID() }))}>核查并取回</button>}{['unknown', 'failed', 'cancelled'].includes(task.state) && <button disabled={busy} onClick={() => act(() => post(`/tasks/${task.id}/reexecute`, { revision: task.revision, requestKey: crypto.randomUUID(), operationId: crypto.randomUUID() }))}>申请重新执行</button>}</div></section>)}
    {!!detail.artifacts?.length && <h3>已保存产物</h3>}
    <div className="workbench-artifacts">{(detail.artifacts || []).map(artifact => <figure key={artifact.id}>{artifact.type === 'text' ? <TextArtifact id={artifact.id} sessionId={sessionId} /> : <img loading="lazy" src={apiUrl(`${base}/artifacts/${artifact.id}/content?sessionId=${sessionId}`)} alt="已保存图片" />}<figcaption>{artifact.type === 'text' ? '工作流结果摘要' : `${artifact.metadata.width} × ${artifact.metadata.height}`}<div className="workbench-actions"><a download={`Agent-${artifact.id}.${artifact.type === 'text' ? 'txt' : artifact.mimeType.split('/')[1]}`} href={apiUrl(`${base}/artifacts/${artifact.id}/content?sessionId=${sessionId}`)}>下载</a><button disabled={busy} onClick={() => attach(artifact.id)}>带结果继续</button><button disabled={busy || !!saved[artifact.id]} onClick={() => act(async () => { const value = await post(`/artifacts/${artifact.id}/wiki`); setSaved(previous => ({ ...previous, [artifact.id]: value.elementId })); })}>{saved[artifact.id] ? '已存入 Wiki' : '保存到 Wiki'}</button>{saved[artifact.id] && <button onClick={() => onOpen?.(saved[artifact.id])}>在 Wiki 中查看</button>}</div></figcaption></figure>)}</div>
  </aside>;
}
