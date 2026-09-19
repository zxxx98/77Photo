package photos

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/zxxx98/77Photo/internal/media"
)

// IndexScannedFile indexes a file already present under managed storage. It
// is deliberately separate from Upload: the scanner never accepts a client
// path and is idempotent on storage_path.
func (s *Service) IndexScannedFile(ctx context.Context, ownerID, folderID, storagePath string) (bool, error) {
	path, err := s.storage.ResolvePath(storagePath)
	if err != nil {
		return false, err
	}
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	hasher := sha256.New()
	head := make([]byte, 512)
	n, readErr := file.Read(head)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		_ = file.Close()
		return false, readErr
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return false, err
	}
	if _, err := io.Copy(hasher, file); err != nil {
		_ = file.Close()
		return false, err
	}
	if err := file.Close(); err != nil {
		return false, err
	}
	stat, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	filename := filepath.Base(storagePath)
	inspection, err := media.InspectBytes(filename, media.MIMEForExtension(filename), head[:n])
	if err != nil {
		return false, ErrUnsupportedMedia
	}
	mimeType := inspection.MIME
	checksum := hex.EncodeToString(hasher.Sum(nil))
	metadata, err := extractMetadataWithTools(path, mimeType, stat.Size(), s.mediaTools)
	if err != nil {
		return false, err
	}
	now := time.Now().UTC()
	var existingID, oldRevision string
	err = s.db.QueryRowContext(ctx, "SELECT id, source_revision FROM photos WHERE storage_path=?", filepath.ToSlash(storagePath)).Scan(&existingID, &oldRevision)
	if errors.Is(err, sql.ErrNoRows) {
		photo := Photo{ID: newPhotoID(), OwnerID: ownerID, FolderID: folderID, StoragePath: filepath.ToSlash(storagePath), Filename: filename, MIMEType: mimeType, Size: stat.Size(), Width: metadata.width, Height: metadata.height, Checksum: checksum, CapturedAt: metadata.capturedAt, CapturedAtSource: metadata.capturedAtSource, FileCreatedAt: timePtr(stat.ModTime().UTC()), IndexedAt: now, SourceRevision: checksum, ScanStatus: "indexed", CameraMake: metadata.cameraMake, CameraModel: metadata.cameraModel, Orientation: metadata.orientation, FocalLength: metadata.focalLength, Aperture: metadata.aperture, ISO: metadata.iso, GPSLatitude: metadata.gpsLatitude, GPSLongitude: metadata.gpsLongitude, CreatedAt: now, UpdatedAt: now}
		_, err := s.db.ExecContext(ctx, `INSERT INTO photos (id, owner_id, folder_id, storage_path, filename, mime_type, size, width, height, checksum, captured_at, captured_at_source, file_created_at, indexed_at, source_revision, scan_status, camera_make, camera_model, orientation, focal_length, aperture, iso, gps_latitude, gps_longitude, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, photo.ID, photo.OwnerID, photo.FolderID, photo.StoragePath, photo.Filename, photo.MIMEType, photo.Size, nullableInt(photo.Width), nullableInt(photo.Height), photo.Checksum, formatTime(photo.CapturedAt), photo.CapturedAtSource, formatOptionalTime(photo.FileCreatedAt), formatTime(photo.IndexedAt), photo.SourceRevision, photo.ScanStatus, nullableString(photo.CameraMake), nullableString(photo.CameraModel), nullableIntPtr(photo.Orientation), nullableFloat(photo.FocalLength), nullableFloat(photo.Aperture), nullableIntPtr(photo.ISO), nullableFloat(photo.GPSLatitude), nullableFloat(photo.GPSLongitude), formatTime(photo.CreatedAt), formatTime(photo.UpdatedAt))
		if err == nil {
			err = s.refreshEmbeddedMotion(ctx, photo.ID, path, mimeType)
		}
		if err == nil {
			err = s.enqueueScannedThumbnail(ctx, photo.ID)
		}
		return true, err
	}
	if err != nil {
		return false, err
	}
	if oldRevision == checksum {
		_, err = s.db.ExecContext(ctx, `UPDATE photos SET owner_id=?, folder_id=?, filename=?, mime_type=?, size=?, width=?, height=?, captured_at=?, captured_at_source=?, file_created_at=?, indexed_at=?, scan_status='indexed', camera_make=?, camera_model=?, orientation=?, focal_length=?, aperture=?, iso=?, gps_latitude=?, gps_longitude=?, updated_at=? WHERE id=?`, ownerID, folderID, filename, mimeType, stat.Size(), nullableInt(metadata.width), nullableInt(metadata.height), formatTime(metadata.capturedAt), metadata.capturedAtSource, formatOptionalTime(timePtr(stat.ModTime().UTC())), formatTime(now), nullableString(metadata.cameraMake), nullableString(metadata.cameraModel), nullableIntPtr(metadata.orientation), nullableFloat(metadata.focalLength), nullableFloat(metadata.aperture), nullableIntPtr(metadata.iso), nullableFloat(metadata.gpsLatitude), nullableFloat(metadata.gpsLongitude), formatTime(now), existingID)
		if err == nil {
			err = s.refreshEmbeddedMotion(ctx, existingID, path, mimeType)
		}
		return false, err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE photos SET owner_id=?, folder_id=?, filename=?, mime_type=?, size=?, width=?, height=?, checksum=?, captured_at=?, captured_at_source=?, file_created_at=?, indexed_at=?, source_revision=?, scan_status='indexed', camera_make=?, camera_model=?, orientation=?, focal_length=?, aperture=?, iso=?, gps_latitude=?, gps_longitude=?, updated_at=? WHERE id=?`, ownerID, folderID, filename, mimeType, stat.Size(), nullableInt(metadata.width), nullableInt(metadata.height), checksum, formatTime(metadata.capturedAt), metadata.capturedAtSource, formatOptionalTime(timePtr(stat.ModTime().UTC())), formatTime(now), checksum, nullableString(metadata.cameraMake), nullableString(metadata.cameraModel), nullableIntPtr(metadata.orientation), nullableFloat(metadata.focalLength), nullableFloat(metadata.aperture), nullableIntPtr(metadata.iso), nullableFloat(metadata.gpsLatitude), nullableFloat(metadata.gpsLongitude), formatTime(now), existingID)
	if err == nil && s.cache != nil {
		_ = s.cache.Invalidate(ctx, existingID)
	}
	if err == nil {
		err = s.refreshEmbeddedMotion(ctx, existingID, path, mimeType)
	}
	if err == nil {
		err = s.enqueueScannedThumbnail(ctx, existingID)
	}
	return false, err
}

