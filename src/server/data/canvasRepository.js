import { createVocabularyRepository } from "./vocabularyRepository.js";
import { relationDirection } from "./relationDirection.js";
import { elementError } from "../../shared/domain/elements.js";
import { maxCanvasNodes, maxCanvasEdges } from "../../shared/domain/canvas.js";

const kindNames = { 1: "text", 2: "image", 3: "session", 5: "video" };

export function createCanvasRepository(db, { publicOnly = false } = {}) {
  const vocabulary = createVocabularyRepository(db);
  function matching(q, tag) {
    const clauses = ["e.deleted_at IS NULL"];
    if (publicOnly) clauses.push("e.local_only=0");
    const values = [];
    if (q) {
      clauses.push("(e.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM element_images image WHERE image.element_id = e.id AND image.original_name LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM element_videos video WHERE video.element_id=e.id AND video.original_name LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM canonical_element_tags et JOIN resolved_tags c ON c.canonical_id=et.tag_id JOIN tags t ON t.id=c.id WHERE et.element_id=e.id AND t.name LIKE ? ESCAPE '\\'))");
      const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      values.push(search, search, search, search);
    }
    if (tag) {
      clauses.push("EXISTS (SELECT 1 FROM canonical_element_tags et JOIN tags t ON t.id=et.tag_id WHERE et.element_id=e.id AND t.normalized_name=?)");
      values.push(vocabulary.tag(tag)?.normalizedName ?? tag);
    }
    return { clauses, values };
  }

  function candidates(ids, q, tag, expand, limit) {
    const { clauses, values } = matching(expand ? "" : q, expand ? "" : tag);
    if (ids.length) {
      clauses.push("e.id NOT IN (SELECT value FROM json_each(?))");
      values.push(JSON.stringify(ids));
    }
    if (expand) {
      clauses.push(`e.id IN (SELECT target_id FROM resolved_element_relations WHERE source_id=?
        UNION ALL SELECT source_id FROM resolved_element_relations WHERE target_id=?)`);
      values.push(expand, expand);
    }
    return db.prepare(`SELECT e.id FROM elements e WHERE ${clauses.join(" AND ")} ORDER BY e.id DESC LIMIT ?`).all(...values, limit);
  }

  function overview({ ids, groupIds, q, limit }) {
    const { clauses, values } = matching(q, "");
    const where = clauses.join(" AND ");
    // Group the whole matching library before paging, so a folder's count does not
    // depend on how many element cards the client has already loaded.
    const buckets = `SELECT 'tag' AS bucket, t.id, t.name, count(*) AS count, max(e.id) AS latest
      FROM elements e JOIN canonical_element_tags et ON et.element_id=e.id JOIN tags t ON t.id=et.tag_id
      WHERE ${where} GROUP BY t.id
      UNION ALL SELECT 'element', e.id, '', 1, e.id FROM elements e
      WHERE ${where} AND NOT EXISTS (SELECT 1 FROM canonical_element_tags et WHERE et.element_id=e.id)`;
    const retained = "((bucket='tag' AND id IN (SELECT value FROM json_each(?))) OR (bucket='element' AND id IN (SELECT value FROM json_each(?))))";
    const bindings = [...values, ...values, JSON.stringify(groupIds), JSON.stringify(ids)];
    const active = db.prepare(`SELECT * FROM (${buckets}) WHERE ${retained}`).all(...bindings);
    const room = Math.min(limit, maxCanvasNodes - active.length);
    // Interleave both kinds so a large run of recent untagged items cannot hide
    // every folder (or the other way around) on the first page.
    const added = room ? db.prepare(`SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY bucket ORDER BY latest DESC, id DESC) AS batch_rank
      FROM (${buckets}) WHERE NOT ${retained}) ORDER BY batch_rank, bucket DESC LIMIT ?`).all(...bindings, room) : [];
    const selected = [...active, ...added];
    const counts = db.prepare(`SELECT bucket, count(*) AS total FROM (${buckets}) GROUP BY bucket`).all(...values, ...values);
    const totals = { groups: counts.find((row) => row.bucket === "tag")?.total || 0, untagged: counts.find((row) => row.bucket === "element")?.total || 0 };
    const groups = selected.filter((row) => row.bucket === "tag");
    const previews = db.prepare(`SELECT t.id, (SELECT json_group_array(json_object('id', id, 'kind', kind, 'summary', summary, 'originalName', original_name))
      FROM (SELECT e.id, e.kind, substr(e.body, 1, 100) AS summary, coalesce(i.original_name,v.original_name) AS original_name
        FROM canonical_element_tags et JOIN elements e ON e.id=et.element_id LEFT JOIN element_images i ON i.element_id=e.id
        LEFT JOIN element_videos v ON v.element_id=e.id
        WHERE et.tag_id=t.id AND ${where} ORDER BY e.id DESC LIMIT 3)) AS previews
      FROM tags t WHERE t.id IN (SELECT value FROM json_each(?))`).all(...values, JSON.stringify(groups.map((group) => group.id)));
    const byGroup = new Map(previews.map((row) => [row.id, JSON.parse(row.previews).map((item) => ({
      id: item.id, kind: kindNames[item.kind], summary: item.summary,
      ...(item.kind === 2 ? { image: { originalName: item.originalName }, thumbnailUrl: `/api/elements/${item.id}/thumbnail` } : {}),
      ...(item.kind === 5 ? { video: { originalName: item.originalName, url: `/api/elements/${item.id}/video` } } : {}),
    }))]));
    return {
      ids: selected.filter((row) => row.bucket === "element").map((row) => row.id),
      groups: groups.map(({ id, name, count }) => ({ id, name, count, previews: byGroup.get(id) })),
      totals, hasMore: totals.groups + totals.untagged > selected.length,
    };
  }

  return {
    read({ ids, q, tag, limit, expand, view = "flat", groupIds = [] }) {
      // One synchronous read transaction keeps nodes and their edges in the same snapshot.
      db.exec("BEGIN");
      try {
        const grouped = view === "tags" && !tag ? overview({ ids, groupIds, q, limit }) : null;
        const active = grouped ? grouped.ids : db.prepare(`SELECT id FROM elements WHERE deleted_at IS NULL ${publicOnly ? "AND local_only=0" : ""} AND id IN (SELECT value FROM json_each(?))`)
          .all(JSON.stringify(ids)).map((row) => row.id);
        if (expand && !active.includes(expand)) throw elementError("请先把要展开的内容加入画布", 400);
        const room = grouped ? 0 : Math.min(limit, maxCanvasNodes - active.length);
        const added = room ? candidates(active, q, tag, expand, room).map((row) => row.id) : [];
        const selected = JSON.stringify([...active, ...added]);
        const elements = db.prepare(`SELECT e.id, e.kind, coalesce(i.original_name,v.original_name) AS original_name, substr(e.body, 1, 240) AS summary, p.x, p.y,
          (SELECT json_group_array(t.name) FROM canonical_element_tags et JOIN tags t ON t.id=et.tag_id WHERE et.element_id=e.id) AS tags,
          (SELECT json_group_array(json_object('name',t.name,'resultId',b.result_id)) FROM organization_bindings b JOIN resolved_tags t ON t.id=b.tag_id WHERE b.element_id=e.id) AS ai_tags
          FROM elements e LEFT JOIN canvas_positions p ON p.element_id=e.id
          LEFT JOIN element_images i ON i.element_id=e.id
          LEFT JOIN element_videos v ON v.element_id=e.id
          WHERE e.id IN (SELECT value FROM json_each(?)) ORDER BY e.id DESC`).all(selected).map((row) => ({
          id: row.id, kind: kindNames[row.kind], summary: row.summary,
          tags: JSON.parse(row.tags), aiTags: JSON.parse(row.ai_tags), position: view === "tags" || row.x === null ? null : { x: row.x, y: row.y },
          ...(row.kind === 2 ? { image: { originalName: row.original_name }, thumbnailUrl: `/api/elements/${row.id}/thumbnail` } : {}),
          ...(row.kind === 5 ? { video: { originalName: row.original_name, url: `/api/elements/${row.id}/video` } } : {}),
        }));
        const edges = db.prepare(`SELECT id, source_id, target_id, kind, name, direction, reverse_name, tag_relation_id, target_tag FROM resolved_element_relations
          WHERE source_id IN (SELECT value FROM json_each(?)) AND target_id IN (SELECT value FROM json_each(?))
          ORDER BY id DESC LIMIT ?`).all(selected, selected, maxCanvasEdges + 1);
        const selectedIds = elements.map((row) => row.id);
        const result = {
          elements, relations: edges.slice(0, maxCanvasEdges).map((row) => ({ id: row.id, name: row.name, ...relationDirection(row),
            ...(!row.tag_relation_id && db.prepare("SELECT result_id AS aiResultId,modified AS aiModified FROM organization_bindings WHERE relation_id=?").get(row.id)), type: row.kind === 2 ? "title" : "related", sourceId: row.source_id, targetId: row.target_id, elementIds: [row.source_id, row.target_id],
            ...(row.tag_relation_id ? { tagRelationId: row.tag_relation_id, targetTag: row.target_tag } : {}) })),
          edgesTruncated: edges.length > maxCanvasEdges,
          hasMore: grouped ? grouped.hasMore : candidates(selectedIds, q, tag, null, 1).length > 0,
          ...(grouped ? { groups: grouped.groups, totals: grouped.totals } : {}),
          expansionHasMore: Boolean(expand && candidates(selectedIds, "", "", expand, 1).length),
        };
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    save(positions) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const count = db.prepare("SELECT count(*) AS total FROM elements WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))")
          .get(JSON.stringify(positions.map((entry) => entry.id))).total;
        if (count !== positions.length) throw elementError("部分内容已移入回收站，请刷新画布", 409);
        const upsert = db.prepare("INSERT INTO canvas_positions (element_id, x, y) VALUES (?, ?, ?) ON CONFLICT (element_id) DO UPDATE SET x=excluded.x, y=excluded.y");
        for (const { id, x, y } of positions) upsert.run(id, x, y);
        db.exec("COMMIT");
        return { ok: true };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
