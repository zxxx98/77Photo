package folders

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/storage"
)

var (
	ErrForbidden    = errors.New("folder access forbidden")
	ErrNotFound     = errors.New("folder not found")
	ErrInvalidName  = storage.ErrInvalidName
	ErrNameConflict = errors.New("folder name conflict")
	ErrNotEmpty     = errors.New("folder is not empty")
	ErrDescendant   = errors.New("folder cannot move into its descendant")
)

type Service struct {
	db         *sql.DB
	storage    storage.Store
	authorizer *acl.Authorizer
}

type CreateInput struct {
	Name     string  `json:"name"`
	ParentID *string `json:"parent_id,omitempty"`
}

type RenameInput struct {
	Name     string `json:"name"`
	Conflict string `json:"conflict,omitempty"`
}

type Folder struct {
	ID                  string          `json:"id"`
	OwnerID             string          `json:"owner_id"`
	ParentID            *string         `json:"parent_id"`
	Name                string          `json:"name"`
	StoragePath         string          `json:"-"`
	IsShared            bool            `json:"is_shared"`
	InheritedPermission *acl.Permission `json:"inherited_permission,omitempty"`
	PhotoCount          int             `json:"photo_count"`
	ChildFolderCount    int             `json:"child_folder_count"`
	CreatedAt           time.Time       `json:"created_at"`
	UpdatedAt           time.Time       `json:"updated_at"`
}

func NewService(db *sql.DB, store storage.Store) *Service { return &Service{db: db, storage: store} }

func (s *Service) SetAuthorizer(authorizer *acl.Authorizer) { s.authorizer = authorizer }

func (s *Service) canRead(ctx context.Context, principal acl.Principal, folder Folder) bool {
	if s.authorizer == nil {
		return acl.CanRead(principal, folder.OwnerID, "")
	}
	ok, err := s.authorizer.CanRead(ctx, principal, folder.ID)
	return err == nil && ok
}

func (s *Service) canWrite(ctx context.Context, principal acl.Principal, folder Folder) bool {
	if s.authorizer == nil {
		return acl.CanWrite(principal, folder.OwnerID, "")
	}
	ok, err := s.authorizer.CanWrite(ctx, principal, folder.ID)
	return err == nil && ok
}

func (s *Service) List(ctx context.Context, principal acl.Principal, parentID *string) ([]Folder, error) {
	if parentID != nil {
		parent, err := s.getRaw(ctx, *parentID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, fmt.Errorf("load parent folder: %w", err)
		}
		if !s.canRead(ctx, principal, parent) {
			return nil, ErrForbidden
		}
	}
	var rows *sql.Rows
	var err error
	if parentID == nil {
		if principal.Role == acl.RoleAdmin {
			rows, err = s.db.QueryContext(ctx, `SELECT id, owner_id, parent_id, storage_path, name, is_shared, created_at, updated_at
FROM folders WHERE parent_id IS NULL ORDER BY name COLLATE NOCASE, id`)
		} else {
			rows, err = s.db.QueryContext(ctx, `SELECT id, owner_id, parent_id, storage_path, name, is_shared, created_at, updated_at
FROM folders WHERE owner_id=? AND parent_id IS NULL ORDER BY name COLLATE NOCASE, id`, principal.UserID)
		}
	} else {
		rows, err = s.db.QueryContext(ctx, `SELECT id, owner_id, parent_id, storage_path, name, is_shared, created_at, updated_at
FROM folders WHERE parent_id=? ORDER BY name COLLATE NOCASE, id`, *parentID)
	}
	if err != nil {
		return nil, fmt.Errorf("list folders: %w", err)
	}
	defer rows.Close()
	allItems := make([]Folder, 0)
	for rows.Next() {
		folder, err := scanFolder(rows)
		if err != nil {
			return nil, fmt.Errorf("scan folder: %w", err)
		}
		allItems = append(allItems, folder)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list folder rows: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close folder rows: %w", err)
	}
	items := make([]Folder, 0, len(allItems))
	for _, folder := range allItems {
		if s.canRead(ctx, principal, folder) {
			items = append(items, folder)
		}
	}
	for i := range items {
		if err := s.addCounts(ctx, &items[i]); err != nil {
			return nil, err
		}
	}
	if parentID == nil && principal.Role != acl.RoleAdmin {
		if err := s.storage.EnsureUserRoot(principal.UserID); err != nil {
			return nil, fmt.Errorf("ensure private root: %w", err)
		}
	}
	return items, nil
}

