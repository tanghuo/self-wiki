import { useEffect, useState } from "react";
import { ImageIcon, FileText, Video, X, Check } from "lucide-react";
import { maxElementBody } from "../../shared/domain/elements.js";
import TagInput from "./TagInput.jsx";
import { savedContentStatus } from "./contentDrafts.js";

export default function ContentDraft({ entry, index, busy, saving, onChange, onRemove }) {
  const [preview, setPreview] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const image = entry.kind === "image", video = entry.kind === "video";
  const label = video ? "视频" : image ? "图片" : "文字";
  const disabled = busy || Boolean(entry.saved);
  useEffect(() => {
    if (!entry.file || entry.kind === "video") return;
    const url = URL.createObjectURL(entry.file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [entry.file]);
  return <article className="wiki-content-draft" aria-label={`${label}元素 ${index + 1}`}>
    <header><span>{video ? <Video size={16} /> : image ? <ImageIcon size={16} /> : <FileText size={16} />}{label} {index + 1}</span>
      {entry.saved ? <span className="wiki-draft-saved"><Check size={15} />{savedContentStatus(entry.saved)}</span>
        : <button type="button" className="icon-only" disabled={busy} aria-label={`移除待保存内容 ${index + 1}`} onClick={onRemove}><X size={15} /></button>}
    </header>
    {image || video ? <div className="wiki-draft-image"><div>{video ? <Video size={26} /> : preview && !previewFailed ? <img src={preview} alt={entry.file.name} onError={() => setPreviewFailed(true)} /> : <ImageIcon size={26} />}</div>
      <p><span>{entry.file.name}</span><small>{video ? `${(entry.file.size / 1024 / 1024).toFixed(1)} MiB` : `${(entry.file.size / 1024).toFixed(1)} KB`}</small></p></div>
      : <textarea id={`draft-${entry.key}`} aria-label="文字" rows={3} maxLength={maxElementBody} value={entry.body} disabled={disabled} autoFocus
        placeholder="输入一段文字，或直接粘贴图片…" onChange={(event) => onChange({ body: event.target.value, error: "" })} />}
    <details className="wiki-draft-tags" onToggle={(event) => setShowTags(event.currentTarget.open)}>
      <summary>单独加标签{entry.tags.tags.length ? ` · ${entry.tags.tags.join("、")}` : ""}</summary>
      {showTags && <TagInput label="此项标签" value={entry.tags} disabled={disabled} onChange={(tags) => onChange({ tags, error: "" })} />}
    </details>
    {saving && <p className="wiki-muted" role="status">正在保存这项内容…</p>}
    {entry.error && <p className="wiki-error" role="alert">{entry.error}</p>}
  </article>;
}
