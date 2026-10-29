import { cp, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Isolate the installed resources so a missing optional dependency cannot resolve from the source checkout.
const root = await mkdtemp(path.join(os.tmpdir(), "wiki-semantic-package-"));
try {
  await cp(path.resolve(import.meta.dirname, "../release/win-unpacked/resources"), path.join(root, "resources"), { recursive: true });
  const env = { ...process.env }; delete env.NODE_PATH;
  const script = `
    import path from 'node:path';
    import { getLoadablePath } from 'sqlite-vec';
    import { access } from 'node:fs/promises';
    import { initDb } from './src/server/data/sqlite.js';
    import { createServer } from './src/server/server.js';
    const extension = getLoadablePath();
    if (!extension.startsWith(process.cwd() + path.sep)) throw new Error('Extension escaped the installed app');
    const db = initDb(':memory:');
    const version = db.prepare('SELECT vec_version() AS version').get().version;
    db.close();
    const app = await createServer({port:0,dataDir:path.resolve('../smoke-data')});
    try {
      const response = await fetch(new URL('api/organization/semantic/status', app.url), { headers: app.managementHeaders() });
      const status = await response.json();
      if (!response.ok || !status.available || status.enabled) throw new Error('Invalid packaged index status');
      const videoResponse = await fetch(new URL('api/video-analysis/status', app.url), { headers: app.managementHeaders() });
      const video = await videoResponse.json();
      if (!videoResponse.ok || video.config.enabled || video.visual.enabled) throw new Error('Invalid packaged video analysis status');
      await access('tools/visual-encoder/server.py'); await access('config/video-analysis.example.json');
      console.log(JSON.stringify({version,available:status.available,http:response.status,videoHttp:videoResponse.status,isolated:true}));
    } finally { await app.close(); }
  `;
  const result = execFileSync(path.join(root, "resources/runtime/node.exe"), ["--input-type=module", "-e", script],
    { cwd: path.join(root, "resources/app"), env, windowsHide: true, timeout: 30000, encoding: "utf8" });
  console.log(result.trim());
} finally {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("wiki-semantic-package-")) throw new Error("Unsafe smoke directory");
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
