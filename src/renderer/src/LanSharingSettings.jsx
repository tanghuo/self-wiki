import { useEffect, useState } from "react";
import { Copy, Wifi } from "lucide-react";
import { request } from "./api.js";

export default function LanSharingSettings({ onBusyChange, onDirtyChange }) {
  const [status, setStatus] = useState(null);
  const [port, setPort] = useState(8766);
  const [autoStart, setAutoStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function apply(value) { setStatus(value); setPort(value.port); setAutoStart(value.autoStart); }
  async function load() {
    try { apply(await request("/api/lan-sharing")); setError(""); }
    catch (failure) { setError(failure.message); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const dirty = Boolean(status && (Number(port) !== status.port || autoStart !== status.autoStart));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  async function update(toggle) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      // Turning sharing off must work even when the unsaved form is invalid.
      if (toggle && status.enabled) apply(await request("/api/lan-sharing", { method: "POST", body: JSON.stringify({ enabled: false }) }));
      else {
        apply(await request("/api/lan-sharing", { method: "PUT", body: JSON.stringify({ port: Number(port), autoStart }) }));
        if (toggle) apply(await request("/api/lan-sharing", { method: "POST", body: JSON.stringify({ enabled: true }) }));
        else setMessage("配置已保存");
      }
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function copy(url) {
    setError(""); setMessage("");
    try { await navigator.clipboard.writeText(url); setMessage("访问地址已复制"); }
    catch { setError("复制失败，请选中地址手动复制"); }
  }
  return <section className="settings-section" aria-labelledby="lan-sharing-heading">
    <header className="settings-section-header"><Wifi size={19} /><h3 id="lan-sharing-heading">局域网共享</h3></header>
    <div className="wiki-form-fields lan-sharing-fields">
      <p>开启后，同一局域网内知道地址的人无需登录，即可使用与本机相同的全部功能，包括编辑、删除、回收站、Agent 会话和设置。</p>
      {!status && !error && <p role="status">正在读取设置…</p>}
      {status && <>
        <div className="lan-sharing-state"><strong>{status.enabled ? "共享已开启" : "共享已关闭"}</strong><button role="switch" aria-label="局域网共享开关" aria-checked={status.enabled} onClick={() => update(true)} disabled={busy}>{status.enabled ? "关闭共享" : "开启共享"}</button></div>
        <section className="lan-sharing-addresses" aria-label="局域网访问地址">
          <strong>局域网访问地址（IP + 端口）</strong>
          {status.urls.map((url) => <div className="lan-sharing-address" key={url}>
            <input aria-label={`访问地址 ${url}`} value={url} readOnly onFocus={(event) => event.target.select()} />
            <button onClick={() => copy(url)}><Copy size={15} />复制地址</button>
          </div>)}
          {!status.urls.length && <p>未发现局域网 IPv4 地址，请连接 Wi-Fi 或有线网络后重新打开设置。</p>}
          <p className="wiki-muted">{status.enabled ? "复制到同一网络的其他设备浏览器中打开。" : "共享尚未开启；可以先复制地址，开启共享后才能访问。"}</p>
          {Number(port) !== status.port && <p className="wiki-muted">以上为已保存端口的地址，保存共享配置后更新。</p>}
        </section>
        <details className="settings-advanced">
        <summary>高级设置<span>端口与启动选项</span></summary>
        <div className="settings-advanced-content">
        <label>访问端口<input type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} disabled={busy || status.enabled} /></label>
        <label className="lan-sharing-checkbox"><input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} disabled={busy} />启动 App 时自动开启共享</label>
        <p className="wiki-muted">即时开关只控制本次运行；自动开启选项需保存后生效。修改端口前请先关闭共享。</p>
        <button className="primary" disabled={busy} onClick={() => update(false)}>{busy ? "正在处理…" : "保存共享配置"}</button>
        </div>
        </details>
        {status.enabled && <p className="wiki-muted">设备需连接同一网络；Windows 防火墙需允许此端口的专用网络入站访问。</p>}
        {status.error && !error && <p className="wiki-error" role="alert">{status.error}</p>}
      </>}
      {error && <p className="wiki-error" role="alert">{error}{!status && <button onClick={load}>重试</button>}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </section>;
}
