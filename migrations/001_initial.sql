CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    parent_id TEXT REFERENCES folders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    storage_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_shared INTEGER NOT NULL DEFAULT 0 CHECK (is_shared IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS folders_parent_name_unique
    ON folders (IFNULL(parent_id, ''), name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    storage_path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size > 0),
    width INTEGER,
    height INTEGER,
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    captured_at TEXT NOT NULL,
    captured_at_source TEXT NOT NULL CHECK (captured_at_source IN ('exif', 'file_mtime')),
    file_created_at TEXT,
    indexed_at TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    scan_status TEXT NOT NULL DEFAULT 'indexed' CHECK (scan_status IN ('indexed', 'missing', 'error')),
    camera_make TEXT,
    camera_model TEXT,
    orientation INTEGER CHECK (orientation IS NULL OR orientation BETWEEN 1 AND 8),
    focal_length REAL CHECK (focal_length IS NULL OR focal_length >= 0),
    aperture REAL CHECK (aperture IS NULL OR aperture >= 0),
    iso INTEGER CHECK (iso IS NULL OR iso >= 0),
    gps_latitude REAL CHECK (gps_latitude IS NULL OR gps_latitude BETWEEN -90 AND 90),
    gps_longitude REAL CHECK (gps_longitude IS NULL OR gps_longitude BETWEEN -180 AND 180),
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type = 'folder'),
    resource_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
    created_at TEXT NOT NULL,
    UNIQUE (resource_type, resource_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS users_role_active_idx ON users (role, is_active);
CREATE INDEX IF NOT EXISTS folders_owner_parent_idx ON folders (owner_id, parent_id);
CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders (parent_id);
CREATE INDEX IF NOT EXISTS photos_owner_captured_idx ON photos (owner_id, captured_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS photos_folder_captured_idx ON photos (folder_id, captured_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS photos_checksum_idx ON photos (checksum);
CREATE INDEX IF NOT EXISTS photos_scan_status_idx ON photos (scan_status);
CREATE INDEX IF NOT EXISTS shares_resource_idx ON shares (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS shares_user_idx ON shares (user_id);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
