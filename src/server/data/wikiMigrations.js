import { migrateElementMaterial } from "./elementMaterialMigration.js";
import { migrateImageDimensions } from "./imageDimensionsMigration.js";
import { migrateChatEffort } from "./chatEffortMigration.js";
import { migrateChatImageOptions } from "./chatImageOptionsMigration.js";
import { migrateVideoOrganization } from "./videoOrganizationMigration.js";
import { migrateElementUsage } from "./elementUsageMigration.js";
import { migrateChatModelPreference } from "./chatModelPreferenceMigration.js";
import { migrateChatTrace } from "./chatTraceMigration.js";
import { migrateRelationDirections } from "./relationDirectionMigration.js";
import { migrateNeutralText } from "./neutralTextMigration.js";
import { migrateOrganization } from "./organizationMigration.js";
import { migrateSemantic } from "./semanticMigration.js";
import { migrateChat } from "./chatMigration.js";
import { migrateOrganizationProvenance } from "./organizationProvenanceMigration.js";
import { migrateChatModels } from "./chatModelMigration.js";
import { migrateChatImageEdits } from "./chatImageEditMigration.js";
import { migrateElementLifecycle, migrateChatFileCopies } from "./elementLifecycleMigration.js";
import { migrateChatContent } from "./chatContentMigration.js";
import { migrateVocabulary } from "./vocabularyMigration.js";
import { migrateChatDrafts } from "./chatDraftMigration.js";
import { migrateChatBranches } from "./chatBranchMigration.js";
import { migrateChatSessionStarts } from "./chatSessionStartMigration.js";
import { migrateChatAttachments } from "./chatAttachmentMigration.js";
import { migrateChatDirectImages } from "./chatDirectImageMigration.js";
import { migrateElementCreationSource } from "./elementCreationSourceMigration.js";
import { migrateChatReferences } from "./chatReferenceMigration.js";

import { migrateChatWebConversations } from "./chatWebConversationMigration.js";
import { migrateChatComposerStorage } from "./chatComposerStorageMigration.js";
import { migrateVideos } from "./videoMigration.js";
import { migrateVideoMarkers } from "./videoMarkerMigration.js";
import { migrateVideoAnalysis } from "./videoAnalysisMigration.js";
import { migrateVideoAnalysisConsistency } from "./videoAnalysisConsistencyMigration.js";
import { migrateVideoAnalysisApplication } from "./videoAnalysisApplicationMigration.js";

