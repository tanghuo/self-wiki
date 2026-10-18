import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { encodeVisual } from "../src/server/semantic/visualEncoderClient.js";
import { defaultVideoAnalysisConfig } from "../src/shared/domain/videoAnalysis.js";

async function serverConfig(t, handler, timeoutMs = 2000) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { ...defaultVideoAnalysisConfig().visual, baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs };
}

test("visual encoder retries only busy responses", async (t) => {
  let requests = 0, unavailable = false;
  const config = await serverConfig(t, async (req, res) => {
    let input = ""; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input); requests++;
    if (unavailable || requests === 1) { res.statusCode = unavailable ? 503 : 429; res.end(); return; }
    res.end(JSON.stringify({ model: body.model, revision: body.revision, fingerprint: "a".repeat(64), dimensions: 2, embeddings: [[1, 0]] }));
  });
  assert.deepEqual((await encodeVisual(config, { texts: ["query"] })).vectors, [[1, 0]]);
  assert.equal(requests, 2);
  unavailable = true;
  await assert.rejects(encodeVisual(config, { texts: ["query"] }), /HTTP 503/);
  assert.equal(requests, 3, "dependency failures are not retried as contention");
});

test("visual encoder busy retries share one total timeout", async (t) => {
  let requests = 0;
  const config = await serverConfig(t, (_req, res) => { requests++; res.statusCode = 429; res.end(); }, 400);
  const started = Date.now();
  await assert.rejects(encodeVisual(config, { texts: ["query"] }), { code: "VISUAL_ENCODER_BUSY" });
  assert.ok(requests >= 2, "the total budget spans multiple requests");
  assert.ok(Date.now() - started < 1500, "retrying must not restart the timeout");
  const completed = requests;
  await delay(300);
  assert.equal(requests, completed, "no retry remains scheduled after timeout");
});

test("visual encoder cancellation interrupts a busy wait without another request", async (t) => {
  const entered = Promise.withResolvers();
  let requests = 0;
  const config = await serverConfig(t, (_req, res) => { requests++; res.statusCode = 429; res.end(); entered.resolve(); });
  const controller = new AbortController(), reason = new Error("cancelled by caller");
  const pending = encodeVisual(config, { texts: ["query"] }, controller.signal);
  const rejected = assert.rejects(pending, (error) => error === reason);
  await entered.promise;
  await delay(20);
  controller.abort(reason);
  await rejected;
  await delay(300);
  assert.equal(requests, 1);
});
