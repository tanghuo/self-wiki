import { useEffect, useRef, useState } from 'react';
import { Bot, MessageCircle } from 'lucide-react';
import { request } from '../../api.js';
import AgentShell from '../../ui/AgentShell.jsx';
import PageHeader from '../../ui/PageHeader.jsx';
import './aionui.css';

export default function AionuiExperiment({ active = true, occluded = false }) {
  const surface = useRef(null), mounted = useRef(false), launching = useRef(null);
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const embed = window.wikiDesktop?.embedAionui;
  const measure = () => {
    const rect = surface.current.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function launch() {
    if (launching.current) {
      if (embed) void embed({ type: 'show', bounds: measure() }).catch(() => {});
      return launching.current;
    }
    setBusy(true); setError('');
    launching.current = (async () => {
      if (embed) await embed({ type: 'show', bounds: measure() });
      else if (!url) {
        const status = await request('/api/aionui/start', { method: 'POST' });
        const address = new URL('/guid', status.url);
        address.hostname = window.location.hostname;
        if (mounted.current) setUrl(address.href);
      }
    })().catch(error => { if (mounted.current) setError(error.message); }).finally(() => {
      launching.current = null;
      if (mounted.current) setBusy(false);
    });
    return launching.current;
  }
  useEffect(() => {
    if (!active || occluded) { void embed?.({ type: 'hide' })?.catch(() => {}); return; }
    void launch();
    const update = () => { if (embed) void embed({ type: 'bounds', bounds: measure() }).catch(() => {}); };
    const observer = new ResizeObserver(update);
    observer.observe(surface.current);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); void embed?.({ type: 'hide' })?.catch(() => {}); };
  }, [active, occluded]);
  // Same AgentShell as Agent 对话 and the workbench. AionUi keeps its own conversations inside the
  // embedded app, so the left column links the other Agent surfaces instead of listing sessions.
  return <main className="aionui-experiment" aria-label="AionUi 内嵌工作台">
    <AgentShell className="aionui-shell" sessionsLabel="Agent 会话入口" resourcesLabel="AionUi 连接"
      sessions={<>
        <a className="nav-item" href="#agent"><MessageCircle size={16} /><span>Agent 对话</span></a>
        <a className="nav-item" href="#workbench"><Bot size={16} /><span>Agent 工作台</span></a>
        <p className="agent-shell-empty">AionUi 的会话列表在中间的内嵌窗口里。</p>
      </>}
      header={<PageHeader className="aionui-experiment-toolbar" title="AionUi 实验版" subtitle="Google 官方 ACP · 本机 CLI" />}
      resources={<>
        <h3>连接</h3>
        <p className="agent-shell-empty">{busy ? '正在连接…' : error ? '未连接' : embed || url ? '已连接本机 AionUi' : '等待连接'}</p>
        <a className="text-button" href="#workbench">切换原工作台</a>
      </>}>
      <div className="aionui-experiment-surface" ref={surface}>
        {busy && <p className="aionui-experiment-message" role="status">正在连接 AionUi，首次启动需要检测本机引擎…</p>}
        {error && <div className="aionui-experiment-message"><p role="alert">{error}</p><button onClick={launch} disabled={busy}>重新连接</button></div>}
        {!embed && url && <iframe title="AionUi 工作台" src={url} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox" />}
      </div>
    </AgentShell>
  </main>;
}
