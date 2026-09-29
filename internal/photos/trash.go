package photos

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/maintenance"
	"github.com/zxxx98/77Photo/internal/storage"
)

var ErrTrashPending = errors.New("a trash operation needs recovery")
var ErrTrashChanged = errors.New("trash source file changed")

type trashFile struct {
	Source   string `json:"source"`
	Trash    string `json:"trash"`
	Restore  string `json:"restore,omitempty"`
	Checksum string `json:"checksum"`
	Role     string `json:"role"`
	PhotoID  string `json:"photo_id,omitempty"`
}

type trashRecord struct {
	ID, State, OriginalPath, RestoreFolder, RestoreName string
	Files                                               []trashFile
}

type TrashItem struct {
	ID               string `json:"id"`
	OwnerID          string `json:"owner_id"`
	Filename         string `json:"filename"`
	MIMEType         string `json:"mime_type"`
	Size             int64  `json:"size"`
	FolderID         string `json:"folder_id"`
	FolderName       string `json:"folder_name"`
	DeletedAt        string `json:"deleted_at"`
	ExpiresAt        string `json:"expires_at"`
	State            string `json:"state"`
	RecoveryRequired bool   `json:"recovery_required"`
}

type TrashPage struct {
	Items         []TrashItem `json:"items"`
	NextCursor    *string     `json:"next_cursor"`
	RetentionDays int         `json:"retention_days"`
}

type RestoreInput struct {
	FolderID string           `json:"folder_id,omitempty"`
	Conflict ConflictStrategy `json:"conflict,omitempty"`
}

func (s *Service) SetMaintenanceLock(lock *maintenance.Lock) { s.maintenance = lock }
func (s *Service) SetTrashRetention(days int) {
	if days > 0 {
		s.trashRetention = time.Duration(days) * 24 * time.Hour
	}
}

func (s *Service) trashLock() (func(), error) {
	release, err := s.maintenance.Acquire(maintenance.KindTrash, "")
	if err != nil {
		return nil, err
	}
	unlock := s.storage.LockMutations()
	return func() { unlock(); release() }, nil
}

