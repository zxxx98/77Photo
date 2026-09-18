package photos

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/rwcarlsen/goexif/exif"
	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/media"
	"github.com/zxxx98/77Photo/internal/storage"
	"github.com/zxxx98/77Photo/internal/thumbnails"
)

var (
	ErrForbidden        = errors.New("photo access forbidden")
	ErrNotFound         = errors.New("photo not found")
	ErrUploadTooLarge   = errors.New("upload exceeds configured maximum size")
	ErrUnsupportedMedia = errors.New("unsupported media type")
	ErrInvalidMedia     = errors.New("invalid media")
	ErrUploadFailed     = errors.New("upload failed")
	ErrNameConflict     = errors.New("photo name conflict")
	ErrDuplicatePhoto   = errors.New("duplicate photo")
	ErrPixelLimit       = errors.New("image pixel limit exceeded")
)

const maxDecodedPixels int64 = 100_000_000

type ConflictStrategy string

const (
	ConflictReject ConflictStrategy = "reject"
	ConflictRename ConflictStrategy = "rename"
)

type UploadInput struct {
	FolderID       string
	Filename       string
	DeclaredMIME   string
	Conflict       ConflictStrategy
	FileModifiedAt *time.Time
	Body           io.Reader
}

type RenameInput struct {
	Name     string
	Conflict ConflictStrategy
}

type CacheInvalidator interface {
	Invalidate(context.Context, string) error
}

type ThumbnailEnqueuer interface {
	Enqueue(string) bool
}

type DuplicateError struct{ ExistingPhotoID string }

func (e *DuplicateError) Error() string {
	return fmt.Sprintf("duplicate photo already exists as %s", e.ExistingPhotoID)
}
func (e *DuplicateError) Unwrap() error { return ErrDuplicatePhoto }

