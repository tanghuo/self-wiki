import { lstat, readdir, rm, utimes } from "node:fs/promises";
import path from "node:path";

async function entrySize(target) {
  const info = await lstat(target);
  if (!info.isDirectory()) return { size: info.size, mtimeMs: info.mtimeMs };
  let size = 0, mtimeMs = info.mtimeMs;
  for (const name of await readdir(target)) {
    const child = await entrySize(path.join(target, name));
    size += child.size; mtimeMs = Math.max(mtimeMs, child.mtimeMs);
  }
  return { size, mtimeMs };
}

// Mark a cache entry as recently used so least-recently-used pruning keeps it.
export async function touchCacheEntry(target) {
  const now = new Date();
  await utimes(target, now, now).catch(() => {});
}

// Least-recently-used pruning for desktop caches (wallpapers, clipboard videos).
// The newest `keep` entries always survive; older ones are removed while the total
// exceeds `maxBytes` or the count exceeds `maxEntries`. `protect` is never removed.
export async function pruneCache(root, { keep = 1, maxEntries = Infinity, maxBytes = Infinity, protect = [] } = {}) {
  let names;
  try { names = await readdir(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const protectedPaths = new Set(protect.map((item) => path.resolve(item)));
  const entries = [];
  for (const name of names) {
    const target = path.join(root, name);
    try { entries.push({ target, ...(await entrySize(target)) }); } catch { /* removed concurrently */ }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.target.localeCompare(b.target));
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const removed = [];
  for (const [index, entry] of entries.entries()) {
    if (index < keep || [...protectedPaths].some((item) => item === entry.target || item.startsWith(`${entry.target}${path.sep}`))) continue;
    if (total <= maxBytes && index < maxEntries) continue;
    try { await rm(entry.target, { recursive: true, force: true }); total -= entry.size; removed.push(entry.target); } catch { /* in use on Windows */ }
  }
  return removed;
}
