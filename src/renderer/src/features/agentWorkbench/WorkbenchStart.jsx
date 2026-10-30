import { useRef } from 'react';
import { ArrowUp, Plus } from 'lucide-react';
import WorkbenchModelPicker from './WorkbenchModelPicker.jsx';
import WorkbenchProjectPicker from './WorkbenchProjectPicker.jsx';
import WorkbenchApprovalPicker from './WorkbenchApprovalPicker.jsx';
import { maxWorkbenchImages, workbenchImageFiles } from './workbenchImages.js';

export default function WorkbenchStart({ settings, change, projects, engines, models, modelState, retryModels, text, setText, busy, create, createProject, selectEngine, loadModels, connectAntigravity, images, addImages, removeImage }) {
  const { kind, projectId, projectName, engine, model, effort, nativeReadAccepted } = settings;
  const form = useRef(null), fileInput = useRef(null);
  const ready = !busy && text.trim() && model;
  function submit(event) {
    event.preventDefault();
    if (!ready) return;
    create({ trusted: true, nativeReadAccepted: ['codex-cli', 'antigravity-acp'].includes(engine) });
  }
  return <div className="workbench-start">
    <div className="workbench-welcome"><h2>今天想完成什么？</h2></div>
    <form ref={form} className="workbench-launcher" onSubmit={submit} onPaste={event => { const files = workbenchImageFiles(event.clipboardData); if (!files.length) return; event.preventDefault(); event.stopPropagation(); addImages(files); }}>
      {!!images.length && <div className="workbench-pending-images">{images.map(image => <button type="button" className="workbench-image-chip" key={image.key} aria-label="移除参考图" title={image.file.name || '参考图'} disabled={busy} onClick={() => removeImage(image.key)}><img src={image.url} alt="" /><span className="workbench-image-remove" aria-hidden="true">×</span></button>)}</div>}
      <textarea aria-label="任务内容" placeholder="描述任务，或提出一个问题，也可直接粘贴图片…" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (ready) form.current.requestSubmit(); } }} rows={3} disabled={busy} autoFocus />
      <div className="workbench-launcher-toolbar">
        <button type="button" className="icon-only" aria-label="添加参考图" title="添加参考图" disabled={busy || images.length >= maxWorkbenchImages} onClick={() => fileInput.current?.click()}><Plus size={19} /></button>
        <input ref={fileInput} aria-label="选择参考图文件" hidden type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy || images.length >= maxWorkbenchImages} onChange={event => { const files = [...event.target.files]; event.target.value = ''; if (files.length) addImages(files); }} />
        <WorkbenchProjectPicker projects={projects} kind={kind} projectId={projectId} projectName={projectName} busy={busy} engine={engine} nativeReadAccepted={nativeReadAccepted} onAcceptNative={value => change({ nativeReadAccepted: value })} onSelect={project => change({ kind: 'project', projectId: project.id, projectPath: project.path, projectName: project.name })} onClear={() => change({ kind: 'scratch', projectId: null, projectPath: '', projectName: '' })} onCreate={createProject} />
        <WorkbenchModelPicker engine={engine} model={model} effort={effort} engines={engines} models={models} modelState={modelState} retryModels={retryModels} busy={busy} change={change} selectEngine={selectEngine} loadModels={loadModels} connectAntigravity={connectAntigravity} />
        <WorkbenchApprovalPicker mode={settings.approvalMode} engine={engine} disabled={busy} onChange={approvalMode => change({ approvalMode })} />
        <button className="primary icon-only workbench-launch-send" aria-label="发送" title="发送" disabled={!ready}><ArrowUp size={19} /></button>
      </div>
    </form>
    {engine === 'codex-cli' && <p className="workbench-muted">发送即确认使用 Codex 原生文件访问：可读取工作目录以外的文件，写入和危险命令按原生审批处理。</p>}
    {engine === 'antigravity-acp' && <p className="workbench-muted">发送即确认使用 Antigravity 已有配置、插件和工具；它以当前用户权限访问文件和执行命令，原生请求在此审批，工作目录不构成系统沙箱。</p>}
  </div>;
}