type Photo struct {
	ID               string     `json:"id"`
	OwnerID          string     `json:"owner_id"`
	FolderID         string     `json:"folder_id"`
	StoragePath      string     `json:"-"`
	Filename         string     `json:"filename"`
	MIMEType         string     `json:"mime_type"`
	Size             int64      `json:"size"`
	Width            int        `json:"width,omitempty"`
	Height           int        `json:"height,omitempty"`
	Checksum         string     `json:"checksum"`
	CapturedAt       time.Time  `json:"captured_at"`
	CapturedAtSource string     `json:"captured_at_source"`
	FileCreatedAt    *time.Time `json:"file_created_at,omitempty"`
	IndexedAt        time.Time  `json:"indexed_at"`
	SourceRevision   string     `json:"source_revision"`
	ScanStatus       string     `json:"scan_status"`
	CameraMake       *string    `json:"camera_make,omitempty"`
	CameraModel      *string    `json:"camera_model,omitempty"`
	Orientation      *int       `json:"orientation,omitempty"`
	FocalLength      *float64   `json:"focal_length,omitempty"`
	Aperture         *float64   `json:"aperture,omitempty"`
	ISO              *int       `json:"iso,omitempty"`
	GPSLatitude      *float64   `json:"gps_latitude,omitempty"`
	GPSLongitude     *float64   `json:"gps_longitude,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type Service struct {
	db         *sql.DB
	storage    storage.Store
	maxSize    int64
	cache      CacheInvalidator
	queue      ThumbnailEnqueuer
	mediaTools *media.Tools
	logger     *slog.Logger
	cursorKey  [32]byte
	cursorTTL  time.Duration
	authorizer *acl.Authorizer
}

func NewService(db *sql.DB, store storage.Store, maxUploadSize int64) *Service {
	service := &Service{db: db, storage: store, maxSize: maxUploadSize, cursorTTL: 15 * time.Minute, logger: slog.Default()}
	if _, err := rand.Read(service.cursorKey[:]); err != nil {
		fallback := sha256.Sum256([]byte(strconv.FormatInt(time.Now().UnixNano(), 10)))
		copy(service.cursorKey[:], fallback[:])
	}
	return service
}

func (s *Service) SetCacheInvalidator(invalidator CacheInvalidator) { s.cache = invalidator }

func (s *Service) SetThumbnailEnqueuer(enqueuer ThumbnailEnqueuer) { s.queue = enqueuer }

func (s *Service) SetMediaTools(tools *media.Tools) { s.mediaTools = tools }

func (s *Service) SetLogger(logger *slog.Logger) {
	if logger == nil {
		s.logger = slog.Default()
		return
	}
	s.logger = logger
}

func (s *Service) SetAuthorizer(authorizer *acl.Authorizer) { s.authorizer = authorizer }

func (s *Service) canRead(ctx context.Context, principal acl.Principal, photo Photo) bool {
	if s.authorizer == nil {
		return acl.CanRead(principal, photo.OwnerID, "")
	}
	ok, err := s.authorizer.CanRead(ctx, principal, photo.FolderID)
	return err == nil && ok
}

func (s *Service) canWrite(ctx context.Context, principal acl.Principal, photo Photo) bool {
	if s.authorizer == nil {
		return acl.CanWrite(principal, photo.OwnerID, "")
	}
	ok, err := s.authorizer.CanWrite(ctx, principal, photo.FolderID)
	return err == nil && ok
}

func (s *Service) canReadFolder(ctx context.Context, principal acl.Principal, folderID, ownerID string) bool {
	if s.authorizer == nil {
		return acl.CanRead(principal, ownerID, "")
	}
	ok, err := s.authorizer.CanRead(ctx, principal, folderID)
	return err == nil && ok
}

func (s *Service) Upload(ctx context.Context, principal acl.Principal, input UploadInput) (Photo, error) {
	if input.Body == nil || s.maxSize < 1 {
		return Photo{}, ErrUploadFailed
	}
	if err := storage.ValidateName(input.Filename); err != nil {
		return Photo{}, storage.ErrInvalidName
	}
	filename := strings.TrimSpace(input.Filename)
	ownerID, folderStoragePath, err := s.authorizedFolder(ctx, principal, input.FolderID)
	if err != nil {
		return Photo{}, err
	}
	folderPath, err := s.storage.ResolvePath(folderStoragePath)
	if err != nil {
		return Photo{}, fmt.Errorf("resolve folder storage: %w", err)
	}
	info, err := os.Stat(folderPath)
	if err != nil || !info.IsDir() {
		return Photo{}, fmt.Errorf("folder storage unavailable: %w", err)
	}
	temporary, err := os.CreateTemp(folderPath, ".77photo-upload-*.tmp")
	if err != nil {
		return Photo{}, fmt.Errorf("create upload temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	hash, head, size, err := streamToFile(temporary, input.Body, s.maxSize)
	if err != nil {
		cleanup()
		if errors.Is(err, ErrUploadTooLarge) {
			return Photo{}, err
		}
		return Photo{}, fmt.Errorf("%w: %v", ErrUploadFailed, err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return Photo{}, fmt.Errorf("%w: sync temporary file: %v", ErrUploadFailed, err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return Photo{}, fmt.Errorf("%w: close temporary file: %v", ErrUploadFailed, err)
	}
	temporary = nil
	checksum := hex.EncodeToString(hash[:])
	mimeType := detectAndValidateMIME(input.DeclaredMIME, filename, head)
	if mimeType == "" {
		_ = os.Remove(temporaryPath)
		return Photo{}, ErrUnsupportedMedia
	}
	metadata, err := extractMetadataWithTools(temporaryPath, mimeType, size, s.mediaTools)
	if err != nil {
		_ = os.Remove(temporaryPath)
		return Photo{}, err
	}
	if metadata.capturedAtSource == "file_mtime" && input.FileModifiedAt != nil && !input.FileModifiedAt.IsZero() {
		metadata.capturedAt = input.FileModifiedAt.UTC()
	}
	if existingID, err := s.findDuplicate(ctx, input.FolderID, checksum); err != nil {
		_ = os.Remove(temporaryPath)
		return Photo{}, err
	} else if existingID != "" {
		_ = os.Remove(temporaryPath)
		return Photo{}, &DuplicateError{ExistingPhotoID: existingID}
	}
	requestedFilename := filename
	var storagePath, finalPath string
	filenameResolved := false
	for suffix := 0; suffix < 10000; suffix++ {
		candidate := requestedFilename
		if suffix > 0 {
			ext := filepath.Ext(requestedFilename)
			base := strings.TrimSuffix(requestedFilename, ext)
			candidate = base + " (" + strconv.Itoa(suffix) + ")" + ext
		}
		nameTaken, err := s.filenameTaken(ctx, input.FolderID, candidate)
		if err != nil {
			_ = os.Remove(temporaryPath)
			return Photo{}, err
		}
		if nameTaken {
			if input.Conflict != ConflictRename {
				_ = os.Remove(temporaryPath)
				return Photo{}, ErrNameConflict
			}
			continue
		}
		candidateStoragePath := filepath.ToSlash(filepath.Join(folderStoragePath, candidate))
		candidateFinalPath, err := s.storage.ResolvePath(candidateStoragePath)
		if err != nil {
			_ = os.Remove(temporaryPath)
			return Photo{}, fmt.Errorf("resolve photo storage: %w", err)
		}
		if _, err := os.Lstat(candidateFinalPath); err == nil {
			if input.Conflict != ConflictRename {
				_ = os.Remove(temporaryPath)
				return Photo{}, ErrNameConflict
			}
			continue
		} else if !os.IsNotExist(err) {
			_ = os.Remove(temporaryPath)
			return Photo{}, fmt.Errorf("inspect photo storage: %w", err)
		}
		filename, storagePath, finalPath = candidate, candidateStoragePath, candidateFinalPath
		filenameResolved = true
		break
	}
	if !filenameResolved {
		_ = os.Remove(temporaryPath)
		return Photo{}, ErrNameConflict
	}
	if err := os.Rename(temporaryPath, finalPath); err != nil {
		_ = os.Remove(temporaryPath)
		return Photo{}, fmt.Errorf("%w: atomic rename: %v", ErrUploadFailed, err)
	}
	keepFile := false
	defer func() {
		if !keepFile {
			_ = os.Remove(finalPath)
		}
	}()
	stat, err := os.Stat(finalPath)
	if err != nil {
		return Photo{}, fmt.Errorf("stat uploaded file: %w", err)
	}
	now := time.Now().UTC()
	photo := Photo{ID: newPhotoID(), OwnerID: ownerID, FolderID: input.FolderID, StoragePath: storagePath, Filename: filename, MIMEType: mimeType, Size: size, Width: metadata.width, Height: metadata.height, Checksum: checksum, CapturedAt: metadata.capturedAt, CapturedAtSource: metadata.capturedAtSource, FileCreatedAt: timePtr(stat.ModTime().UTC()), IndexedAt: now, SourceRevision: checksum, ScanStatus: "indexed", CameraMake: metadata.cameraMake, CameraModel: metadata.cameraModel, Orientation: metadata.orientation, FocalLength: metadata.focalLength, Aperture: metadata.aperture, ISO: metadata.iso, GPSLatitude: metadata.gpsLatitude, GPSLongitude: metadata.gpsLongitude, CreatedAt: now, UpdatedAt: now}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO photos (id, owner_id, folder_id, storage_path, filename, mime_type, size, width, height, checksum, captured_at, captured_at_source, file_created_at, indexed_at, source_revision, scan_status, camera_make, camera_model, orientation, focal_length, aperture, iso, gps_latitude, gps_longitude, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, photo.ID, photo.OwnerID, photo.FolderID, photo.StoragePath, photo.Filename, photo.MIMEType, photo.Size, nullableInt(photo.Width), nullableInt(photo.Height), photo.Checksum, formatTime(photo.CapturedAt), photo.CapturedAtSource, formatOptionalTime(photo.FileCreatedAt), formatTime(photo.IndexedAt), photo.SourceRevision, photo.ScanStatus, nullableString(photo.CameraMake), nullableString(photo.CameraModel), nullableIntPtr(photo.Orientation), nullableFloat(photo.FocalLength), nullableFloat(photo.Aperture), nullableIntPtr(photo.ISO), nullableFloat(photo.GPSLatitude), nullableFloat(photo.GPSLongitude), formatTime(photo.CreatedAt), formatTime(photo.UpdatedAt)); err != nil {
		return Photo{}, fmt.Errorf("index uploaded photo: %w", err)
	}
	keepFile = true
	if s.mediaTools != nil && supportsEmbeddedMotion(mimeType) {
		if motionErr := s.refreshEmbeddedMotion(ctx, photo.ID, finalPath, mimeType); motionErr != nil && s.logger != nil {
			s.logger.Warn("embedded motion extraction failed", "status", "degraded", "photo_id", photo.ID, "filename", photo.Filename, "mime_type", photo.MIMEType, "error", motionErr)
		}
	}
	if s.queue != nil {
		_ = s.queue.Enqueue(photo.ID)
	}
	return photo, nil
}

func (s *Service) Get(ctx context.Context, principal acl.Principal, id string) (Photo, error) {
	photo, err := s.getRaw(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Photo{}, ErrNotFound
	}
	if err != nil {
		return Photo{}, err
	}
	if !s.canRead(ctx, principal, photo) {
		return Photo{}, ErrForbidden
	}
	return photo, nil
}

// LoadPhoto exposes only the source metadata needed by the thumbnail worker;
// callers serving user requests must continue to use Get for ACL checks.
func (s *Service) LoadPhoto(ctx context.Context, id string) (thumbnails.Photo, error) {
	photo, err := s.getRaw(ctx, id)
	if err != nil {
		return thumbnails.Photo{}, err
	}
	return thumbnails.Photo{ID: photo.ID, StoragePath: photo.StoragePath, SourceRevision: photo.SourceRevision, MIMEType: photo.MIMEType, Orientation: photo.Orientation}, nil
}

func (s *Service) Rename(ctx context.Context, principal acl.Principal, id string, input RenameInput) (Photo, error) {
	photo, err := s.getRaw(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Photo{}, ErrNotFound
	}
	if err != nil {
		return Photo{}, err
	}
	if !s.canWrite(ctx, principal, photo) {
		return Photo{}, ErrForbidden
	}
	if err := storage.ValidateName(input.Name); err != nil {
		return Photo{}, storage.ErrInvalidName
	}
	name := strings.TrimSpace(input.Name)
	if strings.EqualFold(name, photo.Filename) {
		return photo, nil
	}
	name, err = s.resolvePhotoName(ctx, photo.FolderID, name, input.Conflict)
	if err != nil {
		return Photo{}, err
	}
	newStoragePath := filepath.ToSlash(filepath.Join(filepath.Dir(photo.StoragePath), name))
	if err := s.storage.Rename(photo.StoragePath, newStoragePath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return Photo{}, ErrNameConflict
		}
		return Photo{}, fmt.Errorf("rename photo on disk: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE photos SET filename=?, storage_path=?, source_revision=?, updated_at=? WHERE id=?", name, newStoragePath, newStorageRevision(photo.SourceRevision), formatTime(time.Now().UTC()), id); err != nil {
		_ = s.storage.Rename(newStoragePath, photo.StoragePath)
		return Photo{}, fmt.Errorf("update photo index: %w", err)
	}
	if s.cache != nil {
		_ = s.cache.Invalidate(ctx, id)
	}
	return s.Get(ctx, principal, id)
}

func (s *Service) Move(ctx context.Context, principal acl.Principal, id, targetFolderID string) (Photo, error) {
	return s.MoveWithConflict(ctx, principal, id, targetFolderID, ConflictReject)
}

func (s *Service) MoveWithConflict(ctx context.Context, principal acl.Principal, id, targetFolderID string, conflict ConflictStrategy) (Photo, error) {
	photo, err := s.getRaw(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Photo{}, ErrNotFound
	}
	if err != nil {
		return Photo{}, err
	}
	if !s.canWrite(ctx, principal, photo) {
		return Photo{}, ErrForbidden
	}
	var targetOwner, targetStorage string
	if err := s.db.QueryRowContext(ctx, "SELECT owner_id, storage_path FROM folders WHERE id=?", targetFolderID).Scan(&targetOwner, &targetStorage); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Photo{}, ErrNotFound
		}
		return Photo{}, fmt.Errorf("load target folder: %w", err)
	}
	if targetOwner != photo.OwnerID || !s.canWrite(ctx, principal, photo) {
		return Photo{}, ErrForbidden
	}
	if s.authorizer != nil {
		ok, authErr := s.authorizer.CanWrite(ctx, principal, targetFolderID)
		if authErr != nil || !ok {
			return Photo{}, ErrForbidden
		}
	}
	if targetFolderID == photo.FolderID {
		return photo, nil
	}
	filename, err := s.resolvePhotoName(ctx, targetFolderID, photo.Filename, conflict)
	if err != nil {
		return Photo{}, err
	}
	newStoragePath := filepath.ToSlash(filepath.Join(targetStorage, filename))
	if err := s.storage.Rename(photo.StoragePath, newStoragePath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return Photo{}, ErrNameConflict
		}
		return Photo{}, fmt.Errorf("move photo on disk: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE photos SET folder_id=?, storage_path=?, filename=?, source_revision=?, updated_at=? WHERE id=?", targetFolderID, newStoragePath, filename, newStorageRevision(photo.SourceRevision), formatTime(time.Now().UTC()), id); err != nil {
		_ = s.storage.Rename(newStoragePath, photo.StoragePath)
		return Photo{}, fmt.Errorf("update moved photo index: %w", err)
	}
	if s.cache != nil {
		_ = s.cache.Invalidate(ctx, id)
	}
	return s.Get(ctx, principal, id)
}

var ErrConfirmationRequired = errors.New("explicit deletion confirmation required")

func (s *Service) Delete(ctx context.Context, principal acl.Principal, id string, confirmed bool) error {
	if !confirmed {
		return ErrConfirmationRequired
	}
	photo, err := s.getRaw(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !s.canWrite(ctx, principal, photo) {
		return ErrForbidden
	}
	deletedAt := formatTime(time.Now().UTC())
	if _, err := s.db.ExecContext(ctx, "UPDATE photos SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL", deletedAt, deletedAt, id); err != nil {
		return fmt.Errorf("mark photo deleted: %w", err)
	}
	if err := s.storage.RemoveFile(photo.StoragePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		_, _ = s.db.ExecContext(ctx, "UPDATE photos SET deleted_at=NULL, updated_at=? WHERE id=?", formatTime(time.Now().UTC()), id)
		return fmt.Errorf("remove photo on disk: %w", err)
	}
	if err := s.removeLiveMotionArtifacts(photo.ID); err != nil {
		return fmt.Errorf("remove photo motion artifact: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "DELETE FROM photos WHERE id=? AND deleted_at IS NOT NULL", id); err != nil {
		// Keep the tombstone hidden from normal reads so a later scan can finish
		// cleanup without resurrecting a deleted photo.
		return fmt.Errorf("remove photo index after file deletion: %w", err)
	}
	if s.cache != nil {
		_ = s.cache.Invalidate(ctx, id)
	}
	return nil
}

func (s *Service) getRaw(ctx context.Context, id string) (Photo, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, owner_id, folder_id, storage_path, filename, mime_type, size, width, height, checksum, captured_at, captured_at_source, file_created_at, indexed_at, source_revision, scan_status, camera_make, camera_model, orientation, focal_length, aperture, iso, gps_latitude, gps_longitude, created_at, updated_at FROM photos WHERE id=? AND deleted_at IS NULL`, id)
	return scanPhoto(row)
}

