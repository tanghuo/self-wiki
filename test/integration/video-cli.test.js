import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer as createWikiServer, fetch, tokenFileForUrl } from "../helpers/authenticatedServer.js";

function cli(args) {
  const url = args[args.indexOf('--url') + 1];
  if (args.includes('--url') && !args.includes('--token-file')) args = [...args, '--token-file', tokenFileForUrl(url) || path.resolve('test/fixtures/local-credentials.json')];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("src/cli/main.js"), ...args], {
      env: { ...process.env, SELF_WIKI_URL: "", APP_DATA_DIR: "" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function success(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout).data;
}

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-video-cli-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-video-cli-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

test("CLI exposes video import and video filters in its offline command schema", async () => {
  const catalogue = success(await cli(["schema"]));
  assert.equal(catalogue.commands.find((command) => command.name === "videos import").route, "/api/videos");
  assert.ok(catalogue.commands.find((command) => command.name === "elements list").options.kind.choices.includes("video"));
});

test("CLI streams video upload/download with Unicode metadata and cleans interrupted downloads", async (t) => {
  const dir = await temp(t);
  const original = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < original.length; i++) original[i] = i % 251;
  const digest = createHash("sha256").update(original).digest("hex");
  const source = path.join(dir, "视频 演示.mp4");
  await writeFile(source, original);
  let received;
  const server = createServer(async (req, res) => {
    if (req.url === "/api/instance") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ application: "self-wiki", protocolVersion: 1, instanceId: "video-cli-test", dataDir: dir }));
    } else if (req.url === "/api/videos") {
      const hash = createHash("sha256");
      let size = 0, chunks = 0;
      for await (const chunk of req) { hash.update(chunk); size += chunk.length; chunks++; }
      received = { digest: hash.digest("hex"), size, chunks, name: decodeURIComponent(req.headers["x-file-name"]),
        tags: JSON.parse(Buffer.from(req.headers["x-video-tags"], "base64").toString("utf8")), instance: req.headers["x-self-wiki-instance"] };
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 1, kind: "video", video: { url: "/api/elements/1/video", originalName: received.name, mimeType: "video/mp4", byteSize: size }, tags: received.tags }));
    } else if (req.url === "/api/elements/1/download") {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": original.length });
      for (let offset = 0; offset < original.length; offset += 65536) {
        if (!res.write(original.subarray(offset, offset + 65536))) {
          const ready = await new Promise((resolve) => {
            const closed = () => { res.off("drain", drained); resolve(false); };
            const drained = () => { res.off("close", closed); resolve(true); };
            res.once("close", closed); res.once("drain", drained);
          });
          if (!ready) return;
        }
      }
      res.end();
    } else if (req.url === "/api/elements/2/download") {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": original.length });
      res.write(original.subarray(0, 65536));
      setTimeout(() => res.destroy(), 30);
    } else if (req.url === "/api/elements/4/download") {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": original.length });
      res.write(original.subarray(0, 65536));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing video" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const run = (args) => cli([...args, "--url", `http://127.0.0.1:${server.address().port}`]);
  const imported = success(await run(["videos", "import", source, "--tag", "素材 & 视频", "--tag", "演示"]));
  assert.equal(imported.kind, "video");
  assert.deepEqual(received, { digest, size: original.length, chunks: received.chunks, name: "视频 演示.mp4", tags: ["素材 & 视频", "演示"], instance: "video-cli-test" });
  assert.ok(received.chunks > 1);
  const output = path.join(dir, "下载.mp4");
  assert.deepEqual(success(await run(["elements", "download", "1", "--output", output])), { path: output, bytes: original.length });
  assert.equal(createHash("sha256").update(await readFile(output)).digest("hex"), digest);
  const overwrite = await run(["elements", "download", "1", "--output", output]);
  assert.equal(overwrite.code, 1);
  assert.equal(JSON.parse(overwrite.stderr).error.code, "IO_ERROR");
  assert.equal(createHash("sha256").update(await readFile(output)).digest("hex"), digest);
  const partial = path.join(dir, "partial.mp4");
  const interrupted = await run(["elements", "download", "2", "--output", partial]);
  assert.equal(interrupted.code, 3, interrupted.stderr);
  assert.equal(JSON.parse(interrupted.stderr).error.code, "CONNECTION");
  assert.equal(interrupted.stdout, "");
  await assert.rejects(stat(partial), { code: "ENOENT" });
  const missing = await run(["elements", "download", "3", "--output", partial]);
  assert.equal(JSON.parse(missing.stderr).error.code, "API_ERROR");
  await assert.rejects(stat(partial), { code: "ENOENT" });
  const timedOut = await run(["elements", "download", "4", "--output", partial, "--timeout", "100"]);
  assert.equal(timedOut.code, 3, timedOut.stderr);
  assert.equal(JSON.parse(timedOut.stderr).error.code, "CONNECTION");
  await assert.rejects(stat(partial), { code: "ENOENT" });
});

