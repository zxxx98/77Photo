CREATE TABLE mobile_devices (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    app_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE TABLE mobile_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL REFERENCES mobile_devices(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    family_id TEXT NOT NULL,
    token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    rotated_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX mobile_devices_user_idx ON mobile_devices(user_id, revoked_at);
CREATE INDEX mobile_tokens_device_idx ON mobile_tokens(device_id, token_type, revoked_at);
CREATE INDEX mobile_tokens_family_idx ON mobile_tokens(family_id, revoked_at);
CREATE INDEX mobile_tokens_expiry_idx ON mobile_tokens(expires_at);