func (s *Service) resolvePhotoName(ctx context.Context, folderID, name string, conflict ConflictStrategy) (string, error) {
	if taken, err := s.filenameTaken(ctx, folderID, name); err != nil {
		return "", err
	} else if !taken {
		return name, nil
	}
	if conflict != ConflictRename {
		return "", ErrNameConflict
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for suffix := 1; suffix < 10000; suffix++ {
		candidate := base + " (" + strconv.Itoa(suffix) + ")" + ext
		taken, err := s.filenameTaken(ctx, folderID, candidate)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return "", ErrNameConflict
}

func (s *Service) filenameTaken(ctx context.Context, folderID, filename string) (bool, error) {
	var existing string
	err := s.db.QueryRowContext(ctx, "SELECT filename FROM photos WHERE folder_id=? AND filename=? COLLATE NOCASE AND deleted_at IS NULL LIMIT 1", folderID, filename).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check filename: %w", err)
	}
	return true, nil
}

func newStorageRevision(previous string) string { return previous + ":changed" }

func scanPhoto(row interface{ Scan(...any) error }) (Photo, error) {
	var photo Photo
	var width, height sql.NullInt64
	var fileCreated, captured, indexed, created, updated string
	var makeValue, modelValue sql.NullString
	var orientation, iso sql.NullInt64
	var focal, aperture, latitude, longitude sql.NullFloat64
	if err := row.Scan(&photo.ID, &photo.OwnerID, &photo.FolderID, &photo.StoragePath, &photo.Filename, &photo.MIMEType, &photo.Size, &width, &height, &photo.Checksum, &captured, &photo.CapturedAtSource, &fileCreated, &indexed, &photo.SourceRevision, &photo.ScanStatus, &makeValue, &modelValue, &orientation, &focal, &aperture, &iso, &latitude, &longitude, &created, &updated); err != nil {
		return Photo{}, err
	}
	photo.Width, photo.Height = int(width.Int64), int(height.Int64)
	photo.CapturedAt, _ = time.Parse(time.RFC3339Nano, captured)
	photo.IndexedAt, _ = time.Parse(time.RFC3339Nano, indexed)
	photo.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	photo.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updated)
	if value, err := time.Parse(time.RFC3339Nano, fileCreated); err == nil {
		photo.FileCreatedAt = &value
	}
	if makeValue.Valid {
		photo.CameraMake = &makeValue.String
	}
	if modelValue.Valid {
		photo.CameraModel = &modelValue.String
	}
	if orientation.Valid {
		value := int(orientation.Int64)
		photo.Orientation = &value
	}
	if iso.Valid {
		value := int(iso.Int64)
		photo.ISO = &value
	}
	if focal.Valid {
		value := focal.Float64
		photo.FocalLength = &value
	}
	if aperture.Valid {
		value := aperture.Float64
		photo.Aperture = &value
	}
	if latitude.Valid {
		value := latitude.Float64
		photo.GPSLatitude = &value
	}
	if longitude.Valid {
		value := longitude.Float64
		photo.GPSLongitude = &value
	}
	return photo, nil
}

