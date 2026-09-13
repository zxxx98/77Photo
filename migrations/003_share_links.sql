CREATE TABLE IF NOT EXISTS share_links (
    id TEXT PRIMARY KEY NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('photo', 'folder')),
    resource_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS share_links_resource_idx ON share_links(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS share_link_access (
    id TEXT PRIMARY KEY NOT NULL,
    share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS share_link_access_link_idx ON share_link_access(share_link_id, expires_at);

CREATE TRIGGER IF NOT EXISTS share_links_resource_insert
BEFORE INSERT ON share_links
WHEN (NEW.resource_type = 'photo' AND NOT EXISTS (
    SELECT 1 FROM photos WHERE id = NEW.resource_id AND deleted_at IS NULL
)) OR (NEW.resource_type = 'folder' AND NOT EXISTS (
    SELECT 1 FROM folders WHERE id = NEW.resource_id
))
BEGIN
    SELECT RAISE(ABORT, 'share link resource does not exist');
END;

CREATE TRIGGER IF NOT EXISTS share_links_resource_update
BEFORE UPDATE OF resource_type, resource_id ON share_links
WHEN (NEW.resource_type = 'photo' AND NOT EXISTS (
    SELECT 1 FROM photos WHERE id = NEW.resource_id AND deleted_at IS NULL
)) OR (NEW.resource_type = 'folder' AND NOT EXISTS (
    SELECT 1 FROM folders WHERE id = NEW.resource_id
))
BEGIN
    SELECT RAISE(ABORT, 'share link resource does not exist');
END;
