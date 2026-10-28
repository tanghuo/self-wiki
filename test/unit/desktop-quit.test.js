import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createQuitController } from '../../src/main/quitController.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const app = new EventEmitter(), window = new EventEmitter(), contents = new EventEmitter();
  let dirty = true, destroyed = false, closes = 0, stops = 0, quitting = false, exits = 0, prompts = 0, response = 0;
  window.webContents = contents;
  window.isDestroyed = () => destroyed;
  window.close = () => {
    closes++;
    if (dirty) {
      let ignoreVeto = false;
      contents.emit('will-prevent-unload', { preventDefault() { ignoreVeto = true; } });
      if (!ignoreVeto) return;
    }
    destroyed = true; window.emit('closed');
  };
  app.quit = () => { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); if (!prevented) exits++; };
  const control = createQuitController({ app, dialog: { showMessageBoxSync(_window, options) { prompts++; assert.equal(options.cancelId, 0); assert.equal(options.defaultId, 0); return response; } }, getWindow: () => window, waitForStartup: async () => {}, closeBackend: async () => { stops++; }, onShutdown: () => { quitting = true; } });
  control.registerWindow(window);
  // Match the app's Windows/Linux last-window behavior.
  window.on('closed', () => app.quit());
  return { app, window, control, setResponse(value) { response = value; }, setDirty(value) { dirty = value; }, state: () => ({ destroyed, closes, stops, quitting, exits, prompts }) };
}
test('desktop Close preserves drafts on cancel and shuts down only after confirmed discard', async () => {
  const f = fixture();
  f.window.close(); await turn();
  assert.equal(f.state().destroyed, false); assert.equal(f.state().stops, 0);
  f.setResponse(1); f.window.close(); await turn();
  assert.equal(f.state().prompts, 2);
  assert.equal(f.state().destroyed, true); assert.equal(f.state().stops, 1); assert.equal(f.state().exits, 1);
});
test('desktop application Quit can be cancelled and retried with explicit discard', async () => {
  const f = fixture();
  f.app.quit(); await turn();
  assert.equal(f.state().destroyed, false); assert.equal(f.state().quitting, false); assert.equal(f.state().stops, 0);
  f.setResponse(1); f.app.quit(); await turn();
  assert.equal(f.state().prompts, 2);
  assert.equal(f.state().destroyed, true); assert.equal(f.state().stops, 1); assert.equal(f.state().exits, 1);
});
test('desktop saved windows close without a prompt and repeated quit requests stop the backend once', async () => {
  const f = fixture(); f.setDirty(false);
  f.app.quit(); f.app.quit(); f.app.quit(); await turn();
  assert.equal(f.state().prompts, 0); assert.equal(f.state().stops, 1); assert.equal(f.state().exits, 1);
});
test('desktop quit during startup waits for the child and still exits if shutdown reports an error', async () => {
  const app = new EventEmitter(); let finishStartup, stopped = 0, errors = 0, exited = 0, shuttingDown = false;
  const startup = new Promise((resolve) => { finishStartup = resolve; });
  app.quit = () => { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); if (!prevented) exited++; };
  createQuitController({ app, dialog: {}, getWindow: () => null, waitForStartup: () => startup, closeBackend: async () => { stopped++; throw new Error('shutdown error'); }, onShutdown() { shuttingDown = true; }, onError() { errors++; } });
  app.quit(); app.quit(); await turn();
  assert.equal(shuttingDown, true); assert.equal(stopped, 0); assert.equal(exited, 0);
  finishStartup(); await turn();
  assert.equal(stopped, 1); assert.equal(errors, 1); assert.equal(exited, 1);
});