func streamToFile(destination *os.File, source io.Reader, maxSize int64) ([32]byte, []byte, int64, error) {
	var digest [32]byte
	hasher := sha256.New()
	firstBytes := make([]byte, 0, 512)
	buffer := make([]byte, 32*1024)
	var total int64
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			total += int64(read)
			if total > maxSize {
				return digest, firstBytes, total, ErrUploadTooLarge
			}
			if len(firstBytes) < 512 {
				firstBytes = append(firstBytes, buffer[:min(read, 512-len(firstBytes))]...)
			}
			if _, err := destination.Write(buffer[:read]); err != nil {
				return digest, firstBytes, total, err
			}
			_, _ = hasher.Write(buffer[:read])
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				copy(digest[:], hasher.Sum(nil))
				return digest, firstBytes, total, nil
			}
			return digest, firstBytes, total, readErr
		}
	}
}

func detectAndValidateMIME(declared, filename string, head []byte) string {
	inspection, err := media.InspectBytes(filename, declared, head)
	if err != nil {
		return ""
	}
	return inspection.MIME
}

type imageMetadata struct {
	width, height             int
	capturedAt                time.Time
	capturedAtSource          string
	cameraMake, cameraModel   *string
	orientation               *int
	focalLength, aperture     *float64
	iso                       *int
	gpsLatitude, gpsLongitude *float64
}

