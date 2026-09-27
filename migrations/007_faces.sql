CREATE TABLE face_profile (
 id INTEGER PRIMARY KEY CHECK(id=1), pipeline_id TEXT NOT NULL, model_id TEXT NOT NULL,
 dimension INTEGER NOT NULL CHECK(dimension BETWEEN 16 AND 4096)
);
CREATE TABLE face_jobs (
 id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 mode TEXT NOT NULL CHECK(mode IN ('incremental','retry_failed')), folder_id TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('running','paused','paused_offline','completed','completed_with_errors','failed','cancelled')),
 error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX face_one_active_job ON face_jobs((1)) WHERE status IN ('running','paused','paused_offline');
CREATE TABLE face_items (
 job_id TEXT NOT NULL REFERENCES face_jobs(id) ON DELETE CASCADE,
 photo_id TEXT NOT NULL,
 checksum TEXT NOT NULL, owner_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','skipped','cancelled')),
 error TEXT NOT NULL DEFAULT '', PRIMARY KEY(job_id,photo_id)
);
CREATE INDEX face_items_status ON face_items(job_id,status,photo_id);
CREATE TABLE face_analyses (
 id TEXT PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
 checksum TEXT NOT NULL, owner_id TEXT NOT NULL, pipeline_id TEXT NOT NULL,
 width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(photo_id,checksum,pipeline_id)
);
CREATE TABLE people (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 name TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
 merged_into TEXT REFERENCES people(id), created_at TEXT NOT NULL
);
CREATE TABLE faces (
 id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL REFERENCES face_analyses(id) ON DELETE CASCADE,
 face_index INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
 score REAL NOT NULL, embedding BLOB, person_id TEXT REFERENCES people(id),
 manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0,1)),
 ignored INTEGER NOT NULL DEFAULT 0 CHECK(ignored IN (0,1)), revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(analysis_id,face_index)
);
CREATE INDEX faces_person ON faces(person_id,ignored);
CREATE INDEX analyses_photo ON face_analyses(photo_id);
CREATE TABLE face_exclusions (
 face_id TEXT NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
 person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE, PRIMARY KEY(face_id,person_id)
);
-- Invalidating at the database boundary also covers index reset, imports and owner transfers.
-- Conservative: owner changes require a fresh scan instead of carrying private labels.
CREATE TRIGGER face_invalidate_photo AFTER UPDATE OF checksum,owner_id ON photos
WHEN OLD.checksum != NEW.checksum OR OLD.owner_id != NEW.owner_id
BEGIN
 DELETE FROM face_analyses WHERE photo_id=NEW.id;
END;
