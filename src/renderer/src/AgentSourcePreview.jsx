import { useState } from "react";
import { BookOpen, X } from "lucide-react";
import Dialog from "./Dialog.jsx";
import ElementDetail from "./ElementDetail.jsx";
import SourceReference from "./SourceReference.jsx";
import WikiContextMenu from "./WikiContextMenu.jsx";

export default function AgentSourcePreview({ id, onClose, onBrowse, onReference, onAddReference }) {
  const [stack, setStack] = useState([{ id, page: 1 }]);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(null), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const current = stack.at(-1);
  function back() { if (stack.length > 1) setStack((p) => p.slice(0, -1)); else onClose(); }
  return <Dialog open label="资料预览" className="wiki-dialog agent-source-preview" onClose={() => { if (!busy) onClose(); }}>
    <header className="wiki-dialog-header"><h2><BookOpen size={18} />资料预览</h2><button className="icon-only" aria-label="关闭资料预览" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <div className="agent-source-body">
      {notice && <p role="status">{notice}</p>}{error && <p className="wiki-error" role="alert">{error}</p>}
      <ElementDetail key={`${stack.length}:${current.id}`} id={current.id} readOnly relationPage={current.page}
      contextId={stack.at(-2)?.id}
      onRelationPage={(page) => setStack((p) => p.map((entry, i) => i === p.length - 1 ? { ...entry, page } : entry))}
      onContentContextMenu={(event, element) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, element }); }}
      onBusyChange={setBusy} onBack={back} onOpen={(id) => setStack((p) => [...p, { id, page: 1 }])} onChanged={() => {}} onTrashed={onClose} /></div>
    <footer className="wiki-dialog-footer"><span className="wiki-muted">查看来源后，继续当前对话。</span><SourceReference id={current.id} onReference={onReference} disabled={busy} showButton /><button disabled={busy} onClick={() => onBrowse(current.id, stack.at(-2)?.id)}>在内容库打开</button></footer>
    {menu && <WikiContextMenu menu={menu} onClose={() => setMenu(null)} onAddReference={onAddReference} disabled={busy} onNotice={setNotice} onError={setError} />}
  </Dialog>;
}
