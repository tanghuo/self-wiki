import { useEffect, useId, useRef, useState } from "react";
import { request } from "./api.js";
import useWikiResource from "./useWikiResource.js";
import { vocabularyAlias } from "../../shared/domain/vocabulary.js";

const empty = { alias: "", canonical: "", aliasReverse: "", canonicalReverse: "", direction: "symmetric" };
const termLabel = (name, reverse) => reverse ? `${name} / ${reverse}` : name;

export default function VocabularySettings({ onChanged, onBusyChange }) {
  const [kind, setKind] = useState("tag"), [form, setForm] = useState(empty), [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0), [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const data = useWikiResource("/api/vocabulary", revision), listId = useId(), formRef = useRef(null);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const terms = data.data?.[kind === "tag" ? "tags" : "relations"] || [];
  const aliases = (data.data?.aliases || []).filter((rule) => rule.kind === kind);
  const choices = terms.filter((t) => kind === "tag" || t.direction === form.direction);
  const source = choices.find((t) => t.name.toLowerCase() === form.alias.trim().toLowerCase() && (kind === "tag" || t.reverseName === form.aliasReverse.trim()));
  const matches = terms.filter((t) => [t.name, t.reverseName, t.canonicalName].some((v) => v?.toLowerCase().includes(search.trim().toLowerCase())));
  function change(next) { setForm(next); setPreview(null); setError(""); setMessage(""); }
  async function mutate(path, method, body) {
    setBusy(true); setError(""); setMessage("");
    try {
      await request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      setRevision((n) => n + 1); setPreview(null); onChanged?.();
      setMessage(method === "DELETE" ? "别名已解除，原始叫法已重新参与显示。" : "已统一名称，已有内容与后续新增均使用这条规则。");
      if (method !== "DELETE") setForm(empty);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  function review(event) {
    event.preventDefault(); setError("");
    try {
      const payload = vocabularyAlias({ kind, alias: { name: form.alias, ...(kind === "relation" ? { direction: form.direction, reverseName: form.aliasReverse } : {}) },
        canonical: { name: form.canonical, ...(kind === "relation" ? { direction: form.direction, reverseName: form.canonicalReverse } : {}) } });
      const left = JSON.stringify(payload.alias), right = JSON.stringify(payload.canonical);
      if (kind === "tag" ? left.toLowerCase() === right.toLowerCase() : left === right) throw new Error("请填写不同的别名与主名称");
      setPreview(payload);
    } catch (failure) { setError(failure.message); }
  }
  return <section className="vocabulary-settings" aria-labelledby="vocabulary-heading">
    <header className="vocabulary-heading"><h3 id="vocabulary-heading">名称与别名</h3>
          </header>
    <div className="vocabulary-tabs ui-segmented" role="group" aria-label="词表类别">{[["tag", "标签"], ["relation", "关联名称"]].map(([key, label]) =>
      <button type="button" key={key} aria-pressed={kind === key} disabled={busy} onClick={() => { setKind(key); change(empty); setSearch(""); }}>{label}</button>)}</div>
    {data.error && <p role="alert" className="wiki-error">{data.error}<button onClick={() => setRevision((n) => n + 1)}>重试</button></p>}
    {data.loading && <p className="wiki-muted">正在读取名称…</p>}
    <div className="vocabulary-section vocabulary-editor">
    <form ref={formRef} className="vocabulary-form" onSubmit={review}>
      <h4>添加别名</h4>
      {kind === "relation" && <><label>名称对的类型<select aria-label="名称对的类型" value={form.direction} disabled={busy} onChange={(e) => change({ ...empty, direction: e.target.value })}>
        <option value="symmetric">双向同名</option><option value="forward">有向名称对</option></select></label>
        </>}
      <div className="vocabulary-fields">
        <label>别名<input aria-label="别名" required maxLength={60} list={`${listId}-names`} value={form.alias} disabled={busy} placeholder={kind === "tag" ? "例如：Cyberpunk" : "已有的关联叫法"} onChange={(e) => {
          const name = e.target.value, term = choices.find((t) => t.name === name);
          change({ ...form, alias: name, ...(term && kind === "relation" ? { aliasReverse: term.reverseName } : {}) });
        }} /></label>
        <label>主名称<input aria-label="主名称" required maxLength={60} list={`${listId}-canonical`} value={form.canonical} disabled={busy} placeholder={kind === "tag" ? "例如：赛博朋克" : "统一采用的名称"} onChange={(e) => {
          const name = e.target.value, term = choices.find((t) => t.canonicalName === name);
          change({ ...form, canonical: name, ...(term && kind === "relation" ? { canonicalReverse: term.canonicalReverseName } : {}) });
        }} /></label>
        {kind === "relation" && form.direction === "forward" && <>
          <label>别名的反向名称<input aria-label="别名的反向名称" required maxLength={60} value={form.aliasReverse} disabled={busy} onChange={(e) => change({ ...form, aliasReverse: e.target.value })} /></label>
          <label>主名称的反向名称<input aria-label="主名称的反向名称" required maxLength={60} value={form.canonicalReverse} disabled={busy} onChange={(e) => change({ ...form, canonicalReverse: e.target.value })} /></label>
        </>}
      </div>
      <datalist id={`${listId}-names`}>{choices.map((t, i) => <option key={i} value={t.name}>{termLabel(t.name, t.reverseName)}</option>)}</datalist>
      <datalist id={`${listId}-canonical`}>{[...new Set(choices.map((t) => t.canonicalName))].map((name) => <option key={name} value={name} />)}</datalist>
      <div className="vocabulary-form-footer" style={{justifyContent:"flex-end"}}>
        <button type="submit" disabled={busy || data.loading || !data.data || !form.alias.trim() || !form.canonical.trim()}>预览归一</button>
      </div>
    </form>
    {preview && <div className="vocabulary-preview" role="region" aria-label="归一预览">
      <strong>{termLabel(preview.alias.name, preview.alias.reverseName)} → {termLabel(preview.canonical.name, preview.canonical.reverseName)}</strong>
      <p>{source?.count || 0} {kind === "tag" ? "条内容使用这个原始标签" : "条关联使用这个原始名称"}；指向这个别名的其他叫法也会一起归一。后续再使用该别名时会复用主名称。</p>
      {preview.alias.direction === "forward" && <p>A — {preview.alias.name} → B，将显示为 A — {preview.canonical.name} → B。<br />B — {preview.alias.reverseName} → A，将显示为 B — {preview.canonical.reverseName} → A。</p>}
      {source?.examples?.length > 0 && <ul>{source.examples.map((e) => <li key={e.id}>{e.label || `图片或内容 #${e.id}`}</li>)}</ul>}
      <p className="wiki-muted">原始记录会保留。解除规则后，未另行编辑或删除的记录可恢复原始叫法。</p>
      <button className="primary" disabled={busy} onClick={() => mutate("/api/vocabulary/aliases", "POST", preview)}>应用归一</button>
    </div>}
    </div>
    {error && <p className="wiki-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <section className="vocabulary-section" aria-label="已有别名">
    <header className="vocabulary-section-heading"><h4>已有别名</h4><span className="vocabulary-count">{aliases.length}</span></header>
    <div className="vocabulary-rules">{aliases.map((a) => <div className="vocabulary-row" key={a.id}>
      <span className="vocabulary-alias-pair"><span>{termLabel(a.alias, a.aliasReverseName)}</span><span className="wiki-muted">→</span><strong>{termLabel(a.canonical, a.canonicalReverseName)}</strong></span>
      <button disabled={busy} aria-label={`解除别名：${a.alias}`} onClick={() => mutate(`/api/vocabulary/aliases/${kind}/${a.id}`, "DELETE")}>解除</button>
    </div>)}{!aliases.length && !data.loading && <p className="wiki-muted">暂无别名规则。</p>}</div>
    </section>
    <section className="vocabulary-section" aria-label="名称使用情况">
    <header className="vocabulary-section-heading"><h4>名称使用情况</h4></header>
    <label className="vocabulary-search">查找名称<input aria-label="查找名称" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="查找已有名称或主名称…" /></label>
    <div className="vocabulary-inventory">{matches.slice(0, 100).map((t, i) => <div className="vocabulary-row" key={i}>
      <span><strong>{termLabel(t.name, t.reverseName)}</strong><small className="wiki-muted">{t.count} {kind === "tag" ? "条内容" : "条关联"}{t.name !== t.canonicalName || t.reverseName !== t.canonicalReverseName && kind === "relation" ? ` · 显示为 ${termLabel(t.canonicalName, t.canonicalReverseName)}` : ""}</small></span>
      <button disabled={busy} onClick={() => { change({ ...empty, alias: t.name, aliasReverse: t.reverseName || "", direction: t.direction || "symmetric" }); formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>设为别名</button>
    </div>)}{!matches.length && !data.loading && <p className="wiki-muted">没有匹配的名称，可在上方填写新叫法。</p>}</div>
    {matches.length > 100 && <p className="wiki-muted">显示前 100 个名称，请输入关键词缩小范围。</p>}
    </section>
  </section>;
}