func (s *Service) Get(ctx context.Context, principal acl.Principal, id string) (Folder, error) {
	folder, err := s.getRaw(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Folder{}, ErrNotFound
	}
	if err != nil {
		return Folder{}, fmt.Errorf("get folder: %w", err)
	}
	if !s.canRead(ctx, principal, folder) {
		return Folder{}, ErrForbidden
	}
	if err := s.addCounts(ctx, &folder); err != nil {
		return Folder{}, err
	}
	return folder, nil
}

func (s *Service) Create(ctx context.Context, principal acl.Principal, input CreateInput) (Folder, error) {
	if !acl.CanWrite(principal, principal.UserID, "") {
		return Folder{}, ErrForbidden
	}
	if err := storage.ValidateName(input.Name); err != nil {
		return Folder{}, ErrInvalidName
	}
	name := strings.TrimSpace(input.Name)
	ownerID := principal.UserID
	storagePath := filepath.Join("users", ownerID, name)
	if input.ParentID != nil {
		parent, err := s.getRaw(ctx, *input.ParentID)
		if errors.Is(err, sql.ErrNoRows) {
			return Folder{}, ErrNotFound
		}
		if err != nil {
			return Folder{}, fmt.Errorf("load parent folder: %w", err)
		}
		if !s.canWrite(ctx, principal, parent) {
			return Folder{}, ErrForbidden
		}
		ownerID = parent.OwnerID
		storagePath = filepath.Join(parent.StoragePath, name)
	}
	if err := s.storage.EnsureUserRoot(ownerID); err != nil {
		return Folder{}, fmt.Errorf("ensure folder owner root: %w", err)
	}
	relativeToUserRoot := strings.TrimPrefix(filepath.ToSlash(storagePath), "users/"+ownerID+"/")
	existing, err := s.storage.ResolveUserPath(ownerID, relativeToUserRoot)
	if err != nil {
		return Folder{}, fmt.Errorf("inspect folder path: %w", err)
	}
	if info, statErr := os.Stat(existing); statErr == nil {
		_ = info
		return Folder{}, ErrNameConflict
	} else if !os.IsNotExist(statErr) {
		return Folder{}, fmt.Errorf("inspect folder path: %w", statErr)
	}
	if err := s.storage.MakeUserDir(ownerID, relativeToUserRoot); err != nil {
		return Folder{}, fmt.Errorf("create folder on disk: %w", err)
	}
	now := time.Now().UTC()
	id := newFolderID()
	_, err = s.db.ExecContext(ctx, `INSERT INTO folders (id, owner_id, parent_id, storage_path, name, is_shared, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, 0, ?, ?)`, id, ownerID, input.ParentID, filepath.ToSlash(storagePath), name, formatTime(now), formatTime(now))
	if err != nil {
		_ = removeEmptyDir(s.storage, ownerID, relativeToUserRoot)
		if strings.Contains(err.Error(), "UNIQUE constraint failed: folders") {
			return Folder{}, ErrNameConflict
		}
		return Folder{}, fmt.Errorf("create folder index: %w", err)
	}
	return s.Get(ctx, principal, id)
}

func (s *Service) Rename(ctx context.Context, principal acl.Principal, id string, input RenameInput) (Folder, error) {
	folder, err := s.getRaw(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Folder{}, ErrNotFound
	}
	if err != nil {
		return Folder{}, err
	}
	if !s.canWrite(ctx, principal, folder) {
		return Folder{}, ErrForbidden
	}
	if err := storage.ValidateName(input.Name); err != nil {
		return Folder{}, ErrInvalidName
	}
	name := strings.TrimSpace(input.Name)
	if strings.EqualFold(name, folder.Name) {
		return s.Get(ctx, principal, id)
	}
	name, err = s.resolveFolderName(ctx, folder.ParentID, name, input.Conflict)
	if err != nil {
		return Folder{}, err
	}
	newStoragePath := filepath.ToSlash(filepath.Join(filepath.Dir(folder.StoragePath), name))
	if err := s.storage.Rename(folder.StoragePath, newStoragePath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return Folder{}, ErrNameConflict
		}
		return Folder{}, fmt.Errorf("rename folder on disk: %w", err)
	}
	if err := s.updateStoragePrefix(ctx, folder.StoragePath, newStoragePath, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE folders SET name=?, updated_at=? WHERE id=?", name, formatTime(time.Now().UTC()), id)
		return err
	}); err != nil {
		_ = s.storage.Rename(newStoragePath, folder.StoragePath)
		return Folder{}, err
	}
	return s.Get(ctx, principal, id)
}

