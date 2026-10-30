import { useEffect, useState } from 'react';
import { FileDiff, ChevronDown, Undo2 } from 'lucide-react';
import { request } from '../../api.js';
import { DialogFrame } from '../../ui/ConfirmDialog.jsx';
import './workbenchChanges.css';

function Counts({ files }) {
  const known = files.every(file => Number.isInteger(file.added) && Number.isInteger(file.removed));
  return known ? <span className="workbench-change-counts"><span>+{files.reduce((n, file) => n + file.added, 0)}</span><span>−{files.reduce((n, file) => n + file.removed, 0)}</span></span> : <span className="workbench-change-unknown">差异统计不可用</span>;
}

export default function WorkbenchChanges({ turn, revision, sessionBusy }) {
  const [value, setValue] = useState(null), [error, setError] = useState(''), [expanded, setExpanded] = useState(false), [selected, setSelected] = useState(null), [busy, setBusy] = useState(false);
  const endpoint = `/api/agent/turns/${turn.id}/changes`;
  useEffect(() => {
    let live = true;
    request(endpoint).then(result => { if (live) { setValue(result); setError(''); } }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [endpoint, revision, turn.state]);
  if (!value) return error ? <p role="alert">变更记录加载失败：{error}</p> : null;
  const { files } = value, active = ['queued', 'running', 'awaiting_approval', 'cancelling'].includes(turn.state);
  const file = selected === null ? null : files[selected];
  const reversible = files.filter(file => file.canUndo), undone = value.undoState === 'undone';
  async function undo() {
    setBusy(true); setError('');
    try { setValue(await request(endpoint + '/undo', { method: 'POST', body: JSON.stringify({ version: value.version }) })); }
    catch (failure) { setError(failure.message); try { setValue(await request(endpoint)); } catch { /* Preserve the actionable error. */ } }
    finally { setBusy(false); }
  }
  const open = index => { setSelected(index); };
  return <>
    {files.length > 0 && (active ? <details className="workbench-live-changes"><summary><FileDiff size={15} />{value.incomplete && '至少 '}{files.length} 个文件已更改 <Counts files={files} /><ChevronDown size={14} /></summary><div className="workbench-live-file-list">{files.map((file, index) => <button type="button" key={file.path} onClick={() => open(index)}><span title={file.displayPath}>{file.displayPath}</span><Counts files={[file]} /></button>)}</div></details> : <section className="workbench-changes-card" aria-label="本轮文件变更">
      <header><FileDiff size={22} /><div><strong>{value.incomplete ? `已记录 ${files.length} 个文件（差异不完整）` : `已编辑 ${files.length} 个文件`}</strong><Counts files={files} /></div><div className="workbench-change-actions">
        {!!reversible.length && <button type="button" disabled={busy || sessionBusy || undone || turn.state === 'unknown'} onClick={undo} title={turn.state === 'unknown' ? '执行结果尚未确认，请先核查仍在运行的命令' : '仅恢复本轮有完整版本的文件；遇到后续修改会停止，不撤销命令的其他副作用'}><Undo2 size={14} />{busy ? '正在撤销…' : undone ? '已撤销' : value.undoState === 'undoing' ? '继续撤销' : `撤销 ${reversible.length} 个文件`}</button>}
        <button type="button" onClick={() => open(0)}>查看变更</button>
      </div></header>
      <div className="workbench-change-files">{(expanded ? files : files.slice(0, 3)).map((file, index) => <button type="button" key={file.path} onClick={() => open(index)}><span title={file.displayPath}>{file.displayPath}{value.undonePaths.includes(file.path) && <small> · 已撤销</small>}</span><Counts files={[file]} /></button>)}</div>
      {files.length > 3 && <button type="button" className="workbench-change-more" onClick={() => setExpanded(!expanded)}>{expanded ? '收起文件' : `再显示 ${files.length - 3} 个文件`}<ChevronDown size={15} /></button>}
      {files.some(file => !file.canUndo) && <p className="workbench-change-note">部分文件仅有差异记录，暂不提供撤销。</p>}
    </section>)}
    {error && <p role="alert" className="workbench-change-error">{error}</p>}
    {(!!value.workspaceDiff || value.workspaceStatus?.length > 0) && <details className="workbench-observed-changes"><summary>工作区检测到的变化（可能包含外部修改）</summary><p>{value.workspaceNotice}</p><pre>{[value.workspaceStatus?.join('\n'), value.workspaceDiff].filter(Boolean).join('\n\n')}</pre></details>}
    {file && <DialogFrame title="本轮文件变更" closeLabel="关闭变更查看" onClose={() => setSelected(null)} className="workbench-changes-dialog" size="wide">
      <div className="workbench-changes-browser"><nav aria-label="变更文件">{files.map((entry, index) => <button type="button" key={entry.path} aria-current={selected === index ? 'true' : undefined} onClick={() => open(index)}><span title={entry.displayPath}>{entry.displayPath}</span><Counts files={[entry]} /></button>)}</nav>
        <section className="workbench-file-diff" aria-label="文件差异"><header><strong>{file.displayPath}</strong><Counts files={[file]} /></header>
          <p className="workbench-change-note">{file.source === 'host' ? '工作台记录的本轮净修改' : file.source === 'antigravity' ? 'Antigravity 原生差异' : 'Codex 原生差异'}{file.undoReason && ` · ${file.undoReason}`}{value.undonePaths.includes(file.path) && ' · 已撤销，以下保留原始变更记录'}</p>
          {file.rows.length > 0 ? <div className="workbench-diff-lines">{file.rows.map((row, index) => <div className={`workbench-diff-line ${row.type}`} key={index}><span>{row.oldLine}</span><span>{row.newLine}</span><code>{row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ' '}{row.text}{row.noNewline && ' ⏎ 无末尾换行'}</code></div>)}</div> : file.rawDiff ? <pre>{file.rawDiff}</pre> : <p>{file.unavailable || '没有可显示的文本行差异'}</p>}
          {file.unavailable && <details><summary>查看修改前后全文</summary><h4>修改前</h4><pre>{file.before}</pre><h4>修改后</h4><pre>{file.after}</pre></details>}
        </section>
      </div>
    </DialogFrame>}
  </>;
}
