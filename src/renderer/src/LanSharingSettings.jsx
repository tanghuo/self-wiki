import { useEffect, useState } from "react";
import { Copy, Wifi } from "lucide-react";
import { request } from "./api.js";
import QrCode from "./QrCode.jsx";
import { Button } from "./ui/Button.jsx";

export default function LanSharingSettings({ onBusyChange, onDirtyChange, registerSave }) {
  const [status, setStatus] = useState(null);
  const [port, setPort] = useState(8766);
  const [autoStart, setAutoStart] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);
  const [requireToken, setRequireToken] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  function apply(value) { setStatus(value); setPort(value.port); setAutoStart(value.autoStart); setAllowWrite(value.allowWrite); setRequireToken(value.requireToken); }
  async function load() {
    try { apply(await request("/api/lan-sharing")); setError(""); }
    catch (failure) { setError(failure.message); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()); }, 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const dirty = Boolean(status && (Number(port) !== status.port || autoStart !== status.autoStart || allowWrite !== status.allowWrite || requireToken !== status.requireToken));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { registerSave?.(dirty ? { save: () => update(), discard: () => apply(status) } : null); });
  useEffect(() => () => registerSave?.(null), [registerSave]);
  // The switch only turns sharing on or off with the saved configuration; it never submits the form below.
  // Unsaved edits stay in the form (and in the settings save bar) until the user saves them.
  async function toggle() {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await request("/api/lan-sharing", { method: "POST", body: JSON.stringify({ enabled: !status.enabled }) });
      if (dirty) { setStatus(next); if (next.enabled) setMessage("已按已保存的配置开启共享；下方改动保存后生效"); }
      else apply(next);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function update() {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      apply(await request("/api/lan-sharing", { method: "PUT", body: JSON.stringify({ port: Number(port), autoStart, allowWrite, requireToken }) }));
      setMessage("配置已保存");
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
  async function beginPairing() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { apply(await request('/api/lan-sharing/pairing', { method: 'POST', body: '{}' })); setNow(Date.now()); }
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
      {!status && !error && <p role="status">正在读取设置…</p>}
      {status && <>
        <div className="lan-sharing-state"><strong>{status.enabled ? "共享已开启" : "共享已关闭"}</strong><button role="switch" aria-label="局域网共享开关" aria-checked={status.enabled} onClick={toggle} disabled={busy}>{status.enabled ? "关闭共享" : "开启共享"}</button></div>
        <section className="lan-sharing-addresses" aria-label="局域网访问地址">
          <strong>局域网访问地址（IP + 端口）</strong>
          {status.urls.map((url) => <div className="lan-sharing-address" key={url}>
            <input aria-label={`访问地址 ${url}`} value={url} readOnly onFocus={(event) => event.target.select()} />
            <button onClick={() => copy(url)}><Copy size={15} />复制地址</button>
          </div>)}
          {(status.pairUrls || status.urls)[0] && <div className="lan-sharing-qr-block">
            <p><strong>用手机扫这个码即可打开</strong></p>
            <QrCode value={(status.pairUrls || status.urls)[0]} label="局域网配对二维码" />
          </div>}
          {status.requireToken && <div className="wiki-muted">{status.pairingExpiresAt > now && <p>6 位配对码：<code>{status.pairingCode}</code>（{Math.ceil((status.pairingExpiresAt - now) / 60000)} 分钟内有效，仅可使用一次）</p>}<button disabled={busy} onClick={beginPairing}>生成 10 分钟配对码</button><button disabled={busy} onClick={regenerate}>更换配对码</button></div>}
          {!status.urls.length && <p>未发现局域网 IPv4 地址，请连接 Wi-Fi 或有线网络后重新打开设置。</p>}
          {Number(port) !== status.port && <p className="wiki-muted">以上为已保存端口的地址，保存共享配置后更新。</p>}
        </section>
        <details className="settings-advanced">
        <summary>高级设置<span>端口、编辑权限与启动选项</span></summary>
        <div className="settings-advanced-content">
        <label>访问端口<input type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} disabled={busy || status.enabled} /></label>
        <label className="lan-sharing-checkbox"><input type="checkbox" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} disabled={busy} />允许局域网设备编辑内容（添加、修改、删除、回收站）</label>
        <label className="lan-sharing-checkbox"><input type="checkbox" checked={!requireToken} onChange={(event) => setRequireToken(!event.target.checked)} disabled={busy} />不要求配对码（同一网络的任何设备都能访问，不推荐）</label>
        <label className="lan-sharing-checkbox"><input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} disabled={busy} />启动 App 时自动开启共享</label>
        <p className="wiki-muted">上方开关立即生效，只控制本次运行；这里的选项改完后点底部「保存」生效。修改端口前请先关闭共享。</p>
        {!registerSave && <Button variant="primary" type="submit" disabled={busy} onClick={() => update()}>{busy ? "正在处理…" : "保存共享配置"}</Button>}
        </div>
        </details>
        {status.error && !error && <p className="wiki-error" role="alert">{status.error}</p>}
      </>}
      {error && <p className="wiki-error" role="alert">{error}{!status && <button onClick={load}>重试</button>}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </section>;
}
