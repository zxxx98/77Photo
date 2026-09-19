DROP TRIGGER IF EXISTS share_links_resource_insert;
DROP TRIGGER IF EXISTS share_links_resource_update;

CREATE TABLE photos_new (
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
    scan_status TEXT NOT NULL DEFAULT 'indexed' CHECK (scan_status IN ('indexed', 'missing', 'error', 'paired')),
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

INSERT INTO photos_new (
    id, owner_id, folder_id, storage_path, filename, mime_type, size, width, height,
    checksum, captured_at, captured_at_source, file_created_at, indexed_at,
    source_revision, scan_status, camera_make, camera_model, orientation,
    focal_length, aperture, iso, gps_latitude, gps_longitude, deleted_at,
    created_at, updated_at
)
SELECT
    id, owner_id, folder_id, storage_path, filename, mime_type, size, width, height,
    checksum, captured_at, captured_at_source, file_created_at, indexed_at,
    source_revision, scan_status, camera_make, camera_model, orientation,
    focal_length, aperture, iso, gps_latitude, gps_longitude, deleted_at,
    created_at, updated_at
FROM photos;

DROP TABLE photos;
ALTER TABLE photos_new RENAME TO photos;

CREATE INDEX photos_owner_captured_idx ON photos (owner_id, captured_at DESC, id DESC);
CREATE INDEX photos_folder_captured_idx ON photos (folder_id, captured_at DESC, id DESC);
CREATE INDEX photos_checksum_idx ON photos (checksum);
CREATE INDEX photos_scan_status_idx ON photos (scan_status);

CREATE TRIGGER share_links_resource_insert
BEFORE INSERT ON share_links
WHEN (NEW.resource_type = 'photo' AND NOT EXISTS (
    SELECT 1 FROM photos WHERE id = NEW.resource_id AND deleted_at IS NULL
)) OR (NEW.resource_type = 'folder' AND NOT EXISTS (
    SELECT 1 FROM folders WHERE id = NEW.resource_id
))
BEGIN
    SELECT RAISE(ABORT, 'share link resource does not exist');
END;

CREATE TRIGGER share_links_resource_update
BEFORE UPDATE OF resource_type, resource_id ON share_links
WHEN (NEW.resource_type = 'photo' AND NOT EXISTS (
    SELECT 1 FROM photos WHERE id = NEW.resource_id AND deleted_at IS NULL
)) OR (NEW.resource_type = 'folder' AND NOT EXISTS (
    SELECT 1 FROM folders WHERE id = NEW.resource_id
))
BEGIN
    SELECT RAISE(ABORT, 'share link resource does not exist');
END;