func (s *Service) Trash(ctx context.Context, principal acl.Principal, id string, confirmed bool) error {
	if !confirmed {
		return ErrConfirmationRequired
	}
	release, err := s.trashLock()
	if err != nil {
		return err
	}
	defer release()
	photo, err := s.photoIncludingDeleted(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !s.canWrite(ctx, principal, photo) {
		return ErrForbidden
	}
	if record, e := s.trashRecord(ctx, id); e == nil {
		if record.State == "moving" {
			return s.finishTrashOperation(ctx, record)
		}
		if record.State == "trashed" {
			return nil
		}
		return ErrTrashPending
	} else if !errors.Is(e, sql.ErrNoRows) {
		return e
	}
	if err := storage.CheckPendingTrash(ctx, s.db); err != nil {
		return err
	}
	files, err := s.collectTrashFiles(ctx, photo)
	if err != nil {
		return err
	}
	manifest, err := json.Marshal(files)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO trash_items(photo_id,deleted_by,deleted_at,expires_at,original_path,state,files_json)
VALUES(?,?,?,?,?,'moving',?)`, id, principal.UserID, formatTime(now), formatTime(now.Add(s.trashRetention)), photo.StoragePath, string(manifest))
	if err != nil {
		return err
	}
	for _, file := range files {
		if file.PhotoID == "" {
			continue
		}
		if _, err = tx.ExecContext(ctx, "UPDATE photos SET deleted_at=?,storage_path=?,updated_at=? WHERE id=?", formatTime(now), file.Trash, formatTime(now), file.PhotoID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE share_links SET revoked_at=?,updated_at=? WHERE resource_type='photo' AND resource_id=? AND revoked_at IS NULL", formatTime(now), formatTime(now), file.PhotoID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM share_link_access WHERE share_link_id IN (SELECT id FROM share_links WHERE resource_type='photo' AND resource_id=?)", file.PhotoID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.finishTrashOperation(context.WithoutCancel(ctx), trashRecord{ID: id, State: "moving", OriginalPath: photo.StoragePath, Files: files})
}

func (s *Service) collectTrashFiles(ctx context.Context, photo Photo) ([]trashFile, error) {
	base := filepath.ToSlash(filepath.Join(".trash", photo.OwnerID, photo.ID))
	files := []trashFile{}
	seen := map[string]bool{}
	add := func(source, role, photoID string, required bool) error {
		if seen[source] {
			return nil
		}
		digest, _, err := s.storage.FileDigest(source)
		if !required && os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if role == "original" && digest != photo.Checksum {
			return ErrTrashChanged
		}
		seen[source] = true
		files = append(files, trashFile{Source: source, Trash: base + "/" + fmt.Sprintf("%d", len(files)) + filepath.Ext(source), Checksum: digest, Role: role, PhotoID: photoID})
		return nil
	}
	if err := add(photo.StoragePath, "original", photo.ID, true); err != nil {
		return nil, err
	}
	for _, path := range []string{liveMotionStoragePath(photo.ID), legacyLiveMotionStoragePath(photo.ID)} {
		if err := add(path, "motion", "", false); err != nil {
			return nil, err
		}
	}
	var companion string
	err := s.db.QueryRowContext(ctx, "SELECT source_path FROM photo_motion_sources WHERE photo_id=? AND kind='scanned'", photo.ID).Scan(&companion)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	// Older scans did not record provenance. Match only a same-basename file
	// whose bytes equal the stored motion, never an unrelated neighboring video.
	if companion == "" && len(files) > 1 {
		dir, err := s.storage.ResolvePath(filepath.ToSlash(filepath.Dir(photo.StoragePath)))
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		stem := strings.TrimSuffix(photo.Filename, filepath.Ext(photo.Filename))
		for _, entry := range entries {
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if entry.IsDir() || (ext != ".mov" && ext != ".mp4") || !strings.EqualFold(strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())), stem) {
				continue
			}
			candidate := filepath.ToSlash(filepath.Join(filepath.Dir(photo.StoragePath), entry.Name()))
			digest, _, err := s.storage.FileDigest(candidate)
			if err == nil && digest == files[1].Checksum {
				companion = candidate
				break
			}
		}
	}
	if companion != "" {
		digest, _, err := s.storage.FileDigest(companion)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		if err == nil {
			matched := false
			for _, file := range files {
				if file.Role == "motion" && file.Checksum == digest {
					matched = true
				}
			}
			if !matched {
				return nil, ErrTrashChanged
			}
			var pairedID, status string
			err := s.db.QueryRowContext(ctx, "SELECT id,scan_status FROM photos WHERE storage_path=? AND deleted_at IS NULL", companion).Scan(&pairedID, &status)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if pairedID != "" && status != "paired" {
				return nil, ErrTrashChanged
			}
			if err := add(companion, "companion", pairedID, true); err != nil {
				return nil, err
			}
		}
	}
	return files, nil
}

func (s *Service) photoIncludingDeleted(ctx context.Context, id string) (Photo, error) {
	return scanPhoto(s.db.QueryRowContext(ctx, `SELECT id,owner_id,folder_id,storage_path,filename,mime_type,size,width,height,checksum,captured_at,captured_at_source,file_created_at,indexed_at,source_revision,scan_status,camera_make,camera_model,orientation,focal_length,aperture,iso,gps_latitude,gps_longitude,created_at,updated_at FROM photos WHERE id=?`, id))
}

func (s *Service) trashRecord(ctx context.Context, id string) (trashRecord, error) {
	var record trashRecord
	var manifest string
	err := s.db.QueryRowContext(ctx, `SELECT photo_id,state,original_path,files_json,restore_folder_id,restore_name FROM trash_items WHERE photo_id=?`, id).Scan(&record.ID, &record.State, &record.OriginalPath, &manifest, &record.RestoreFolder, &record.RestoreName)
	if err != nil {
		return record, err
	}
	err = json.Unmarshal([]byte(manifest), &record.Files)
	if err == nil && len(record.Files) == 0 {
		err = ErrTrashPending
	}
	return record, err
}

func (s *Service) authorizeTrash(ctx context.Context, principal acl.Principal, id string) (Photo, trashRecord, error) {
	photo, err := s.photoIncludingDeleted(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return photo, trashRecord{}, ErrNotFound
	}
	if err != nil {
		return photo, trashRecord{}, err
	}
	if principal.Role != acl.RoleAdmin && principal.UserID != photo.OwnerID {
		return Photo{}, trashRecord{}, ErrForbidden
	}
	record, err := s.trashRecord(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return photo, record, err
}

func (s *Service) RestoreTrash(ctx context.Context, principal acl.Principal, id string, input RestoreInput) (Photo, error) {
	if input.Conflict != "" && input.Conflict != ConflictReject && input.Conflict != ConflictRename {
		return Photo{}, ErrInvalidFilter
	}
	release, err := s.trashLock()
	if err != nil {
		return Photo{}, err
	}
	defer release()
	photo, record, err := s.authorizeTrash(ctx, principal, id)
	if errors.Is(err, ErrNotFound) {
		// Retrying a completed restore is harmless for the owner/admin.
		if restored, e := s.Get(ctx, principal, id); e == nil && (principal.Role == acl.RoleAdmin || restored.OwnerID == principal.UserID) {
			return restored, nil
		}
	}
	if err != nil {
		return Photo{}, err
	}
	if record.State == "restoring" {
		err = s.finishTrashOperation(ctx, record)
		if err != nil {
			return Photo{}, err
		}
		return s.Get(ctx, principal, id)
	}
	if record.State != "trashed" {
		return Photo{}, ErrTrashPending
	}
	if err := storage.CheckPendingTrash(ctx, s.db); err != nil {
		return Photo{}, err
	}
	folderID := input.FolderID
	if folderID == "" {
		folderID = photo.FolderID
	}
	owner, path, err := s.authorizedFolder(ctx, principal, folderID)
	if err != nil {
		return Photo{}, err
	}
	// Restoring must not silently transfer ownership to another member.
	if owner != photo.OwnerID {
		return Photo{}, ErrForbidden
	}
	destination, err := s.storage.ResolvePath(path)
	if err != nil {
		return Photo{}, err
	}
	if info, e := os.Stat(destination); e != nil {
		return Photo{}, e
	} else if !info.IsDir() {
		return Photo{}, ErrNotFound
	}
	name := photo.Filename
	for attempt := 0; attempt < 10000; attempt++ {
		candidate := name
		if attempt > 0 {
			ext := filepath.Ext(name)
			candidate = fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(name, ext), attempt, ext)
		}
		if err := storage.ValidateName(candidate); err != nil {
			return Photo{}, err
		}
		taken, err := s.filenameTaken(ctx, folderID, candidate)
		if err != nil {
			return Photo{}, err
		}
		for i := range record.Files {
			file := &record.Files[i]
			switch file.Role {
			case "original":
				file.Restore = filepath.ToSlash(filepath.Join(path, candidate))
			case "companion":
				file.Restore = filepath.ToSlash(filepath.Join(path, strings.TrimSuffix(candidate, filepath.Ext(candidate))+filepath.Ext(file.Source)))
			default:
				file.Restore = file.Source
			}
			absolute, err := s.storage.ResolvePath(file.Restore)
			if err != nil {
				return Photo{}, err
			}
			if _, e := os.Lstat(absolute); e == nil {
				taken = true
			} else if !os.IsNotExist(e) {
				return Photo{}, e
			}
		}
		if taken {
			if input.Conflict != ConflictRename {
				return Photo{}, ErrNameConflict
			}
			continue
		}
		record.State = "restoring"
		record.RestoreFolder = folderID
		record.RestoreName = candidate
		manifest, _ := json.Marshal(record.Files)
		_, err = s.db.ExecContext(ctx, "UPDATE trash_items SET state='restoring',restore_folder_id=?,restore_name=?,files_json=?,last_error='' WHERE photo_id=?", folderID, candidate, string(manifest), id)
		if err != nil {
			return Photo{}, err
		}
		if err = s.finishTrashOperation(context.WithoutCancel(ctx), record); err != nil {
			return Photo{}, err
		}
		return s.Get(ctx, principal, id)
	}
	return Photo{}, ErrNameConflict
}

func (s *Service) PurgeTrash(ctx context.Context, principal acl.Principal, id string, confirmed bool) error {
	return s.purgeTrash(ctx, principal, id, confirmed, nil, nil)
}

func (s *Service) purgeTrash(ctx context.Context, principal acl.Principal, id string, confirmed bool, expiresBefore, deletedBefore *time.Time) error {
	if !confirmed {
		return ErrConfirmationRequired
	}
	release, err := s.trashLock()
	if err != nil {
		return err
	}
	defer release()
	_, record, err := s.authorizeTrash(ctx, principal, id)
	if err != nil {
		return err
	}
	if expiresBefore != nil || deletedBefore != nil {
		var expires, deleted string
		if err := s.db.QueryRowContext(ctx, "SELECT expires_at,deleted_at FROM trash_items WHERE photo_id=?", id).Scan(&expires, &deleted); err != nil {
			return err
		}
		expiry, e1 := time.Parse(time.RFC3339Nano, expires)
		deletion, e2 := time.Parse(time.RFC3339Nano, deleted)
		if e1 != nil || e2 != nil {
			return ErrTrashPending
		}
		if expiresBefore != nil && expiry.After(*expiresBefore) || deletedBefore != nil && deletion.After(*deletedBefore) {
			return ErrNotFound
		}
	}
	if record.State != "trashed" && record.State != "purging" {
		return ErrTrashPending
	}
	if _, err = s.db.ExecContext(ctx, "UPDATE trash_items SET state='purging',last_error='' WHERE photo_id=?", id); err != nil {
		return err
	}
	record.State = "purging"
	return s.finishTrashOperation(context.WithoutCancel(ctx), record)
}

func (s *Service) finishTrashOperation(ctx context.Context, record trashRecord) (err error) {
	defer func() {
		if err != nil {
			_, _ = s.db.ExecContext(context.WithoutCancel(ctx), "UPDATE trash_items SET last_error=? WHERE photo_id=?", err.Error(), record.ID)
		}
	}()
	if _, e := os.Stat(s.storage.Root()); e != nil {
		return e
	}
	for _, file := range record.Files {
		switch record.State {
		case "moving":
			err = s.storage.MoveFileDurable(file.Source, file.Trash, file.Checksum)
		case "restoring":
			err = s.storage.MoveFileDurable(file.Trash, file.Restore, file.Checksum)
		case "purging":
			err = s.storage.RemoveFileDurable(file.Trash)
		case "trashed":
			return nil
		default:
			return ErrTrashPending
		}
		if err != nil {
			return err
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	switch record.State {
	case "moving":
		_, err = tx.ExecContext(ctx, "UPDATE trash_items SET state='trashed',last_error='' WHERE photo_id=?", record.ID)
	case "restoring":
		for _, file := range record.Files {
			if file.PhotoID != "" {
				_, err = tx.ExecContext(ctx, "UPDATE photos SET storage_path=?,folder_id=?,filename=?,deleted_at=NULL,source_revision=source_revision||':restored',updated_at=? WHERE id=?", file.Restore, record.RestoreFolder, filepath.Base(file.Restore), formatTime(time.Now().UTC()), file.PhotoID)
				if err != nil {
					return err
				}
			}
			if file.Role == "companion" {
				_, err = tx.ExecContext(ctx, "UPDATE photo_motion_sources SET source_path=? WHERE photo_id=?", file.Restore, record.ID)
				if err != nil {
					return err
				}
			}
		}
		_, err = tx.ExecContext(ctx, "DELETE FROM trash_items WHERE photo_id=?", record.ID)
	case "purging":
		if _, err = tx.ExecContext(ctx, "DELETE FROM trash_items WHERE photo_id=?", record.ID); err != nil {
			return err
		}
		for _, file := range record.Files {
			if file.PhotoID == "" {
				continue
			}
			_, err = tx.ExecContext(ctx, "DELETE FROM share_link_access WHERE share_link_id IN (SELECT id FROM share_links WHERE resource_type='photo' AND resource_id=?)", file.PhotoID)
			if err != nil {
				return err
			}
			// Keep a revoked, secret-free management record after the photo is
			// permanently removed. Only administrators can manage orphan links.
			_, err = tx.ExecContext(ctx, `UPDATE share_links SET
			owner_id=COALESCE(owner_id,(SELECT owner_id FROM photos WHERE id=?)),
			resource_name=COALESCE((SELECT filename FROM photos WHERE id=?),resource_name),
			revoked_at=COALESCE(revoked_at,?), updated_at=?
			WHERE resource_type='photo' AND resource_id=?`, file.PhotoID, file.PhotoID, formatTime(time.Now().UTC()), formatTime(time.Now().UTC()), file.PhotoID)
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, "DELETE FROM photos WHERE id=? AND deleted_at IS NOT NULL", file.PhotoID)
			if err != nil {
				return err
			}
		}
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if record.State == "purging" && s.cache != nil {
		_ = s.cache.Invalidate(ctx, record.ID)
	}
	if record.State == "restoring" && s.queue != nil {
		s.queue.Enqueue(record.ID)
	}
	if record.State == "restoring" || record.State == "purging" {
		_ = s.storage.RemoveEmptyDir(filepath.ToSlash(filepath.Dir(record.Files[0].Trash)))
	}
	return nil
}

// RecoverTrash replays durable intents before starting maintenance workers.
// Failed intents stay hidden and block conflicting writes until retried.
func (s *Service) RecoverTrash(ctx context.Context) error {
	release, err := s.trashLock()
	if err != nil {
		return err
	}
	defer release()
	rows, err := s.db.QueryContext(ctx, "SELECT photo_id FROM trash_items WHERE state!='trashed' ORDER BY deleted_at,photo_id")
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	var failures []error
	for _, id := range ids {
		record, e := s.trashRecord(ctx, id)
		if e == nil {
			e = s.finishTrashOperation(ctx, record)
		}
		if e != nil {
			failures = append(failures, fmt.Errorf("recover %s: %w", id, e))
		}
	}
	return errors.Join(failures...)
}

func (s *Service) ListTrash(ctx context.Context, principal acl.Principal, cursor string, limit int, all bool) (TrashPage, error) {
	page := TrashPage{Items: []TrashItem{}, RetentionDays: int(s.trashRetention / (24 * time.Hour))}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return page, ErrInvalidFilter
	}
	if all && principal.Role != acl.RoleAdmin {
		return page, ErrForbidden
	}
	scope := "trash:mine"
	if all {
		scope = "trash:all"
	}
	query := `SELECT p.id,p.owner_id,p.filename,p.mime_type,p.size,p.folder_id,f.name,t.deleted_at,t.expires_at,t.state,t.last_error
FROM trash_items t JOIN photos p ON p.id=t.photo_id JOIN folders f ON f.id=p.folder_id WHERE p.deleted_at IS NOT NULL`
	args := []any{}
	if !all {
		query += " AND p.owner_id=?"
		args = append(args, principal.UserID)
	}
	if cursor != "" {
		c, err := s.decodeCursor(cursor)
		if err != nil {
			return page, err
		}
		if c.UserID != principal.UserID || c.Role != string(principal.Role) || c.FolderID != scope {
			return page, ErrInvalidCursor
		}
		query += " AND (t.deleted_at<? OR (t.deleted_at=? AND p.id<?))"
		args = append(args, c.LastCaptured, c.LastCaptured, c.LastID)
	}
	query += " ORDER BY t.deleted_at DESC,p.id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var item TrashItem
		var lastError string
		if err := rows.Scan(&item.ID, &item.OwnerID, &item.Filename, &item.MIMEType, &item.Size, &item.FolderID, &item.FolderName, &item.DeletedAt, &item.ExpiresAt, &item.State, &lastError); err != nil {
			return page, err
		}
		item.RecoveryRequired = lastError != ""
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		last := page.Items[limit-1]
		value := s.encodeCursor(photoCursor{Version: 1, UserID: principal.UserID, Role: string(principal.Role), FolderID: scope, LastCaptured: last.DeletedAt, LastID: last.ID, ExpiresAt: time.Now().Add(s.cursorTTL).Unix()})
		page.NextCursor = &value
	}
	return page, nil
}

// ExpireTrash does a bounded batch; each purge rechecks its state under the
// mutation lock so restoring a selected item can never delete a restored file.
func (s *Service) ExpireTrash(ctx context.Context, now time.Time) error {
	rows, err := s.db.QueryContext(ctx, "SELECT photo_id FROM trash_items WHERE state='trashed' AND expires_at<=? ORDER BY expires_at,photo_id LIMIT 100", formatTime(now))
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		err = s.purgeTrash(ctx, acl.Principal{Role: acl.RoleAdmin}, id, true, &now, nil)
		if err != nil && !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrTrashPending) {
			return err
		}
	}
	return nil
}
