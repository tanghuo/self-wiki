import { test } from "node:test";
import assert from "node:assert/strict";
import { runCodexProcess } from "../../src/agent/executors/codexCli.js";

test("Codex CLI output keeps multi-byte characters intact across pipe chunk boundaries", async () => {
  // Write one JSON line in two chunks, splitting a 3-byte UTF-8 character between them.
  const script = `const b = Buffer.from(JSON.stringify({ text: "雨夜街景" }) + "\\n", "utf8");
    const cut = b.indexOf(Buffer.from("夜", "utf8")) + 1;
    process.stdout.write(b.subarray(0, cut));
    setTimeout(() => { process.stdout.write(b.subarray(cut)); process.stderr.write(Buffer.from("错误", "utf8").subarray(0, 4)); setTimeout(() => process.stderr.write(Buffer.from("错误", "utf8").subarray(4)), 30); }, 60);`;
  const lines = [];
  const result = await runCodexProcess({ executable: process.execPath, prefix: ["-e", script] }, [], { env: process.env, onLine: (line) => lines.push(line) });
  assert.equal(result.code, 0);
  assert.deepEqual(lines.filter(Boolean).map((line) => JSON.parse(line).text), ["雨夜街景"]);
  assert.ok(!result.stdout.includes("\uFFFD"));
  assert.equal(result.stderr, "错误");
});
