// Closing the desktop app discards unsaved drafts without a confirmation.
// Stop the backend after the window closes, including during startup.
export function createQuitController({ app, getWindow, waitForStartup, closeBackend, onShutdown = () => {}, onError = console.error }) {
  let allowed = false, stopping = false, requested = false;
  const registered = new WeakSet();
  function registerWindow(window) {
    if (registered.has(window)) return;
    registered.add(window);
    window.webContents.on('will-prevent-unload', (event) => {
      event.preventDefault(); // Electron: ignore the renderer's unload veto.
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
