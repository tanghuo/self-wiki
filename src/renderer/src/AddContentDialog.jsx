import { useEffect, useRef, useState } from "react";
import { FileText, Upload, Save, X } from "lucide-react";
import Dialog from "./Dialog.jsx";
import TagInput, { readTagInput } from "./TagInput.jsx";
import ContentDraft from "./ContentDraft.jsx";
import { textDraft } from "./contentDrafts.js";
import { request } from "./api.js";
import { elementTags, maxImageBytes, maxVideoBytes } from "../../shared/domain/elements.js";

export default function AddContentDialog({ value, onChange, onChooseFiles, onClose, onSaved, onComplete, onBusyChange }) {
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [material, setMaterial] = useState(false);
  const locked = useRef(false);
  const pending = value.entries.filter((entry) => !entry.saved && (entry.file || entry.body.trim()));
  const saved = value.entries.filter((entry) => entry.saved);
  const hasUnsaved = pending.length > 0 || !saved.length && (value.tags.tags.length > 0 || value.tags.draft.trim()
    || value.entries.some((entry) => entry.tags.tags.length > 0 || entry.tags.draft.trim()));
  function requestClose() {
    if (locked.current) return;
    if (hasUnsaved) setConfirmDiscard(true);
    else onClose();
  }
  useEffect(() => {
    if (!hasUnsaved && !busy) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsaved, busy]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const entry = value.entries.find((item) => item.kind === "text" && !item.body.trim());
    // Dialog has opened by this effect. Focus now so a later frame cannot steal the user's next input.
    document.getElementById(`draft-${entry?.key}`)?.focus();
  }, []);
  function updateEntry(key, patch) {
    onChange((current) => ({ ...current, entries: current.entries.map((entry) => entry.key === key ? { ...entry, ...patch } : entry) }));
  }
  function addText() {
    const last = value.entries.at(-1);
    const entry = last?.kind === "text" && !last.body.trim() && !last.saved ? last : textDraft();
    if (entry !== last) onChange((current) => ({ ...current, entries: [...current.entries, entry] }));
    requestAnimationFrame(() => document.getElementById(`draft-${entry.key}`)?.focus());
  }
  async function submit(event) {
    event.preventDefault();
    if (locked.current || !pending.length) return;
    setError("");
    let batch;
    try {
      const common = readTagInput(value.tags);
      batch = pending.map((entry) => ({ entry, tags: elementTags([...common, ...readTagInput(entry.tags)]) }));
    } catch (failure) { setError(failure.message); return; }
    locked.current = true; setBusy(true); onBusyChange(true);
    const completed = saved.map((entry) => entry.saved);
    let failures = 0;
    try {
      for (const { entry, tags } of batch) {
        setSaving(entry.key); updateEntry(entry.key, { error: "" });
        try {
          if (entry.file && entry.file.size > (entry.kind === "video" ? maxVideoBytes : maxImageBytes)) throw new Error(entry.kind === "video" ? "每个视频最多 1 GiB" : "每张图片最多 25 MiB");
          const element = entry.kind === "text"
            ? await request("/api/elements", { method: "POST", body: JSON.stringify({ body: entry.body, tags, material }) })
            : await request(entry.kind === "video" ? "/api/videos" : "/api/images", { method: "POST", headers: {
              "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(entry.file.name),
              "x-element-material": material ? "1" : "0",
              [entry.kind === "video" ? "x-video-tags" : "x-image-tags"]: btoa(Array.from(new TextEncoder().encode(JSON.stringify(tags)), (byte) => String.fromCharCode(byte)).join("")),
            }, body: entry.file });
          completed.push(element); updateEntry(entry.key, { saved: element }); onSaved(element, entry);
        } catch (failure) { failures++; updateEntry(entry.key, { error: failure.message }); }
      }
      if (failures) setError(`${failures} 项未保存，草稿已保留。可以修改或移除后重试，已保存的项会跳过。`);
      else onComplete(completed);
    } finally { locked.current = false; setSaving(null); setBusy(false); }
  }
  return <><Dialog open label="新增内容" className="wiki-dialog wiki-composer" onClose={requestClose}>
    <form onSubmit={submit}>
      <header className="wiki-dialog-header"><div><h2>新增内容</h2><p>图片、视频和文字可以放在一起，每一项独立保存。</p></div>
        <button type="button" className="icon-only" aria-label="关闭新增内容" disabled={busy} onClick={requestClose}><X size={18} /></button></header>
      <div className="wiki-form-fields">
        <label className="wiki-material-filter"><input type="checkbox" checked={material} disabled={busy || saved.length > 0} onChange={(event) => setMaterial(event.target.checked)} />本次内容用作素材</label>
        <div className="wiki-composer-tags"><TagInput label="本次标签" value={value.tags} disabled={busy || saved.length > 0}
          onChange={(tags) => { onChange((current) => ({ ...current, tags })); setError(""); }} />
          <p className="wiki-muted">这些标签会加到本次所有内容上，每项也可以单独补充。</p></div>
        <div className="wiki-draft-list">{value.entries.map((entry, index) => <ContentDraft key={entry.key} entry={entry} index={index} busy={busy} saving={saving === entry.key}
          onChange={(patch) => updateEntry(entry.key, patch)} onRemove={() => onChange((current) => ({ ...current, entries: current.entries.filter((item) => item.key !== entry.key) }))} />)}</div>
        <p className="wiki-muted">可粘贴、拖入或导入文件。图片支持 PNG、JPEG、WebP、GIF，每张最多 25 MiB；视频支持 MP4、M4V、WebM、MOV，每个最多 1 GiB。播放取决于浏览器支持的编码，可随时下载原文件。</p>
        {error && <p className="wiki-error" role="alert">{error}</p>}
      </div>
      <footer className="wiki-dialog-footer wiki-composer-footer">
        <div className="wiki-composer-tools"><button type="button" disabled={busy} onClick={addText}><FileText size={16} />添加文字</button><button type="button" disabled={busy} onClick={onChooseFiles}><Upload size={16} />导入图片或视频</button></div>
        <span className="wiki-muted">待保存 {pending.length} 项{saved.length > 0 && ` · 已保存 ${saved.length} 项`}</span>
        <button type="button" disabled={busy} onClick={requestClose}>{saved.length ? "关闭" : "取消"}</button>
        <button className="primary" disabled={busy || !pending.length}><Save size={16} />{busy ? "正在保存…" : saved.length || value.entries.some((entry) => entry.error) ? "重试未保存项" : "保存全部"}</button>
      </footer>
    </form>
  </Dialog>
    {confirmDiscard && <Dialog open label="放弃未保存内容？" className="wiki-dialog" onClose={() => setConfirmDiscard(false)}>
      <header className="wiki-dialog-header"><h2>放弃未保存内容？</h2></header>
      <div className="wiki-form-fields"><p>未保存的文字、图片、视频和标签会被丢弃。已经保存成功的内容会保留。</p></div>
      <footer className="wiki-dialog-footer">
        <button autoFocus onClick={() => setConfirmDiscard(false)}>继续编辑</button>
        <button className="danger-quiet" onClick={onClose}>放弃未保存内容</button>
      </footer>
    </Dialog>}
  </>;
}
