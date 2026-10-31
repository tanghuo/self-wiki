import { app, BrowserWindow, shell } from 'electron';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createAionuiExperiment } from '../src/server/application/aionuiExperiment.js';
import { createAionuiWindow } from '../src/main/aionuiWindow.js';

const root = path.resolve(import.meta.dirname, '..');
app.setName('self-wiki-aionui-ab');
const profile = process.env.APP_DATA_DIR ? path.join(process.env.APP_DATA_DIR, 'aionui-desktop-profile') : path.join(root, '.local/aionui-experiment/desktop-profile');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const experiment = createAionuiExperiment({ root, dataDir: process.env.APP_DATA_DIR || path.join(root, 'data') });
const cookie = `self-wiki-aionui-launch=${randomUUID()}`;
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/aionui/start' || req.headers.cookie !== cookie || req.headers.origin) { res.writeHead(403); res.end(); return; }
  try {
    const result = await experiment.launch();
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': result.cookies }); res.end(JSON.stringify(result.status));
  } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
let stopping = false;
app.on('before-quit', event => {
  if (stopping) return;
  event.preventDefault(); stopping = true;
  server.close(); server.closeAllConnections();
  void experiment.close().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
if (!app.requestSingleInstanceLock()) app.quit();
else {
  void app.whenReady().then(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const controller = createAionuiWindow({ BrowserWindow, shell, backend: { url: `http://127.0.0.1:${server.address().port}`, localCookie: cookie } });
    app.on('second-instance', () => { void controller.open(); });
    await controller.open();
    console.log('AionUi 实验窗口已打开，关闭窗口即停止独立实验服务。');
  }).catch(error => { console.error(error.message); app.quit(); });
}
