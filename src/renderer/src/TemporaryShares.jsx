import { useCallback, useEffect, useState } from "react";
import { Download, File, Folder, Share2, X } from "lucide-react";
import { apiUrl, request } from "./api.js";
import QrCode from "./QrCode.jsx";
import { openSettings } from "./openSettings.js";
import "./temporaryShares.css";
import { EmptyState, PageHeader } from "./ui/index.js";

const bytes = (size) => size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : size < 1024 ** 3 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${(size / 1024 ** 3).toFixed(1)} GB`;

export default function TemporaryShares({ local }) {
  const [items, setItems] = useState([]), [lan, setLan] = useState(null);
  const [sourcePath, setSourcePath] = useState(""), [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(null), [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    if (!local) return;
    const result = await request("/api/temporary-shares");
    setItems(result.shares);
    if (local) setLan(await request("/api/lan-sharing"));
  }, [local]);
  useEffect(() => {
    let disposed = false;
    const update = () => { if (!disposed) refresh().catch((failure) => { if (!disposed) setError(failure.message); }).finally(() => { if (!disposed) setLoading(false); }); };
    update(); const timer = setInterval(update, 10_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [refresh]);
  async function pick(kind) {
    try { const value = await window.wikiDesktop.pickShareSource(kind); if (value) setSourcePath(value); }
    catch (failure) { setError(failure.message); }
  }
  async function create(event) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const item = await request("/api/temporary-shares", { method: "POST", body: JSON.stringify({ sourcePath, hours }) });
      setSourcePath(""); setNotice(`“${item.name}”已准备好`); await refresh();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function cancel(item) {
    setBusy(true); setError("");
    try { await request(`/api/temporary-shares/${item.id}`, { method: "DELETE" }); if (selected === item.id) setSelected(null); await refresh(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  function shareUrl(item) {
    const base = lan?.urls?.[0];
    if (!base || !item.shareToken) return "";
    const url = new URL(`/share/${item.id}`, base); url.searchParams.set("token", item.shareToken); return url.href;
  }
  async function copy(item) {
    try { await navigator.clipboard.writeText(shareUrl(item)); setNotice("已复制分享链接"); }
    catch { setNotice("请复制下方链接"); }
    setSelected(item.id);
  }
  const focused = new URLSearchParams(window.location.hash.split("?")[1] || "").get("item");
  const sorted = [...items].sort((a, b) => Number(b.id === focused) - Number(a.id === focused));
  return <main id="main-content" className="temporary-shares">
    <PageHeader title="临时分享" subtitle={local ? "在同一局域网的设备之间传文件。到期或退出应用后自动失效。" : "请使用分享者提供的独立下载链接或二维码获取文件。"} />
    {local && <form className="share-create" onSubmit={create}>
      <h2>分享文件或目录</h2>
      {window.wikiDesktop?.pickShareSource && <div className="share-actions"><button type="button" disabled={busy} onClick={() => pick("file")}><File size={16} />选择文件</button><button type="button" disabled={busy} onClick={() => pick("directory")}><Folder size={16} />选择目录</button></div>}
      <label>本机文件或目录路径<input required value={sourcePath} disabled={busy} onChange={(event) => setSourcePath(event.target.value)} placeholder="输入本机绝对路径，或使用上方选择按钮" /></label>
      <div className="share-actions"><label>有效期<select value={hours} disabled={busy} onChange={(event) => setHours(Number(event.target.value))}><option value={1}>1 小时</option><option value={24}>24 小时</option><option value={168}>7 天</option></select></label><button className="primary" disabled={busy || !sourcePath.trim()}>{busy ? "正在处理，请稍候…" : "创建临时分享"}</button></div>
      <p className="wiki-muted">文件会复制到临时空间；单个文件和目录内容均须小于 4 GB，目录打包为 ZIP（不压缩）。准备完成后可下载，源文件会保留。退出应用即失效。</p>
    </form>}
    {local && !lan?.enabled && <p className="share-lan-hint">局域网共享尚未开启，其他设备暂时打不开分享链接。<button className="text-button button-sm" onClick={() => openSettings("sharing")}>去设置开启</button></p>}
    {error && <p className="wiki-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">正在加载分享…</p> : !items.length && <EmptyState icon={Share2} title="还没有临时分享">{local ? "选择文件或目录，创建一个临时分享。" : "在本机创建分享后即可在这里下载。"}</EmptyState>}
    <div className="share-list">{sorted.map((item) => <article className="share-card" key={item.id} data-focused={item.id === focused}>
      <div className="share-card-title"><File size={22} /><h2>{item.name}</h2></div>
      <p className="wiki-muted">{bytes(item.size)} · 到期：{new Date(item.expiresAt).toLocaleString()}</p>
      <div className="share-actions"><a className="button share-download" href={apiUrl(item.downloadUrl)} download><Download size={16} />下载</a>
        {local && <><button disabled={!lan?.enabled || !shareUrl(item)} title={!lan?.enabled ? "先在「设置 → 局域网共享」里开启共享" : undefined} onClick={() => copy(item)}>复制链接 / 二维码</button><button className="danger-quiet" disabled={busy} onClick={() => cancel(item)}><X size={16} />取消分享</button></>}
      </div>
      {local && selected === item.id && lan?.enabled && <div className="share-link"><QrCode value={shareUrl(item)} label="临时分享二维码" /><input aria-label="分享链接" readOnly value={shareUrl(item)} onFocus={(event) => event.target.select()} /><p className="wiki-muted">同一网络内打开链接即可下载此文件；到期或取消后链接失效。</p></div>}
    </article>)}</div>
  </main>;
}
