// Stop the backend after the window closes, including during startup.
export function createQuitController({ app, dialog, getWindow, waitForStartup, closeBackend, onShutdown = () => {}, onError = console.error }) {
  let allowed = false, stopping = false, requested = false;
  const registered = new WeakSet();
  function registerWindow(window) {
    if (registered.has(window)) return;
    registered.add(window);
    window.webContents.on('will-prevent-unload', (event) => {
      const response = dialog.showMessageBoxSync(window, { type: 'warning', title: '尚有未保存的修改',
        message: '放弃未保存的修改并关闭？', buttons: ['取消', '放弃并关闭'], defaultId: 0, cancelId: 0, noLink: true });
      if (response === 1) event.preventDefault(); // Electron: explicitly accept discarding the draft.
      else requested = false;
    });
    window.on('closed', () => { if (requested) app.quit(); });
  }
  app.on('before-quit', (event) => {
    if (allowed) return;
    event.preventDefault();
    if (stopping) return;
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      requested = true;
      window.close();
      return;
    }
    stopping = true;
    onShutdown();
    void (async () => {
      try { await waitForStartup(); await closeBackend(); }
      catch (error) { onError(error); }
      finally { allowed = true; app.quit(); }
    })();
  });
  return { registerWindow, allowQuit() { allowed = true; } };
}
