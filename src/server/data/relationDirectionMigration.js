export function migrateRelationDirections(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=12").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of ["element_relations", "tag_relations"]) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN direction INTEGER NOT NULL DEFAULT 0 CHECK(direction IN(-1,0,1,2));
        ALTER TABLE ${table} ADD COLUMN reverse_name TEXT NOT NULL DEFAULT '' CHECK(length(reverse_name)<=60);
        UPDATE ${table} SET direction=2 WHERE name IN('参考','参考了','被参考','改写','改写自','被改写为','生成','生成自','生成了','包含','属于')${table === "element_relations" ? " AND kind=1" : ""};`);
    }
    for (const table of ["element_relations", "tag_relations"]) {
      for (const event of ["INSERT", "UPDATE"]) db.exec(`CREATE TRIGGER ${table}_direction_${event.toLowerCase()} BEFORE ${event} ON ${table}
        WHEN (abs(NEW.direction)=1 AND (length(trim(NEW.name))=0 OR length(trim(NEW.reverse_name))=0))
          OR (NEW.direction IN(0,2) AND NEW.reverse_name!='')${table === "element_relations" ? " OR (NEW.kind=2 AND NEW.direction!=0)" : ""}
        BEGIN SELECT RAISE(ABORT,'关联方向与正反名称不完整，标题关联不能改变方向'); END;`);
    }
    db.exec(`DROP VIEW resolved_element_relations;
      CREATE VIEW resolved_element_relations AS
        SELECT id,source_id,target_id,kind,name,NULL AS tag_relation_id,NULL AS target_tag,direction,reverse_name FROM element_relations
        UNION ALL
        SELECT 'tag:'||r.id||':'||et.element_id,r.source_id,et.element_id,3,r.name,r.id,t.name,r.direction,r.reverse_name
        FROM tag_relations r JOIN tags t ON t.id=r.tag_id JOIN element_tags et ON et.tag_id=r.tag_id
        WHERE r.source_id!=et.element_id;
      CREATE TRIGGER organization_edited_relation_direction AFTER UPDATE OF direction,reverse_name ON element_relations
      WHEN NEW.direction!=OLD.direction OR NEW.reverse_name!=OLD.reverse_name BEGIN
        INSERT OR IGNORE INTO organization_rejections(element_id,action_key)
          SELECT b.element_id,'relation:'||OLD.source_id||':'||OLD.target_id||':'||OLD.name
          FROM organization_bindings b WHERE b.relation_id=OLD.id;
        UPDATE organization_bindings SET modified=1 WHERE relation_id=OLD.id;
      END;
      INSERT INTO wiki_schema VALUES(12);`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Relation direction migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