test("CLI rejects empty video files and directories before connecting", async (t) => {
  const dir = await temp(t);
  const empty = path.join(dir, "empty.mp4");
  await writeFile(empty, "");
  for (const source of [empty, dir]) {
    const result = await cli(["videos", "import", source]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, "USAGE");
  }
});

test("CLI video import works with the real backend across reuse, filtering, download and trash", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-video-cli-"));
  const app = await createWikiServer({ port: 0, dataDir: dir });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-video-cli-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts), header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8); header.write(type, 4);
    return Buffer.concat([header, body]);
  };
  const original = Buffer.concat([
    box("moov", box("trak", box("mdia", box("hdlr", Buffer.alloc(8), Buffer.from("vide"))))),
    box("mdat", Buffer.from("video-cli-test")),
  ]);
  const source = path.join(dir, "视频演示.mp4");
  await writeFile(source, original);
  const run = (args) => cli([...args.map(String), "--url", app.url]);
  const imported = success(await run(["videos", "import", source, "--tag", "视频"]));
  assert.equal(imported.kind, "video");
  assert.equal(imported.video.originalName, "视频演示.mp4");
  assert.equal(imported.video.byteSize, original.length);
  const reused = success(await run(["videos", "import", source, "--tag", "演示"]));
  assert.equal(reused.id, imported.id);
  assert.equal(reused.importStatus, "reused");
  assert.deepEqual(reused.tags, ["视频", "演示"]);
  const filtered = success(await run(["elements", "list", "--kind", "video", "--q", "视频演示"]));
  assert.deepEqual(filtered.elements.map((element) => element.id), [imported.id]);
  const note = success(await run(["elements", "create", "--body", "片段参考"]));
  const payload = { startMs: 100, endMs: 900, body: "关键镜头", tags: ["片段标签"], targetIds: [note.id], requestKey: "cli-marker-request" };
  const marker = success(await run(["markers", "create", imported.id, "--data", JSON.stringify(payload)]));
  assert.equal(success(await run(["markers", "create", imported.id, "--data", JSON.stringify(payload)])).id, marker.id);
  assert.equal(success(await run(["markers", "get", marker.id])).videoId, imported.id);
  assert.equal(success(await run(["markers", "list", imported.id, "--q", "关键", "--tag", "片段标签", "--page-size", "1"])).markers[0].id, marker.id);
  assert.equal(success(await run(["markers", "references", note.id])).references[0].id, marker.id);
  const { requestKey, ...fields } = payload;
  const updated = success(await run(["markers", "update", marker.id, "--data", JSON.stringify({ ...fields, endMs: null, revision: marker.revision })]));
  assert.equal(updated.endMs, null); assert.equal(updated.revision, 2);
  assert.equal((await run(["markers", "delete", marker.id, "--data", '{"revision":1}'])).code, 1);
  success(await run(["markers", "delete", marker.id, "--data", JSON.stringify({ revision: updated.revision })]));
  assert.equal(success(await run(["markers", "references", note.id])).pagination.total, 0);
  const output = path.join(dir, "copy.mp4");
  assert.equal(success(await run(["elements", "download", imported.id, "--output", output])).bytes, original.length);
  assert.deepEqual(await readFile(output), original);
  success(await run(["elements", "trash", imported.id]));
  assert.equal((await run(["elements", "get", imported.id])).code, 1);
  assert.equal(success(await run(["elements", "restore", imported.id])).kind, "video");
  assert.equal(success(await run(["elements", "get", imported.id])).video.url, `/api/elements/${imported.id}/video`);
});
