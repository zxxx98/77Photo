-- Keep non-rebuildable motion originals distinct from derived motion caches.
CREATE TABLE photo_motion_sources (
    photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('uploaded', 'scanned', 'embedded')),
    source_path TEXT NOT NULL DEFAULT '',
    photo_checksum TEXT NOT NULL
);

-- Durable intent is committed before moving any files. The manifest contains
-- only server-generated relative paths and hashes, never client paths.
CREATE TABLE trash_items (
    photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE RESTRICT,
    deleted_by TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    original_path TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('moving', 'trashed', 'restoring', 'purging')),
    files_json TEXT NOT NULL,
    restore_folder_id TEXT NOT NULL DEFAULT '',
    restore_name TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX trash_expiry_idx ON trash_items(state, expires_at, photo_id);
CREATE INDEX trash_deleted_idx ON trash_items(deleted_at DESC, photo_id DESC);
