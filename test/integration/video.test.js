import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { createServer } from "../../src/server/server.js";
import { createVideoStore } from "../../src/server/assets/videoStore.js";
import { maxVideoBytes } from "../../src/shared/domain/elements.js";
import sharp from "sharp";

test("video covers survive server restart, validate images and follow video lifecycle", async (t) => {
  let app;
  const dir = await directory(t, () => app?.close());
  app = await createServer({ port: 0, dataDir: dir });
  const api = (route, body, method = "GET") => fetch(new URL(`api/${route}`, app.url), {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const imported = await fetch(new URL("api/videos", app.url), { method: "POST", headers: { "x-file-name": "cover.mp4" }, body: mp4() });
  const video = await imported.json(), route = `elements/${video.id}/video-cover`;
  assert.deepEqual(await (await api(route)).json(), { cover: null });
  const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#779966" } }).jpeg().toBuffer();
  const cover = { url: `data:image/jpeg;base64,${bytes.toString("base64")}`, duration: 10, time: 1 };
  assert.equal((await api(route, { ...cover, time: 10 }, "PUT")).status, 400);
  assert.equal((await api(route, { ...cover, url: "data:image/jpeg;base64,YWJj" }, "PUT")).status, 400);
  assert.equal((await api(route, { ...cover, url: "x".repeat(512 * 1024) }, "PUT")).status, 413);
  const saved = await api(route, cover, "PUT");
  assert.equal(saved.status, 200);
  const expected = await saved.json();
  await app.close();
  app = await createServer({ port: 0, dataDir: dir });
  assert.deepEqual(await (await api(route)).json(), expected);
  const folder = path.join(dir, "assets", "videos");
  const key = (await readdir(folder)).find((name) => name.endsWith(".cover-v1.json"));
  assert.ok(key);
  await writeFile(path.join(folder, key), "interrupted cache");
  assert.deepEqual(await (await api(route)).json(), { cover: null }, "Broken cache is treated as a miss");
  assert.equal((await api(route, cover, "PUT")).status, 200);
  await api(`elements/${video.id}`, undefined, "DELETE");
  assert.equal((await api(route)).status, 404);
  assert.equal((await api(route, cover, "PUT")).status, 404);
  await api(`elements/${video.id}/restore`, {}, "POST");
  assert.deepEqual(await (await api(route)).json(), expected);
  await api(`elements/${video.id}`, undefined, "DELETE");
  await api("trash/purge", { ids: [video.id] }, "POST");
  assert.deepEqual(await readdir(folder), [], "Purge removes both original and cover");
});

function box(type, ...payload) {
  const body = Buffer.concat(payload), header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8); header.write(type, 4);
  return Buffer.concat([header, body]);
}
function mp4(track = "vide", media = "video test payload") {
  return Buffer.concat([box("ftyp", Buffer.from("isom0000isom")),
    box("moov", box("trak", box("mdia", box("hdlr", Buffer.alloc(8), Buffer.from(track))))), box("mdat", Buffer.from(media))]);
}
function ebml(id, body) { return Buffer.concat([Buffer.from(id, "hex"), Buffer.from([0x80 | body.length]), body]); }
function webm() {
  return Buffer.concat([ebml("1a45dfa3", ebml("4282", Buffer.from("webm"))), ebml("18538067", Buffer.concat([
    ebml("1654ae6b", ebml("ae", ebml("83", Buffer.from([1])))), ebml("1f43b675", Buffer.from([0])),
  ]))]);
}
async function directory(t, beforeCleanup = async () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-video-"));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-video-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}
async function fixture(t) {
  let app;
  const dir = await directory(t, () => app?.close());
  app = await createServer({ port: 0, dataDir: dir });
  const api = (route, body, method = body === undefined ? "GET" : "POST") => fetch(new URL(`api/${route}`, app.url), {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const upload = (bytes, name = "演示.mp4", tags = []) => fetch(new URL("api/videos", app.url), {
    method: "POST", headers: { "x-file-name": encodeURIComponent(name), "x-video-tags": Buffer.from(JSON.stringify(tags)).toString("base64") }, body: bytes,
  });
  return { dir, app, api, upload };
}

test("video import preserves bytes, deduplicates, searches, relates, restores and permanently cleans files", async (t) => {
  const { dir, app, api, upload } = await fixture(t), bytes = mp4();
  const response = await upload(bytes, "旅行.mp4", ["旅行"]);
  assert.equal(response.status, 201);
  const video = await response.json();
  assert.equal(video.kind, "video"); assert.equal(video.creationSource, "manual");
  assert.equal(video.video.byteSize, bytes.length); assert.equal(video.video.mimeType, "video/mp4");
  const fileDir = path.join(dir, "assets", "videos"), originalFile = (await readdir(fileDir))[0];
  assert.deepEqual(await readFile(path.join(fileDir, originalFile)), bytes);
  const duplicate = await upload(bytes, "改名.mp4", ["收藏"]);
  assert.equal(duplicate.status, 200);
  const reused = await duplicate.json(); assert.equal(reused.id, video.id); assert.deepEqual(reused.tags, ["旅行", "收藏"]);
  assert.equal((await readdir(fileDir)).length, 1);
  const collision = await (await upload(mp4("vide", "different video"), "旅行.mp4")).json();
  assert.notEqual(collision.id, video.id); assert.equal(collision.importStatus, "same-name");
  const text = await (await api("elements", { body: "旅行笔记" })).json();
  assert.equal((await api("relations", { sourceId: text.id, targetId: video.id, name: "片段" })).status, 200);
  assert.ok((await (await api("elements?kind=video&q=旅行&tag=收藏")).json()).elements.some((e) => e.id === video.id));
  assert.ok((await (await api("elements")).json()).elements.some((e) => e.id === video.id));
  assert.ok((await (await api(`elements/${text.id}/relations`)).json()).relations.some((r) => r.element.kind === "video"));
  const canvas = await (await api("canvas?q=旅行.mp4")).json();
  assert.ok(canvas.elements.some((e) => e.id === video.id && e.video.originalName === "旅行.mp4"));
  assert.equal((await api(`elements/${video.id}`, { body: "invalid" }, "PATCH")).status, 400);
  assert.equal((await api(`elements/${video.id}`, { tags: ["新标签"] }, "PATCH")).status, 200);
  await api(`elements/${video.id}`, undefined, "DELETE");
  assert.equal((await fetch(new URL(video.video.url, app.url))).status, 404);
  assert.equal((await upload(bytes)).status, 409);
  assert.equal((await readdir(fileDir)).length, 2);
  await api(`elements/${video.id}/restore`, {});
  assert.deepEqual(Buffer.from(await (await fetch(new URL(video.video.url, app.url))).arrayBuffer()), bytes);
  await api(`elements/${video.id}`, undefined, "DELETE");
  const purged = await (await api("trash/purge", { ids: [video.id] })).json();
  assert.deepEqual(purged.deleted, [video.id]); assert.deepEqual(purged.cleanupFailed, []);
  assert.equal((await readdir(fileDir)).length, 1);
  assert.equal((await api(`elements/${video.id}/restore`, {})).status, 404);
});

test("video playback and download implement byte ranges, HEAD, missing files and origin checks", async (t) => {
  const { dir, app, api, upload } = await fixture(t), bytes = mp4();
  const video = await (await upload(bytes)).json(), url = new URL(video.video.url, app.url);
  for (const [range, start, end] of [["bytes=0-15", 0, 15], ["bytes=12-", 12, bytes.length - 1], ["bytes=-8", bytes.length - 8, bytes.length - 1], ["bytes=0-99999", 0, bytes.length - 1]]) {
    const result = await fetch(url, { headers: { range } });
    assert.equal(result.status, 206); assert.equal(result.headers.get("content-range"), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  for (const range of ["bytes=99999-", "bytes=-0", "bytes=9-2", "bytes=a-b", "bytes=0-1,5-6", "bytes=999999999999999999-"]) {
    const result = await fetch(url, { headers: { range } });
    assert.equal(result.status, 416); assert.equal(result.headers.get("content-range"), `bytes */${bytes.length}`);
  }
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(bytes.length)); assert.equal(await head.text(), "");
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  const changed = await fetch(url, { headers: { range: "bytes=0-3", "if-range": '"old"' } });
  assert.equal(changed.status, 200); await changed.arrayBuffer();
  const etag = head.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{64}"$/, "immutable videos expose their content hash as a strong ETag");
  const resumed = await fetch(url, { headers: { range: "bytes=4-7", "if-range": etag } });
  assert.equal(resumed.status, 206, "a matching If-Range resumes with the requested range");
  assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), bytes.subarray(4, 8));
  const download = await fetch(new URL(`api/elements/${video.id}/download`, app.url));
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await fetch(url, { headers: { origin: "https://other.invalid" } })).status, 403);
  const note = await (await api("elements", { body: "note" })).json();
  assert.equal((await api(`elements/${note.id}/video`)).status, 404);
  const folder = path.join(dir, "assets", "videos"), key = (await readdir(folder))[0];
  await writeFile(path.join(folder, key), Buffer.alloc(0));
  assert.equal((await fetch(url, { signal: AbortSignal.timeout(2000) })).status, 409, "truncated originals must fail promptly without leaving an unfinished response");
  await rm(path.join(folder, key));
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await (await upload(bytes)).json()).id, video.id, "reimport repairs missing video file");
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes);
});

