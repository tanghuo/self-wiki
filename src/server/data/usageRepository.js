import { tokenUsage } from "../../shared/domain/tokenUsage.js";

export function createUsageRepository(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY, purpose TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL,
    started_at INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, input INTEGER, output INTEGER,
    cached INTEGER, reasoning INTEGER, total INTEGER, context TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS token_usage_started ON token_usage(started_at);
    UPDATE token_usage SET state='interrupted' WHERE state='running'`);
  const save = db.prepare(`INSERT INTO token_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET model=excluded.model,state=excluded.state,elapsed_ms=excluded.elapsed_ms,
    input=excluded.input,output=excluded.output,cached=excluded.cached,reasoning=excluded.reasoning,total=excluded.total,context=excluded.context`);
  const aggregates = `COUNT(*) AS calls, COUNT(total) AS measured, SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed,
    SUM(input) AS input, SUM(output) AS output, SUM(cached) AS cached, SUM(reasoning) AS reasoning,
    SUM(CASE WHEN cached BETWEEN 0 AND input THEN input-cached END) AS uncached,
    SUM(CASE WHEN input IS NOT NULL AND (cached IS NULL OR cached>input) THEN input ELSE 0 END) AS unsplitInput,
    SUM(total) AS total, SUM(elapsed_ms) AS elapsedMs`;
  return {
    record({ id, purpose, model = "", state, startedAt, elapsedMs = 0, usage, context = {} }) {
      const u = tokenUsage(usage);
      save.run(id, purpose, model ?? "", state, startedAt, elapsedMs, u.input, u.output, u.cached, u.reasoning, u.total, JSON.stringify(context));
    },
    report(days = 7) {
      const since = days ? Date.now() - days * 86400000 : 0;
      return { since, summary: db.prepare(`SELECT ${aggregates} FROM token_usage WHERE started_at>=?`).get(since),
        groups: db.prepare(`SELECT purpose,model,${aggregates} FROM token_usage WHERE started_at>=? GROUP BY purpose,model ORDER BY total DESC`).all(since),
        costly: db.prepare(`SELECT * FROM token_usage WHERE started_at>=? ORDER BY total DESC, started_at DESC LIMIT 100`).all(since).map((r) => ({ ...r, context: JSON.parse(r.context) })),
        recent: db.prepare(`SELECT * FROM token_usage WHERE started_at>=? ORDER BY started_at DESC LIMIT 100`).all(since).map((r) => ({ ...r, context: JSON.parse(r.context) })) };
    },
  };
}
