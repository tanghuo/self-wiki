// Reserve one of two decoders for interactive requests. Queued work can be promoted.
export function createPreviewQueue() {
  const waiting = [];
  let active = 0, background = 0;
  function drain() {
    while (active < 2) {
      let index = waiting.findIndex((job) => job.foreground);
      if (index < 0 && background === 0) index = 0;
      const job = waiting[index];
      if (!job) return;
      waiting.splice(index, 1);
      active++;
      const lowPriority = !job.foreground;
      if (lowPriority) background++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        active--; if (lowPriority) background--; drain();
      });
    }
  }
  return (run, foreground = false) => {
    const job = { run, foreground };
    const promise = new Promise((resolve, reject) => { Object.assign(job, { resolve, reject }); });
    waiting.push(job); drain();
    return { promise, promote() { job.foreground = true; drain(); } };
  };
}