test("storage rejects invalid, audio-only, truncated, oversized and interrupted uploads without leaving temporary files", async (t) => {
  const dir = await directory(t), store = createVideoStore(dir);
  const save = (bytes, name = "sample.mp4") => store.save(Readable.from([bytes]), name);
  for (const bytes of [Buffer.alloc(0), Buffer.from("not video"), mp4("soun"), mp4().subarray(0, -2)]) await assert.rejects(save(bytes));
  await assert.rejects(save(mp4(), "sample.exe"), { statusCode: 415 });
  const oversized = Readable.from([mp4()]); oversized.headers = { "content-length": maxVideoBytes + 1 };
  await assert.rejects(store.save(oversized, "sample.mp4"), { statusCode: 413 });
  const interrupted = Readable.from((async function* () { yield mp4(); throw new Error("upload disconnected"); })());
  await assert.rejects(store.save(interrupted, "sample.mp4"), /upload disconnected/);
  assert.deepEqual(await readdir(dir), []);
  for (const [name, bytes, type] of [["sample.mp4", mp4(), "video/mp4"], ["sample.M4V", mp4(), "video/mp4"], ["sample.mov", mp4(), "video/quicktime"], ["sample.webm", webm(), "video/webm"]]) {
    const file = await save(bytes, name); assert.equal(file.mimeType, type);
    assert.deepEqual(await readFile(path.join(dir, file.storageKey)), bytes);
  }
});

