import { createHash } from "node:crypto";
import { elementError, elementKindLabels } from "../../shared/domain/elements.js";
import { suppressVideoObservation, suppressCorrectedVideoMarker } from "./videoAnalysisRepository.js";

const kindNames = { 1: "text", 2: "image", 3: "session", 5: "video" };

export function createVideoMarkerRepository(db, { getElement, vocabulary, publicOnly }) {
  const visible = publicOnly ? " AND e.local_only=0" : "";
  function transaction(work) {
    if (db.isTransaction) return work();
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function video(id) {
    if (getElement(id).kind !== "video") throw elementError("只有视频可以添加时间标注");
  }
  function present(row) {
    if (!row) throw elementError("视频标注不存在", 404);
    const tags = db.prepare(`SELECT t.name FROM canonical_video_marker_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.marker_id=? ORDER BY t.id`).all(row.id).map((t) => t.name);
    const links = db.prepare(`SELECT e.id,e.kind,e.body,e.deleted_at,coalesce(i.original_name,v.original_name) AS original_name
      FROM video_marker_links l JOIN elements e ON e.id=l.target_id LEFT JOIN element_images i ON i.element_id=e.id
      LEFT JOIN element_videos v ON v.element_id=e.id WHERE l.marker_id=?${visible} ORDER BY e.id`).all(row.id).map((e) => ({
      id: e.id, kind: kindNames[e.kind], label: e.body.slice(0, 90) || e.original_name || elementKindLabels[kindNames[e.kind]], unavailable: Boolean(e.deleted_at),
    }));
    return { id: row.id, videoId: row.video_id, startMs: row.start_ms, endMs: row.end_ms, body: row.body, tags, links,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      origin: ["manual", "ai", "corrected"][row.origin ?? 0], analysisRunId: row.analysis_run_id ?? null, observationId: row.observation_id ?? null };
  }
  function get(id) {
    const row = db.prepare("SELECT * FROM video_markers WHERE id=?").get(id);
    if (!row) throw elementError("视频标注不存在", 404);
    video(row.video_id);
    return present(row);
  }
  function saveBindings(id, videoId, content) {
    const existing = new Set(db.prepare("SELECT target_id FROM video_marker_links WHERE marker_id=?").all(id).map((r) => r.target_id));
    for (const targetId of content.targetIds) {
      if (targetId === videoId) throw elementError("标注已属于当前视频，无需关联自身");
      if (!existing.has(targetId)) getElement(targetId);
    }
    const canonicalNames = vocabulary.tags(content.tags);
    db.prepare(`DELETE FROM video_marker_tags WHERE marker_id=? AND tag_id NOT IN
      (SELECT id FROM resolved_tags WHERE normalized_name IN(SELECT value FROM json_each(?)))`).run(id, JSON.stringify(canonicalNames));
    for (const name of content.tags) {
      const canonical = vocabulary.tag(name);
      if (canonical && db.prepare("SELECT 1 FROM canonical_video_marker_tags WHERE marker_id=? AND tag_id=?").get(id, canonical.id)) continue;
      db.prepare("INSERT INTO tags(name,normalized_name) VALUES(?,?) ON CONFLICT(normalized_name) DO NOTHING").run(name, name.toLowerCase());
      const tagId = db.prepare("SELECT id FROM tags WHERE normalized_name=?").get(name.toLowerCase()).id;
      db.prepare("INSERT INTO video_marker_tags VALUES(?,?)").run(id, tagId);
    }
    db.prepare("DELETE FROM video_marker_links WHERE marker_id=? AND target_id NOT IN(SELECT value FROM json_each(?))").run(id, JSON.stringify(content.targetIds));
    for (const targetId of content.targetIds) db.prepare("INSERT OR IGNORE INTO video_marker_links VALUES(?,?)").run(id, targetId);
  }
  function touch(id) { db.prepare("UPDATE elements SET updated_at=? WHERE id=?").run(new Date().toISOString(), id); }
  return {
    get,
    list(videoId, { q = "", tags = [], page = 1, pageSize = 36 } = {}) {
      video(videoId);
      const clauses = ["m.video_id=?"], values = [videoId];
      if (q) {
        const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
        clauses.push(`(m.body LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM video_marker_tags mt JOIN resolved_tags c ON c.id=mt.tag_id
          JOIN resolved_tags alias ON alias.canonical_id=c.canonical_id JOIN tags t ON t.id=alias.id WHERE mt.marker_id=m.id AND t.name LIKE ? ESCAPE '\\'))`);
        values.push(search, search);
      }
      for (const name of tags) {
        clauses.push("EXISTS(SELECT 1 FROM canonical_video_marker_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.marker_id=m.id AND t.normalized_name=?)");
        values.push(vocabulary.tag(name)?.normalizedName ?? name.toLowerCase());
      }
      const where = clauses.join(" AND ");
      const total = db.prepare(`SELECT count(*) AS n FROM video_markers m WHERE ${where}`).get(...values).n;
      const markers = db.prepare(`SELECT m.* FROM video_markers m WHERE ${where} ORDER BY start_ms,id LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize).map(present);
      return { markers, pagination: { total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) } };
    },
    create(videoId, content) {
      return transaction(() => {
        video(videoId);
        const { requestKey, ...payload } = content;
        const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        const prior = db.prepare("SELECT * FROM video_markers WHERE video_id=? AND request_key=?").get(videoId, requestKey);
        if (prior) {
          if (prior.request_hash !== hash) throw elementError("标注请求标识已用于不同内容，请重新创建标注", 409);
          return { ...present(prior), reused: true };
        }
        if (db.prepare("SELECT count(*) AS n FROM video_markers WHERE video_id=?").get(videoId).n >= 500) throw elementError("每个视频最多保存 500 条标注");
        const now = new Date().toISOString();
        const id = Number(db.prepare("INSERT INTO video_markers(video_id,start_ms,end_ms,body,request_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(videoId, content.startMs, content.endMs, content.body, requestKey, hash, now, now).lastInsertRowid);
        saveBindings(id, videoId, content); touch(videoId); return get(id);
      });
    },
    update(id, content) {
      return transaction(() => {
        const previous = get(id);
        if (previous.origin === "corrected") suppressCorrectedVideoMarker(db, id, 1);
        if (!db.prepare("UPDATE video_markers SET start_ms=?,end_ms=?,body=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
          .run(content.startMs, content.endMs, content.body, new Date().toISOString(), id, content.revision).changes) throw elementError("标注已被修改，请刷新后重新编辑；当前草稿已保留", 409);
        if (previous.origin === "ai") {
          suppressVideoObservation(db, previous.observationId, 1);
          db.prepare("UPDATE video_markers SET origin=2 WHERE id=?").run(id);
        }
        saveBindings(id, previous.videoId, content); touch(previous.videoId); return get(id);
      });
    },
    remove(id, revision) {
      return transaction(() => {
        const previous = get(id);
        if (previous.revision !== revision) throw elementError("标注已被修改，请刷新后再删除", 409);
        if (previous.origin === "ai") suppressVideoObservation(db, previous.observationId);
        if (previous.origin === "corrected") suppressCorrectedVideoMarker(db, id);
        if (!db.prepare("DELETE FROM video_markers WHERE id=? AND revision=?").run(id, revision).changes) throw elementError("标注已被修改，请刷新后再删除", 409);
        touch(previous.videoId); return { ok: true };
      });
    },
    references(targetId, { page = 1, pageSize = 36 } = {}) {
      getElement(targetId);
      const from = `FROM video_marker_links l JOIN video_markers m ON m.id=l.marker_id JOIN elements e ON e.id=m.video_id
        JOIN element_videos v ON v.element_id=e.id WHERE l.target_id=? AND e.deleted_at IS NULL${visible}`;
      const total = db.prepare(`SELECT count(*) AS n ${from}`).get(targetId).n;
      const references = db.prepare(`SELECT m.id,m.video_id AS videoId,m.start_ms AS startMs,m.end_ms AS endMs,m.body,v.original_name AS videoName ${from}
        ORDER BY m.video_id DESC,m.start_ms,m.id LIMIT ? OFFSET ?`).all(targetId, pageSize, (page - 1) * pageSize);
      return { references, pagination: { total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) } };
    },
  };
}
