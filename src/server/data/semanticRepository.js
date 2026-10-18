import { createHash, randomUUID } from "node:crypto";
import { elementError } from "../../shared/domain/elements.js";
import { embeddingVector } from "../../shared/domain/embedding.js";

const states = ["pending", "running", "ready", "failed"];
export function semanticSpace(config) {
  return createHash("sha256").update(JSON.stringify(["chunks-1000-overlap-150-v1", config.provider, config.baseUrl,
    config.model, config.modelRevision, config.dimensions])).digest("hex");
}

export function createSemanticRepository(db) {
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function document(id) {
    return db.prepare(`SELECT d.*, e.kind, e.body, i.content_hash AS image_hash FROM semantic_documents d
      JOIN elements e ON e.id=d.element_id LEFT JOIN element_images i ON i.element_id=e.id
      WHERE e.id=? AND e.deleted_at IS NULL`).get(id);
  }
  function current(job) {
    const row = document(job.element_id);
    return row && row.state === 1 && row.token === job.token && row.revision === job.revision &&
      db.prepare("SELECT space_key FROM semantic_state WHERE id=1").get().space_key === job.spaceKey;
  }
  function reset(where) {
    return db.prepare(`UPDATE semantic_documents SET revision=revision+1,state=0,attempts=0,available_at=0,token=NULL,error='',indexed_at=NULL ${where}`).run().changes;
  }
  return {
    available() { try { db.prepare("SELECT vec_version()").get(); return true; } catch { return false; } },
    configure(config) {
      const spaceKey = semanticSpace(config);
      transaction(() => {
        if (db.prepare("SELECT space_key FROM semantic_state WHERE id=1").get().space_key !== spaceKey) {
          db.prepare("UPDATE semantic_state SET space_key=? WHERE id=1").run(spaceKey); reset("");
        } else db.prepare(`UPDATE semantic_documents SET revision=revision+1,state=CASE WHEN attempts>=3 THEN 3 ELSE 0 END,
          available_at=0,token=NULL,error='上次索引中断',indexed_at=NULL WHERE state=1`).run();
      });
      return spaceKey;
    },
    reset(mode) { return reset(mode === "retry" ? "WHERE state=3" : mode === "missing" ? "WHERE state IN(0,3)" : ""); },
    document,
    claim(spaceKey, excludedIds = [], canDescribeImages = true) {
      return transaction(() => {
        if (db.prepare("SELECT space_key FROM semantic_state WHERE id=1").get().space_key !== spaceKey) return null;
        const row = db.prepare(`SELECT d.element_id FROM semantic_documents d JOIN elements e ON e.id=d.element_id
          WHERE e.deleted_at IS NULL AND d.state=0 AND d.available_at<=? AND d.element_id NOT IN(SELECT value FROM json_each(?))
          AND (? OR e.kind=1 OR d.description!='')
          ORDER BY e.kind,d.element_id LIMIT 1`).get(Date.now(), JSON.stringify(excludedIds), Number(canDescribeImages));
        if (!row) return null;
        const token = randomUUID();
        if (!db.prepare("UPDATE semantic_documents SET state=1,token=?,attempts=attempts+1,error='' WHERE element_id=? AND state=0").run(token, row.element_id).changes) return null;
        return { ...document(row.element_id), spaceKey };
      });
    },
    saveDescription(job, description, executor) {
      return transaction(() => {
        if (!current(job)) return false;
        return Boolean(db.prepare("UPDATE semantic_documents SET description=?,description_executor=? WHERE element_id=? AND token=?")
          .run(description, JSON.stringify(executor), job.element_id, job.token).changes);
      });
    },
    replaceDescription(id, revision, description, executor) {
      return transaction(() => {
        const row = document(id);
        if (!row || row.kind !== 2) throw elementError("图片不存在或不可修改说明", 404);
        if (row.revision !== revision) throw elementError("图片说明或搜索数据已更新，请刷新后重试", 409);
        const changed = db.prepare(`UPDATE semantic_documents SET description=?,description_executor=?,revision=revision+1,
          state=0,attempts=0,available_at=0,token=NULL,error='',indexed_at=NULL WHERE element_id=? AND revision=?`)
          .run(description, JSON.stringify(executor), id, revision);
        if (!changed.changes) throw elementError("图片说明已更新，请刷新后重试", 409);
        // Organization snapshots may have used the previous description as evidence.
        db.prepare("UPDATE organization_state SET epoch=epoch+1 WHERE id=1").run();
        return document(id);
      });
    },
    complete(job, chunks, vectors, dimensions) {
      if (!chunks.length || chunks.length !== vectors.length) throw elementError("索引分段与向量数量不符");
      const blobs = vectors.map((v) => new Uint8Array(embeddingVector(v, dimensions).buffer));
      const hash = createHash("sha256").update(JSON.stringify([job.body, job.image_hash, chunks])).digest("hex");
      return transaction(() => {
        if (!current(job)) return false;
        db.prepare("DELETE FROM semantic_vectors WHERE element_id=?").run(job.element_id);
        const insert = db.prepare("INSERT INTO semantic_vectors(element_id,chunk_index,revision,space_key,embedding,text) VALUES(?,?,?,?,?,?)");
        chunks.forEach((text, i) => insert.run(job.element_id, i, job.revision, job.spaceKey, blobs[i], text));
        return Boolean(db.prepare("UPDATE semantic_documents SET state=2,token=NULL,error='',indexed_at=?,content_hash=? WHERE element_id=? AND token=?")
          .run(Date.now(), hash, job.element_id, job.token).changes);
      });
    },
    failed(job, message, retryable = true) {
      if (!current(job)) return false;
      return Boolean(db.prepare("UPDATE semantic_documents SET state=?,token=NULL,error=?,available_at=? WHERE element_id=? AND token=?")
        .run(retryable && job.attempts < 3 ? 0 : 3, message.slice(0, 500), Date.now() + job.attempts * 10000, job.element_id, job.token).changes);
    },
    cancel(job) {
      if (!current(job)) return false;
      return Boolean(db.prepare("UPDATE semantic_documents SET state=0,token=NULL,attempts=max(0,attempts-1) WHERE element_id=? AND token=?")
        .run(job.element_id, job.token).changes);
    },
    status() {
      const counts = Object.fromEntries(states.map((s) => [s, 0]));
      for (const row of db.prepare("SELECT d.state,count(*) AS n FROM semantic_documents d JOIN elements e ON e.id=d.element_id WHERE e.deleted_at IS NULL GROUP BY d.state").all()) counts[states[row.state]] = row.n;
      const errors = db.prepare(`SELECT d.element_id AS elementId,d.error FROM semantic_documents d JOIN elements e ON e.id=d.element_id
        WHERE e.deleted_at IS NULL AND d.error!='' ORDER BY d.element_id DESC LIMIT 5`).all();
      return { counts, errors };
    },
    vectors(id, spaceKey) {
      return db.prepare(`SELECT v.embedding FROM semantic_vectors v JOIN semantic_documents d ON d.element_id=v.element_id
        JOIN elements e ON e.id=v.element_id WHERE v.element_id=? AND v.space_key=? AND v.revision=d.revision AND d.state=2 AND e.deleted_at IS NULL
        ORDER BY v.chunk_index`).all(id, spaceKey).map((r) => r.embedding);
    },
    search(vector, spaceKey, excludeId, limit) {
      // Filter deleted/stale/other-model rows before scoring; stale rows cannot crowd out valid hits.
      // SQLite's single min() aggregate takes the bare excerpt column from a row achieving that minimum.
      return db.prepare(`SELECT v.element_id AS elementId,v.text AS excerpt,min(vec_distance_cosine(v.embedding,?)) AS distance
        FROM semantic_vectors v JOIN semantic_documents d ON d.element_id=v.element_id JOIN elements e ON e.id=v.element_id
        WHERE v.space_key=? AND v.revision=d.revision AND d.state=2 AND e.deleted_at IS NULL AND e.id!=?
        GROUP BY v.element_id ORDER BY distance,v.element_id LIMIT ?`).all(vector, spaceKey, excludeId || 0, limit);
    },
  };
}
