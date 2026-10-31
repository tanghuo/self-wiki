export function createAionuiView({ WebContentsView, window, shell, backend }) {
  let view, opening, origin, loaded = false, visible = false, closed = false, bounds;
  function position() {
    if (!view || view.webContents.isDestroyed() || window.isDestroyed()) return;
    const [width, height] = window.getContentSize(), zoom = window.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(width, Math.round((bounds?.x || 0) * zoom)));
    const y = Math.max(0, Math.min(height, Math.round((bounds?.y || 0) * zoom)));
    const w = Math.max(0, Math.min(width - x, Math.round((bounds?.width || 0) * zoom)));
    const h = Math.max(0, Math.min(height - y, Math.round((bounds?.height || 0) * zoom)));
    view.setBounds({ x, y, width: w, height: h });
    view.setVisible(visible && loaded && w > 0 && h > 0);
  }
  function setBounds(value) {
    if (!value || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]) && Math.abs(value[key]) < 100000)) throw new Error('内嵌区域尺寸无效');
    bounds = value; position();
  }
  async function show(value) {
    if (closed) throw new Error('实验页面正在关闭');
    visible = true; setBounds(value);
    return opening ||= (async () => {
      const response = await fetch(new URL('/api/aionui/start', backend.url), { method: 'POST', headers: { cookie: backend.localCookie } });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error || 'AionUi 启动失败');
      const address = new URL(state.url);
      if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port) throw new Error('实验版地址无效');
      if (closed || window.isDestroyed()) throw new Error('实验页面已关闭');
      if (!view) {
        view = new WebContentsView({ webPreferences: { partition: 'self-wiki-aionui-experiment', contextIsolation: true, nodeIntegration: false, sandbox: true } });
        view.setVisible(false); window.contentView.addChildView(view);
        const external = url => { if (/^https?:/.test(url)) void shell.openExternal(url); };
        view.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
        view.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); external(url); } });
        const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
        view.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => { callback(allowed.has(permission) && details.isMainFrame !== false && details.requestingUrl?.startsWith(origin + '/')); });
        view.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowed.has(permission) && requestingOrigin === origin);
        view.webContents.on('render-process-gone', () => { loaded = false; position(); });
      }
      for (const cookie of response.headers.getSetCookie()) {
        const first = cookie.split(';')[0], at = first.indexOf('='), name = first.slice(0, at);
        if (!['aionui-session', 'aionui-refresh'].includes(name)) continue;
        await view.webContents.session.cookies.set({ url: address.origin, name, value: first.slice(at + 1), path: /;\s*Path=([^;]+)/i.exec(cookie)?.[1] || '/', httpOnly: true, sameSite: 'lax' });
      }
      if (!loaded || origin !== address.origin) {
        loaded = false; origin = address.origin; position();
        await view.webContents.loadURL(new URL('/guid', address).href); loaded = true;
      }
      if (!closed) position();
      return state;
    })().catch(error => { visible = false; position(); throw error; }).finally(() => { opening = null; });
  }
  const hide = () => { visible = false; position(); };
  const navigate = (_event, url, isMainFrame) => { if (isMainFrame && new URL(url).hash !== '#aionui') hide(); };
  window.webContents.on('did-navigate-in-page', navigate); window.on('resize', position);
  return { show, hide, setBounds, close() {
    closed = true; visible = false;
    window.webContents.off('did-navigate-in-page', navigate); window.off('resize', position);
    if (view) {
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
      view = null;
    }
  } };
}
