import { readdir, stat } from "node:fs/promises";
import path from "node:path";

async function resolveCandidates(candidates) {
  for (let candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      if (/\.cmd$/i.test(candidate)) {
        candidate = path.join(path.dirname(candidate), "node_modules/@openai/codex/bin/codex.js");
        if (!(await stat(candidate)).isFile()) continue;
      }
      return /\.[cm]?js$/i.test(candidate) ? { executable: process.execPath, prefix: [candidate], path: candidate } : { executable: candidate, prefix: [], path: candidate };
    } catch { /* Try the next candidate without executing shell launchers. */ }
  }
}

export async function resolveCodexCommand(config) {
  const name = config.codexCli.executable.trim();
  const candidates = path.isAbsolute(name) ? [name] : (process.env.PATH || "").split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)
    .flatMap((dir) => process.platform === "win32" && !path.extname(name) ? [path.join(dir, `${name}.exe`), path.join(dir, `${name}.cmd`), path.join(dir, name)] : [path.join(dir, name)]);
  const command = await resolveCandidates(candidates);
  if (command) return command;
  // Only the default command opts into discovery; explicit overrides must not silently fall back.
  if (name === "codex" && process.platform === "win32") {
    const installed = [];
    if (process.env.APPDATA) installed.push(path.join(process.env.APPDATA, "npm/node_modules/@openai/codex/bin/codex.js"));
    const roots = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
      process.env.ProgramFiles,
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "WindowsApps"),
      // Portable Codex installations can sit beside this application's installation.
      path.resolve(import.meta.dirname, "../../../.."),
      process.env.PORTABLE_EXECUTABLE_DIR && path.dirname(process.env.PORTABLE_EXECUTABLE_DIR),
    ].filter(Boolean);
    for (const root of new Set(roots)) {
      let entries;
      try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
      const apps = entries.filter((entry) => entry.isDirectory() && /^(?:Codex|OpenAI\.Codex(?:_[\w.]+)?)$/i.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }));
      for (const app of apps) {
        installed.push(path.join(root, app.name, "app/resources/codex.exe"), path.join(root, app.name, "resources/codex.exe"));
      }
    }
    const discovered = await resolveCandidates(installed);
    if (discovered) return discovered;
  }
  throw Object.assign(new Error("未找到 Codex CLI，请在设置中指定 codex.exe 或 Codex 的 JS 入口绝对路径"), { code: "NOT_INSTALLED", retryable: false });
}
