import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAionuiView } from '../../src/main/aionuiView.js';

test('embedded view closes safely after its owner window has been destroyed', async t => {
  let destroyed = false, childClosed = false;
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, getZoomFactor: () => 1 });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed, getContentSize: () => [1000, 800],
    contentView: { addChildView() {}, removeChildView() { assert.fail('Cannot access a destroyed window'); } },
  });
  Object.defineProperty(window, 'webContents', { get() { if (destroyed) throw new Error('Object has been destroyed'); return contents; } });
  class View {
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => childClosed, setWindowOpenHandler() {},
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      async loadURL() {}, close() { childClosed = true; },
    });
    setVisible() {} setBounds() {}
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ url: 'http://127.0.0.1:1234' }), headers: { getSetCookie: () => [] } }));
  const view = createAionuiView({ WebContentsView: View, window, shell: {}, backend: { url: 'http://127.0.0.1:1233' } });
  await view.show({ x: 0, y: 0, width: 800, height: 600 });
  destroyed = true;
  assert.doesNotThrow(() => view.close());
  assert.equal(childClosed, true);
  assert.equal(contents.listenerCount('did-navigate-in-page'), 0);
  assert.doesNotThrow(() => view.close());
  await assert.rejects(view.show({ x: 0, y: 0, width: 800, height: 600 }), /正在关闭/);
});
