import { relationPresets } from "../../shared/domain/elements.js";

export function migrateVocabulary(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=17").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE tag_aliases (
        alias_id INTEGER PRIMARY KEY REFERENCES tags(id),
        canonical_id INTEGER NOT NULL REFERENCES tags(id),
        CHECK(alias_id != canonical_id)
      );
      CREATE INDEX idx_tag_aliases_canonical ON tag_aliases(canonical_id);
      CREATE TABLE relation_terms (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
        reverse_name TEXT NOT NULL DEFAULT '' CHECK(length(reverse_name)<=60),
        directed INTEGER NOT NULL CHECK(directed IN(0,1)),
        CHECK((directed=0 AND reverse_name='') OR (directed=1 AND length(reverse_name)>0)),
        UNIQUE(name,reverse_name,directed)
      );
      CREATE TABLE relation_aliases (
        alias_id INTEGER PRIMARY KEY REFERENCES relation_terms(id),
        canonical_id INTEGER NOT NULL REFERENCES relation_terms(id),
        CHECK(alias_id != canonical_id)
      );
      CREATE INDEX idx_relation_aliases_canonical ON relation_aliases(canonical_id);
      CREATE VIEW resolved_tags AS
        WITH RECURSIVE paths(id,canonical_id) AS (
          SELECT id,id FROM tags UNION ALL
          SELECT p.id,a.canonical_id FROM paths p JOIN tag_aliases a ON a.alias_id=p.canonical_id
        ) SELECT p.id,t.id AS canonical_id,t.name,t.normalized_name FROM paths p JOIN tags t ON t.id=p.canonical_id
          WHERE NOT EXISTS(SELECT 1 FROM tag_aliases a WHERE a.alias_id=p.canonical_id);
      CREATE VIEW canonical_element_tags AS
        SELECT DISTINCT et.element_id,t.canonical_id AS tag_id FROM element_tags et JOIN resolved_tags t ON t.id=et.tag_id;
      CREATE VIEW resolved_relation_terms AS
        WITH RECURSIVE paths(id,canonical_id) AS (
          SELECT id,id FROM relation_terms UNION ALL
          SELECT p.id,a.canonical_id FROM paths p JOIN relation_aliases a ON a.alias_id=p.canonical_id
        ) SELECT p.id,t.id AS canonical_id,t.name,t.reverse_name,t.directed FROM paths p JOIN relation_terms t ON t.id=p.canonical_id
          WHERE NOT EXISTS(SELECT 1 FROM relation_aliases a WHERE a.alias_id=p.canonical_id);
      CREATE VIEW canonical_element_relations AS
        SELECT r.id,r.source_id,r.target_id,r.kind,coalesce(c.name,r.name) AS name,r.created_at,r.direction,
          coalesce(c.reverse_name,r.reverse_name) AS reverse_name
        FROM element_relations r LEFT JOIN relation_terms t
          ON r.kind=1 AND r.direction IN(-1,0,1) AND t.name=r.name AND t.reverse_name=r.reverse_name AND t.directed=abs(r.direction)
        LEFT JOIN resolved_relation_terms c ON c.id=t.id;
      CREATE VIEW visible_element_relations AS
        SELECT min(id) AS id,source_id,target_id,kind,name,min(created_at) AS created_at,direction,reverse_name
        FROM canonical_element_relations GROUP BY source_id,target_id,kind,name,direction,reverse_name;
      CREATE VIEW canonical_tag_relations AS
        SELECT r.id,r.source_id,tag.canonical_id AS tag_id,coalesce(c.name,r.name) AS name,r.created_at,r.direction,
          coalesce(c.reverse_name,r.reverse_name) AS reverse_name
        FROM tag_relations r JOIN resolved_tags tag ON tag.id=r.tag_id LEFT JOIN relation_terms t
          ON r.direction IN(-1,0,1) AND t.name=r.name AND t.reverse_name=r.reverse_name AND t.directed=abs(r.direction)
        LEFT JOIN resolved_relation_terms c ON c.id=t.id;
      CREATE VIEW visible_tag_relations AS
        SELECT min(id) AS id,source_id,tag_id,name,min(created_at) AS created_at,direction,reverse_name
        FROM canonical_tag_relations GROUP BY source_id,tag_id,name,direction,reverse_name;
      DROP VIEW resolved_element_relations;
      CREATE VIEW resolved_element_relations AS
        SELECT id,source_id,target_id,kind,name,NULL AS tag_relation_id,NULL AS target_tag,direction,reverse_name FROM visible_element_relations
        UNION ALL
        SELECT 'tag:'||r.id||':'||et.element_id,r.source_id,et.element_id,3,r.name,r.id,t.name,r.direction,r.reverse_name
        FROM visible_tag_relations r JOIN tags t ON t.id=r.tag_id JOIN canonical_element_tags et ON et.tag_id=r.tag_id
        WHERE r.source_id!=et.element_id;
    `);
    for (const preset of relationPresets) db.prepare("INSERT INTO relation_terms(name,reverse_name,directed) VALUES(?,?,?)")
      .run(preset.name, preset.reverseName, Number(preset.direction !== "symmetric"));
    for (const name of ["提示词", "prompt", "prompts"]) db.prepare("INSERT INTO tags(name,normalized_name) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM tags WHERE normalized_name=?)").run(name, name, name);
    db.exec(`INSERT INTO tag_aliases(alias_id,canonical_id) SELECT id,(SELECT id FROM tags WHERE normalized_name='提示词') FROM tags WHERE normalized_name IN('prompt','prompts');
      INSERT INTO wiki_schema VALUES(17);`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Vocabulary migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
