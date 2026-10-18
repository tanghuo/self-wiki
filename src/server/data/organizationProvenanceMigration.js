export function migrateOrganizationProvenance(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=10").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE organization_results ADD COLUMN tracked INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE organization_bindings (
        result_id INTEGER NOT NULL REFERENCES organization_results(id) ON DELETE CASCADE,
        action_index INTEGER NOT NULL,
        element_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        tag_id INTEGER,
        relation_id INTEGER UNIQUE REFERENCES element_relations(id) ON DELETE CASCADE,
        modified INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(result_id, action_index),
        UNIQUE(element_id, tag_id),
        FOREIGN KEY(element_id, tag_id) REFERENCES element_tags(element_id, tag_id) ON DELETE CASCADE,
        CHECK((tag_id IS NULL) != (relation_id IS NULL))
      );
      CREATE TRIGGER organization_removed_tag BEFORE DELETE ON element_tags BEGIN
        INSERT OR IGNORE INTO organization_rejections(element_id,action_key)
          SELECT OLD.element_id,'tag:' || OLD.element_id || ':' || t.normalized_name
          FROM organization_bindings b JOIN tags t ON t.id=b.tag_id
          WHERE b.element_id=OLD.element_id AND b.tag_id=OLD.tag_id;
      END;
      CREATE TRIGGER organization_removed_relation BEFORE DELETE ON element_relations BEGIN
        INSERT OR IGNORE INTO organization_rejections(element_id,action_key)
          SELECT b.element_id,'relation:' || OLD.source_id || ':' || OLD.target_id || ':' || OLD.name
          FROM organization_bindings b WHERE b.relation_id=OLD.id;
      END;
      CREATE TRIGGER organization_edited_relation AFTER UPDATE OF name ON element_relations WHEN NEW.name != OLD.name BEGIN
        INSERT OR IGNORE INTO organization_rejections(element_id,action_key)
          SELECT b.element_id,'relation:' || OLD.source_id || ':' || OLD.target_id || ':' || OLD.name
          FROM organization_bindings b WHERE b.relation_id=OLD.id;
        UPDATE organization_bindings SET modified=1 WHERE relation_id=OLD.id;
      END;
      INSERT INTO wiki_schema VALUES(10);
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
