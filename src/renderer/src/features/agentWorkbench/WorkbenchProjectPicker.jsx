import { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, FolderPlus, Monitor, Plus, Search, X } from 'lucide-react';
import { DialogFrame } from '../../ui/ConfirmDialog.jsx';

function folderBaseName(value) {
  return String(value || '').trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.slice(0, 80) || '';
}

export default function WorkbenchProjectPicker({ projects, kind, projectId, projectName, busy, engine, nativeReadAccepted, onAcceptNative, onSelect, onClear, onCreate }) {
  const [open, setOpen] = useState(false), [creating, setCreating] = useState(false), [query, setQuery] = useState(''), [name, setName] = useState(''), [folder, setFolder] = useState(''), [typing, setTyping] = useState(false), [pickerError, setPickerError] = useState(''), [position, setPosition] = useState({}), [nameEdited, setNameEdited] = useState(false);
  const root = useRef(null), popup = useRef(null), trigger = useRef(null);
  const label = kind === 'project' && projectName ? projectName : '不在项目中工作';
  const visible = projects.filter(project => project.name.toLowerCase().includes(query.trim().toLowerCase()));
  function close() { setOpen(false); }
  function show(event) {
    if (open) { close(); return; }
    trigger.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    const above = rect.top > 280;
    setPosition(above
      ? { left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)), bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(160, rect.top - 16) }
      : { left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)), top: rect.bottom + 8, maxHeight: Math.max(160, window.innerHeight - rect.bottom - 16) });
    setQuery(''); setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector('input')?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) close(); };
    const resize = () => close();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
  }, [open]);
  function chooseFolder(next) {
    setFolder(next);
    if (!nameEdited) setName(folderBaseName(next));
  }
  async function browse() {
    setPickerError('');
    try {
      const selected = await window.wikiDesktop?.pickProjectDirectory?.();
      if (selected) { chooseFolder(selected); setTyping(false); return; }
      setTyping(true);
    } catch { setPickerError('无法打开目录选择器，请输入文件夹的绝对路径。'); setTyping(true); }
  }
  function resetCreate() { setCreating(false); setName(''); setFolder(''); setTyping(false); setPickerError(''); setNameEdited(false); }
  function submit() {
    const projectName = name.trim().slice(0, 80) || folderBaseName(folder);
    onCreate({ path: folder.trim(), ...(projectName ? { name: projectName } : {}) }).then(created => { if (created) resetCreate(); });
  }
  return <div className="workbench-project-control" ref={root} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus(); } }}>
    <button type="button" className="workbench-config-trigger workbench-project-chip" aria-label="选择项目" aria-haspopup="dialog" aria-expanded={open} disabled={busy} title={kind === 'project' ? projects.find(project => project.id === projectId)?.path : '不绑定项目文件夹'} onClick={show}><FolderOpen size={15} /><span>{label}</span></button>
    <span className="workbench-machine"><Monitor size={14} />此计算机</span>
    {open && <div ref={popup} className="workbench-project-popover" style={position} role="dialog" aria-label="选择项目">
      <div className="workbench-project-search"><Search size={15} /><input aria-label="搜索项目" placeholder="搜索项目" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div role="group" aria-label="项目列表">{visible.map(project => <button type="button" className="workbench-project-option" key={project.id} aria-pressed={kind === 'project' && projectId === project.id} disabled={busy} onClick={() => { onSelect(project); close(); }}><FolderOpen size={16} /><span>{project.name}</span>{kind === 'project' && projectId === project.id && <Check size={16} />}</button>)}</div>
      {!visible.length && <p className="workbench-muted">没有匹配的项目</p>}
      <div className="workbench-project-actions">
        <button type="button" className="workbench-project-option" disabled={busy} onClick={() => { close(); setCreating(true); }}><Plus size={16} /><span>新建项目</span></button>
        <button type="button" className="workbench-project-option" aria-pressed={kind === 'scratch'} disabled={busy} onClick={() => { onClear(); close(); }}><X size={16} /><span>不在项目中工作</span>{kind === 'scratch' && <Check size={16} />}</button>
      </div>
    </div>}
    {creating && <DialogFrame title="创建项目" onClose={resetCreate} closeLabel="关闭创建项目" className="workbench-settings-dialog" busy={busy} footer={<><button type="button" disabled={busy} onClick={resetCreate}>取消</button><button type="button" className="primary" disabled={busy || !folder.trim() || ['codex-cli', 'antigravity-acp'].includes(engine) && !nativeReadAccepted} onClick={submit}>创建项目</button></>}>
      <label className="workbench-project-name"><FolderOpen size={16} /><input aria-label="项目名称" placeholder={folderBaseName(folder) || '项目名称（可选）'} value={name} disabled={busy} autoFocus onChange={event => { const value = event.target.value; setName(value); setNameEdited(Boolean(value.trim()) && value.trim() !== folderBaseName(folder)); }} /></label>
      <p className="workbench-source-label">源文件夹</p>
      <div className="workbench-source-folder">
        <p aria-label="源文件夹">{folder || '在此电脑上添加文件夹'}</p>
        <button type="button" disabled={busy} aria-label="添加源文件夹" onClick={browse}><FolderPlus size={16} />添加</button>
        {typing && <input aria-label="项目目录" value={folder} disabled={busy} placeholder="输入文件夹的绝对路径" onChange={event => chooseFolder(event.target.value)} />}
      </div>
      <p>创建后，这个项目里的新会话都使用该文件夹。文件修改和命令仍按会话权限审批；已批准的命令使用当前用户权限运行。</p>
      {engine === 'codex-cli' && <label className="workbench-trust"><input type="checkbox" checked={nativeReadAccepted} onChange={event => onAcceptNative(event.target.checked)} />我接受 Codex 原生全盘读取权限，安全读取可能自动执行；写入和危险命令按原生审批处理。</label>}
      {engine === 'antigravity-acp' && <label className="workbench-trust"><input type="checkbox" checked={nativeReadAccepted} onChange={event => onAcceptNative(event.target.checked)} />我信任 Antigravity 原生文件访问、命令以及已有配置；工作目录不构成系统沙箱。</label>}
      {pickerError && <p role="alert">{pickerError}</p>}
    </DialogFrame>}
  </div>;
}