export function migrateWiki(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS wiki_schema (version INTEGER PRIMARY KEY CHECK (version > 0))");
    const versions = db.prepare("SELECT version FROM wiki_schema ORDER BY version").all();
    if (versions.some(({ version }) => ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39].includes(version))) throw new Error("Unsupported Wiki schema version");
    if (!versions.length) {
      db.exec(`
        CREATE TABLE elements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind INTEGER NOT NULL CHECK (kind IN (1, 2)),
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          CHECK (kind != 2 OR body = ''),
          CHECK (kind != 1 OR length(trim(title)) > 0 OR length(trim(body)) > 0)
        );
        CREATE TABLE element_images (
          element_id INTEGER PRIMARY KEY REFERENCES elements(id),
          storage_key TEXT NOT NULL UNIQUE,
          mime_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL CHECK (byte_size > 0),
          original_name TEXT NOT NULL
        );
        CREATE TABLE element_relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          left_id INTEGER NOT NULL REFERENCES elements(id),
          right_id INTEGER NOT NULL REFERENCES elements(id),
          created_at TEXT NOT NULL,
          CHECK (left_id < right_id),
          UNIQUE (left_id, right_id)
        );
        CREATE INDEX idx_elements_updated ON elements(deleted_at, updated_at DESC, id DESC);
        CREATE INDEX idx_relations_right ON element_relations(right_id, left_id);
        INSERT INTO wiki_schema VALUES (1);
      `);
    }
    if (!versions.some(({ version }) => version === 2)) {
      db.exec(`
        ALTER TABLE element_images ADD COLUMN content_hash TEXT;
        CREATE INDEX idx_image_hash ON element_images(content_hash);
        CREATE TABLE tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE element_tags (
          element_id INTEGER NOT NULL REFERENCES elements(id),
          tag_id INTEGER NOT NULL REFERENCES tags(id),
          PRIMARY KEY (element_id, tag_id)
        );
        CREATE INDEX idx_element_tags_tag ON element_tags(tag_id, element_id);
        INSERT INTO wiki_schema VALUES (2);
      `);
    }
    if (!versions.some(({ version }) => version === 3)) {
      db.exec(`
        CREATE TABLE canvas_positions (
          element_id INTEGER PRIMARY KEY REFERENCES elements(id),
          x REAL NOT NULL CHECK (x BETWEEN -1000000 AND 1000000),
          y REAL NOT NULL CHECK (y BETWEEN -1000000 AND 1000000)
        );
        INSERT INTO wiki_schema VALUES (3);
      `);
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Wiki foreign key check failed");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  migrateNeutralText(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM wiki_schema WHERE version = 5").get()) {
      db.exec(`
        CREATE TABLE relations_v5 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES elements(id),
          target_id INTEGER NOT NULL REFERENCES elements(id),
          kind INTEGER NOT NULL CHECK (kind IN (1, 2)),
          name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 60),
          created_at TEXT NOT NULL,
          CHECK (source_id != target_id AND (kind != 1 OR source_id < target_id)),
          UNIQUE (source_id, target_id, kind, name)
        );
        INSERT INTO relations_v5 (id, source_id, target_id, kind, created_at)
          SELECT id, source_id, target_id, kind, created_at FROM element_relations;
        UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'element_relations'), 0)) WHERE name = 'relations_v5';
        DROP TABLE element_relations;
        ALTER TABLE relations_v5 RENAME TO element_relations;
        CREATE INDEX idx_relations_target ON element_relations(target_id, source_id);
        INSERT INTO wiki_schema VALUES (5);
      `);
    }
    if (!db.prepare("SELECT 1 FROM wiki_schema WHERE version = 6").get()) {
      db.exec(`
        CREATE TABLE tag_relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES elements(id),
          tag_id INTEGER NOT NULL REFERENCES tags(id),
          name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 60),
          created_at TEXT NOT NULL,
          UNIQUE (source_id, tag_id, name)
        );
        CREATE INDEX idx_tag_relations_tag ON tag_relations(tag_id, source_id);
        CREATE VIEW resolved_element_relations AS
          SELECT id, source_id, target_id, kind, name, NULL AS tag_relation_id, NULL AS target_tag
          FROM element_relations
          UNION ALL
          SELECT 'tag:' || r.id || ':' || et.element_id, r.source_id, et.element_id, 3, r.name, r.id, t.name
          FROM tag_relations r JOIN tags t ON t.id = r.tag_id
          JOIN element_tags et ON et.tag_id = r.tag_id
          WHERE r.source_id != et.element_id;
        INSERT INTO wiki_schema VALUES (6);
      `);
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Relation migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  migrateOrganization(db);
  migrateSemantic(db);
  migrateChat(db);
  migrateOrganizationProvenance(db);
  migrateChatModels(db);
  migrateRelationDirections(db);
  migrateChatImageEdits(db);
  migrateElementLifecycle(db);
  migrateChatFileCopies(db);
  migrateChatContent(db);
  migrateVocabulary(db);
  migrateChatDrafts(db);
  migrateChatBranches(db);
  migrateChatEffort(db);
  migrateChatTrace(db);
  migrateChatModelPreference(db);
  migrateChatSessionStarts(db);
  migrateElementCreationSource(db);
  migrateChatReferences(db);
  migrateChatAttachments(db);
  migrateChatDirectImages(db);
  migrateChatWebConversations(db);
  migrateChatComposerStorage(db);
  migrateVideos(db);
  migrateVideoMarkers(db);
  migrateVideoAnalysis(db);
  migrateVideoAnalysisConsistency(db);
  migrateVideoAnalysisApplication(db);
  migrateElementUsage(db);
  migrateChatImageOptions(db);
  migrateVideoOrganization(db);
  migrateImageDimensions(db);
  migrateElementMaterial(db);
}
