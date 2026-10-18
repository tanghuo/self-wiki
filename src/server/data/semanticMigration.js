export function migrateSemantic(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=8").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE semantic_state (id INTEGER PRIMARY KEY CHECK(id=1), space_key TEXT NOT NULL DEFAULT '');
      INSERT INTO semantic_state(id) VALUES(1);
      CREATE TABLE semantic_documents (
        element_id INTEGER PRIMARY KEY REFERENCES elements(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,
        state INTEGER NOT NULL DEFAULT 0 CHECK(state BETWEEN 0 AND 3),
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        token TEXT, error TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '', description_executor TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '', indexed_at INTEGER
      );
      CREATE INDEX semantic_pending ON semantic_documents(state,available_at,element_id);
      CREATE TABLE semantic_vectors (
        element_id INTEGER NOT NULL REFERENCES semantic_documents(element_id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL, revision INTEGER NOT NULL, space_key TEXT NOT NULL,
        embedding BLOB NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(element_id,chunk_index)
      );
      INSERT INTO semantic_documents(element_id) SELECT id FROM elements;
      CREATE TRIGGER semantic_new_element AFTER INSERT ON elements BEGIN
        INSERT INTO semantic_documents(element_id) VALUES(NEW.id);
      END;
      CREATE TRIGGER semantic_body_changed AFTER UPDATE OF body ON elements WHEN NEW.body != OLD.body BEGIN
        UPDATE semantic_documents SET revision=revision+1,state=0,attempts=0,available_at=0,token=NULL,error='',indexed_at=NULL WHERE element_id=NEW.id;
      END;
      CREATE TRIGGER semantic_visibility_changed AFTER UPDATE OF deleted_at ON elements WHEN NEW.deleted_at IS NOT OLD.deleted_at BEGIN
        UPDATE semantic_documents SET revision=revision+1,state=0,attempts=0,available_at=0,token=NULL,error='',indexed_at=NULL WHERE element_id=NEW.id;
      END;
      CREATE TRIGGER semantic_image_changed AFTER UPDATE OF content_hash,storage_key ON element_images
      WHEN NEW.content_hash IS NOT OLD.content_hash OR NEW.storage_key != OLD.storage_key BEGIN
        UPDATE semantic_documents SET revision=revision+1,state=0,attempts=0,available_at=0,token=NULL,error='',description='',description_executor='',indexed_at=NULL WHERE element_id=NEW.element_id;
      END;
      INSERT INTO wiki_schema VALUES(8);
      COMMIT;
    `);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
