import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeFileTool } from "../../src/server/application/fileTools.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-file-tools-"));
  const workspace = path.join(directory, "session");
  await mkdir(path.join(workspace, "中文 空格"), { recursive: true });
  await writeFile(path.join(workspace, "中文 空格", "笔记.txt"), "第一行\r\nNeedle[1] 第二行\r\n第三行 needle[1]");
  await writeFile(path.join(workspace, "empty.txt"), "");
  await writeFile(path.join(workspace, ".hidden.txt"), "隐藏资料");
  await writeFile(path.join(workspace, "image.png"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(directory, "outside.txt"), "其他会话的资料");
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("wiki-file-tools-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return { workspace, directory, call: (name, args) => executeFileTool(name, args, { workspace }) };
}

test("file listing handles Unicode paths, globs, hidden files and bounded traversal without a shell", async (t) => {
  const { call } = await fixture(t);
  const all = await call("list_files", {});
  assert.equal(all.truncated, false);
  assert.ok(all.entries.some((entry) => entry.path.endsWith(".hidden.txt")));
  const filtered = await call("list_files", { glob: "**/*.{png,txt}" });
  assert.ok(filtered.entries.some((entry) => entry.path.endsWith("笔记.txt")));
  assert.ok(filtered.entries.some((entry) => entry.path.endsWith("image.png")));
  assert.ok(filtered.entries.every((entry) => entry.type === "file"));
  const direct = await call("list_files", { recursive: false });
  assert.ok(direct.entries.some((entry) => entry.type === "directory"));
  assert.ok(!direct.entries.some((entry) => entry.path.endsWith("笔记.txt")));
  const limited = await call("list_files", { limit: 1 });
  assert.equal(limited.entries.length, 1); assert.equal(limited.truncated, true);
  assert.deepEqual((await call("list_files", { glob: "**/*.missing" })).entries, []);
});

test("text reads paginate precisely and support UTF-8 and BOM-marked UTF-16", async (t) => {
  const { workspace, call } = await fixture(t);
  const file = "中文 空格/笔记.txt", first = await call("read_file", { path: file, limit: 4 });
  assert.equal(first.truncated, true);
  const rest = await call("read_file", { path: first.path, offset: first.nextOffset });
  assert.equal(first.content + rest.content, "第一行\r\nNeedle[1] 第二行\r\n第三行 needle[1]");
  assert.equal(rest.nextOffset, null);
  assert.equal((await call("read_file", { path: "empty.txt" })).content, "");
  const utf16 = Buffer.from("\ufeff中文 Windows 文本", "utf16le");
  await writeFile(path.join(workspace, "utf16.txt"), utf16);
  assert.equal((await call("read_file", { path: "utf16.txt" })).content, "中文 Windows 文本");
  await writeFile(path.join(workspace, "utf16be.txt"), Buffer.from(utf16).swap16());
  assert.equal((await call("read_file", { path: "utf16be.txt" })).content, "中文 Windows 文本");
  await assert.rejects(call("read_file", { path: "image.png" }), /二进制/);
  await writeFile(path.join(workspace, "large.txt"), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(call("read_file", { path: "large.txt" }), /1 MiB/);
});

test("content searches are literal, report line numbers and incomplete scans, and bound long excerpts", async (t) => {
  const { workspace, call } = await fixture(t);
  const result = await call("search_files", { query: "needle[1]" });
  assert.deepEqual(result.matches.map((entry) => entry.line), [2, 3]);
  assert.ok(result.skipped.some((entry) => entry.path.endsWith("image.png")));
  assert.equal((await call("search_files", { query: "needle[1]", caseSensitive: true })).matches.length, 1);
  const limited = await call("search_files", { query: "needle[1]", limit: 1 });
  assert.equal(limited.matches.length, 1); assert.equal(limited.truncated, true);
  const none = await call("search_files", { query: "does not exist", glob: "**/*.txt" });
  assert.equal(none.matches.length, 0); assert.equal(none.truncated, false);
  await writeFile(path.join(workspace, "long.txt"), "x".repeat(2000) + "needle[1]" + "x".repeat(2000));
  const long = await call("search_files", { query: "needle[1]", glob: "long.txt" });
  assert.equal(long.matches[0].truncated, true);
  assert.ok(long.matches[0].text.includes("needle[1]"));
  assert.ok(long.matches[0].text.length <= 1000);
});

test("paths and junctions cannot escape the session workspace", async (t) => {
  const { directory, workspace, call } = await fixture(t);
  for (const file of ["../outside.txt", path.join(directory, "outside.txt")]) await assert.rejects(call("read_file", { path: file }), /当前会话工作目录/);
  await assert.rejects(call("list_files", { path: ".." }), /当前会话工作目录/);
  await assert.rejects(call("search_files", { path: "..", query: "资料" }), /当前会话工作目录/);
  const outside = path.join(directory, "other"); await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "不可读取");
  await symlink(outside, path.join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(call("read_file", { path: "link/secret.txt" }), /当前会话工作目录/);
  await assert.rejects(call("list_files", { path: "link" }), /当前会话工作目录/);
  const listing = await call("list_files", {});
  assert.ok(listing.skipped.some((entry) => entry.path.endsWith("link")));
  assert.ok(!JSON.stringify(listing.entries).includes("secret.txt"));
  const absolute = path.join(await realpath(workspace), "empty.txt");
  assert.equal((await call("read_file", { path: absolute })).content, "");
});

test("file tools validate arguments and honor cancellation", async (t) => {
  const { workspace, call } = await fixture(t);
  for (const [name, args] of [["missing", {}], ["list_files", { limit: 201 }], ["list_files", { recursive: "true" }], ["read_file", {}], ["read_file", { path: "empty.txt", offset: -1 }], ["search_files", { query: "" }], ["list_files", { delete: true }], ["list_files", { path: "\0" }]]) {
    await assert.rejects(call(name, args));
  }
  const controller = new AbortController();
  const searching = executeFileTool("search_files", { query: "needle" }, { workspace, signal: controller.signal });
  controller.abort();
  await assert.rejects(searching, { name: "AbortError" });
  await assert.rejects(executeFileTool("list_files", {}, { workspace, signal: controller.signal }), { name: "AbortError" });
});
