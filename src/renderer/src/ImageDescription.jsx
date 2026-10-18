import { useEffect, useRef, useState } from "react";
import { Pencil, RotateCw, Save } from "lucide-react";
import { request } from "./api.js";

export default function ImageDescription({ id, revision, disabled, readOnly, onBusyChange, onChanged }) {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [editing, setEditing] = useState(null), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  const previous = useRef(null);
  const endpoint = `/api/elements/${id}/description`;
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const controller = new AbortController(), current = ++sequence.current;
    request(endpoint, { signal: controller.signal }).then(
      (value) => { if (current === sequence.current && !controller.signal.aborted) { setData(value); setError(""); } },
      (failure) => { if (current === sequence.current && !controller.signal.aborted) setError(failure.message); },
    );
    return () => controller.abort();
  }, [endpoint, revision, refresh]);
  useEffect(() => {
    if (!data?.generating) return;
    const timer = setTimeout(() => setRefresh((value) => value + 1), 1000);
    return () => clearTimeout(timer);
  }, [data, refresh]);
  useEffect(() => {
    const before = previous.current; previous.current = data;
    if (before?.generating && data && !data.generating && before.revision !== data.revision) onChanged();
  }, [data, onChanged]);
  async function change(regenerate = false) {
    if (busy || disabled || !data) return;
    sequence.current++; setBusy(true); setError("");
    try {
      const value = await request(regenerate ? `${endpoint}/regenerate` : endpoint, {
        method: regenerate ? "POST" : "PATCH",
        body: JSON.stringify(regenerate ? { revision: data.revision } : { revision: editing.revision, description: editing.text }),
      });
      setData(value);
      if (!regenerate) { setEditing(null); onChanged(); }
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <section className="wiki-image-description" aria-label="图片说明">
    <header><h2>图片说明</h2>{data && !readOnly && !editing && <div className="wiki-actions">
      <button className="text-button" disabled={busy || disabled} onClick={() => setEditing({ text: data.description, revision: data.revision })}><Pencil size={14} />修改说明</button>
      <button className="text-button" aria-label="重新识别" disabled={busy || disabled || data.generating} onClick={() => change(true)}><RotateCw size={14} />{data.generating ? "正在识别…" : "重新识别"}</button>
    </div>}</header>
    {editing ? <form onSubmit={(event) => { event.preventDefault(); void change(); }}>
      <label>图片说明<textarea aria-label="图片说明内容" rows={7} maxLength={2000} value={editing.text} disabled={busy || disabled} onChange={(event) => setEditing({ ...editing, text: event.target.value })} /></label>
      <div className="wiki-image-description-footer"><small>{editing.text.length} / 2000</small><div className="wiki-actions">
        <button type="button" disabled={busy || disabled} onClick={() => setEditing(null)}>取消修改</button>
        <button className="primary" disabled={busy || disabled || !editing.text.trim()}><Save size={14} />{busy ? "正在保存…" : "保存说明"}</button>
      </div></div>
    </form> : data ? <>
      {data.description ? <p className="wiki-image-description-text">{data.description}</p> : <p className="wiki-muted">暂无图片说明。</p>}
      {(data.manual || data.model) && <p className="wiki-muted">{data.manual ? "已手动修改" : `识别模型：${data.model}`}</p>}
    </> : !error && <p className="wiki-muted" role="status">正在读取图片说明…</p>}
    {data?.generating && <p className="wiki-muted" role="status">正在识别图片，完成后更新说明。</p>}
    {!editing && data && !data.generating && <p className="wiki-muted">说明会用于搜索、标签和关联。重新识别会调用模型，成功后替换当前说明。</p>}
    {(error || data?.error) && <p className="wiki-error" role="alert">{error || data.error}<button className="text-button" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>刷新说明</button></p>}
  </section>;
}
