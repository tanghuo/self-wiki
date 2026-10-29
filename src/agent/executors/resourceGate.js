import { externalKeyLimit, externalResourceLimits } from '../../shared/domain/externalResources.js';

// All in-process chat/workflow adapters share these external resource limits.
let active = 0;
const counts = new Map(), queue = [];
function drain() {
  for (let i = 0; i < queue.length && active < externalResourceLimits.total;) {
    const job = queue[i];
    if (job.signal?.aborted) { queue.splice(i, 1); job.reject(job.signal.reason || new Error('已取消')); continue; }
    if ((counts.get(job.key) || 0) >= externalKeyLimit(job.key)) { i++; continue; }
    queue.splice(i, 1); active++; counts.set(job.key, (counts.get(job.key) || 0) + 1);
    job.signal?.removeEventListener('abort', job.abort);
    let released = false;
    job.resolve(() => {
      if (released) return;
      released = true; active--;
      const next = counts.get(job.key) - 1;
      if (next > 0) counts.set(job.key, next); else counts.delete(job.key);
      drain();
    });
  }
}
export function acquireExternalResource(key, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const job = { key, signal, resolve, reject };
    job.abort = () => { const index = queue.indexOf(job); if (index >= 0) { queue.splice(index, 1); reject(signal.reason || new Error('已取消')); } };
    signal?.addEventListener('abort', job.abort, { once: true });
    queue.push(job); drain();
  });
}
export async function withExternalResource(key, signal, fn) {
  const release = await acquireExternalResource(key, signal);
  try { signal?.throwIfAborted(); return await fn(); } finally { release(); }
}
