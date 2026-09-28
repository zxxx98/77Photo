-- Kept with the database so restarts and address changes preserve identity.
CREATE TABLE server_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    seed BLOB NOT NULL CHECK (length(seed) = 32)
);
