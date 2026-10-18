import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export function videoDownloadUrl(src, backendUrl, pageOrigin = new URL(backendUrl).origin) {
  const url = new URL(src);
  if (![new URL(backendUrl).origin, pageOrigin].includes(url.origin) || !/^\/api\/elements\/[^/]+\/video$/.test(url.pathname)) {
    throw new Error("无法复制此视频来源。");
  }
  url.pathname = url.pathname.replace(/\/video$/, "/download");
  url.search = "";
  url.hash = "";
  return new URL(url.pathname, backendUrl).href;
}

export async function prepareVideoFile(url, cacheRoot) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`读取视频失败（${response.status}）。`);
  const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get("content-disposition") || "")?.[1];
  let name = encodedName ? decodeURIComponent(encodedName) : "video.mp4";
  name = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").replace(/[. ]+$/, "");
  if (!name || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `video-${name || "file"}`;
  const directory = path.join(cacheRoot, createHash("sha256").update(url).digest("hex"));
  const target = path.join(directory, name);
  const length = response.headers.get("content-length");
  const existing = await stat(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (existing?.isFile() && length !== null && existing.size === Number(length)) {
    await response.body.cancel();
    return target;
  }
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    await pipeline(response.body, createWriteStream(temporary, { flags: "wx" }));
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  // Keep the cached file after app exit so a later paste still works.
  return target;
}

export async function copyVideoFile(file) {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($env:SELF_WIKI_CLIPBOARD_FILE)
[System.Windows.Forms.Clipboard]::SetFileDropList($files)`;
  await promisify(execFile)(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
    { windowsHide: true, timeout: 15000, env: { ...process.env, SELF_WIKI_CLIPBOARD_FILE: file } });
}
