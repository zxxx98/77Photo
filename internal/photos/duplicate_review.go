package photos

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
)

// DuplicateReview binds a reviewed photo to its content, location and motion.
type DuplicateReview struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
	Checksum string `json:"checksum"`
	Motion   string `json:"motion"`
}

// DuplicateMotion returns a content identity for the complete motion component.
// Unknown or inconsistent provenance is excluded rather than assumed static.
func (s *Service) DuplicateMotion(ctx context.Context, photo Photo) (string, error) {
	var kind, source, checksum string
	err := s.db.QueryRowContext(ctx, "SELECT kind,source_path,photo_checksum FROM photo_motion_sources WHERE photo_id=?", photo.ID).Scan(&kind, &source, &checksum)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if err == nil && checksum != photo.Checksum {
		return "", ErrTrashChanged
	}
	paths := []string{liveMotionStoragePath(photo.ID), legacyLiveMotionStoragePath(photo.ID)}
	if source != "" {
		paths = append(paths, source)
	}
	digest := ""
	for _, path := range paths {
		sum, _, e := s.storage.FileDigest(path)
		if os.IsNotExist(e) && path != source {
			continue
		}
		if e != nil {
			return "", e
		}
		if digest != "" && sum != digest {
			return "", ErrTrashChanged
		}
		digest = sum
	}
	if digest == "" && kind != "" {
		return "", ErrTrashChanged
	}
	if digest != "" && kind == "" {
		return "", ErrTrashChanged
	}
	if digest == "" {
		return "static", nil
	}
	hash := sha256.Sum256([]byte("motion:" + digest))
	return hex.EncodeToString(hash[:]), nil
}

// TrashReviewed validates the entire selection while holding the same locks as
// Trash. The surviving original is verified before any reviewed copy moves.
func (s *Service) TrashReviewed(ctx context.Context, principal acl.Principal, keep DuplicateReview, remove []DuplicateReview, exact bool) (BulkDeleteResult, error) {
	result := BulkDeleteResult{DeletedIDs: []string{}, Failed: []BulkDeleteFailure{}}
	if len(remove) == 0 || len(remove) > 500 {
		return result, ErrConfirmationRequired
	}
	release, err := s.trashLock()
	if err != nil {
		return result, err
	}
	defer release()
	keeper, err := s.getRaw(ctx, keep.ID)
	if err != nil {
		return result, err
	}
	if !s.canWrite(ctx, principal, keeper) {
		return result, ErrForbidden
	}
	if !strings.HasPrefix(keeper.MIMEType, "image/") {
		return result, ErrTrashChanged
	}
	validate := func(p Photo, r DuplicateReview) error {
		if p.SourceRevision != r.Revision || p.Checksum != r.Checksum || p.ScanStatus != "indexed" {
			return ErrTrashChanged
		}
		sum, _, e := s.storage.FileDigest(p.StoragePath)
		if e != nil {
			return e
		}
		if sum != p.Checksum {
			return ErrTrashChanged
		}
		motion, e := s.DuplicateMotion(ctx, p)
		if e != nil {
			return e
		}
		if motion != r.Motion {
			return ErrTrashChanged
		}
		return nil
	}
	if err = validate(keeper, keep); err != nil {
		return result, err
	}
	// A companion must not be moved if the keeper still refers to its path.
	keeperPaths := map[string]bool{keeper.StoragePath: true, liveMotionStoragePath(keeper.ID): true, legacyLiveMotionStoragePath(keeper.ID): true}
	var keeperSource string
	err = s.db.QueryRowContext(ctx, "SELECT source_path FROM photo_motion_sources WHERE photo_id=?", keeper.ID).Scan(&keeperSource)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if keeperSource != "" {
		keeperPaths[keeperSource] = true
	}
	seen := map[string]bool{keep.ID: true}
	for _, review := range remove {
		if seen[review.ID] {
			return result, ErrTrashChanged
		}
		seen[review.ID] = true
		p, e := s.photoIncludingDeleted(ctx, review.ID)
		if e != nil {
			return result, e
		}
		if p.OwnerID != keeper.OwnerID || !strings.HasPrefix(p.MIMEType, "image/") || !s.canWrite(ctx, principal, p) {
			return result, ErrForbidden
		}
		// Retry after a successful move reports the same completed ID.
		if record, e := s.trashRecord(ctx, p.ID); e == nil && (record.State == "trashed" || record.State == "moving") {
			continue
		}
		var active bool
		if e = s.db.QueryRowContext(ctx, "SELECT deleted_at IS NULL FROM photos WHERE id=?", p.ID).Scan(&active); e != nil {
			return result, e
		}
		if !active {
			return result, ErrTrashChanged
		}
		if e = validate(p, review); e != nil {
			return result, e
		}
		if exact && (p.Checksum != keeper.Checksum || review.Motion != keep.Motion) {
			return result, ErrTrashChanged
		}
		var companion string
		e = s.db.QueryRowContext(ctx, "SELECT source_path FROM photo_motion_sources WHERE photo_id=?", p.ID).Scan(&companion)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return result, e
		}
		if keeperPaths[p.StoragePath] || (companion != "" && keeperPaths[companion]) {
			return result, ErrTrashChanged
		}
	}
	for _, review := range remove {
		if e := s.trashLocked(ctx, principal, review.ID); e != nil {
			result.Failed = append(result.Failed, BulkDeleteFailure{ID: review.ID, Code: bulkDeleteErrorCode(e)})
		} else {
			result.DeletedIDs = append(result.DeletedIDs, review.ID)
		}
	}
	return result, nil
}
