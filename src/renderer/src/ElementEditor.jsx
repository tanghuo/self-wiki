import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, Save } from "lucide-react";
import Dialog from "./Dialog.jsx";
import TagInput, { readTagInput } from "./TagInput.jsx";
import { request } from "./api.js";
import { maxElementBody } from "../../shared/domain/elements.js";

export default function ElementEditor({ element, onClose, onSaved, onBusyChange, tagsOnly = false }) {
  const [body, setBody] = useState(element.body);
  const [tags, setTags] = useState({ tags: element.tags, draft: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const locked = useRef(false);
  const bodyInput = useRef(null);
  const editsBody = element.kind === "text" && !tagsOnly;
  const title = tagsOnly ? "编辑标签" : "编辑内容";
  const snapshot = JSON.stringify({ body: editsBody ? body : "", tags });
  const initial = useRef(snapshot);
  const dirty = snapshot !== initial.current;
  useLayoutEffect(() => { if (editsBody) bodyInput.current?.focus(); }, [editsBody]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  function close() { if (locked.current) return; if (dirty) setDiscard(true); else onClose(); }
  async function submit(event) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const content = { tags: readTagInput(tags, element.tags), ...(editsBody ? { body } : {}) };
      const saved = await request(`/api/elements/${element.id}`, {
        method: "PATCH", body: JSON.stringify(content),
      });
      onSaved(saved);
    } catch (failure) { setError(failure.message); }
    finally { locked.current = false; setBusy(false); }
  }
  return <><Dialog open label={title} className="wiki-dialog" onClose={close}>
    <form onSubmit={submit}>
      <header className="wiki-dialog-header"><h2>{title}</h2><button type="button" className="icon-only" aria-label="关闭编辑" onClick={close} disabled={busy}><X size={18} /></button></header>
      <div className="wiki-form-fields">
        {editsBody && <label>文字<textarea ref={bodyInput} aria-label="文字" rows={10} value={body} maxLength={maxElementBody} onChange={(e) => setBody(e.target.value)} disabled={busy} placeholder="记下想法、保存提示词，或写一个人物的名字……" /><small>{body.length} / {maxElementBody}</small></label>}
        <TagInput value={tags} onChange={setTags} disabled={busy} existingTags={element.tags} />
        {error && <p className="wiki-error" role="alert">{error}</p>}
      </div>
      <footer className="wiki-dialog-footer"><button type="button" onClick={close} disabled={busy}>取消</button><button className="primary" disabled={busy || (editsBody && !body.trim())}><Save size={16} />{busy ? "正在保存…" : "保存"}</button></footer>
    </form>
  </Dialog>{discard && <Dialog open label="放弃内容修改？" className="wiki-dialog" onClose={() => setDiscard(false)}>
    <header className="wiki-dialog-header"><h2>放弃内容修改？</h2></header><p>未保存的文字和标签修改会被丢弃。</p>
    <footer className="wiki-dialog-footer"><button autoFocus onClick={() => setDiscard(false)}>继续编辑</button><button className="danger-quiet" onClick={onClose}>放弃修改</button></footer>
  </Dialog>}</>;
}
