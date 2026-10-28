import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import path from "node:path";
import { startBackendProcess } from "./backendProcess.js";
import { copyVideoFile, prepareVideoFile, videoDownloadUrl } from "./videoClipboard.js";
import { prepareWallpaperFile, setDesktopWallpaper } from "./wallpaper.js";
import { createQuitController } from './quitController.js';

let backend;
let mainWindow;
let quitController;
let quitting = false;
let windowCreation;
const smoke = process.argv.includes("--smoke");
if (smoke) {
  app.disableHardwareAcceleration();
}

async function createMainWindow() {
  const appDir = app.getAppPath();
  const dataRoot = app.isPackaged
    ? process.env.PORTABLE_EXECUTABLE_DIR || app.getPath("userData")
    : appDir;
  if (!backend) {
    backend = process.env.EXTERNAL_API_URL
      ? { url: new URL(process.env.EXTERNAL_API_URL).href, close: async () => {} }
      : await startBackendProcess({
        nodeBinary: process.env.NODE_BINARY || (app.isPackaged ? path.join(process.resourcesPath, "runtime/node.exe") : "node"),
        appDir,
        dataDir: process.env.APP_DATA_DIR || path.join(dataRoot, "data"),
        port: Number(process.env.API_PORT || 0),
      });
    const current = backend;
    current.onExit?.((info) => { void handleBackendExit(current, info); });
  }
  if (quitting) return;
  mainWindow = new BrowserWindow({
    width: 1360, height: 920, minWidth: 980, minHeight: 680,
    title: "self-wiki", backgroundColor: "#f7f8f6", show: !smoke,
    icon: path.join(appDir, app.isPackaged ? "dist/renderer/brand/self-wiki.ico" : "src/renderer/public/brand/self-wiki.ico"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(appDir, "src/main/preload.cjs") },
  });
  mainWindow.setMenu(null);
  const pageUrl = process.env.VITE_DEV_SERVER_URL || backend.url;
  const pageOrigin = new URL(pageUrl).origin;
  const openExternal = (url) => {
    if (["https:", "http:"].includes(new URL(url).protocol)) void shell.openExternal(url);
  };
  // Deny every permission except what the Wiki UI uses (clipboard, video fullscreen), and only for its own page.
  const allowedPermissions = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
  const trusted = (url) => { try { return new URL(url).origin === pageOrigin; } catch { return false; } };
  const permissionSession = mainWindow.webContents.session;
  permissionSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowedPermissions.has(permission) && details.isMainFrame !== false && trusted(details.requestingUrl));
  });
  permissionSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowedPermissions.has(permission) && trusted(requestingOrigin));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== pageOrigin) { event.preventDefault(); openExternal(url); }
  });
  const window = mainWindow;
  quitController.registerWindow(window);
  ipcMain.removeHandler("wiki:pick-share-source");
  ipcMain.handle("wiki:pick-share-source", async (event, kind) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== pageOrigin) throw new Error("此页面无法选择本机文件");
    const result = await dialog.showOpenDialog(window, {
      title: kind === "directory" ? "选择要临时分享的目录" : "选择要临时分享的文件",
      properties: [kind === "directory" ? "openDirectory" : "openFile"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  let settingWallpaper = false;
  ipcMain.removeHandler("wiki:set-wallpaper");
  ipcMain.handle("wiki:set-wallpaper", async (event, elementId) => {
    if (process.platform !== "win32" || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== pageOrigin) {
      return { ok: false, error: "此页面无法设置桌面壁纸" };
    }
    if (settingWallpaper) return { ok: false, error: "正在设置壁纸，请稍候" };
    settingWallpaper = true;
    try {
      const file = await prepareWallpaperFile(elementId, backend.url, path.join(app.getPath("userData"), "wallpapers"));
      await setDesktopWallpaper(file);
      return { ok: true };
    } catch (error) { return { ok: false, error: `设置桌面壁纸失败：${error.message}` }; }
    finally { settingWallpaper = false; }
  });
  let copyingVideo = false;
  window.webContents.on("context-menu", (_event, params) => {
    if (params.mediaType === "video" && process.platform === "win32") {
      let downloadUrl;
      try { downloadUrl = videoDownloadUrl(params.srcURL, backend.url, pageOrigin); } catch { return; }
      Menu.buildFromTemplate([{
        label: copyingVideo ? "正在准备视频文件…" : "复制视频文件",
        enabled: !copyingVideo,
        click: async () => {
          if (copyingVideo) return;
          copyingVideo = true;
          try {
            const file = await prepareVideoFile(downloadUrl, path.join(app.getPath("userData"), "clipboard-videos"));
            await copyVideoFile(file);
          } catch (error) {
            if (!window.isDestroyed()) await dialog.showMessageBox(window, { type: "error", message: "复制视频文件失败", detail: error.message });
          } finally { copyingVideo = false; }
        },
      }]).popup({ window });
      return;
    }
    if (params.mediaType !== "image" || !params.hasImageContents) return;
    Menu.buildFromTemplate([{
      label: "复制",
      click: () => {
        if (!window.isDestroyed()) window.webContents.copyImageAt(params.x, params.y);
      },
    }]).popup({ window });
  });
  await mainWindow.loadURL(smoke ? new URL("#wiki", pageUrl).href : pageUrl);
  if (smoke) {
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const instance = await fetch("/api/instance").then(r => { if (!r.ok) throw new Error("instance " + r.status); return r.json(); });
      if (!document.querySelector('#root') || instance.application !== 'self-wiki') throw new Error('Invalid renderer/API state');
      const json = async (url, options) => {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(url + ': ' + await response.text());
        return response.json();
      };
      const text = await json('/api/elements', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({body:'portrait\\n  soft light'}) });
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
      canvas.getContext('2d').fillRect(0, 0, 8, 8);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const image = await json('/api/images', { method: 'POST', headers: {'content-type':'application/octet-stream','x-file-name':'smoke.png'}, body: blob });
      await json('/api/relations', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({leftId:text.id,rightId:image.id}) });
      const relations = await json('/api/elements/' + image.id + '/relations');
      const original = await fetch(image.image.url);
      if (relations.relations[0]?.element.id !== text.id || !original.ok || (await original.arrayBuffer()).byteLength !== blob.size) throw new Error('Wiki persistence failed');
      if (!document.querySelector('.wiki-shell')) throw new Error('Wiki renderer missing');
      const canvasEntry = Array.from(document.querySelectorAll('.wiki-sidebar button')).find(button => button.textContent.includes('关系画布'));
      if (!canvasEntry) throw new Error('Wiki canvas entry missing');
      canvasEntry.click();
      const deadline = Date.now() + 5000;
      while (document.querySelectorAll('.react-flow__node').length !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      const canvasNodeCount = document.querySelectorAll('.react-flow__node').length;
      if (canvasNodeCount !== 2 || document.querySelector('.wiki-canvas [role="alert"]')) throw new Error('Wiki canvas did not load');
      if (await Notification.requestPermission() !== 'denied') throw new Error('Unexpected permission grant');
      const preview = await fetch('/api/elements/' + image.id + '/thumbnail');
      if (!preview.ok || preview.headers.get('content-type') !== 'image/webp') throw new Error('Wiki canvas preview failed');
      return { origin: location.origin, instanceId: instance.instanceId, wikiImageId: image.id, wikiRelationCount: relations.relations.length, canvasNodeCount };
    })()`);
    console.log(`electron renderer smoke ok: ${JSON.stringify(result)}`);
    await backend.close();
    quitController.allowQuit();
    app.quit();
  }
}

// The API child crashed after startup: tell the user and offer a restart instead of a silently dead window.
async function handleBackendExit(exited, { code, signal, stderr }) {
  if (quitting || backend !== exited) return;
  backend = undefined;
  console.error(`API process exited unexpectedly (${code ?? signal})`);
  if (smoke) { quitting = true; app.exit(1); return; }
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options = {
    type: "error", buttons: ["重新启动", "退出"], defaultId: 0, cancelId: 1, noLink: true,
    title: "self-wiki", message: "后台服务意外退出",
    detail: `退出代码：${code ?? signal}。正在进行的生成或整理任务会在重启后恢复为中断状态。${stderr ? `\n\n${stderr.slice(-800)}` : ""}`,
  };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (quitting) return;
  if (response !== 0) { app.quit(); return; }
  try {
    // Open the replacement first so closing the old window does not trigger window-all-closed.
    mainWindow = undefined;
    await showMainWindow();
    if (window && !window.isDestroyed()) window.destroy();
  } catch (error) { await handleStartupError(error); }
}

async function handleStartupError(error) {
  console.error(error);
  quitting = true;
  if (backend) await backend.close();
  if (!smoke) dialog.showErrorBox("self-wiki", error.message);
  app.exit(1);
}

async function showMainWindow() {
  await app.whenReady();
  if (quitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Startup and repeated launches must share the same backend/window creation.
    windowCreation ||= createMainWindow().finally(() => { windowCreation = undefined; });
    await windowCreation;
  }
  if (quitting || smoke || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  quitController = createQuitController({
    app, getWindow: () => mainWindow,
    waitForStartup: () => windowCreation,
    closeBackend: async () => { if (backend) await backend.close(); },
    onShutdown: () => { quitting = true; },
  });
  const show = () => { void showMainWindow().catch(handleStartupError); };
  app.on("second-instance", show);
  app.on("activate", show);
  show();
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