func (s *Service) Move(ctx context.Context, principal acl.Principal, id, targetID string) (Folder, error) {
	return s.MoveWithConflict(ctx, principal, id, targetID, "reject")
}

func (s *Service) MoveWithConflict(ctx context.Context, principal acl.Principal, id, targetID, conflict string) (Folder, error) {
	folder, err := s.getRaw(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Folder{}, ErrNotFound
	}
	if err != nil {
		return Folder{}, err
	}
	target, err := s.getRaw(ctx, targetID)
	if errors.Is(err, sql.ErrNoRows) {
		return Folder{}, ErrNotFound
	}
	if err != nil {
		return Folder{}, err
	}
	if !s.canWrite(ctx, principal, folder) || !s.canWrite(ctx, principal, target) || folder.OwnerID != target.OwnerID {
		return Folder{}, ErrForbidden
	}
	if id == targetID || s.isDescendant(ctx, id, targetID) {
		return Folder{}, ErrDescendant
	}
	if folder.ParentID != nil && *folder.ParentID == target.ID {
		return folder, nil
	}
	name, err := s.resolveFolderName(ctx, &target.ID, folder.Name, conflict)
	if err != nil {
		return Folder{}, err
	}
	newStoragePath := filepath.ToSlash(filepath.Join(target.StoragePath, name))
	if err := s.storage.Rename(folder.StoragePath, newStoragePath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return Folder{}, ErrNameConflict
		}
		return Folder{}, fmt.Errorf("move folder on disk: %w", err)
	}
	if err := s.updateStoragePrefix(ctx, folder.StoragePath, newStoragePath, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE folders SET parent_id=?, name=?, updated_at=? WHERE id=?", target.ID, name, formatTime(time.Now().UTC()), id)
		return err
	}); err != nil {
		_ = s.storage.Rename(newStoragePath, folder.StoragePath)
		return Folder{}, err
	}
	return s.Get(ctx, principal, id)
}

func (s *Service) Delete(ctx context.Context, principal acl.Principal, id string) error {
	folder, err := s.getRaw(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !s.canWrite(ctx, principal, folder) {
		return ErrForbidden
	}
	var children, photos int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM folders WHERE parent_id=?", id).Scan(&children); err != nil {
		return fmt.Errorf("count folder children: %w", err)
	}
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM photos WHERE folder_id=? AND deleted_at IS NULL", id).Scan(&photos); err != nil {
		return fmt.Errorf("count folder photos: %w", err)
	}
	if children > 0 || photos > 0 {
		return ErrNotEmpty
	}
	if err := s.storage.RemoveEmptyDir(folder.StoragePath); err != nil {
		return fmt.Errorf("remove folder on disk: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "DELETE FROM folders WHERE id=?", id); err != nil {
		_ = s.storage.MakeDir(folder.StoragePath)
		return fmt.Errorf("remove folder index: %w", err)
	}
	return nil
}

