ALTER TABLE sessions ADD COLUMN csrf_token_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions (token_hash);
