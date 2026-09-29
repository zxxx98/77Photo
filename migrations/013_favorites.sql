CREATE TABLE photo_favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    photo_id TEXT NOT NULL REFERENCES photos(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, photo_id)
);

CREATE INDEX photo_favorites_photo_idx ON photo_favorites (photo_id);
