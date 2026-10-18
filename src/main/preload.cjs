const { contextBridge, ipcRenderer } = require("electron");

if (process.platform === "win32" && process.isMainFrame) {
  contextBridge.exposeInMainWorld("wikiDesktop", {
    setWallpaper: (elementId) => ipcRenderer.invoke("wiki:set-wallpaper", elementId),
  });
}