func (s *Service) enqueueScannedThumbnail(ctx context.Context, photoID string) error {
	if s.queue == nil {
		return nil
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if s.queue.Enqueue(photoID) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Service) refreshEmbeddedMotion(ctx context.Context, photoID, sourcePath, mimeType string) error {
	if s.mediaTools == nil || !supportsEmbeddedMotion(mimeType) {
		return nil
	}
	motion, err := s.mediaTools.FindEmbeddedMotionBounded(ctx, sourcePath)
	if err != nil {
		_ = s.removeLiveMotionArtifacts(photoID)
		return err
	}
	if motion.Size == 0 {
		return s.removeLiveMotionArtifacts(photoID)
	}
	destination, err := s.storage.ResolvePath(liveMotionStoragePath(photoID))
	if err != nil {
		return err
	}
	if err := s.removeLiveMotionArtifacts(photoID); err != nil {
		return err
	}
	if err := s.mediaTools.ExtractMotionBounded(ctx, sourcePath, destination); err != nil {
		_ = s.removeLiveMotionArtifacts(photoID)
		return err
	}
	return nil
}

func (s *Service) HasEmbeddedMotion(ctx context.Context, sourcePath, mimeType string) bool {
	if s.mediaTools == nil || !supportsEmbeddedMotion(mimeType) {
		return false
	}
	motion, err := s.mediaTools.FindEmbeddedMotionBounded(ctx, sourcePath)
	return err == nil && motion.Size > 0
}

func supportsEmbeddedMotion(mimeType string) bool {
	return mimeType == "image/jpeg" || mimeType == "image/heic" || mimeType == "image/heif"
}

func (s *Service) MarkMissing(ctx context.Context, storagePath string) error {
	_, err := s.db.ExecContext(ctx, "UPDATE photos SET scan_status='missing', updated_at=? WHERE storage_path=? AND deleted_at IS NULL", formatTime(time.Now().UTC()), filepath.ToSlash(storagePath))
	return err
}

func scanFolderForPath(ctx context.Context, db *sql.DB, storagePath string) (ownerID, folderID string, err error) {
	err = db.QueryRowContext(ctx, "SELECT owner_id, id FROM folders WHERE storage_path=?", filepath.ToSlash(storagePath)).Scan(&ownerID, &folderID)
	return
}

func ensureScanPath(storagePath string) error {
	if filepath.IsAbs(storagePath) {
		return fmt.Errorf("scan path must be relative")
	}
	return nil
}
