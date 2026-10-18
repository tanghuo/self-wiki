const waiting = [];
let active = 0;

// A slot covers video loading, seeking and capture, not just the initial request.
export function scheduleVideoCover(start) {
  const entry = { start, active: false };
  function drain() {
    while (active < 2 && waiting.length) {
      const next = waiting.shift();
      next.active = true; active++; next.start();
    }
  }
  waiting.push(entry); drain();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (entry.active) active--;
    else {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
    }
    drain();
  };
}
