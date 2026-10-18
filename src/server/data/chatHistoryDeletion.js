import { createHash } from "node:crypto";

// Called inside the element deletion transaction. File removal is retried after commit.
export function deleteChatHistory(db, elementId) {
  const bindings = db.prepare("SELECT turn_id,output_key FROM chat_element_bindings WHERE element_id=?").all(elementId);
  const session = db.prepare("SELECT session_id FROM chat_session_elements WHERE element_id=?").get(elementId);
  const artifacts = new Set(bindings.filter((b) => b.output_key.startsWith("image:")).map((b) => b.output_key.slice(6)));
  const textTurns = new Set(bindings.filter((b) => {
    if (!b.output_key.startsWith("text:")) return false;
    const turn = db.prepare("SELECT answer FROM chat_turns WHERE id=?").get(b.turn_id);
    const key = createHash("sha256").update(JSON.stringify({ body: turn?.answer, excerpts: [] })).digest("hex");
    return b.output_key.startsWith(`text:${key}`);
  }).map((b) => b.turn_id));
  for (const job of db.prepare("SELECT extraction_turn_id FROM chat_prompt_jobs WHERE element_id=?").all(elementId)) if (job.extraction_turn_id) textTurns.add(job.extraction_turn_id);
  db.prepare(`UPDATE chat_prompt_jobs SET state=4,error='' WHERE element_id=? OR turn_id IN
    (SELECT id FROM chat_turns WHERE session_id=?) OR (turn_id,artifact) IN
    (SELECT turn_id,substr(output_key,7) FROM chat_element_bindings WHERE element_id=? AND output_key LIKE 'image:%')`).run(elementId, session?.session_id || 0, elementId);
  if (session) db.prepare("UPDATE chat_sessions SET title='已删除的会话',codex_thread_id=NULL WHERE id=?").run(session.session_id);
  const enqueue = (name) => db.prepare("INSERT OR IGNORE INTO chat_file_cleanup(name) VALUES(?)").run(name);
  const retainedByFork = (artifact) => session && db.prepare(`SELECT 1 FROM chat_turns t
    JOIN chat_session_elements s ON s.session_id=t.session_id AND s.element_id IS NOT NULL WHERE t.session_id!=? AND (
    EXISTS (SELECT 1 FROM json_each(t.events) WHERE json_extract(value,'$.artifact')=?) OR
    EXISTS (SELECT 1 FROM json_each(t.sources) WHERE json_extract(value,'$.imageArtifact')=?) OR
    EXISTS (SELECT 1 FROM json_each(t.input_attachments) WHERE json_extract(value,'$.artifact')=?)) LIMIT 1`)
    .get(session.session_id, artifact, artifact, artifact);
  const removed = (source) => {
    if (source.imageArtifact && !retainedByFork(source.imageArtifact)) artifacts.add(source.imageArtifact);
    return { id: source.id, kind: source.kind, label: "来源已删除", body: "", tags: [], deleted: true,
      ...(source.appearedAt !== undefined && { appearedAt: source.appearedAt, sequence: source.sequence }) };
  };
  const rows = db.prepare(`SELECT * FROM chat_turns WHERE session_id=? OR id IN (SELECT value FROM json_each(?))
    OR EXISTS (SELECT 1 FROM json_each(sources) WHERE json_extract(value,'$.id')=?)
    OR EXISTS (SELECT 1 FROM json_each(events) WHERE json_extract(value,'$.artifact') IN (SELECT value FROM json_each(?)))
    OR json_extract(image_edit,'$.artifact') IN (SELECT value FROM json_each(?))`)
    .all(session?.session_id || 0, JSON.stringify([...textTurns]), elementId, JSON.stringify([...artifacts]), JSON.stringify([...artifacts]));
  // A retained web thread still contains the redacted material. Stop reusing it.
  db.prepare("DELETE FROM chat_web_conversations WHERE session_id IN (SELECT value FROM json_each(?))")
    .run(JSON.stringify([...new Set([session?.session_id, ...rows.map(row => row.session_id)].filter(Boolean))]));
  const redactedTurns = new Set();
  for (const row of rows) {
    const whole = row.session_id === session?.session_id;
    let sources = JSON.parse(row.sources), events = JSON.parse(row.events);
    sources = sources.map((source) => whole || source.id === elementId ? removed(source) : source);
    if (whole) {
      redactedTurns.add(row.id);
      db.prepare("UPDATE chat_turns SET input_attachments='[]' WHERE id=?").run(row.id);
      for (const image of JSON.parse(row.input_attachments)) {
        if (!db.prepare("SELECT 1 FROM chat_turns,json_each(input_attachments) WHERE json_extract(value,'$.id')=? LIMIT 1").get(image.id)) {
          artifacts.add(image.artifact);
          db.prepare("DELETE FROM chat_attachments WHERE id=?").run(image.id);
        }
      }
      for (const event of events) if (event.artifact && !retainedByFork(event.artifact) && !db.prepare("SELECT 1 FROM chat_element_bindings WHERE output_key=? AND element_id IS NOT NULL").get(`image:${event.artifact}`)) artifacts.add(event.artifact);
    }
    events = events.map((event) => {
      if (whole || artifacts.has(event.artifact)) event = { ...event, parameters: {}, parametersDeleted: true };
      if (event.artifact && (whole || artifacts.has(event.artifact))) { const { artifact, ...rest } = event; return { ...rest, artifactDeleted: true }; }
      return event;
    });
    const imageEdit = JSON.parse(row.image_edit || "null");
    if (imageEdit && artifacts.has(imageEdit.artifact)) imageEdit.deleted = true;
    db.prepare("UPDATE chat_turns SET text=?,answer=?,sources=?,events=?,image_edit=? WHERE id=?").run(
      whole ? "[会话内容已删除]" : row.text, whole || textTurns.has(row.id) ? "" : row.answer, JSON.stringify(sources), JSON.stringify(events), JSON.stringify(imageEdit), row.id);
    db.prepare("UPDATE chat_sessions SET codex_thread_id=NULL WHERE id=?").run(row.session_id);
  }
  const affectedTurns = [...new Set([...textTurns, ...redactedTurns])];
  // Request snapshots and tool output can contain copies of sources or history.
  // Keep a tombstone so old snapshots cannot be recreated by a late tool reply.
  db.prepare(`UPDATE chat_trace_records SET data=NULL,version=version+1 WHERE data IS NOT NULL AND (
    turn_id IN (SELECT id FROM chat_turns WHERE session_id=?) OR turn_id IN (SELECT value FROM json_each(?))
    OR EXISTS (SELECT 1 FROM json_each(source_ids) WHERE value=?)
    OR EXISTS (SELECT 1 FROM json_each(history_turn_ids) WHERE value IN (SELECT value FROM json_each(?)))
    OR turn_id IN (SELECT turn_id FROM chat_element_bindings WHERE element_id=?))`)
    .run(session?.session_id || 0, JSON.stringify(affectedTurns), elementId, JSON.stringify(affectedTurns), elementId);
  const cleanExcerpt = (e) => redactedTurns.has(e.turnId) || textTurns.has(e.turnId) && e.role === "assistant"
    ? { turnId: e.turnId, role: e.role, deleted: true } : e;
  const records = db.prepare(`SELECT b.* FROM chat_element_bindings b JOIN chat_turns t ON t.id=b.turn_id
    WHERE b.element_id=? OR t.session_id=? OR b.turn_id IN (SELECT value FROM json_each(?))
    OR EXISTS (SELECT 1 FROM json_each(b.data,'$.sources') WHERE json_extract(value,'$.id')=?)
    OR EXISTS (SELECT 1 FROM json_each(b.data,'$.excerpts') WHERE json_extract(value,'$.turnId') IN (SELECT value FROM json_each(?)))
    OR json_extract(b.data,'$.imageEdit.artifact') IN (SELECT value FROM json_each(?))`)
    .all(elementId, session?.session_id || 0, JSON.stringify(affectedTurns), elementId, JSON.stringify(affectedTurns), JSON.stringify([...artifacts]));
  for (const row of records) {
    let data = JSON.parse(row.data);
    if (row.element_id === elementId) data = {};
    else {
      if (data.sources) data.sources = data.sources.map((source) => source.id === elementId || redactedTurns.has(row.turn_id) ? removed(source) : source);
      if (textTurns.has(row.turn_id)) delete data.originalAnswer;
      if (data.excerpts) data.excerpts = data.excerpts.map(cleanExcerpt);
      if (redactedTurns.has(row.turn_id)) { delete data.text; delete data.originalAnswer; delete data.parameters; data.historyDeleted = true; }
      if (data.imageEdit && artifacts.has(data.imageEdit.artifact)) data.imageEdit.deleted = true;
    }
    db.prepare("UPDATE chat_element_bindings SET data=? WHERE turn_id=? AND output_key=?").run(JSON.stringify(data), row.turn_id, row.output_key);
  }
  for (const row of db.prepare(`SELECT * FROM chat_proposals WHERE json_extract(changes,'$.createdId')=?
    OR EXISTS (SELECT 1 FROM json_each(snapshots) WHERE json_extract(value,'$.id')=?)
    OR EXISTS (SELECT 1 FROM json_each(after_snapshots) WHERE json_extract(value,'$.id')=?)
    OR turn_id IN (SELECT value FROM json_each(?))
    OR EXISTS (SELECT 1 FROM json_each(payload,'$.excerpts') WHERE json_extract(value,'$.turnId') IN (SELECT value FROM json_each(?)))`)
    .all(elementId, elementId, elementId, JSON.stringify(affectedTurns), JSON.stringify(affectedTurns))) {
    const payload = JSON.parse(row.payload), changes = JSON.parse(row.changes);
    const clean = (raw) => JSON.stringify(JSON.parse(raw).map((s) => s.id === elementId ? removed(s) : s));
    if (payload.excerpts) payload.excerpts = payload.excerpts.map(cleanExcerpt);
    const invalid = payload.excerpts?.some((e) => e.deleted) || redactedTurns.has(row.turn_id) || JSON.parse(row.snapshots).some((s) => s.id === elementId);
    if (changes.createdId === elementId || row.state === 0 && invalid) { payload.body = ""; payload.reason = "来源内容已删除"; }
    db.prepare("UPDATE chat_proposals SET payload=?,snapshots=?,after_snapshots=?,state=? WHERE id=?").run(JSON.stringify(payload), clean(row.snapshots), clean(row.after_snapshots), row.state === 0 && invalid ? 2 : row.state, row.id);
  }
  for (const artifact of artifacts) {
    enqueue(artifact);
    for (const copy of db.prepare("SELECT path FROM chat_file_copies WHERE artifact=?").all(artifact)) enqueue(`workspace:${copy.path}`);
    db.prepare("DELETE FROM chat_file_copies WHERE artifact=?").run(artifact);
  }
}
