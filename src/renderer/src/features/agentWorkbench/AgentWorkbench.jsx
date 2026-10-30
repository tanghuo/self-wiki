import { useEffect, useRef, useState } from 'react';
import { Plus, Square, ArrowUp, ShieldCheck, PanelRight, Folder, FolderOpen, ArrowLeft, PanelLeft, Monitor, ChevronRight, Check, LoaderCircle } from 'lucide-react';
import { apiUrl, request } from '../../api.js';
import ReactMarkdown from 'react-markdown';
import './workbench.css';
import './workbenchSurface.css';
import WorkbenchPolicy from './WorkbenchPolicy.jsx';
import WorkbenchModelPicker from './WorkbenchModelPicker.jsx';
import WorkbenchStart from './WorkbenchStart.jsx';
import WorkbenchApprovalPicker from './WorkbenchApprovalPicker.jsx';
import WorkbenchChanges from './WorkbenchChanges.jsx';
import useWorkbenchDraft from './useWorkbenchDraft.js';
import useWorkbenchModels from './useWorkbenchModels.js';
import WorkbenchResults, { CommandOutput } from './WorkbenchResults.jsx';
import { maxWorkbenchImages, workbenchImageError, workbenchImageFiles } from './workbenchImages.js';

const base = '/api/agent';
const post = (route, value = {}) => request(base + route, { method: 'POST', body: JSON.stringify(value) });
const labels = { ready: '就绪', running: '执行中', queued: '排队中', awaiting_approval: '等待审批', cancelling: '正在停止', completed: '完成', failed: '失败', cancelled: '已停止', unknown: '结果待核查', needs_attention: '需要核查' };
const active = state => ['queued', 'running', 'awaiting_approval', 'cancelling'].includes(state);
const projectLabel = workspace => !workspace || workspace.kind === 'scratch' ? '不在项目中工作' : workspace.name || workspace.path.split(/[\\/]/).filter(Boolean).at(-1);
const OPEN_PROJECTS_KEY = 'workbenchOpenProjects';
const EXPANDED_THREADS_KEY = 'workbenchExpandedThreads';
function readStoredSet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
    }
  } catch {}
  return null;
}
function writeStoredSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch {}
}

