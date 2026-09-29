package photos

import (
	"context"
	"database/sql"
	"errors"
	"os"
)

func (s *Service) setMotionSource(ctx context.Context, photoID, kind, path string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO photo_motion_sources(photo_id,kind,source_path,photo_checksum)
SELECT id,?,?,checksum FROM photos WHERE id=? AND deleted_at IS NULL
ON CONFLICT(photo_id) DO UPDATE SET kind=excluded.kind,source_path=excluded.source_path,photo_checksum=excluded.photo_checksum`, kind, path, photoID)
	return err
}

func (s *Service) SetScannedMotionSource(ctx context.Context, photoID, path string) error {
	return s.setMotionSource(ctx, photoID, "scanned", path)
}

func (s *Service) HasScannedMotionSource(ctx context.Context, photoID string) bool {
	var kind string
	return s.db.QueryRowContext(ctx, "SELECT kind FROM photo_motion_sources WHERE photo_id=?", photoID).Scan(&kind) == nil && kind == "scanned"
}

// Legacy companions had no provenance. Preserve them conservatively: they may
// be the only copy uploaded by a phone, rather than an extractable cache.
func (s *Service) preserveMotionOriginal(ctx context.Context, photoID string) (bool, error) {
	var kind, sourceChecksum, checksum string
	err := s.db.QueryRowContext(ctx, `SELECT m.kind,m.photo_checksum,p.checksum FROM photo_motion_sources m
JOIN photos p ON p.id=m.photo_id WHERE p.id=?`, photoID).Scan(&kind, &sourceChecksum, &checksum)
	if err == nil {
		return kind != "embedded" && sourceChecksum == checksum, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	for _, relative := range []string{liveMotionStoragePath(photoID), legacyLiveMotionStoragePath(photoID)} {
		path, e := s.storage.ResolvePath(relative)
		if e != nil {
			return false, e
		}
		if info, e := os.Stat(path); e == nil && info.Mode().IsRegular() {
			return true, s.setMotionSource(ctx, photoID, "uploaded", "")
		} else if e != nil && !os.IsNotExist(e) {
			return false, e
		}
	}
	return false, nil
}
