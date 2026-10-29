const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const assert = require("node:assert/strict");

app.disableHardwareAcceleration();
app.setPath("userData", process.env.WIKI_WALLPAPER_TEST_CACHE);
app.setPath("sessionData", process.env.WIKI_WALLPAPER_TEST_CACHE);
app.commandLine.appendSwitch("in-process-gpu");
app.whenReady().then(async () => {
  // Check the real sandboxed bridge and Sharp's Electron runtime without changing the desktop.
  const { prepareWallpaperFile } = await import("../../src/main/wallpaper.js");
  const file = await prepareWallpaperFile(1, process.env.WIKI_WALLPAPER_TEST_URL, process.env.WIKI_WALLPAPER_TEST_CACHE);
  assert.equal(path.extname(file), ".png");
  ipcMain.handle("wiki:set-wallpaper", (_event, id) => ({ ok: true, id }));
  const window = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true,
    preload: path.resolve(__dirname, "../../src/main/preload.cjs"),
  } });
  await window.loadURL("data:text/html,<html><body>wallpaper bridge</body></html>");
  const result = await window.webContents.executeJavaScript("window.wikiDesktop.setWallpaper(42)");
  assert.deepEqual(result, { ok: true, id: 42 });
  assert.deepEqual(await window.webContents.executeJavaScript('Object.keys(window.wikiDesktop).sort()'), ['pairLocal', 'pickShareSource', 'setWallpaper']);
  console.log("wallpaper desktop bridge ok");
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
