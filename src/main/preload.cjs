const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("wikiDesktop", {
    pairLocal: () => ipcRenderer.invoke('wiki:pair-local'),
    ...(process.platform === "win32" ? { setWallpaper: (elementId) => ipcRenderer.invoke("wiki:set-wallpaper", elementId) } : {}),
    pickShareSource: (kind) => ipcRenderer.invoke("wiki:pick-share-source", kind),
  });
}
