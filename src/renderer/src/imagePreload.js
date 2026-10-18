// Share one observer and four loading/decoding slots across all mounted cards.
const jobs = new Map();
let observer, active = 0;

function drain() {
  if (document.hidden || active >= 4) return;
  const nearby = [...jobs.values()].filter((job) => job.near && !job.active).map((job) => {
    const rect = job.node.getBoundingClientRect();
    return { job, visible: rect.width > 0 && rect.height > 0, distance: Math.max(0, rect.top - innerHeight, -rect.bottom) };
  }).filter((entry) => entry.visible).sort((a, b) => a.distance - b.distance);
  for (const { job } of nearby) {
    if (active >= 4) break;
    job.active = true; active++;
    job.start();
  }
}

export function preloadImage(node, start) {
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const job = jobs.get(entry.target);
        if (job) job.near = entry.isIntersecting;
      }
      drain();
    }, { rootMargin: "4000px" });
    document.addEventListener("visibilitychange", drain);
  }
  const job = { node, start, near: false, active: false };
  jobs.set(node, job); observer.observe(node);
  // Finishing decoding and cancelling an unmounted card both release the slot.
  return () => {
    if (jobs.get(node) !== job) return;
    jobs.delete(node); observer.unobserve(node);
    if (job.active) active--;
    if (!jobs.size) {
      observer.disconnect(); observer = null;
      document.removeEventListener("visibilitychange", drain);
    } else queueMicrotask(drain);
  };
}
