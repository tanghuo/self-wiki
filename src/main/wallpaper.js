import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import sharp from "sharp";
import { pruneCache } from "./cacheCleanup.js";
import { maxImageBytes } from "../shared/domain/elements.js";

export async function prepareWallpaperFile(elementId, backendUrl, cacheRoot) {
  if (!Number.isSafeInteger(elementId) || elementId <= 0) throw new Error("无效的图片编号");
  const response = await fetch(new URL(`/api/elements/${elementId}/image`, backendUrl), {
    redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`读取原图失败（${response.status}）`);
  if (!response.headers.get("content-type")?.startsWith("image/")) {
    await response.body?.cancel();
    throw new Error("此内容不是图片");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxImageBytes) throw new Error("图片必须在 25 MiB 以内");
    chunks.push(chunk);
  }
  // Use the first animation frame, honor EXIF orientation, and retain full resolution.
  const bytes = await sharp(Buffer.concat(chunks), { limitInputPixels: 40_000_000 })
    .rotate().flatten({ background: "#ffffff" }).png().toBuffer();
  const file = path.join(cacheRoot, `${createHash("sha256").update(bytes).digest("hex")}.png`);
  await mkdir(cacheRoot, { recursive: true });
  const temporary = path.join(cacheRoot, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  // Windows must still be able to read the wallpaper after the library image is deleted;
  // keep the current file and a few recent ones, drop older conversions.
  await pruneCache(cacheRoot, { keep: 1, maxEntries: 5, protect: [file] }).catch(() => {});
  return file;
}

export async function setDesktopWallpaper(file) {
  if (process.platform !== "win32") throw new Error("仅支持 Windows 桌面壁纸");
  if (!(await stat(file)).isFile()) throw new Error("壁纸文件不存在");
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WikiWallpaper {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SystemParametersInfoW(uint action, uint param, string value, uint flags);
}
'@
if (-not [WikiWallpaper]::SystemParametersInfoW(20, 0, $env:SELF_WIKI_WALLPAPER_FILE, 3)) {
  throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}`;
  await promisify(execFile)(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 15000, env: { ...process.env, SELF_WIKI_WALLPAPER_FILE: file } });
}
