// Fire-and-forget work must never become an unhandled rejection: Node treats
// those as fatal, which would take the whole API (and every in-flight job) down.
export function background(task, label) {
  Promise.resolve(task).catch((error) => {
    console.error(`[self-wiki] background task failed (${label}):`, error?.stack || error);
  });
}
