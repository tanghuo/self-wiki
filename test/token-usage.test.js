import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tokenUsage, accumulateTurnUsage } from "../src/shared/domain/tokenUsage.js";
import { createUsageRepository } from "../src/server/data/usageRepository.js";

test("usage separates cached and reasoning subsets and preserves unknown counters", () => {
  assert.deepEqual(tokenUsage({ input_tokens: 100, cached_input_tokens: 60, output_tokens: 30 }), { input: 100, cached: 60, output: 30, reasoning: null, total: 130 });
  assert.equal(tokenUsage(null).total, null);
  assert.equal(tokenUsage({ input_tokens: -1, output_tokens: 3 }).total, null);
  assert.equal(tokenUsage({ prompt_tokens: 20, total_tokens: 20, output_tokens: 0 }).total, 20);
});
test("chat sums model requests within one turn and ignores duplicate notifications", () => {
  const first = { total: { inputTokens: 1000, outputTokens: 100 }, last: { inputTokens: 100, outputTokens: 10 } };
  const a = accumulateTurnUsage(null, first), b = accumulateTurnUsage(a, first);
  assert.equal(b.usage.totalTokens, 110);
  const c = accumulateTurnUsage(b, { total: { inputTokens: 1200, outputTokens: 120 }, last: { inputTokens: 200, outputTokens: 20 } });
  assert.equal(c.usage.totalTokens, 330);
  assert.equal(accumulateTurnUsage(null, { total: { inputTokens: 1200, outputTokens: 120 }, last: { inputTokens: 200, outputTokens: 20 } }).usage.totalTokens, 220);
});
test("ledger updates attempts once, keeps failed usage and recovers interrupted calls", () => {
  const db = new DatabaseSync(":memory:");
  try {
    let repo = createUsageRepository(db);
    const e = { id: "call-1", purpose: "organization", model: "fixture", state: "running", startedAt: Date.now(), context: { round: 1 } };
    repo.record(e); repo.record({ ...e, state: "failed", usage: { input_tokens: 80, output_tokens: 20 } });
    repo.record({ ...e, id: "call-2" });
    repo.record({ ...e, id: "old", startedAt: Date.now() - 40 * 86400000, state: "completed", usage: { input_tokens: 500, output_tokens: 0 } });
    repo = createUsageRepository(db);
    const report = repo.report(7);
    assert.equal(report.summary.calls, 2); assert.equal(report.summary.measured, 1);
    assert.equal(report.summary.total, 100); assert.equal(report.summary.failed, 1);
    assert.equal(report.recent.find((r) => r.id === "call-2").state, "interrupted");
    assert.equal(repo.report(0).costly[0].id, "old");
  } finally { db.close(); }
});

test("non-cached totals subtract only paired counters and retain unclassified input", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const repo = createUsageRepository(db);
    for (const [id, usage] of [["known", { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }], ["unknown", { input_tokens: 300, output_tokens: 0 }], ["zero", { input_tokens: 40, cached_input_tokens: 0, output_tokens: 0 }]]) {
      repo.record({ id, purpose: "chat", state: "completed", startedAt: Date.now(), usage });
    }
    const r = repo.report(0);
    assert.equal(r.summary.uncached, 60);
    assert.equal(r.summary.cached, 80);
    assert.equal(r.summary.unsplitInput, 300);
    assert.equal(r.summary.input, 440);
    assert.equal(r.groups[0].uncached, 60);
  } finally { db.close(); }
});