func extractMetadata(path, mimeType string, size int64) (imageMetadata, error) {
	return extractMetadataWithTools(path, mimeType, size, nil)
}

func extractMetadataWithTools(path, mimeType string, size int64, tools *media.Tools) (imageMetadata, error) {
	stat, err := os.Stat(path)
	if err != nil {
		return imageMetadata{}, fmt.Errorf("stat media: %w", err)
	}
	metadata := imageMetadata{capturedAt: stat.ModTime().UTC(), capturedAtSource: "file_mtime"}
	if tools != nil && (strings.HasPrefix(mimeType, "video/") || mimeType == "image/heic" || mimeType == "image/heif") {
		if captured, ok, probeErr := tools.ProbeCapturedAt(context.Background(), path); probeErr == nil && ok {
			metadata.capturedAt, metadata.capturedAtSource = captured.UTC(), "exif"
		}
	}
	if strings.HasPrefix(mimeType, "video/") {
		return metadata, nil
	}
	decodePath := path
	exifSidecar := ""
	cleanup := func() {}
	if mimeType == "image/heic" || mimeType == "image/heif" {
		if tools == nil {
			return imageMetadata{}, fmt.Errorf("%w: HEIC decoder is unavailable", ErrUnsupportedMedia)
		}
		temporary, tempErr := os.CreateTemp(filepath.Dir(path), ".77photo-decode-*.png")
		if tempErr != nil {
			return imageMetadata{}, fmt.Errorf("create decoded image: %w", tempErr)
		}
		decodePath = temporary.Name()
		if closeErr := temporary.Close(); closeErr != nil {
			_ = os.Remove(decodePath)
			return imageMetadata{}, fmt.Errorf("close decoded image: %w", closeErr)
		}
		_ = os.Remove(decodePath)
		cleanup = func() {
			_ = os.Remove(decodePath)
			if exifSidecar != "" {
				_ = os.Remove(exifSidecar)
			}
		}
		var decodeErr error
		exifSidecar, decodeErr = tools.DecodeStillWithEXIF(context.Background(), path, decodePath)
		if decodeErr != nil {
			cleanup()
			return imageMetadata{}, fmt.Errorf("%w: decode HEIC image: %v", ErrInvalidMedia, decodeErr)
		}
	}
	defer cleanup()
	decodeLimit := size + 1
	if mimeType == "image/heic" || mimeType == "image/heif" {
		decodeLimit = 256 << 20
	}
	if decodeLimit < 1 || decodeLimit > 256<<20 {
		decodeLimit = 256 << 20
	}
	file, err := os.Open(decodePath)
	if err != nil {
		return imageMetadata{}, fmt.Errorf("open image: %w", err)
	}
	config, _, err := image.DecodeConfig(io.LimitReader(file, decodeLimit))
	_ = file.Close()
	if err != nil {
		return imageMetadata{}, fmt.Errorf("%w: decode image: %v", ErrInvalidMedia, err)
	}
	if int64(config.Width)*int64(config.Height) > maxDecodedPixels {
		return imageMetadata{}, ErrPixelLimit
	}
	metadata.width, metadata.height = config.Width, config.Height
	if exifSidecar != "" {
		if sidecar, openErr := os.Open(exifSidecar); openErr == nil {
			if parsed, exifErr := exif.Decode(sidecar); exifErr == nil {
				applyEXIF(&metadata, parsed)
			}
			_ = sidecar.Close()
		}
	}
	if mimeType != "image/heic" && mimeType != "image/heif" {
		file, err = os.Open(path)
		if err == nil {
			if parsed, exifErr := exif.Decode(file); exifErr == nil {
				applyEXIF(&metadata, parsed)
			}
			_ = file.Close()
		}
	}
	return metadata, nil
}