function Approval({ approval, decide, busy }) {
  const op = approval.operation;
  if (op.provider === 'Antigravity') return <section className="workbench-approval" aria-label="待审批操作">
    <h3><ShieldCheck size={18} />Antigravity 原生审批</h3><p>{op.title}</p>
    {!!op.locations?.length && <p className="workbench-path">{op.locations.map(item => item.path).join('\n')}</p>}
    <pre>{JSON.stringify(op.input, null, 2)}</pre>
    {(op.content || []).map((item, index) => item.type === 'diff' ? <div key={index}><p className="workbench-path">{item.path}</p><pre>{item.oldText || ''}</pre><pre>{item.newText || ''}</pre></div> : item.type === 'content' && item.content?.type === 'text' ? <pre key={index}>{item.content.text}</pre> : null)}
    <p className="workbench-muted">仅允许本次原生操作，不创建长期允许规则；不限时等待，停止任务后失效。</p>
    <div className="workbench-actions"><button disabled={busy} onClick={() => decide(approval, 'reject')}>拒绝</button><button disabled={busy} onClick={() => decide(approval, 'allow')}>允许一次</button></div>
  </section>;
  if (op.kind.startsWith('native.')) return <section className="workbench-approval" aria-label="待审批操作"><h3><ShieldCheck size={18} />{op.kind === 'native.file' ? '修改文件 · Codex 原生审批' : '运行命令 · Codex 原生审批'}</h3>{op.kind === 'native.file' ? op.changes.map((change, index) => <div key={index}><p className="workbench-path">{change.path}{change.kind?.move_path && ` → ${change.kind.move_path}`}</p><pre>{change.diff}</pre></div>) : <><pre>{op.command}</pre><p className="workbench-path">工作目录：{op.cwd}</p></>}<p>{op.reason}</p><p>本次原生操作；不创建长期规则。Codex 可读取全盘，安全读取可能无需审批。</p><div className="workbench-actions"><button disabled={busy} onClick={() => decide(approval, 'reject')}>拒绝</button><button disabled={busy} onClick={() => decide(approval, 'allow')}>允许一次</button></div></section>;
  return <section className="workbench-approval" aria-label="待审批操作">
    <h3><ShieldCheck size={18} />{op.kind === 'file.write' ? '写入文件' : op.kind === 'command' ? '运行命令' : '引擎权限请求'}</h3>
    {op.kind === 'file.write' ? <><p className="workbench-path">{op.path}</p><details open><summary>查看修改</summary><div className="workbench-diff"><pre aria-label="修改前">{op.before || '（新建文件）'}</pre><pre aria-label="修改后">{op.after}</pre></div></details></> : op.kind === 'command' ? <><p className="workbench-path">{op.program}</p><pre>{op.args?.join('\n')}</pre><p>工作目录：{op.cwd}</p>{op.environment?.length > 0 && <p>环境：{op.environment.map(entry => `${entry.name}=${entry.value}`).join(' · ')}</p>}<p>{op.warning}</p></> : <><p>{op.title || op.tool}</p><pre>{JSON.stringify(op.input, null, 2)}</pre><p>此授权不能替代文件或命令宿主的审批。</p></>}
    <p className="workbench-muted">{approval.expiresAt > 0 ? `本次有效，${new Date(approval.expiresAt).toLocaleTimeString()} 到期。` : '本次有效，不限时等待处理；停止任务后失效。'}</p>
    <div className="workbench-actions"><button disabled={busy} onClick={() => decide(approval, 'reject')}>拒绝</button><button disabled={busy} onClick={() => decide(approval, 'allow')}>允许一次</button></div>
  </section>;
}
function ExecutionEvent({ item, turnId }) {
  const value = item.data;
  if (item.type === 'tool.updated') return <p className="workbench-activity-line">{active(value.status) ? <LoaderCircle size={14} /> : <Check size={14} />}<span>{value.title || '工具调用'} · {labels[value.status] || value.status}</span></p>;
  if (item.type === 'command.output') return <CommandOutput turnId={turnId} value={value} />;
  if (item.type === 'plan.updated') return <ol>{(value.entries || []).map((entry, index) => <li key={index}>{entry.content} · {entry.status}</li>)}</ol>;
  return null;
}
function Timeline({ turns, events }) {
  const visible = new Set(['tool.updated', 'command.output', 'plan.updated']);
  const items = [];
  for (const event of events) {
    if (event.type === 'workspace.changed' && !event.data.current?.git) continue;
    if (event.type !== 'message.delta' && !(event.type === 'turn.finished' && event.data.error) && !visible.has(event.type)) continue;
    const previous = items.at(-1);
    if (event.type === 'message.delta' && previous?.type === 'message.delta' && previous.turnId === event.turnId) previous.data.text += event.data.text;
    else items.push({ ...event, data: { ...event.data } });
  }
  return <div className="workbench-timeline" aria-label="执行时间线">
    {turns.map(turn => {
      const groups = [];
      for (const item of items.filter(item => item.turnId === turn.id)) {
        const activity = visible.has(item.type), previous = groups.at(-1);
        if (activity && previous?.activity) previous.items.push(item);
        else groups.push({ key: item.seq, activity, items: [item] });
      }
      return <section className="workbench-turn" key={turn.id}>
        <div className="workbench-message user"><p>{turn.input.text}</p></div>
        {groups.map(group => group.activity ? <details className="workbench-execution" key={group.key}><summary><ChevronRight size={14} /><span>执行过程</span><span className="workbench-activity-count">{group.items.length} 条记录</span></summary><div className="workbench-activity-list">{group.items.map(item => <div className="workbench-event" key={item.seq}><ExecutionEvent item={item} turnId={turn.id} /></div>)}</div></details> : <div className="workbench-event assistant" key={group.key}>{group.items[0].type === 'message.delta' ? <div className="workbench-markdown"><ReactMarkdown skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{group.items[0].data.text}</ReactMarkdown></div> : <p role="alert">{group.items[0].data.error}</p>}</div>)}
        <p className="workbench-turn-state" data-state={turn.state}>{labels[turn.state] || turn.state}{turn.state === 'unknown' ? '：不会自动重发，请先核对文件和命令结果。' : ''}</p>
        <WorkbenchChanges turn={turn} sessionBusy={turns.some(turn => active(turn.state))} revision={events.filter(event => event.turnId === turn.id && ['file.changed', 'file.native_diff', 'engine.diff', 'workspace.changed'].includes(event.type)).at(-1)?.seq || 0} />
      </section>;
    })}
  </div>;
}
export default function AgentWorkbench({ onOpen }) {
  const [status, setStatus] = useState(null), [sessions, setSessions] = useState([]), [projects, setProjects] = useState([]), [openProjects, setOpenProjects] = useState(() => readStoredSet(OPEN_PROJECTS_KEY) || new Set()), [expandedThreads, setExpandedThreads] = useState(() => readStoredSet(EXPANDED_THREADS_KEY) || new Set()), [selected, setSelected] = useState(null), [detail, setDetail] = useState(null), [events, setEvents] = useState([]);
  const [settings, setSettings] = useState({ kind: 'scratch', projectId: null, projectPath: '', projectName: '', engine: 'grok-build', model: '', nativeReadAccepted: false, effort: 'medium', approvalMode: 'ask' });
  const [newText, setNewText] = useState('');
  const { catalog: modelCatalog, load: loadEngineModels, connectAntigravity: connectAntigravityAccount } = useWorkbenchModels(status?.engines, status?.agentWorkbenchEnabled);
  const models = modelCatalog[settings.engine]?.models || [];
  useEffect(() => {
    const value = modelCatalog[settings.engine];
    if (value?.models?.length) setSettings(previous => previous.engine !== settings.engine || previous.model ? previous : { ...previous, model: value.defaultModel || value.models[0].id });
  }, [modelCatalog, settings.engine]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [inspecting, setInspecting] = useState(false), [railOpen, setRailOpen] = useState(false), [pendingImages, setPendingImages] = useState([]);
  const fileInput = useRef(null), scroll = useRef(null), follows = useRef(true), sending = useRef(false), pendingRef = useRef([]);
  pendingRef.current = pendingImages;
  const editor = useWorkbenchDraft(selected, setError), draft = editor.value?.text || '';
  const change = value => setSettings(previous => ({ ...previous, ...value }));
  const refresh = async () => {
    const [state, list, saved] = await Promise.all([request(base + '/status'), request(base + '/sessions'), request(base + '/workspaces')]);
    setStatus(state); setSessions(list.sessions); setProjects(saved.projects);
    if (readStoredSet(OPEN_PROJECTS_KEY) === null && saved.projects?.length) {
      const initial = new Set(saved.projects.map(item => item.id));
      setOpenProjects(initial);
      writeStoredSet(OPEN_PROJECTS_KEY, initial);
    }
    setSettings(previous => ({ ...previous, model: previous.model || state.engines.find(value => value.id === previous.engine)?.model || '' }));
  };
  function choose(id) {
    setSelected(id); setRailOpen(false); setError(''); follows.current = true;
    if (window.location.hash.startsWith('#workbench')) window.history.replaceState(null, '', id ? `#workbench?session=${id}` : '#workbench');
  }
  useEffect(() => () => { for (const image of pendingRef.current) URL.revokeObjectURL(image.url); }, []);
  function addPendingImages(files) {
    if (busy) { setError('请等待当前操作完成后再添加图片'); return; }
    const problem = workbenchImageError(files, pendingImages.length);
    if (problem) { setError(problem); return; }
    setError('');
    setPendingImages(current => [...current, ...files.map(file => ({ key: crypto.randomUUID(), file, url: URL.createObjectURL(file) }))]);
  }
  function removePendingImage(key) {
    setPendingImages(current => {
      const image = current.find(value => value.key === key);
      if (image) URL.revokeObjectURL(image.url);
      return current.filter(value => value.key !== key);
    });
  }
  useEffect(() => {
    refresh().catch(error => setError(error.message));
    const linked = () => { if (!window.location.hash.startsWith('#workbench')) return; const id = Number(new URLSearchParams(window.location.hash.split('?')[1] || '').get('session')); choose(id > 0 ? id : null); };
    linked(); window.addEventListener('hashchange', linked); return () => window.removeEventListener('hashchange', linked);
  }, []);
  useEffect(() => {
    setDetail(null); setEvents([]);
    if (!selected) return;
    let stopped = false;
    const load = () => request(`${base}/sessions/${selected}`).then(value => {
      if (!stopped) {
        setDetail(value); editor.hydrate(selected, value.draft);
        setSessions(previous => previous.map(session => session.id === selected ? value.session : session));
      }
    }).catch(error => { if (!stopped) setError(error.message); });
    load(); const timer = setInterval(load, 1000);
    const stream = new EventSource(apiUrl(`${base}/sessions/${selected}/events?after=0`));
    stream.onmessage = event => { try { const item = JSON.parse(event.data); if (!stopped) setEvents(previous => previous.some(e => e.seq === item.seq) ? previous : [...previous, item]); } catch { if (!stopped) setError('事件格式无效，请刷新会话'); } };
    return () => { stopped = true; clearInterval(timer); stream.close(); };
  }, [selected]);
  useEffect(() => { if (follows.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [events, detail?.turns.length, selected]);
  async function action(fn) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try { await fn(); } catch (error) { setError(error.message); } finally { sending.current = false; setBusy(false); }
  }
  const loadModels = () => loadEngineModels(settings.engine);
  const loadSessionModels = () => loadEngineModels(detail?.session.engine);
  function changeSessionModel(patch) {
    const data = detail?.session.data;
    if (!data) return;
    const model = patch.model || data.model;
    const effort = patch.effort || data.effort;
    if (model === data.model && effort === data.effort) return;
    void action(async () => {
      const saved = await request(`${base}/sessions/${selected}`, { method: 'PATCH', body: JSON.stringify({ model, effort }) });
      setDetail(current => current?.session.id === saved.id ? { ...current, session: saved } : current);
      setSessions(current => current.map(item => item.id === saved.id ? saved : item));
    });
  }
  async function createProject(value) {
    let workspace;
    await action(async () => {
      const projectName = typeof value.name === 'string' ? value.name.trim() : '';
      workspace = await post('/workspaces', { kind: 'project', path: value.path, ...(projectName ? { name: projectName } : {}), trusted: true });
      setProjects(current => [workspace, ...current.filter(item => item.id !== workspace.id)]);
      change({ kind: 'project', projectId: workspace.id, projectPath: workspace.path, projectName: workspace.name });
      setOpenProjects(current => { const next = new Set(current).add(workspace.id); writeStoredSet(OPEN_PROJECTS_KEY, next); return next; });
    });
    return workspace;
  }
  function chooseProject(project) {
    change({ kind: 'project', projectId: project.id, projectPath: project.path, projectName: project.name });
    setOpenProjects(current => { const next = new Set(current); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); writeStoredSet(OPEN_PROJECTS_KEY, next); return next; });
  }
  function selectEngine(engine) {
    const value = modelCatalog[engine];
    change({ engine, model: value?.defaultModel || value?.models?.[0]?.id || '', nativeReadAccepted: false, approvalMode: 'ask' });
    void loadEngineModels(engine);
  }
  async function connectAntigravity() {
    await action(connectAntigravityAccount);
  }
  async function create(authorization) {
    await action(async () => {
      const { kind, projectId, projectPath, projectName, engine, model, effort, approvalMode } = settings;
      const { trusted, nativeReadAccepted } = authorization;
      const workspace = kind === 'project' && projectId ? { id: projectId } : await post('/workspaces', { kind, path: projectPath, name: projectName, trusted });
      const session = await post('/sessions', { workspaceId: workspace.id, engine, model, effort, approvalMode, nativeReadAccepted, title: newText.trim().split('\n')[0].slice(0, 60) || projectName || '不在项目中工作' });
      // Save the initial task before submitting so a failed send can be resumed
      // from the existing session instead of creating or sending it again.
      let value = await request(`${base}/sessions/${session.id}`);
      const images = pendingRef.current, attachments = [];
      let uploadError;
      for (const image of images) {
        try {
          const artifact = await request(`${base}/sessions/${session.id}/attachments`, { method: 'POST', headers: { 'content-type': image.file.type || 'application/octet-stream' }, body: image.file });
          attachments.push(artifact.id);
        } catch (error) { uploadError = error; break; }
      }
      if (newText.trim() || attachments.length) {
        const saved = await request(`${base}/sessions/${session.id}/draft`, { method: 'PUT', body: JSON.stringify({ revision: value.draft.revision, text: newText, attachments }) });
        value = { ...value, draft: saved };
      }
      for (const image of images) URL.revokeObjectURL(image.url);
      setPendingImages([]);
      editor.hydrate(session.id, value.draft); choose(session.id); setNewText('');
      if (uploadError) throw uploadError;
      await refresh();
      if (value.draft.text.trim()) {
        await post(`/sessions/${session.id}/turns`, { text: value.draft.text, artifactIds: value.draft.attachments, requestKey: value.draft.requestKey });
        const latest = await request(`${base}/sessions/${session.id}`); editor.submitted(session.id, latest.draft); setDetail(latest);
      }
    });
  }
  async function send(event) {
    event.preventDefault(); if (!draft.trim() || current || busy) return;
    await action(async () => {
      const saved = await editor.flush(selected);
      await post(`/sessions/${selected}/turns`, { text: saved.text, artifactIds: saved.attachments, requestKey: saved.requestKey });
      const value = await request(`${base}/sessions/${selected}`);
      editor.submitted(selected, value.draft); setDetail(value); follows.current = true;
    });
  }
  const current = detail?.turns.find(turn => active(turn.state));
  const reloadDetail = async () => setDetail(await request(`${base}/sessions/${selected}`));
  async function attachFiles(files) {
    const existing = editor.value?.attachments || [];
    const problem = workbenchImageError(files, existing.length);
    if (busy) { setError('请等待当前操作完成后再添加图片'); return; }
    if (problem) { setError(problem); return; }
    await action(async () => {
      const ids = [...existing];
      for (const file of files) {
        const artifact = await request(`${base}/sessions/${selected}/attachments`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
        ids.push(artifact.id);
      }
      editor.update({ attachments: ids });
      await reloadDetail();
    });
  }
  const stop = () => action(async () => { await post(`/turns/${current.id}/cancel`); await reloadDetail(); });
  const attention = (detail?.approvals.length || 0) + (detail?.operations || []).filter(value => value.state === 'pending').length + (detail?.proposals || []).filter(value => value.state === 'pending').length;
  useEffect(() => { if (attention > 0) setInspecting(true); }, [selected, attention]);
  useEffect(() => {
    const id = detail?.workspace?.kind === 'project' ? detail.workspace.id : null;
    if (!id) return;
    setOpenProjects(current => { if (current.has(id)) return current; const next = new Set(current).add(id); writeStoredSet(OPEN_PROJECTS_KEY, next); return next; });
  }, [detail?.session?.id]);
  const chats = sessions.filter(session => session.purpose !== 'workflow');
  return <main className="wiki-main workbench-page" data-c-surface="workbench">
    {error && <p role="alert" className="workbench-error">{error}</p>}
    <div className={`workbench-layout${railOpen ? " rail-open" : ""}`}>
    <header className="workbench-topbar">
      <button className="icon-only workbench-rail-toggle" aria-label="切换会话列表" disabled={!status} aria-expanded={railOpen} onClick={() => setRailOpen(!railOpen)}><PanelLeft size={18} /></button>
      <div className="workbench-topbar-title"><strong>{detail?.session.data.title || '新任务'}</strong>{detail && <span title={detail.workspace.path}><FolderOpen size={13} />{projectLabel(detail.workspace)}</span>}</div>
      <div className="workbench-topbar-actions">{detail && <button className="icon-only" title="任务、产物与权限" aria-label="任务、产物与权限" aria-expanded={inspecting} onClick={() => setInspecting(!inspecting)}><PanelRight size={18} />{attention > 0 && <span className="workbench-attention">{attention}</span>}</button>}</div>
    </header>
    {!status ? <p className="workbench-conversation" role="status">正在加载工作台…</p> : !status.agentWorkbenchEnabled ? <section className="workbench-empty"><h2>启用 Agent 工作台</h2><p>项目需要先确认信任；文件写入和命令逐次审批。已批准的命令使用当前用户权限运行。</p><button onClick={() => action(async () => { await request(base + '/settings', { method: 'PUT', body: JSON.stringify({ agentWorkbenchEnabled: true }) }); await refresh(); })} disabled={busy}>启用工作台</button></section> : <>
      <nav className="workbench-sessions" aria-label="工作台会话">
        <a className="workbench-library-link" href="#wiki"><ArrowLeft size={16} />返回内容库</a>
        <button className="workbench-new-chat" onClick={() => choose(null)} disabled={busy}><Plus size={17} />新建会话</button>
        {projects.length > 0 && <p className="workbench-rail-title">项目</p>}
        {projects.map(project => {
          const threads = chats.filter(session => session.workspaceId === project.id);
          const open = openProjects.has(project.id);
          const shown = expandedThreads.has(project.id) ? threads : threads.slice(0, 5);
          return <div className="workbench-project-group" key={project.id}>
            <button type="button" className="workbench-project" aria-expanded={open} aria-current={!selected && settings.projectId === project.id ? 'true' : undefined} disabled={busy} onClick={() => chooseProject(project)}>{open ? <FolderOpen size={15} /> : <Folder size={15} />}<span className="workbench-thread-label">{project.name}</span></button>
            {open && shown.map(session => <button type="button" className="workbench-thread" key={session.id} aria-current={selected === session.id ? 'page' : undefined} disabled={busy} onClick={() => choose(session.id)}><span className="workbench-thread-label">{session.data.title}</span>{active(session.state) && <span>{labels[session.state]}</span>}</button>)}
            {open && threads.length > shown.length && <button type="button" className="workbench-more" disabled={busy} onClick={() => setExpandedThreads(current => { const next = new Set(current).add(project.id); writeStoredSet(EXPANDED_THREADS_KEY, next); return next; })}>展开显示</button>}
          </div>;
        })}
        <p className="workbench-rail-title">最近</p>
        {chats.map(session => <button type="button" className="workbench-recent" key={session.id} aria-current={selected === session.id ? 'page' : undefined} disabled={busy} onClick={() => choose(session.id)}><span className="workbench-thread-label">{session.data.title}</span>{active(session.state) && <span>{labels[session.state]}</span>}</button>)}
        {!chats.length && <p className="workbench-muted">首次发送后，会话会保存在这里。</p>}
      </nav>
      <section className="workbench-conversation">
        {!selected ? <WorkbenchStart settings={settings} change={change} projects={projects} engines={status.engines} models={models} modelState={modelCatalog[settings.engine]} retryModels={() => loadEngineModels(settings.engine, true)} text={newText} setText={setNewText} busy={busy} create={create} createProject={createProject} selectEngine={selectEngine} loadModels={loadModels} connectAntigravity={connectAntigravity} images={pendingImages} addImages={addPendingImages} removeImage={removePendingImage} /> : !detail ? <p role="status">正在打开会话…</p> : <>

          <div className={`workbench-session-grid${inspecting ? ' inspecting' : ''}`}>
            <div className="workbench-chat-column">
              <div className="workbench-scroll" ref={scroll} onScroll={event => { const el = event.currentTarget; follows.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
                {detail.session.data.provenance && <p className="workbench-muted">已转换上下文，使用新的原生会话。最近最多 20 轮摘录会在首次发送时作为参考；原历史、分支、附件和来源继续保留。{detail.session.data.provenance.sessionId && <a href={`#agent?session=${detail.session.data.provenance.sessionId}`}>查看旧会话</a>}</p>}
                {!detail.turns.length && <div className="workbench-chat-empty"><h3>准备好了</h3><p>在下方输入任务，开始这个会话。</p></div>}
                <Timeline turns={detail.turns} events={events} />
                {detail.approvals.map(approval => <Approval key={approval.id} approval={approval} busy={busy} decide={(a, decision) => action(async () => { await post(`/approvals/${a.id}/decision`, { decision, operationHash: a.operationHash, revision: a.policyRevision }); await reloadDetail(); })} />)}
              </div>
              <form className="workbench-composer" onSubmit={send} onPaste={event => { const files = workbenchImageFiles(event.clipboardData); if (!files.length) return; event.preventDefault(); event.stopPropagation(); void attachFiles(files); }}>
                <div className="workbench-attachments">{(editor.value?.attachments || []).map(id => {
                  const artifact = (detail.artifacts || []).find(item => item.id === id);
                  const image = artifact?.type !== 'text';
                  return <button key={id} type="button" className={image ? 'workbench-image-chip' : 'workbench-file-chip'} aria-label={`参考图 ${id} ×`} title={image ? '移除参考图' : '移除文字结果'} disabled={busy} onClick={() => editor.update({ attachments: editor.value.attachments.filter(value => value !== id) })}>
                    {image ? <img src={apiUrl(`${base}/artifacts/${id}/content?sessionId=${selected}`)} alt="" /> : <span>文字结果</span>}
                    <span className="workbench-image-remove" aria-hidden="true">×</span>
                  </button>;
                })}<input ref={fileInput} aria-label="选择参考图文件" hidden type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy || !editor.value || (editor.value?.attachments.length || 0) >= maxWorkbenchImages} onChange={event => { const files = [...event.target.files]; event.target.value = ''; if (files.length) void attachFiles(files); }} /></div>
                <textarea aria-label="任务内容" placeholder={current ? '可以先写下一条任务，当前任务结束后发送，也可粘贴图片…' : '描述要完成的任务，也可直接粘贴图片…'} value={draft} disabled={busy || !editor.value} onChange={event => editor.update({ text: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } }} rows={3} />
                <div className="workbench-composer-toolbar">
                  <button type="button" className="icon-only" aria-label="添加参考图" title="添加参考图" disabled={busy || !editor.value || (editor.value?.attachments.length || 0) >= maxWorkbenchImages} onClick={() => fileInput.current?.click()}><Plus size={19} /></button>
                  <span className="workbench-project-chip" title={detail.workspace.path}><FolderOpen size={15} /><span>{projectLabel(detail.workspace)}</span></span>
                  <span className="workbench-machine"><Monitor size={14} />此计算机</span>
                  {!detail.session.data.restricted && detail.session.purpose !== 'workflow' && <WorkbenchApprovalPicker mode={detail.session.policy.approvalMode} engine={detail.session.engine} disabled={busy || !!current} onChange={mode => action(async () => { await request(`${base}/sessions/${selected}/policy`, { method: 'PUT', body: JSON.stringify({ revision: detail.session.revision, approvalMode: mode }) }); await reloadDetail(); })} />}
                  <WorkbenchModelPicker engine={detail.session.engine} model={detail.session.data.model} effort={detail.session.data.effort} engines={status.engines} models={modelCatalog[detail.session.engine]?.models || []} modelState={modelCatalog[detail.session.engine]} retryModels={() => loadEngineModels(detail.session.engine, true)} busy={busy} change={changeSessionModel} loadModels={loadSessionModels} connectAntigravity={connectAntigravity} />
                  <span className="workbench-draft-state" data-saved={editor.value?.saved === editor.value?.edit ? "true" : "false"}>{current ? labels[current.state] : ""}</span>
                  {current ? <button type="button" className="primary icon-only" aria-label="停止" title="停止" disabled={busy || current.state === 'cancelling'} onClick={stop}><Square size={14} fill="currentColor" /></button> : <button className="primary icon-only" aria-label="发送" title="发送" disabled={busy || !editor.value || !draft.trim()}><ArrowUp size={19} /></button>}
                </div>
              </form>
            </div>
            {inspecting && <aside className="workbench-inspector" aria-label="会话详情"><h3>任务与产物</h3><p className="workbench-path">{detail.workspace.path}</p>
              <WorkbenchResults onOpen={onOpen} key={selected} detail={detail} busy={busy} act={action} refresh={reloadDetail} attach={id => { const attachments = editor.value?.attachments || []; if (!attachments.includes(id) && attachments.length < 8) editor.update({ attachments: [...attachments, id], text: draft || '请分析这些产物，并继续任务。' }); }} />
              {!detail.tasks?.length && !detail.artifacts?.length && !detail.operations?.length && !detail.proposals?.length && <p className="workbench-muted">任务、文件产物和待处理建议会显示在这里。</p>}
              <WorkbenchPolicy key={selected} session={detail.session} busy={busy} act={action} refresh={reloadDetail} />
            </aside>}
          </div>
        </>}
      </section>
    </>}
    </div>
  </main>;
}
