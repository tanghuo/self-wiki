import path from "node:path";
import { build, Platform, Arch } from "electron-builder";
import { getLoadablePath } from "sqlite-vec";

if (process.platform !== "win32" || Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error("Windows packaging requires Windows and Node.js 24 or newer.");
}
const directoryOnly = process.argv.includes("--dir");
process.env.ELECTRON_BUILDER_CACHE ||= path.resolve(import.meta.dirname, "../.electron-cache/builder");
await build({
  targets: Platform.WINDOWS.createTarget(directoryOnly ? ["dir"] : ["portable"], Arch.x64),
  config: {
    electronDist: path.resolve(import.meta.dirname, "../node_modules/electron/dist"),
    extraResources: [
      { from: process.execPath, to: "runtime/node.exe" },
      // electron-builder omits this transitive optional package; the loader resolves it by package name.
      { from: path.dirname(getLoadablePath()), to: "app/node_modules/sqlite-vec-windows-x64", filter: ["package.json", "vec0.dll"] },
    ],
    ...(directoryOnly ? { win: { signAndEditExecutable: false } } : {}),
  },
});
