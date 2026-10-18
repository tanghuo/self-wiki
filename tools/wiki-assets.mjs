import { DatabaseSync } from "node:sqlite";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Call only while the app is stopped when applying cleanup. A readonly scan never migrates the database.
export async function inspectWikiAssets(dataDir, { apply = false, offline = false } = {}) {
  if (apply && !offline) throw new Error("Close the application first, then pass --apply --offline to clean unreferenced files.");
  const root = path.resolve(dataDir);
  const directory = path.join(root, "assets");
  const directoryInfo = await lstat(directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (directoryInfo?.isSymbolicLink()) throw new Error("Assets directory must not be a symbolic link");
  const db = new DatabaseSync(path.join(root, "library.sqlite3"), { readOnly: true });
  let references, hasVideos;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='element_images'").get()) throw new Error("No Wiki schema; no files will be removed");
    references = db.prepare("SELECT storage_key FROM element_images").all().map((r) => r.storage_key);
    hasVideos = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='element_videos'").get());
    if (hasVideos) references.push(...db.prepare("SELECT storage_key FROM element_videos").all().map((r) => `videos/${r.storage_key}`));
  } finally { db.close(); }
  const referenced = new Set(references);
  const present = new Set(), unused = [], unknown = [], removed = [], candidates = [];
  const directories = [{ directory, info: directoryInfo, prefix: "", pattern: /^[a-f0-9-]+\.(png|jpeg|webp|gif)(\.tmp)?$/ }];
  if (hasVideos) {
    const videoDirectory = path.join(directory, "videos");
    const info = await lstat(videoDirectory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new Error("Videos directory must be a regular directory");
    directories.push({ directory: videoDirectory, info, prefix: "videos/", pattern: /^[a-f0-9-]+\.(mp4|webm|mov)(\.tmp)?$/ });
  }
  const previewDirectory = path.join(directory, "previews-v1");
  const previewInfo = await lstat(previewDirectory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (previewInfo?.isSymbolicLink() || previewInfo && !previewInfo.isDirectory()) throw new Error("Preview directory must be a regular directory");
  directories.push({ directory: previewDirectory, info: previewInfo, prefix: "previews-v1/", pattern: /^[a-f0-9-]+\.(png|jpeg|webp|gif)\.(small|400|800|1200|1600)\.webp(\.[a-f0-9-]+\.tmp)?$/ });
  for (const entry of directories) {
    const names = entry.info ? await readdir(entry.directory) : [];
    for (const name of names) {
      if (!entry.prefix && (name === "videos" && hasVideos || name === "previews-v1")) continue;
      const file = path.resolve(entry.directory, name), relative = `${entry.prefix}${name}`;
      if (path.dirname(file) !== entry.directory) throw new Error("Asset path escaped its directory");
      const info = await lstat(file);
      const firstFrame = entry.prefix && /^([a-f0-9-]+\.(?:mp4|webm|mov))\.first-frame-v1\.png(\.[a-f0-9-]+\.tmp)?$/.exec(name);
      if (!info.isFile() || info.isSymbolicLink() || !entry.pattern.test(name) && !firstFrame) { unknown.push(relative); continue; }
      present.add(relative);
      if (referenced.has(relative)) continue;
      if (firstFrame && !firstFrame[2] && referenced.has(`${entry.prefix}${firstFrame[1]}`)) continue;
      const preview = entry.prefix === "previews-v1/" && /^([a-f0-9-]+\.(?:png|jpeg|webp|gif))\.(?:small|400|800|1200|1600)\.webp$/.exec(name);
      if (preview && referenced.has(preview[1])) continue;
      unused.push(relative);
      candidates.push({ file, relative });
    }
  }
  const missing = references.filter((name) => !present.has(name));
  if (apply) {
    for (const { file, relative } of candidates) { await rm(file); removed.push(relative); }
  }
  return { dataDir: root, referenced: referenced.size, missing, unused, unknown, removed, applied: apply };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let dataDir = path.resolve(import.meta.dirname, "../data");
  let apply = false, offline = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) dataDir = path.resolve(args[++i]);
    else if (args[i] === "--apply") apply = true;
    else if (args[i] === "--offline") offline = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  console.log(JSON.stringify(await inspectWikiAssets(dataDir, { apply, offline }), null, 2));
}