func applyEXIF(metadata *imageMetadata, parsed *exif.Exif) {
	for _, name := range []exif.FieldName{exif.DateTimeOriginal, exif.FieldName("DateTimeDigitized"), exif.FieldName("DateTime")} {
		field, err := parsed.Get(name)
		if err != nil {
			continue
		}
		value, err := field.StringVal()
		if err != nil {
			continue
		}
		if captured, err := time.ParseInLocation("2006:01:02 15:04:05", strings.TrimSpace(value), time.UTC); err == nil {
			metadata.capturedAt, metadata.capturedAtSource = captured, "exif"
			break
		}
	}
	if field, err := parsed.Get(exif.Make); err == nil {
		if value, err := field.StringVal(); err == nil && utf8.ValidString(value) {
			value = strings.TrimSpace(value)
			metadata.cameraMake = &value
		}
	}
	if field, err := parsed.Get(exif.Model); err == nil {
		if value, err := field.StringVal(); err == nil && utf8.ValidString(value) {
			value = strings.TrimSpace(value)
			metadata.cameraModel = &value
		}
	}
	if field, err := parsed.Get(exif.Orientation); err == nil {
		if value, err := field.Int(0); err == nil {
			metadata.orientation = &value
		}
	}
}

func (s *Service) authorizedFolder(ctx context.Context, principal acl.Principal, folderID string) (string, string, error) {
	var ownerID, storagePath string
	if err := s.db.QueryRowContext(ctx, "SELECT owner_id, storage_path FROM folders WHERE id=?", folderID).Scan(&ownerID, &storagePath); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", ErrNotFound
		}
		return "", "", fmt.Errorf("load photo folder: %w", err)
	}
	if s.authorizer != nil {
		ok, authErr := s.authorizer.CanWrite(ctx, principal, folderID)
		if authErr != nil || !ok {
			return "", "", ErrForbidden
		}
	} else if !acl.CanWrite(principal, ownerID, "") {
		return "", "", ErrForbidden
	}
	return ownerID, storagePath, nil
}

func (s *Service) findDuplicate(ctx context.Context, folderID, checksum string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, "SELECT id FROM photos WHERE folder_id=? AND checksum=? AND deleted_at IS NULL LIMIT 1", folderID, checksum).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func newPhotoID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "p_" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return "p_" + hex.EncodeToString(raw)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func timePtr(v time.Time) *time.Time { return &v }
func formatTime(v time.Time) string  { return v.UTC().Format(time.RFC3339Nano) }
func formatOptionalTime(v *time.Time) any {
	if v == nil {
		return nil
	}
	return formatTime(*v)
}
func nullableString(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}
func nullableInt(v int) any {
	if v == 0 {
		return nil
	}
	return v
}
func nullableIntPtr(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}
func nullableFloat(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}
