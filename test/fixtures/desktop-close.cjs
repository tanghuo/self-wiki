const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
app.setPath('userData', process.env.WIKI_CLOSE_TEST_DIR);
app.setPath('sessionData', process.env.WIKI_CLOSE_TEST_DIR);
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('in-process-gpu');

(async () => {
  const { createQuitController } = await import(pathToFileURL(path.resolve(__dirname, '../../src/main/quitController.js')));
  let window, prompts = 0, stopped = 0, response = 0;
  const control = createQuitController({
    app, getWindow: () => window, waitForStartup: async () => {},
    dialog: { showMessageBoxSync() { prompts++; return response; } },
    closeBackend: async () => {
      assert.equal(window.isDestroyed(), true);
      assert.equal(prompts, 4); assert.equal(++stopped, 1);
      console.log('desktop close guard smoke ok');
    },
    onError(error) { console.error(error); app.exit(1); },
  });
  await app.whenReady();
  async function create() {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    control.registerWindow(win);
    await win.loadURL('data:text/html,<html><body>unsaved draft</body></html>');
    await win.webContents.executeJavaScript('window.onbeforeunload = () => false; true');
    return win;
  }
  window = await create();
  const veto = new Promise((resolve) => window.webContents.once('will-prevent-unload', () => setImmediate(resolve)));
  window.close(); await veto;
  assert.equal(window.isDestroyed(), false); assert.equal(stopped, 0);
  response = 1;
  const closed = new Promise((resolve) => window.once('closed', resolve));
  window.close(); await closed;
  assert.equal(window.isDestroyed(), true); assert.equal(prompts, 2); assert.equal(stopped, 0);
  window = await create();
  response = 0;
  const quitVeto = new Promise((resolve) => window.webContents.once('will-prevent-unload', () => setImmediate(resolve)));
  app.quit(); await quitVeto;
  assert.equal(window.isDestroyed(), false); assert.equal(stopped, 0);
  response = 1;
  app.quit();
})().catch((error) => { console.error(error); app.exit(1); });
