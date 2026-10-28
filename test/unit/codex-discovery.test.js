import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCodexCommand } from "../../src/agent/executors/codexCommand.js";

const config = (executable = "codex") => ({ codexCli: { executable } });

test("Codex discovery honors overrides, PATH and Windows installations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-discovery-"));
  const saved = Object.fromEntries(["PATH", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "PORTABLE_EXECUTABLE_DIR"].map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  async function file(relative) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "");
    return target;
  }
  process.env.PATH = path.join(root, "bin");
  process.env.APPDATA = path.join(root, "roaming");
  process.env.LOCALAPPDATA = path.join(root, "local");
  process.env.ProgramFiles = path.join(root, "programs");
  process.env.PORTABLE_EXECUTABLE_DIR = path.join(root, "portable/wiki");

  const explicit = await file("custom/cli.mjs");
  assert.deepEqual(await resolveCodexCommand(config(explicit)), { executable: process.execPath, prefix: [explicit], path: explicit });
  await assert.rejects(resolveCodexCommand(config(path.join(root, "missing.exe"))), { code: "NOT_INSTALLED" });
  await assert.rejects(resolveCodexCommand(config(path.dirname(explicit))), { code: "NOT_INSTALLED" });
  await assert.rejects(resolveCodexCommand(config("custom-missing-command")), { code: "NOT_INSTALLED" });

  const fromPath = await file(process.platform === "win32" ? "bin/codex.exe" : "bin/codex");
  assert.equal((await resolveCodexCommand(config())).path, fromPath);
  if (process.platform !== "win32") return;
  assert.equal((await resolveCodexCommand(config("codex.exe"))).path, fromPath);
  process.env.PATH = `"${path.dirname(fromPath)}"`;
  assert.equal((await resolveCodexCommand(config())).path, fromPath);

  const npmEntry = await file("roaming/npm/node_modules/@openai/codex/bin/codex.js");
  assert.equal((await resolveCodexCommand(config())).path, fromPath);
  await rm(fromPath);
  assert.equal((await resolveCodexCommand(config())).path, npmEntry);
  await rm(npmEntry);

  await file("local/Programs/OpenAI.Codex_26.9.0.0_x64/app/resources/codex.exe");
  const latest = await file("local/Programs/OpenAI.Codex_26.10.0.0_x64/app/resources/codex.exe");
  assert.equal((await resolveCodexCommand(config())).path, latest);
  await rm(path.join(root, "local"), { recursive: true });
  const store = await file("programs/WindowsApps/OpenAI.Codex_26.10.0.0_x64__publisher/app/resources/codex.exe");
  assert.equal((await resolveCodexCommand(config())).path, store);
  await rm(path.join(root, "programs"), { recursive: true });
  const portable = await file("portable/OpenAI.Codex_99.0.0.0_x64/app/resources/codex.exe");
  // A development machine may also have a sibling installation; use the
  // production module from a temporary application to isolate that search root.
  const { readFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const modulePath = await file("portable/wiki/src/agent/executors/codexCommand.mjs");
  const sourceUrl = new URL("../../src/agent/executors/codexCommand.js", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  // Relocate this module's own search root while retaining all real dependencies.
  await writeFile(modulePath, source.replace(/(from\s+)(["'])(\.\.?\/[^"']+)\2/g,
    (_, prefix, quote, specifier) => prefix + JSON.stringify(new URL(specifier, sourceUrl).href)));
  const isolated = await import(pathToFileURL(modulePath));
  assert.equal((await isolated.resolveCodexCommand(config())).path, portable);
  await rm(portable);
  await assert.rejects(isolated.resolveCodexCommand(config()), { code: "NOT_INSTALLED" });
});
