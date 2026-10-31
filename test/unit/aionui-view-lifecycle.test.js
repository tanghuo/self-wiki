import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAionuiView } from '../../src/main/aionuiView.js';

// Electron's destroyed BrowserWindow throws from its native accessors.
function fakeWindow() {
  const window = new EventEmitter(), contents = new EventEmitter();
  let destroyed = false;
  const children = new Set();
  contents.isDestroyed = () => destroyed;
  contents.getZoomFactor = () => { if (destroyed) throw new TypeError('Object has been destroyed'); return 1; };
  Object.defineProperty(window, 'webContents', { get() { if (destroyed) throw new TypeError('Object has been destroyed'); return contents; } });
  Object.defineProperty(window, 'contentView', { get() { if (destroyed) throw new TypeError('Object has been destroyed'); return { addChildView: view => children.add(view), removeChildView: view => children.delete(view) }; } });
  window.isDestroyed = () => destroyed;
  window.getContentSize = () => { if (destroyed) throw new TypeError('Object has been destroyed'); return [1200, 800]; };
  window.destroy = () => { destroyed = true; window.emit('closed'); };
  return { window, contents, children };
}
class FakeView {
  constructor() {
    const webContents = new EventEmitter(); let closed = false;
    Object.assign(webContents, { isDestroyed: () => closed, close: () => { closed = true; }, setWindowOpenHandler() {}, loadURL: async () => {},
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, cookies: { set: async () => {} } } });
    this.webContents = webContents; this.visible = false;
  }
  setVisible(value) { this.visible = value; }
  setBounds(value) { this.bounds = value; }
}
const bounds = { x: 10, y: 10, width: 400, height: 300 };
function stubFetch(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ url: 'http://127.0.0.1:4567' }), { headers: { 'content-type': 'application/json', 'set-cookie': 'aionui-session=x; Path=/; HttpOnly' } });
  t.after(() => { globalThis.fetch = original; });
}

test('closing after the main window is destroyed does not throw and is idempotent', () => {
  const { window } = fakeWindow();
  const view = createAionuiView({ WebContentsView: FakeView, window, shell: {}, backend: { url: 'http://127.0.0.1:1' } });
  window.once('closed', () => view.close());
  assert.doesNotThrow(() => window.destroy());
  assert.doesNotThrow(() => view.close());
  assert.doesNotThrow(() => view.hide());
  assert.doesNotThrow(() => view.setBounds(bounds));
  window.emit('resize');
});

test('an embedded view is detached and closed, and late resize/navigation after destruction is ignored', async t => {
  stubFetch(t);
  const { window, contents, children } = fakeWindow();
  const view = createAionuiView({ WebContentsView: FakeView, window, shell: { openExternal() {} }, backend: { url: 'http://127.0.0.1:1' } });
  await view.show(bounds);
  assert.equal(children.size, 1);
  const [child] = children;
  assert.equal(child.visible, true);
  contents.emit('did-navigate-in-page', {}, 'http://127.0.0.1/#workbench', true);
  assert.equal(child.visible, false);
  view.close();
  assert.equal(children.size, 0);
  assert.equal(child.webContents.isDestroyed(), true);
  window.destroy();
  assert.doesNotThrow(() => { window.emit('resize'); contents.emit('did-navigate-in-page', {}, 'http://127.0.0.1/#wiki', true); view.close(); });
});

test('a show that is still loading when the window closes rejects instead of touching the destroyed window', async t => {
  stubFetch(t);
  const { window } = fakeWindow();
  const view = createAionuiView({ WebContentsView: FakeView, window, shell: {}, backend: { url: 'http://127.0.0.1:1' } });
  window.once('closed', () => view.close());
  const pending = view.show(bounds);
  window.destroy();
  await assert.rejects(pending, /已关闭/);
  await assert.rejects(view.show(bounds), /正在关闭/);
});
