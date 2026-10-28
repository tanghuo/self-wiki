// Settings panels that edit the same config save only what they changed, on top of the latest saved config.
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
// Apply what changed between `saved` and `edited` onto `base` (the latest config from the server).
export function mergeEdits(base, saved, edited) {
  if (!plain(base) || !plain(saved) || !plain(edited)) return JSON.stringify(edited) === JSON.stringify(saved) ? base : edited;
  const next = { ...base };
  for (const key of Object.keys(edited)) {
    if (plain(edited[key]) && plain(saved[key]) && plain(base[key])) next[key] = mergeEdits(base[key], saved[key], edited[key]);
    else if (JSON.stringify(edited[key]) !== JSON.stringify(saved[key])) next[key] = edited[key];
  }
  return next;
}
