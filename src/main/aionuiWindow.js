export function createAionuiWindow({ BrowserWindow, shell, backend, parent }) {
  let window, opening;
  async function open() {
    return opening ||= (async () => {
      const response = await fetch(new URL('/api/aionui/start', backend.url), { method: 'POST', headers: { cookie: backend.localCookie } });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error || 'AionUi 启动失败');
      const address = new URL(state.url);
      if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port) throw new Error('实验版地址无效');
      if (window && !window.isDestroyed()) {
        if (new URL(window.webContents.getURL()).origin === address.origin) { window.show(); window.focus(); return state; }
        window.destroy();
      }
      const current = new BrowserWindow({
        width: 1440, height: 960, minWidth: 960, minHeight: 680,
        title: 'AionUi 实验版 · self-wiki', show: false, parent,
        webPreferences: { partition: 'self-wiki-aionui-experiment', contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      window = current;
      current.setMenu(null);
      const external = value => { if (/^https?:/.test(value)) void shell.openExternal(value); };
      current.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
      current.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== address.origin) { event.preventDefault(); external(url); }
      });
      current.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
        callback(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission) && details.isMainFrame !== false && details.requestingUrl?.startsWith(address.origin + '/'));
      });
      try {
        for (const cookie of response.headers.getSetCookie()) {
          const first = cookie.split(';')[0], at = first.indexOf('=');
          const name = first.slice(0, at);
          if (!['aionui-session', 'aionui-refresh'].includes(name)) continue;
          const cookiePath = /;\s*Path=([^;]+)/i.exec(cookie)?.[1] || '/';
          await current.webContents.session.cookies.set({ url: address.origin, name, value: first.slice(at + 1), path: cookiePath, httpOnly: true, sameSite: 'lax' });
        }
        await current.loadURL(new URL('/guid', address).href);
        if (!current.isDestroyed()) { current.show(); current.focus(); }
        return state;
      } catch (error) { if (!current.isDestroyed()) current.destroy(); throw error; }
    })().finally(() => { opening = null; });
  }
  return { open, close() { if (window && !window.isDestroyed()) window.destroy(); } };
}
