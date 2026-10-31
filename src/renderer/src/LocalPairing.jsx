import { useEffect, useState } from 'react';
import PageHeader from './ui/PageHeader.jsx';
import { Button } from './ui/Button.jsx';

const access = document.querySelector('meta[name="wiki-access"]')?.content;
const lanGuest = ['read-only', 'lan-edit'].includes(access);
let authentication;
async function authenticate() {
  if (lanGuest) return true;
  const fragment = /^#local-bootstrap=([\w-]+)$/.exec(location.hash);
  if (fragment) {
    // Remove the code before loading the application, including on failed redemption.
    history.replaceState(null, '', location.pathname + location.search);
    const response = await fetch('/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: fragment[1] }) });
    if (response.ok) return true;
  }
  if ((await fetch('/api/auth/session')).ok) return true;
  if (window.wikiDesktop?.pairLocal) return Boolean((await window.wikiDesktop.pairLocal()).ok);
  return false;
}

export default function LocalPairing({ children }) {
  const [ready, setReady] = useState(lanGuest), [checked, setChecked] = useState(lanGuest);
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    authentication ||= authenticate().catch(() => false);
    const apply = ok => { if (live) { setReady(ok); setChecked(true); } };
    authentication.then(apply);
    const onHash = () => {
      if (!location.hash.startsWith('#local-bootstrap=')) return;
      authentication = authenticate().catch(() => false); authentication.then(apply);
    };
    window.addEventListener('hashchange', onHash);
    return () => { live = false; window.removeEventListener('hashchange', onHash); };
  }, []);
  if (ready) return children;
  return <main className="local-pairing"><form onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const input = code.trim();
      const value = input.includes('#local-bootstrap=') ? input.slice(input.indexOf('#local-bootstrap=') + 17) : input;
      const response = await fetch('/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: value }) });
      if (!response.ok) throw new Error('配对码无效、已使用或已过期，请重新获取。');
      authentication = Promise.resolve(true); setCode(''); setReady(true);
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }}>
    <PageHeader title="连接本机 self-wiki" subtitle={checked ? '使用本机启动器打开，或在本机运行 self-wiki pair 获取一次性配对链接。' : '正在连接…'} />
    <label>一次性配对码或链接<input value={code} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck={false} required /></label>
    {error && <p role="alert">{error}</p>}
    <Button variant="primary" type="submit" disabled={busy || !checked || !code.trim()} title={busy ? '正在连接' : !checked ? '正在检测本机连接' : !code.trim() ? '请先填写一次性配对码或链接' : undefined}>连接</Button>
  </form></main>;
}
