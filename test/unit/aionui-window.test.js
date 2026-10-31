import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAionuiWindow } from '../../src/main/aionuiWindow.js';

for (const phase of ['fetch', 'cookie', 'load']) {
  test(`closing the experiment during ${phase} prevents late window creation or display`, async t => {
    const gate = Promise.withResolvers(), reached = Promise.withResolvers();
    let creations = 0, displays = 0, parentDestroyed = false;
    const pause = async stage => { if (stage === phase) { reached.resolve(); await gate.promise; } };
    class Window {
      constructor() { creations++; this.destroyed = false; }
      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; }
      setMenu() {}
      show() { displays++; }
      focus() {}
      async loadURL() { await pause('load'); }
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        session: { setPermissionRequestHandler() {}, cookies: { set: async () => pause('cookie') } },
      });
    }
    t.mock.method(globalThis, 'fetch', async () => {
      await pause('fetch');
      return { ok: true, json: async () => ({ url: 'http://127.0.0.1:4321' }), headers: { getSetCookie: () => ['aionui-session=test; Path=/'] } };
    });
    const controller = createAionuiWindow({ BrowserWindow: Window, shell: {}, backend: { url: 'http://127.0.0.1:1234' }, parent: { isDestroyed: () => parentDestroyed } });
    const pending = controller.open();
    const rejection = assert.rejects(pending, /实验窗口已关闭/);
    await reached.promise;
    parentDestroyed = true;
    controller.close(); controller.close(); gate.resolve();
    await rejection;
    assert.equal(creations, phase === 'fetch' ? 0 : 1);
    assert.equal(displays, 0);
    await assert.rejects(controller.open(), /实验窗口已关闭/);
  });
}