test("video uploads reject bad tags before writing files and cannot become AI references", async (t) => {
  const { app, api, upload } = await fixture(t);
  assert.equal((await upload(mp4(), "x.mp4", [null])).status, 400);
  const badHeader = await fetch(new URL("api/videos", app.url), { method: "POST", headers: { "x-file-name": "%invalid" }, body: mp4() });
  assert.equal(badHeader.status, 400);
  const video = await (await upload(mp4())).json();
  const session = await (await api("chat/sessions", {})).json();
  const result = await api(`chat/sessions/${session.id}/turns`, { requestKey: "video-rejected-request", text: "参考视频", sourceIds: [video.id] });
  assert.equal(result.status, 400); assert.match((await result.json()).error, /视频暂不支持/);
  assert.deepEqual((await (await api(`chat/sessions/${session.id}`)).json()).turns, []);
});

test("LAN sharing streams and imports videos through the same content API", async (t) => {
  const { api, upload } = await fixture(t), video = await (await upload(mp4())).json();
  const probe = createHttpServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  assert.equal((await api("lan-sharing", { autoStart: false, port, allowWrite: true }, "PUT")).status, 200);
  const lanToken = (await (await api("lan-sharing", undefined, "GET")).json()).token;
  const lanFetch = (target, options = {}) => fetch(target, { ...options, headers: { "x-self-wiki-lan-token": lanToken, ...options.headers } });
  assert.equal((await api("lan-sharing", { enabled: true })).status, 200);
  const url = `http://127.0.0.1:${port}`;
  const streamed = await lanFetch(`${url}${video.video.url}`, { headers: { range: "bytes=0-7" } });
  assert.equal(streamed.status, 206); assert.equal((await streamed.arrayBuffer()).byteLength, 8);
  const imported = await lanFetch(`${url}/api/videos`, { method: "POST", headers: { "x-file-name": "lan.webm" }, body: webm() });
  assert.equal(imported.status, 201); assert.equal((await imported.json()).kind, "video");
});

test("real browser-recorded WebM and MP4 retain their playable container bytes", async (t) => {
  const { app, upload } = await fixture(t);
  for (const extension of ["webm", "mp4"]) {
    const bytes = await readFile(new URL(`../fixtures/sample.${extension}`, import.meta.url));
    const response = await upload(bytes, `${"录".repeat(241)}.${extension}`);
    assert.equal(response.status, 201);
    const video = await response.json();
    assert.equal(video.video.originalName.length, 240);
    assert.ok(video.video.originalName.endsWith(`.${extension}`));
    assert.equal(video.video.mimeType, `video/${extension}`);
    assert.deepEqual(Buffer.from(await (await fetch(new URL(video.video.url, app.url))).arrayBuffer()), bytes);
  }
});
