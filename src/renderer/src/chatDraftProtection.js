// Keep protection alive when a conversation unmounts while its save is still pending.
const pending = new Map();
function protect(event) {
  if (!pending.size) return;
  event.preventDefault(); event.returnValue = "";
}
export function markDraftPending(key, revision) {
  pending.set(key, Math.max(revision, pending.get(key) || 0));
  window.addEventListener("beforeunload", protect);
}
export function acknowledgeDraft(key, revision) {
  if ((pending.get(key) || 0) <= revision) pending.delete(key);
  if (!pending.size) window.removeEventListener("beforeunload", protect);
}
