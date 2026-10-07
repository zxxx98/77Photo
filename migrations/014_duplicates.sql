CREATE INDEX photos_active_duplicate_idx ON photos(owner_id, checksum, id)
WHERE deleted_at IS NULL AND scan_status='indexed' AND mime_type LIKE 'image/%';

CREATE TABLE duplicate_features (
    photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    checksum TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    pipeline TEXT NOT NULL,
    phash TEXT NOT NULL,
    sharpness REAL NOT NULL,
    exposure REAL NOT NULL,
    embedding BLOB,
    local_features TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(photo_id, pipeline)
);
CREATE INDEX duplicate_features_pipeline_idx ON duplicate_features(pipeline,owner_id,photo_id);
CREATE TABLE duplicate_pairs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('perceptual','ai')),
    photo_a TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    photo_b TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    checksum_a TEXT NOT NULL,
    checksum_b TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    pipeline TEXT NOT NULL,
    generation TEXT NOT NULL,
    score REAL NOT NULL,
    reason TEXT NOT NULL
);
CREATE INDEX duplicate_pairs_kind_idx ON duplicate_pairs(kind,generation,id);
CREATE TABLE duplicate_pair_generations (
    kind TEXT PRIMARY KEY CHECK(kind IN ('perceptual','ai')),
    generation TEXT NOT NULL
);
CREATE TABLE duplicate_jobs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK(mode IN ('perceptual','ai')),
    pipeline TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','paused','completed','cancelled','failed')),
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX duplicate_job_active_idx ON duplicate_jobs((1)) WHERE status IN ('running','paused');
CREATE TABLE duplicate_job_items (
    job_id TEXT NOT NULL REFERENCES duplicate_jobs(id) ON DELETE CASCADE,
    photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    checksum TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed','skipped')),
    error TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(job_id,photo_id)
);
CREATE INDEX duplicate_job_pending_idx ON duplicate_job_items(job_id,status,photo_id);
-- Durable reviewed manifests let a lost HTTP response retry the same cleanup.
CREATE TABLE duplicate_cleanup_requests (
    id TEXT PRIMARY KEY,
    keeper_json TEXT NOT NULL,
    remove_json TEXT NOT NULL,
    exact INTEGER NOT NULL CHECK(exact IN (0,1))
);
