-- The gallery and search list only indexed, non-trashed photos. Keep their
-- captured_at/id order in the index so the first page does not sort the library.
CREATE INDEX IF NOT EXISTS photos_active_timeline_idx
ON photos (captured_at DESC, id DESC)
WHERE deleted_at IS NULL AND scan_status='indexed';
