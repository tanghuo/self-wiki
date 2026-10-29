import { spawn } from 'node:child_process';

// POSIX callers must spawn detached so descendants share a dedicated process group.
export function terminateProcessTree(child, { graceMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let done = false, killer, killerDone = false, treeConfirmed = false, childClosed = false, hardTimer, deadline;
    function kill(signal) {
      if (!child.pid) return;
      if (process.platform === 'win32') { child.kill(signal); return; }
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
    }
    function finish(force = false) {
      if (done || !force && killer && !killerDone) return;
      done = true;
      clearTimeout(hardTimer); clearTimeout(deadline); child.off('close', onClose);
      // Reap descendants even if the group leader exited first.
      if (process.platform !== 'win32') { kill('SIGKILL'); treeConfirmed = true; }
      killer?.kill(); resolve({ treeConfirmed: treeConfirmed && childClosed && !force });
    }
    function onClose() { childClosed = true; finish(); }
    child.once('close', onClose);
    if (process.platform === 'win32' && child.pid) {
      killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { killerDone = true; kill('SIGKILL'); if (childClosed) finish(); });
      killer.on('exit', (code) => { killerDone = true; treeConfirmed = code === 0; if (code) kill('SIGKILL'); if (childClosed) finish(); });
    } else kill('SIGTERM');
    hardTimer = setTimeout(() => kill('SIGKILL'), graceMs);
    deadline = setTimeout(() => {
      kill('SIGKILL'); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); finish(true);
    }, graceMs + 1500);
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) onClose();
  });
}
