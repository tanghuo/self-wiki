import { useEffect, useState } from 'react';
import { Plus, Square, Send, FolderOpen, ShieldCheck } from 'lucide-react';
import { apiUrl, request } from '../../api.js';
import PageHeader from '../../ui/PageHeader.jsx';
import './workbench.css';
import WorkbenchPolicy from './WorkbenchPolicy.jsx';
import useWorkbenchDraft from './useWorkbenchDraft.js';
import WorkbenchResults, { CommandOutput } from './WorkbenchResults.jsx';

const base = '/api/agent';
const post = (route, value = {}) => request(base + route, { method: 'POST', body: JSON.stringify(value) });
const labels = { ready: '就绪', running: '执行中', queued: '排队中', awaiting_approval: '等待审批', cancelling: '正在停止', completed: '完成', failed: '失败', cancelled: '已停止', unknown: '结果待核查', needs_attention: '需要核查' };
const active = state => ['queued', 'running', 'awaiting_approval', 'cancelling'].includes(state);

function Approval({ approval, decide, busy }) {
  const op = approval.operation;
  if (op.kind.startsWith('native.')) return <section className="workbench-approval" aria-label="待审批操作"><h3><ShieldCheck size={18} />{op.kind === 'native.file' ? '修改文件 · Codex 原生审批' : '运行命令 · Codex 原生审批'}</h3>{op.kind === 'native.file' ? op.changes.map((change, index) => <div key={index}><p className="workbench-path">{change.path}{change.kind?.move_path && ` → ${change.kind.move_path}`}</p><pre>{change.diff}</pre></div>) : <><pre>{op.command}</pre><p className="workbench-path">工作目录：{op.cwd}</p></>}<p>{op.reason}</p><p>本次原生操作；不创建长期规则。Codex 可读取全盘，安全读取可能无需审批。</p><div className="workbench-actions"><button disabled={busy} onClick={() => decide(approval, 'reject')}>拒绝</button><button disabled={busy} onClick={() => decide(approval, 'allow')}>允许一次</button></div></section>;
  return <section className="workbench-approval" aria-label="待审批操作">
    <h3><ShieldCheck size={18} />{op.kind === 'file.write' ? '写入文件' : op.kind === 'command' ? '运行命令' : '引擎权限请求'}</h3>
    {op.kind === 'file.write' ? <><p className="workbench-path">{op.path}</p><details open><summary>查看修改</summary><div className="workbench-diff"><pre aria-label="修改前">{op.before || '（新建文件）'}</pre><pre aria-label="修改后">{op.after}</pre></div></details></> : op.kind === 'command' ? <><p className="workbench-path">{op.program}</p><pre>{op.args?.join('\n')}</pre><p>工作目录：{op.cwd}</p>{op.environment?.length > 0 && <p>环境：{op.environment.map(entry => `${entry.name}=${entry.value}`).join(' · ')}</p>}<p>{op.warning}</p></> : <><p>{op.title || op.tool}</p><pre>{JSON.stringify(op.input, null, 2)}</pre><p>此授权不能替代文件或命令宿主的审批。</p></>}
    <p className="workbench-muted">本次有效，{new Date(approval.expiresAt).toLocaleTimeString()} 到期。</p>
    <div className="workbench-actions"><button disabled={busy} onClick={() => decide(approval, 'reject')}>拒绝</button><button disabled={busy} onClick={() => decide(approval, 'allow')}>允许一次</button></div>
  </section>;
}
function Timeline({ turns, events }) {
  const items = [];
  for (const event of events) {
    const previous = items.at(-1);
    if (event.type === 'message.delta' && previous?.type === 'message.delta' && previous.turnId === event.turnId) previous.data.text += event.data.text;
    else items.push({ ...event, data: { ...event.data } });
  }
  return <div className="workbench-timeline" aria-label="执行时间线">
    {turns.map(turn => <section className="workbench-turn" key={turn.id}>
      <div className="workbench-message user"><strong>你</strong><p>{turn.input.text}</p></div>
      {items.filter(item => item.turnId === turn.id).map(item => <div key={item.seq} className={`workbench-event ${item.type === 'message.delta' ? 'assistant' : ''}`}>
        {item.type === 'message.delta' ? <p>{item.data.text}</p> : item.type === 'tool.updated' ? <p>{item.data.title || '工具调用'} {labels[item.data.status] || item.data.status}</p> : item.type === 'command.output' ? <CommandOutput turnId={turn.id} value={item.data} /> : item.type === 'file.changed' ? <details><summary>已修改 {item.data.path}</summary><div className="workbench-diff"><pre>{item.data.before || '（新文件）'}</pre><pre>{item.data.after}</pre></div></details> : item.type === 'file.native_diff' ? <details><summary>Codex 原生文件差异 · {item.data.status}</summary>{item.data.changes.map((change, index) => <div key={index}><p className="workbench-path">{change.path}</p><pre>{change.diff}</pre></div>)}</details> : item.type === 'engine.diff' ? <details><summary>Codex 本轮差异</summary><pre>{item.data.diff}</pre></details> : item.type === 'plan.updated' ? <ol>{(item.data.entries || []).map((entry, index) => <li key={index}>{entry.content} · {entry.status}</li>)}</ol> : item.type === 'workspace.changed' ? item.data.current.git && <details><summary>工作区差异（可能包含外部修改）</summary><pre>{item.data.current.status.join('\n') || '没有可见变化'}</pre><pre>{item.data.current.diff}</pre></details> : item.type === 'turn.finished' && item.data.error ? <p role="alert">{item.data.error}</p> : null}
      </div>)}
      <p className="workbench-muted">{labels[turn.state] || turn.state}{turn.state === 'unknown' ? '：不会自动重发，请先核对文件和命令结果。' : ''}</p>
    </section>)}
  </div>;
}
export default function AgentWorkbench({ onOpen }) {
  const [status, setStatus] = useState(null), [sessions, setSessions] = useState([]), [selected, setSelected] = useState(null), [detail, setDetail] = useState(null), [events, setEvents] = useState([]);
  const [creating, setCreating] = useState(false), [kind, setKind] = useState('project'), [projectPath, setProjectPath] = useState(''), [trusted, setTrusted] = useState(false), [model, setModel] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [engine, setEngine] = useState('grok-build'), [models, setModels] = useState([]), [nativeReadAccepted, setNativeReadAccepted] = useState(false), [effort, setEffort] = useState('medium');
  const editor = useWorkbenchDraft(selected, setError), draft = editor.value?.text || '';
  const refresh = async () => { const [state, list] = await Promise.all([request(base + '/status'), request(base + '/sessions')]); setStatus(state); setSessions(list.sessions); if (!model) setModel(state.engines[0]?.model || ''); };
  useEffect(() => { refresh().catch(error => setError(error.message)); const linked = () => { const id = Number(new URLSearchParams(window.location.hash.split('?')[1] || '').get('session')); if (id > 0) setSelected(id); }; linked(); window.addEventListener('hashchange', linked); return () => window.removeEventListener('hashchange', linked); }, []);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let stopped = false; setEvents([]); setDetail(null);
    const load = () => request(`${base}/sessions/${selected}`).then(value => { if (!stopped) { setDetail(value); editor.hydrate(selected, value.draft); } }).catch(error => { if (!stopped) setError(error.message); });
    load(); const timer = setInterval(load, 1000);
    const stream = new EventSource(apiUrl(`${base}/sessions/${selected}/events?after=0`));
    stream.onmessage = event => { try { const item = JSON.parse(event.data); if (!stopped) setEvents(previous => previous.some(e => e.seq === item.seq) ? previous : [...previous, item]); } catch { setError('事件格式无效，请刷新会话'); } };
    return () => { stopped = true; clearInterval(timer); stream.close(); };
  }, [selected]);
  async function action(fn) { setBusy(true); setError(''); try { await fn(); } catch (error) { setError(error.message); } finally { setBusy(false); } }
  async function create(event) {
    event.preventDefault(); await action(async () => {
      const workspace = await post('/workspaces', { kind, path: projectPath, trusted });
      const session = await post('/sessions', { workspaceId: workspace.id, engine, model, effort, nativeReadAccepted, title: kind === 'scratch' ? '临时工作区' : projectPath.split(/[\\/]/).filter(Boolean).at(-1) });
      setSelected(session.id); setCreating(false); setTrusted(false); await refresh();
    });
  }
  async function send(event) {
    event.preventDefault(); if (!draft.trim()) return;
    await action(async () => {
      const saved = await editor.flush(selected);
      await post(`/sessions/${selected}/turns`, { text: saved.text, artifactIds: saved.attachments, requestKey: saved.requestKey });
      const value = await request(`${base}/sessions/${selected}`);
      editor.submitted(selected, value.draft); setDetail(value);
    });
  }
  const current = detail?.turns.find(turn => active(turn.state));
  return <main className="wiki-main workbench-page" data-c-surface="workbench">
    <PageHeader title="Agent 工作台" subtitle="绑定项目，审批修改，查看执行过程与结果。" actions={<button onClick={() => setCreating(!creating)} disabled={!status?.agentWorkbenchEnabled || busy}><Plus size={16} />新建会话</button>} />
    {error && <p role="alert" className="workbench-error">{error}</p>}
    {status && !status.agentWorkbenchEnabled ? <section className="workbench-empty"><h2>启用 Agent 工作台</h2><p>项目需要先确认信任；文件写入和命令逐次审批。已批准的命令使用当前用户权限运行。</p><button onClick={() => action(async () => { await request(base + '/settings', { method: 'PUT', body: JSON.stringify({ agentWorkbenchEnabled: true }) }); await refresh(); })} disabled={busy}>启用工作台</button></section> : <>
      {creating && <form className="workbench-create" onSubmit={create}><h2>新建会话</h2><label>工作区<select aria-label="工作区" value={kind} onChange={event => setKind(event.target.value)}><option value="project">已有项目</option><option value="scratch">临时工作区</option></select></label>{kind === 'project' && <label>项目目录<div className="workbench-path-input"><input value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="例如 D:\Projects\my-app" required /><FolderOpen size={18} /></div></label>}<label>执行引擎<select value={engine} disabled={busy} onChange={event => { const id = event.target.value; setEngine(id); setModels([]); setModel(''); setNativeReadAccepted(false); action(async () => { const value = await request(`${base}/engines/${id}/models`); setModels(value.models); setModel(value.defaultModel || value.models[0]?.id || ''); }); }}>{status.engines.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label><label>模型<input value={model} list="workbench-models" onChange={event => setModel(event.target.value)} required /><datalist id="workbench-models">{models.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</datalist></label><label>推理强度<select value={effort} onChange={event => setEffort(event.target.value)}>{['low', 'medium', 'high', 'xhigh'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>{engine === 'codex-cli' && <label className="workbench-trust"><input type="checkbox" checked={nativeReadAccepted} onChange={event => setNativeReadAccepted(event.target.checked)} />我接受 Codex 原生全盘读取权限，安全读取可能自动执行；写入和危险命令按原生审批处理。</label>}<label className="workbench-trust"><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} />我信任此项目中的配置。允许执行的命令将使用当前用户权限，目录不构成系统沙箱。</label><div className="workbench-actions"><button type="button" onClick={() => setCreating(false)}>取消</button><button disabled={!trusted || busy || engine === 'codex-cli' && !nativeReadAccepted}>创建会话</button></div></form>}
      <div className="workbench-layout"><nav className="workbench-sessions" aria-label="工作台会话">{sessions.map(session => <button key={session.id} aria-current={selected === session.id ? 'page' : undefined} disabled={busy} onClick={() => setSelected(session.id)}><strong>{session.data.title}</strong><span>{session.data.model} · {labels[session.state]}</span></button>)}{!sessions.length && <p className="workbench-muted">创建项目或临时工作区，开始第一个任务。</p>}</nav>
        <section className="workbench-conversation">{detail ? <><header className="workbench-session-header"><div><h2>{detail.session.data.title}</h2><p className="workbench-path">{detail.workspace.path}</p><p className="workbench-muted">{detail.session.data.model} · {detail.session.engine === 'codex-cli' ? 'Codex 原生全盘读取；写入和危险命令原生审批' : detail.session.policy.write === 'allow_workspace' ? '允许写入工作区；命令逐次审批' : '每次写入与命令审批'}</p></div>{current && <button disabled={busy} onClick={() => action(async () => { await post(`/turns/${current.id}/cancel`); setDetail(await request(`${base}/sessions/${selected}`)); })}><Square size={14} />停止</button>}</header><>{detail.session.data.provenance && <p className="workbench-muted">已转换上下文，使用新的原生会话。最近最多 20 轮摘录会在首次发送时作为参考；原历史、分支、附件和来源继续保留。{detail.session.data.provenance.sessionId && <a href={`#agent?session=${detail.session.data.provenance.sessionId}`}>查看旧会话</a>}</p>}</><WorkbenchPolicy key={selected} session={detail.session} busy={busy} act={action} refresh={async () => setDetail(await request(`${base}/sessions/${selected}`))} /><Timeline turns={detail.turns} events={events} />{detail.approvals.map(approval => <Approval key={approval.id} approval={approval} busy={busy} decide={(a, decision) => action(async () => { await post(`/approvals/${a.id}/decision`, { decision, operationHash: a.operationHash, revision: a.policyRevision }); setDetail(await request(`${base}/sessions/${selected}`)); })} />)}<WorkbenchResults onOpen={onOpen} key={selected} detail={detail} busy={busy} act={action} refresh={async () => setDetail(await request(`${base}/sessions/${selected}`))} attach={id => { const attachments = editor.value?.attachments || []; if (!attachments.includes(id) && attachments.length < 8) editor.update({ attachments: [...attachments, id], text: draft || '请分析这些产物，并继续任务。' }); }} /><form className="workbench-composer" onSubmit={send}><textarea aria-label="任务内容" placeholder="描述要完成的任务…" value={draft} disabled={busy || !editor.value} onChange={event => editor.update({ text: event.target.value })} rows={4} /><div className="workbench-attachments">{(editor.value?.attachments || []).map(id => <button key={id} type="button" disabled={busy} onClick={() => editor.update({ attachments: editor.value.attachments.filter(value => value !== id) })}>参考图 {id} ×</button>)}<label>添加参考图<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || (editor.value?.attachments.length || 0) >= 8} onChange={event => { const file = event.target.files[0]; event.target.value = ''; if (file) action(async () => { const artifact = await request(`${base}/sessions/${selected}/attachments`, { method: 'POST', headers: { 'content-type': file.type }, body: file }); editor.update({ attachments: [...(editor.value?.attachments || []), artifact.id] }); setDetail(await request(`${base}/sessions/${selected}`)); }); }} /></label></div><div className="workbench-actions"><span className="workbench-muted">{current ? labels[current.state] : editor.value?.saved !== editor.value?.edit ? '草稿保存中…' : '草稿已保存'}</span><button className="primary" disabled={busy || !!current || !draft.trim()}><Send size={16} />发送</button></div></form></> : <div className="workbench-empty">选择会话，或新建一个项目工作区。</div>}</section>
      </div></>}
  </main>;
}