func (s *Service) resolveFolderName(ctx context.Context, parentID *string, name, conflict string) (string, error) {
	var existing string
	var err error
	if parentID == nil {
		err = s.db.QueryRowContext(ctx, "SELECT name FROM folders WHERE parent_id IS NULL AND name=? COLLATE NOCASE LIMIT 1", name).Scan(&existing)
	} else {
		err = s.db.QueryRowContext(ctx, "SELECT name FROM folders WHERE parent_id=? AND name=? COLLATE NOCASE LIMIT 1", *parentID, name).Scan(&existing)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return name, nil
	}
	if err != nil {
		return "", fmt.Errorf("check folder name: %w", err)
	}
	if conflict != "rename" {
		return "", ErrNameConflict
	}
	for suffix := 1; suffix < 10000; suffix++ {
		candidate := fmt.Sprintf("%s (%d)", name, suffix)
		var candidateExisting string
		if parentID == nil {
			err = s.db.QueryRowContext(ctx, "SELECT name FROM folders WHERE parent_id IS NULL AND name=? COLLATE NOCASE LIMIT 1", candidate).Scan(&candidateExisting)
		} else {
			err = s.db.QueryRowContext(ctx, "SELECT name FROM folders WHERE parent_id=? AND name=? COLLATE NOCASE LIMIT 1", *parentID, candidate).Scan(&candidateExisting)
		}
		if errors.Is(err, sql.ErrNoRows) {
			return candidate, nil
		}
		if err != nil {
			return "", fmt.Errorf("check renamed folder: %w", err)
		}
	}
	return "", ErrNameConflict
}

func (s *Service) isDescendant(ctx context.Context, sourceID, targetID string) bool {
	current := targetID
	for current != "" {
		if current == sourceID {
			return true
		}
		var parent sql.NullString
		if err := s.db.QueryRowContext(ctx, "SELECT parent_id FROM folders WHERE id=?", current).Scan(&parent); err != nil || !parent.Valid {
			return false
		}
		current = parent.String
	}
	return false
}

func (s *Service) updateStoragePrefix(ctx context.Context, oldPrefix, newPrefix string, update func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin folder filesystem transaction: %w", err)
	}
	defer tx.Rollback()
	oldPrefix = filepath.ToSlash(oldPrefix)
	newPrefix = filepath.ToSlash(newPrefix)
	if _, err := tx.ExecContext(ctx, `UPDATE folders SET storage_path=? || substr(storage_path, length(?) + 1), updated_at=?
WHERE storage_path=? OR storage_path LIKE ? || '/%'`, newPrefix, oldPrefix, formatTime(time.Now().UTC()), oldPrefix, oldPrefix); err != nil {
		return fmt.Errorf("update descendant folder paths: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE photos SET storage_path=? || substr(storage_path, length(?) + 1), updated_at=?
WHERE storage_path=? OR storage_path LIKE ? || '/%'`, newPrefix, oldPrefix, formatTime(time.Now().UTC()), oldPrefix, oldPrefix); err != nil {
		return fmt.Errorf("update descendant photo paths: %w", err)
	}
	if err := update(tx); err != nil {
		return fmt.Errorf("update folder index: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit folder operation: %w", err)
	}
	return nil
}

func (s *Service) getRaw(ctx context.Context, id string) (Folder, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, owner_id, parent_id, storage_path, name, is_shared, created_at, updated_at FROM folders WHERE id=?`, id)
	return scanFolder(row)
}

func (s *Service) addCounts(ctx context.Context, folder *Folder) error {
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM photos WHERE folder_id=? AND deleted_at IS NULL", folder.ID).Scan(&folder.PhotoCount); err != nil {
		return fmt.Errorf("count folder photos: %w", err)
	}
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM folders WHERE parent_id=?", folder.ID).Scan(&folder.ChildFolderCount); err != nil {
		return fmt.Errorf("count child folders: %w", err)
	}
	return nil
}

type rowScanner interface{ Scan(...any) error }

func scanFolder(row rowScanner) (Folder, error) {
	var folder Folder
	var parentID sql.NullString
	var shared int
	var created, updated string
	if err := row.Scan(&folder.ID, &folder.OwnerID, &parentID, &folder.StoragePath, &folder.Name, &shared, &created, &updated); err != nil {
		return Folder{}, err
	}
	if parentID.Valid {
		folder.ParentID = &parentID.String
	}
	folder.IsShared = shared == 1
	var err error
	folder.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	if err != nil {
		return Folder{}, err
	}
	folder.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated)
	return folder, err
}

func removeEmptyDir(store storage.Store, ownerID, relative string) error {
	path, err := store.ResolveUserPath(ownerID, relative)
	if err != nil {
		return err
	}
	return os.Remove(path)
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func newFolderID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic("crypto/rand unavailable")
	}
	return "f_" + hex.EncodeToString(raw)
}
