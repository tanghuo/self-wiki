import { useEffect, useState } from "react";
import { Copy, Wifi } from "lucide-react";
import { request } from "./api.js";
import QrCode from "./QrCode.jsx";

export default function LanSharingSettings({ onBusyChange, onDirtyChange }) {
  const [status, setStatus] = useState(null);
  const [port, setPort] = useState(8766);
  const [autoStart, setAutoStart] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);
  const [requireToken, setRequireToken] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function apply(value) { setStatus(value); setPort(value.port); setAutoStart(value.autoStart); setAllowWrite(value.allowWrite); setRequireToken(value.requireToken); }
  async function load() {
    try { apply(await request("/api/lan-sharing")); setError(""); }
    catch (failure) { setError(failure.message); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const dirty = Boolean(status && (Number(port) !== status.port || autoStart !== status.autoStart || allowWrite !== status.allowWrite || requireToken !== status.requireToken));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  async function update(toggle) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      // Turning sharing off must work even when the unsaved form is invalid.
      if (toggle && status.enabled) apply(await request("/api/lan-sharing", { method: "POST", body: JSON.stringify({ enabled: false }) }));
      else {
        apply(await request("/api/lan-sharing", { method: "PUT", body: JSON.stringify({ port: Number(port), autoStart, allowWrite, requireToken }) }));
        if (toggle) apply(await request("/api/lan-sharing", { method: "POST", body: JSON.stringify({ enabled: true }) }));
        else setMessage("配置已保存");
      }
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function regenerate() {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { apply(await request("/api/lan-sharing/token", { method: "POST", body: "{}" })); setMessage("已更换配对码，已配对的设备需要重新配对"); }
    catch (failure) { setError(failure.message); }
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
      <p>开启后，同一局域网内的设备打开下方地址，输入 6 位数字配对码即可访问。默认只读；Agent 会话、自动整理、视频分析和全部设置始终仅限本机使用。</p>
      {!status && !error && <p role="status">正在读取设置…</p>}
      {status && <>
        <div className="lan-sharing-state"><strong>{status.enabled ? "共享已开启" : "共享已关闭"}</strong><button role="switch" aria-label="局域网共享开关" aria-checked={status.enabled} onClick={() => update(true)} disabled={busy}>{status.enabled ? "关闭共享" : "开启共享"}</button></div>
        <section className="lan-sharing-addresses" aria-label="局域网访问地址">
          <strong>局域网访问地址（IP + 端口）</strong>
          {status.urls.map((url) => <div className="lan-sharing-address" key={url}>
            <input aria-label={`访问地址 ${url}`} value={url} readOnly onFocus={(event) => event.target.select()} />
            <button onClick={() => copy(url)}><Copy size={15} />复制地址</button>
          </div>)}
          {(status.pairUrls || status.urls)[0] && <div className="lan-sharing-qr-block">
            <p><strong>用手机扫这个码即可打开</strong></p>
            <QrCode value={(status.pairUrls || status.urls)[0]} label="局域网配对二维码" />
            <p className="wiki-muted">手机需与电脑在同一 Wi-Fi；扫码后浏览器会记住本机。</p>
          </div>}
          {status.requireToken && <p className="wiki-muted">6 位配对码：<code>{status.pairingCode}</code>（在 Mac 或其他电脑打开上方地址后输入，浏览器会记住此设备）<button disabled={busy} onClick={regenerate}>更换配对码</button></p>}
          {!status.urls.length && <p>未发现局域网 IPv4 地址，请连接 Wi-Fi 或有线网络后重新打开设置。</p>}
          <p className="wiki-muted">{status.enabled ? "也可复制地址到同一网络的其他设备浏览器中打开。" : "共享尚未开启；可以先扫码或复制地址，开启共享后才能访问。"}</p>
          {Number(port) !== status.port && <p className="wiki-muted">以上为已保存端口的地址，保存共享配置后更新。</p>}
        </section>
        <details className="settings-advanced">
        <summary>高级设置<span>端口、编辑权限与启动选项</span></summary>
        <div className="settings-advanced-content">
        <label>访问端口<input type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} disabled={busy || status.enabled} /></label>
        <label className="lan-sharing-checkbox"><input type="checkbox" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} disabled={busy} />允许局域网设备编辑内容（新增、修改、删除、回收站）</label>
        <label className="lan-sharing-checkbox"><input type="checkbox" checked={!requireToken} onChange={(event) => setRequireToken(!event.target.checked)} disabled={busy} />不要求配对码（同一网络的任何设备都能访问，不推荐）</label>
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
