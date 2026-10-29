import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl, request } from '../../api.js';
import WorkflowEditor, { WorkflowPlan } from './WorkflowEditor.jsx';
import WorkflowRun, { stateLabels } from './WorkflowRun.jsx';
import WorkflowContentField from './WorkflowContentField.jsx';
import WorkflowArtifactImages from './WorkflowArtifactImages.jsx';
import WorkflowTextField from './WorkflowTextField.jsx';
import RuntimeGenerationParameters, { generationParameterConfig, withGenerationParameters } from '../modelAdapters/RuntimeGenerationParameters.jsx';
import { outputType, isRuntimeElement, editableDefinition, matchesType } from '../../../../shared/domain/workflow/contracts.js';
import { inferGraphTypes } from './workflowBindings.js';
import { workflowSteps, stepLabel, stepConnections, isPreparationInput, workflowIssues, missingFixedContent } from './workflowLabels.js';
import { workflowTemplates } from '../../../../shared/domain/workflow/examples.js';
import { planFromPrompt } from './workflowPlanner.js';
import PageHeader from '../../ui/PageHeader.jsx';
import './workflow.css';

const post = (path, payload) => request(path, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), ...payload }) });
export const runCountOf = (definition) => Number.isInteger(definition?.runCount) && definition.runCount >= 1 && definition.runCount <= 20 ? definition.runCount : 1;
// Fixed-content edits on the preparation page are disposable. The run count is not.
function definitionKeepingRunCount(base, current) {
  if (!base || (base.runCount ?? undefined) === (current?.runCount ?? undefined)) return base;
  const next = { ...base };
  if (current?.runCount === undefined) delete next.runCount;
  else next.runCount = current.runCount;
  return next;
}
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
// Map the inputs of an earlier run back to values a new run accepts. Images were
// copied into the run, so point at their library element or upload instead.
function rerunInputs(snapshot, definition) {
  const values = {}, sources = new Map((snapshot?.inputArtifacts || []).map((artifact) => [artifact.id, artifact.metadata || {}]));
  let dropped = 0;
  const ref = (value) => {
    const source = sources.get(value?.artifactId);
    if (source?.sourceElementId) return { elementId: source.sourceElementId };
    if (source?.sourceAttachmentId) return { attachmentId: source.sourceAttachmentId };
    dropped++; return null;
  };
  for (const node of definition.nodes.filter(isRuntimeElement)) {
    const type = outputType(node), value = snapshot?.inputs?.[node.config.parameter];
    if (value === undefined) continue;
    if (type === 'image') { const next = ref(value); if (next) values[node.config.parameter] = next; }
    else if (type === 'list<image>') { if (Array.isArray(value)) values[node.config.parameter] = value.map(ref).filter(Boolean); }
    else if (matchesType(value, type)) values[node.config.parameter] = value;
  }
  return { values, dropped };
}
function emptyFixed(node) {
  const value = node.config.default;
  if (Array.isArray(node.config.parts)) return !fixedText(node).trim();
  return value === undefined || value === '' || Array.isArray(value) && !value.length;
}
function fixedText(node) {
  if (Array.isArray(node.config.parts)) return node.config.parts.map((part) => part.kind === 'text' ? part.text : '').join('');
  return typeof node.config.default === 'string' ? node.config.default : '';
}
function FixedPreview({ node, label }) {
  const type = outputType(node), value = node.config.default;
  if (type.includes('image')) {
    const refs = type === 'image' ? value ? [value] : [] : Array.isArray(value) ? value : [];
    return <div className="workflow-fixed-preview" role="group" aria-label={label}><p>{refs.length ? `${refs.length} 张图片` : '没有图片'}</p><div className="workflow-content-images">{refs.map((ref, index) => <div key={`${ref.elementId || ref.attachmentId}:${index}`}>{ref.elementId && <img src={apiUrl(`/api/elements/${ref.elementId}/thumbnail?width=400`)} alt={`固定图片 ${index + 1}`} />}{ref.attachmentId && <img src={apiUrl(`/api/workflow-input-images/${ref.attachmentId}/media`)} alt={`固定图片 ${index + 1}`} />}</div>)}</div></div>;
  }
  if (type === 'text' && value && typeof value === 'object') return <div className="workflow-fixed-preview" role="group" aria-label={label}><p>使用资料库里的一段文字</p></div>;
  const text = type === 'text' ? fixedText(node) : JSON.stringify(value ?? null, null, 2);
  return <div className="workflow-fixed-preview" role="group" aria-label={label}><p className="workflow-fixed-text">{text || '（空）'}</p></div>;
}
function SnapshotImages({ runId, type, value }) {
  const refs = type === 'image' ? value ? [value] : [] : Array.isArray(value) ? value : [];
  if (!refs.length) return <p>没有图片。</p>;
  return <WorkflowArtifactImages key={runId} images={refs} runId={runId} className="workflow-content-images" alt="本次快照图片" />;
}
function RunSnapshot({ snapshot, fallbackDefinition }) {
  const definition = snapshot?.definition || fallbackDefinition;
  const fields = (definition?.nodes || []).filter(isPreparationInput);
  const sample = definition?.nodes?.some((node) => node.config?.sampleSize === 1);
  return <aside className="workflow-run-snapshot" aria-label="本次输入快照"><h3>{snapshot ? `运行 #${snapshot.id} 用的内容` : '这次用的内容'}</h3><p>{sample ? '这次是「先试 1 项」：每个列表只处理了第 1 项。' : '这次处理了全部内容。'}</p>{!snapshot && <p className="workflow-waiting">正在读取这次用的内容。</p>}{snapshot && !fields.length && <p>这次运行不需要填写内容。</p>}{snapshot && fields.map((node, index) => {
    const type = outputType(node), label = runtimeLabel(node, index, definition.nodes);
    const value = Array.isArray(node.config.parts) ? node.config.parts.map((part) => part.kind === 'text' ? part.text : part.ref.value).join('') : snapshot.inputs?.[node.config.parameter];
    const plain = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    return <div key={node.id}><strong>{label}</strong>{type.includes('image') ? <SnapshotImages runId={snapshot.id} type={type} value={value} /> : type === 'text' ? <textarea readOnly aria-label={`${label}（本次快照）`} rows={4} value={value ?? ''} /> : plain ? <input readOnly aria-label={`${label}（本次快照）`} value={String(value)} /> : <pre aria-label={`${label}（本次快照）`}>{JSON.stringify(value, null, 2)}</pre>}</div>;
  })}<p>这是开始时提交的内容。修改流程或再运行一次都会另开一次运行，不影响这次的结果。</p></aside>;
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
    return { id: run.id, inputs: run.inputs, definition: run.definition, inputArtifacts: run.inputArtifacts };
  }), []);
  const [focusNodeId, setFocusNodeId] = useState(null);
  const [locate, setLocate] = useState(null), [prep, setPrep] = useState(null);
  const [buildPrompt, setBuildPrompt] = useState('');
  const [promptPlan, setPromptPlan] = useState(null);
  const [generationParameters, setGenerationParameters] = useState({});
  async function refresh() { setList((await request('/api/workflows')).workflows); }
  useEffect(() => { refresh().catch((reason) => setError(reason.message)); }, []);
  useEffect(() => { const warn = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  function adopt(loaded, extra = {}) {
    const edited = inferGraphTypes(editableDefinition(loaded.definition));
    const source = { workflow: loaded, definition: edited, name: loaded.name, dirty: JSON.stringify(edited) !== JSON.stringify(loaded.definition), history: loaded.runs || [] };
    setWorkflow(source.workflow); setDefinition(source.definition); setName(source.name); setDirty(source.dirty); setHistory(source.history);
    setErrors([]); setNotice(''); setFocusNodeId(null); setInputForm(false); setPrep(null); setLocate(null); setSnapshot(null); setRunId(extra.runId ?? null); setMode(extra.mode ?? 'edit');
    return source;
  }
  function open(loaded) { return adopt(loaded); }
  useEffect(() => {
    let alive = true;
    async function openLinkedRun() {
      const id = new URLSearchParams(window.location.hash.split('?')[1] || '').get('run');
      if (!id || !/^\d+$/.test(id)) return;
      try { const run = await request(`/api/workflow-runs/${id}`), loaded = await request(`/api/workflows/${run.workflowId}`); if (alive) adopt(loaded, { mode: 'run', runId: run.id }); }
      catch (error) { if (alive) setError(error.message); }
    }
    void openLinkedRun(); window.addEventListener('hashchange', openLinkedRun);
    return () => { alive = false; window.removeEventListener('hashchange', openLinkedRun); };
  }, []);
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
    const created = await post(`/api/workflows/${current.id}/runs`, { revision: current.revision, inputs: values, sample: isSample, count: runCountOf(source.definition),
      ...(Object.keys(generationParameters).length && { definition: withGenerationParameters(source.definition, generationParameters) }) });
    setInputForm(false); setPrep(null); setFocusNodeId(null); setRunId(created.id); setMode('run'); setSnapshot(null); setHistory((await request(`/api/workflows/${current.id}`)).runs);
  }
  function beginRun(isSample, source, previous = null) {
    setGenerationParameters({});
    setError(''); setNotice(''); setSample(isSample);
    const carried = previous ? rerunInputs(previous, source.definition) : null;
    const nextInputs = { ...defaultInputs(source.definition), ...carried?.values };
    setInputs(nextInputs);
    // Always show the run page (small tool): fill → start. Never auto-start on open.
    setPrep({ base: source.definition, baseDirty: source.dirty, unlocked: source.definition.nodes.filter((node) => !isRuntimeElement(node) && isPreparationInput(node) && emptyFixed(node)).map((node) => node.id), from: previous?.id ?? null, dropped: carried?.dropped || 0 });
    setInputForm(true); setMode('run'); setSnapshot(null);
  }
  function leavePreparation() {
    setGenerationParameters({});
    // Leaving without starting drops edits made to fixed content on this page.
    // The run count is a workflow setting, so it stays with the draft.
    if (prep) {
      const next = definitionKeepingRunCount(prep.base, definition);
      setDefinition(next);
      setDirty(next === prep.base ? prep.baseDirty : true);
    }
    setPrep(null); setInputForm(false);
  }
  function goFix(issue) {
    leavePreparation(); setMode('edit');
    setLocate({ nodeId: issue.nodeId, scope: issue.scope, nonce: Date.now() });
  }
  async function runFromList(id) { const source = adopt(await request(`/api/workflows/${id}`)); await beginRun(false, source); }
  async function openLatest(id) {
    const loaded = await request(`/api/workflows/${id}`);
    const latest = loaded.runs?.[0];
    adopt(loaded, { mode: latest ? 'run' : 'edit', runId: latest?.id ?? null });
  }
  // open() keeps edit for "新建/导入"; list title uses beginRun for the small-tool path.
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
  const issues = useMemo(() => workflowIssues(definition, errors), [definition, errors]);
  const changedFixed = prep ? fixedNodes.filter((node) => JSON.stringify(prep.base.nodes.find((item) => item.id === node.id)?.config) !== JSON.stringify(node.config)) : [];
  function setRunCount(raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) return;
    const count = Math.min(20, Math.max(1, parsed));
    if (runCountOf(definition) === count) return;
    setDefinition((current) => ({ ...current, runCount: count }));
    setDirty(true); setError('');
  }
  function undoFixed(node) {
    const original = prep?.base.nodes.find((item) => item.id === node.id);
    if (!original) return;
    const next = { ...definition, nodes: definition.nodes.map((item) => item.id === node.id ? original : item) };
    // Once nothing differs any more, return to the untouched definition so starting does not save a draft.
    const same = next.nodes.every((item, index) => item === prep.base.nodes[index]) && next.nodes.length === prep.base.nodes.length;
    if (!same) { setDefinition(next); return; }
    const restored = definitionKeepingRunCount(prep.base, definition);
    setDefinition(restored);
    setDirty(restored === prep.base ? prep.baseDirty : true);
  }
  const steps = workflowSteps(definition);
  const inputSteps = steps.filter((step) => step.depth === 0 && isPreparationInput(step.node));
  const blockers = [
    ...issues.map((issue) => ({ key: issue.key, label: issue.label, message: issue.message, action: '去修改', run: () => goFix(issue) })),
    ...missingFixedContent(definition).map((node) => { const step = inputSteps.find((item) => item.node.id === node.id); return { key: 'missing:' + node.id, label: step ? stepLabel(step) : '固定内容', message: '还没有填写', action: '去填写', run: () => locateInput(node.id) }; }),
  ];
  function locateInput(id) {
    const card = inputCards.current.get(id);
    if (!card) return;
    setActiveInputId(id); card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.querySelector('textarea, input:not([type=hidden]), button')?.focus({ preventScroll: true });
  }
  const running = inputForm || mode === 'run';
  // One way back to the list (the page header's 「← 工作流列表」); unsaved edits are saved first.
  const backToList = () => perform(async () => {
    if (inputForm) {
      const base = prep ? prep.base : definition, baseDirty = prep ? prep.baseDirty : dirty;
      const next = prep ? definitionKeepingRunCount(base, definition) : definition;
      leavePreparation();
      if (next !== base || baseDirty) await saveSource({ workflow, definition: next, name, dirty: true });
    } else if (dirty) await save();
    setWorkflow(null); setDefinition(null);
  });
  return <main ref={appRef} id="main-content" className="workflow-app"><PageHeader title={workflow ? name : '工作流'}
      subtitle={undefined}
      back={workflow ? { label: '工作流列表', ariaLabel: '返回工作流列表', disabled: busy, onClick: backToList } : undefined}
      actions={undefined}
      tabs={workflow ? <div className="workflow-view-tabs ui-tabs" role="group" aria-label="工作流页面">
        <button type="button" aria-selected={!!inputForm} aria-pressed={!!inputForm} disabled={busy || !!workflow.archivedAt || (!!issues.length && mode === 'edit')} title={issues.length && mode === 'edit' ? '先处理下方列出的问题' : undefined} onClick={() => perform(() => beginRun(false, sourceNow(), snapshot))}>{!inputForm && mode === 'run' && runId ? '准备新运行' : '运行'}</button>
        <button type="button" aria-selected={mode === 'run' && !inputForm} aria-pressed={mode === 'run' && !inputForm} onClick={() => { leavePreparation(); setMode('run'); setRunId(null); request(`/api/workflows/${workflow.id}`).then((loaded) => setHistory(loaded.runs)).catch((reason) => setError(reason.message)); }}>运行记录{history.length ? `（${history.length}）` : ''}</button>
        <button type="button" aria-selected={mode === 'edit'} aria-pressed={mode === 'edit'} onClick={() => { leavePreparation(); setMode('edit'); }}>修改流程</button>
      </div> : undefined} />
    {error && <p className="workflow-error" role="alert">{error}</p>}{notice && <p className="workflow-notice" role="status">{notice}</p>}
    {!workflow ? <section className="workflow-home" aria-label="工作流首页">
      <section className="workflow-home-build" aria-label="一句话搭建">
        <h2><span className="workflow-home-num">1</span>用一句话说出你想做的事</h2>
        <div className="workflow-home-prompt">
          <input aria-label="一句话描述要搭的流程" placeholder="例如：把选中的图片逐张写一段描述，我确认后存进资料库" value={buildPrompt} onChange={(e) => { setBuildPrompt(e.target.value); setPromptPlan(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setPromptPlan(planFromPrompt(buildPrompt, { textAdapter: adapters.find((a) => a.nodeType === 'model')?.id, imageAdapter: adapters.find((a) => a.nodeType === 'image.generate')?.id })); } }} />
          <button type="button" className={promptPlan ? '' : 'primary'} disabled={busy || !buildPrompt.trim()} title={!buildPrompt.trim() ? '先用一句话描述要做的事' : undefined} onClick={() => setPromptPlan(planFromPrompt(buildPrompt, { textAdapter: adapters.find((a) => a.nodeType === 'model')?.id || 'grok-text', imageAdapter: adapters.find((a) => a.nodeType === 'image.generate')?.id || 'grok-build' }))}>帮我搭好</button>
        </div>
        {promptPlan && <div className="workflow-home-plan" role="region" aria-label="搭建计划">
          <h3>计划：{promptPlan.name}</h3>
          <p>根据「{promptPlan.summary}」会生成下面这个流程。确认后才会保存。</p>
          <ol>{promptPlan.steps.map((step) => <li key={step.number}>第 {step.number} 步 · {step.name}</li>)}</ol>
          <p>{promptPlan.valid ? `检查通过 · 最多调用 AI ${promptPlan.maxCalls} 次` : `还有问题：${promptPlan.errors[0]?.message || '请换个说法'}`}</p>
          <div className="workflow-actions">
            <button type="button" onClick={() => setPromptPlan(null)}>取消</button>
            <button type="button" className="primary" disabled={busy || !promptPlan.valid} title={!promptPlan.valid ? '计划还有问题，换个说法再试' : undefined} onClick={() => perform(async () => { const created = await post('/api/workflows', { name: promptPlan.name, definition: promptPlan.definition }); setPromptPlan(null); setBuildPrompt(''); open(created); await refresh(); })}>确认并生成</button>
          </div>
        </div>}
      </section>
      <section className="workflow-home-templates" aria-label="从模板开始">
        <h2><span className="workflow-home-num">2</span>从模板开始 <small>选一个，改两处就能用</small></h2>
        <div className="workflow-template-grid">{workflowTemplates({ textAdapter: adapters.find((a) => a.nodeType === 'model')?.id || 'grok-text', imageAdapter: adapters.find((a) => a.nodeType === 'image.generate')?.id || 'grok-build' }).map((tpl) => (
          <article key={tpl.id} className="workflow-template-card">
            <h3>{tpl.name}</h3>
            <p>{tpl.blurb}</p>
            <p className="workflow-template-flow">{tpl.flow.join(' → ')}</p>
            <button type="button" disabled={busy} onClick={() => perform(async () => { const created = await post('/api/workflows', { name: tpl.name, definition: tpl.definition }); open(created); await refresh(); })}>使用模板</button>
          </article>
        ))}</div>
      </section>
      <section className="workflow-list" aria-label="我的工作流">
        <header className="workflow-list-head"><h2><span className="workflow-home-num">3</span>我的工作流</h2></header>
        <div className="workflow-card-grid">{list.filter((item) => showArchived || !item.archivedAt).map((item) => (
          <article key={item.id} className="workflow-home-card">
            <button type="button" className="workflow-list-title" disabled={busy} onClick={() => perform(async () => { const loaded = await request(`/api/workflows/${item.id}`); const source = open(loaded); let previous = null; if (loaded.runs?.[0]) { try { const run = await request(`/api/workflow-runs/${loaded.runs[0].id}`); previous = { id: run.id, inputs: run.inputs, definition: run.definition, inputArtifacts: run.inputArtifacts }; } catch {} } beginRun(false, source, previous); })}>
              <strong>{item.name}</strong>
              <small>{item.latestState ? `上次 ${new Date(item.updatedAt).toLocaleString()} · ${stateLabels[item.latestState]}` : '尚未运行'}{item.archivedAt ? ' · 已归档' : ''}</small>
            </button>
            <div className="workflow-list-actions">
              <button type="button" disabled={busy || !!item.archivedAt} title={item.archivedAt ? '已归档的流程不能运行，先恢复归档' : undefined} onClick={() => perform(() => runFromList(item.id))}>运行</button>
              <button type="button" disabled={busy} onClick={() => perform(async () => { const loaded = await request(`/api/workflows/${item.id}`); adopt(loaded, { mode: 'edit' }); })}>编辑</button>
              <button type="button" disabled={busy || !item.latestState} onClick={() => perform(() => openLatest(item.id))}>最近运行</button>
            </div>
          </article>
        ))}
        <article className="workflow-home-card workflow-home-blank">
          <button type="button" disabled={busy} onClick={() => perform(async () => open(await post('/api/workflows', { name: '未命名工作流' })))}>＋ 从空白开始搭建</button>
        </article>
        </div>
        {!list.length && <p className="workflow-empty">还没有自己的工作流。可以从上面的模板开始，或者点「＋ 从空白开始搭建」。</p>}
      </section>
    </section> : <>
      {!inputForm && mode === 'edit' && <div className="workflow-toolbar ui-toolbar"><input aria-label="工作流名称" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} /><span className="workflow-save-state">{dirty ? '未保存' : '已保存'}</span><button disabled={busy} onClick={() => perform(save)}>保存</button><button disabled={busy} onClick={() => perform(async () => { const report = await post(`/api/workflows/${workflow.id}/validate`, { definition }); setErrors(report.errors); setNotice(report.valid ? `检查通过 · 最多调用 AI ${report.maxCalls} 次` : `还有 ${workflowIssues(definition, report.errors).length} 个问题，见下方列表`); })}>检查</button><button disabled={busy || !!workflow.archivedAt || !!issues.length || !definition.nodes.some((node) => node.type === 'foreach')} title="每个列表只处理第 1 项，用来先确认效果" onClick={() => perform(() => beginRun(true, sourceNow()))}>先试 1 项</button><details className="workflow-menu"><summary>管理</summary><div><button onClick={exportDefinition}>导出定义</button><button disabled={busy} onClick={() => perform(async () => { const saved = await request(`/api/workflows/${workflow.id}`, { method: 'PUT', body: JSON.stringify({ name, definition, revision: workflow.revision, archived: !workflow.archivedAt }) }); setWorkflow(saved); setDirty(false); await refresh(); })}>{workflow.archivedAt ? '恢复归档' : '归档'}</button></div></details></div>}
      {!inputForm && mode === 'edit' && !!issues.length && <section className="workflow-issues" aria-label="需要处理的问题"><strong>还有 {issues.length} 个问题，处理后才能运行</strong><ul>{issues.map((issue) => <li key={issue.key}><span className="workflow-issue-step">{issue.label}</span><span>{issue.message}</span>{issue.nodeId && <button onClick={() => goFix(issue)}>去修改</button>}</li>)}</ul></section>}
      {!inputForm && mode === 'edit' && <p className="workflow-mode-note">{definition.nodes.some((node) => node.type === 'foreach') ? '「运行」会处理全部内容；「先试 1 项」只处理每个列表的第 1 项，用来先确认效果。' : '「运行」会执行流程里的全部步骤。'}</p>}
      {!inputForm && mode === 'run' && !runId && <section className="workflow-history" aria-label="运行记录"><h2>运行记录</h2>{!history.length && <p className="workflow-empty">还没有运行过。点上方「运行」，填好内容后开始。</p>}<ul className="workflow-history-list">{history.map((entry) => <li key={entry.id}><button type="button" className="workflow-history-item" data-active={runId === entry.id} onClick={() => { setSnapshot(null); setRunId(entry.id); setInputForm(false); setMode('run'); }}><strong>运行 #{entry.id}</strong><span data-state={entry.state}>{stateLabels[entry.state]}</span><small>流程第 {entry.version} 版 · {new Date(entry.createdAt || entry.updatedAt || Date.now()).toLocaleString()}</small></button></li>)}</ul>
      </section>}
      {!inputForm && mode === 'run' && runId && <section className="workflow-history-switcher" aria-label="切换运行记录"><button type="button" className="text-button button-sm workflow-history-back" onClick={() => { setRunId(null); setSnapshot(null); }}>← 全部运行记录</button></section>}
      {inputForm && <div className="workflow-workbench"><section className="workflow-workbench-columns" aria-label="运行工作台"><section className="workflow-input-form" aria-label="填写运行内容"><div className="workflow-input-heading"><span className="workflow-step">{sample ? '先试 1 项' : '新建运行'}</span><h2>{runtimeNodes().length || fixedNodes.length ? '准备本次素材' : '准备就绪'}</h2><p>{runtimeNodes().length ? '选择或填写本次要处理的内容，' : '使用已配置的素材，'}点击「开始{sample ? '试跑' : '运行'}」。</p></div>{prep?.from && <p className="workflow-prefill-note" role="status">已带上运行 #{prep.from} 的内容，可以直接修改后开始。{prep.dropped ? `有 ${prep.dropped} 张图片无法再次使用，请重新选择。` : ''}</p>}{sample && <div><p>只处理下面每个列表的第 1 项，用来先确认效果；其余步骤照常执行，参考图片全部保留。</p><ul>{definition.nodes.filter((node) => node.type === 'foreach').map((node) => <li key={node.id}>{node.name || '批量循环'}：{definition.nodes.find((source) => source.id === node.inputs?.items?.nodeId)?.name || '输入列表'}的第 1 项（空列表不执行）</li>)}</ul></div>}{!runtimeNodes().length && !!fixedNodes.length && <p>下面是流程里的固定内容，确认后即可开始。</p>}<div className="workflow-preparation-fields">{inputSteps.map((step) => {
        const node = step.node, runtime = isRuntimeElement(node), label = stepLabel(step);
        const locked = !runtime && !prep?.unlocked.includes(node.id), changed = changedFixed.includes(node);
        const { sources, targets, sourceLabel } = stepConnections(step, steps);
        return <section key={node.id} ref={(element) => { if (element) inputCards.current.set(node.id, element); else inputCards.current.delete(node.id); }} className="workflow-preparation-card" data-node-id={node.id} data-active={activeInputId === node.id} onFocusCapture={() => setActiveInputId(node.id)} aria-label={label + '的输入'}>
          <header><strong>{label}</strong><span>{sourceLabel}</span></header>
          {sources.length > 0 && <p className="workflow-input-connection">来自：{sources.map(stepLabel).join('、')}</p>}
          {targets.length > 0 && <p className="workflow-input-connection">用于：{targets.map(stepLabel).join('、')}</p>}
          {locked ? <><FixedPreview node={node} label={label} /><button className="workflow-fixed-edit" onClick={() => setPrep((current) => ({ ...current, unlocked: [...current.unlocked, node.id] }))}>修改这项固定内容</button></> : <>
          {!runtime && <small className="workflow-input-save-note">{changed ? '已修改：开始时会保存到流程，以后每次运行都用新内容。' : '这是固定内容：填写或修改后会保存到流程，以后每次运行都用它。'}</small>}
          {changed && <button className="workflow-fixed-undo" onClick={() => undoFixed(node)}>撤销修改</button>}
          <WorkflowContentField showImageHelp label={label} type={outputType(node)} value={runtime ? inputs[node.config.parameter] : node.config.default}
            renderText={!runtime && outputType(node) === 'text' ? (text) => <WorkflowTextField allowReferences={false} label={label} parts={node.config.parts || [{ kind: 'text', text }]} nodes={definition.nodes} selected={node.id} onChange={(parts) => updateFixed(node, { parts })} /> : undefined}
            onChange={(value) => runtime ? setInputs((all) => ({ ...all, [node.config.parameter]: value })) : updateFixed(node, { default: value, parts: undefined })} /></>}
        </section>;
      })}</div>
      {steps.some((step) => generationParameterConfig(step.node)) && <section className="workflow-runtime-parameters" aria-label="本次生图参数"><h3>本次生图参数</h3><p>可按本次图片的比例调整分辨率、尺寸来源和 seed。只作用于这次运行，不修改流程默认值。</p>{steps.filter((step) => generationParameterConfig(step.node)).map((step) => <section key={step.id} aria-label={stepLabel(step) + '的生图参数'}><strong>{stepLabel(step)}</strong><RuntimeGenerationParameters node={step.node} value={generationParameters[step.id]} onChange={(config) => setGenerationParameters((current) => ({ ...current, [step.id]: config }))} />{generationParameters[step.id] && <><small>已调整，仅用于本次运行</small><button type="button" onClick={() => setGenerationParameters((current) => { const next = { ...current }; delete next[step.id]; return next; })}>恢复流程默认参数</button></>}</section>)}</section>}
{!!blockers.length && <div className="workflow-start-blockers" role="status"><strong>暂时不能开始：</strong><ul>{blockers.map((blocker) => <li key={blocker.key}><span className="workflow-issue-step">{blocker.label}</span><span>{blocker.message}</span><button onClick={blocker.run}>{blocker.action}</button></li>)}</ul></div>}<div className="workflow-actions workflow-input-actions"><label className="workflow-run-count">运行次数<input aria-label="运行次数" title="下次点「开始运行」时，整个流程按这个次数各开一次" type="number" min="1" max="20" step="1" value={runCountOf(definition)} disabled={busy} onChange={(event) => setRunCount(event.target.value)} /></label><button disabled={busy} onClick={() => { leavePreparation(); setMode('edit'); }}>返回编辑</button><button className="primary" disabled={!!blockers.length} title={blockers.length ? '先处理上方「暂时不能开始」里的问题' : undefined} onClick={() => perform(() => launch(sample, inputs, sourceNow()))}>{changedFixed.length ? '保存修改并' : ''}开始{sample ? '试 1 项' : '运行'}{runCountOf(definition) > 1 ? ` ${runCountOf(definition)} 次` : ''}</button></div></section><aside className="workflow-plan" aria-label="执行前状态"><WorkflowPlan definition={definition} activeNodeId={activeInputId} onLocate={locateInput} /></aside></section></div>}
      {/* Stay mounted while hidden so a run does not drop the canvas selection or undo stack. */}
      <div hidden={inputForm || mode !== 'edit'}><WorkflowEditor key={workflow.id} active={!inputForm && mode === 'edit'} definition={definition} adapters={adapters} issues={issues} locate={locate} onPreview={history.length ? (nodeId, scope) => { setFocusNodeId(scope || nodeId); setRunId(history[0].id); setInputForm(false); setMode('run'); setNotice('这里显示最近一次运行的结果；还没运行过的修改不会出现在这里。'); } : undefined} onChange={(next) => { setDefinition(next); setDirty(true); setErrors([]); }} /></div>
      {!inputForm && mode === 'run' && runId && <div className="workflow-run-workspace"><WorkflowRun key={runId} runId={runId} runCount={runCountOf(definition)} onRunCountChange={setRunCount} archived={!!workflow.archivedAt} focusNodeId={focusNodeId} onStateChange={updateRunState} onRun={rememberRun} definition={definition} onEditVersion={(loaded) => { open(loaded); refresh(); }} onDerived={(id) => { setSnapshot(null); setRunId(id); setInputForm(false); setMode('run'); }} /></div>}
    </>}

  </main>;
}
