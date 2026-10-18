import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("test harness", () => {
  it("exposes the foundation validation scripts", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    assert.equal(packageJson.scripts.test, "node --test");
    assert.equal(packageJson.scripts["check:arch"], "node tools/check-architecture.mjs");
    assert.match(packageJson.scripts.check, /npm run test/);
    assert.match(packageJson.scripts.check, /npm run check:arch/);
  });
});
