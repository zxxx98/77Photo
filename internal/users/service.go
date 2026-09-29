package users

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/maintenance"
	"github.com/zxxx98/77Photo/internal/storage"
)

var (
	ErrAdminRequired    = errors.New("administrator role required")
	ErrUserNotFound     = errors.New("user not found")
	ErrUsernameTaken    = errors.New("username already exists")
	ErrLastAdmin        = errors.New("cannot remove the last active administrator")
	ErrInvalidInput     = errors.New("invalid user input")
	ErrTransferRequired = errors.New("photo transfer target required")
	ErrTransferInvalid  = errors.New("invalid photo transfer target")
)

type Service struct {
	db          *sql.DB
	auth        *auth.Service
	storage     *storage.Store
	maintenance *maintenance.Lock
}

type CreateInput struct {
	Username string
	Password string
	Role     acl.Role
}

type UpdateInput struct {
	Username *string   `json:"username"`
	Password *string   `json:"password"`
	Role     *acl.Role `json:"role"`
	IsActive *bool     `json:"is_active"`
}

type DeleteInput struct {
	PhotoAction      string `json:"photo_action"`
	TransferToUserID string `json:"transfer_to_user_id"`
}

func NewService(db *sql.DB, authService *auth.Service) *Service {
	return &Service{db: db, auth: authService}
}

// SetStorage enables photo transfer on deletion, which moves the deleted
// user's files into the recipient's storage root.
func (s *Service) SetStorage(store storage.Store) { s.storage = &store }

func (s *Service) SetMaintenanceLock(lock *maintenance.Lock) { s.maintenance = lock }

func (s *Service) List(ctx context.Context, principal acl.Principal) ([]auth.Account, error) {
	if !acl.CanManageUsers(principal) {
		return nil, ErrAdminRequired
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, COALESCE(deleted_username, username) AS display_name, role, is_active, deleted_at, created_at, updated_at
FROM users ORDER BY display_name COLLATE NOCASE, id`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	var accounts []auth.Account
	for rows.Next() {
		account, err := scanAccount(rows)
		if err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		accounts = append(accounts, account)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list users rows: %w", err)
	}
	return accounts, nil
}

func (s *Service) Create(ctx context.Context, principal acl.Principal, input CreateInput) (auth.Account, error) {
	if !acl.CanManageUsers(principal) {
		return auth.Account{}, ErrAdminRequired
	}
	if err := auth.ValidateCredentials(input.Username, input.Password); err != nil {
		return auth.Account{}, fmt.Errorf("%w: %w", ErrInvalidInput, err)
	}
	if input.Role != acl.RoleAdmin && input.Role != acl.RoleUser {
		return auth.Account{}, fmt.Errorf("%w: invalid role", ErrInvalidInput)
	}
	hash, err := auth.HashPassword(input.Password)
	if err != nil {
		return auth.Account{}, err
	}
	now := time.Now().UTC()
	id := newUserID()
	_, err = s.db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES (?, ?, ?, ?, 1, ?, ?)`, id, strings.TrimSpace(input.Username), hash, input.Role, formatTime(now), formatTime(now))
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: users.username") {
			return auth.Account{}, ErrUsernameTaken
		}
		return auth.Account{}, fmt.Errorf("create user: %w", err)
	}
	return s.get(ctx, id)
}

func (s *Service) Update(ctx context.Context, principal acl.Principal, id string, input UpdateInput) (auth.Account, error) {
	if !acl.CanManageUsers(principal) {
		return auth.Account{}, ErrAdminRequired
	}
	if strings.TrimSpace(id) == "" {
		return auth.Account{}, ErrUserNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return auth.Account{}, fmt.Errorf("begin user update: %w", err)
	}
	defer tx.Rollback()
	var currentRole string
	var active int
	if err := tx.QueryRowContext(ctx, "SELECT role, is_active FROM users WHERE id=? AND deleted_at IS NULL", id).Scan(&currentRole, &active); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return auth.Account{}, ErrUserNotFound
		}
		return auth.Account{}, fmt.Errorf("load user for update: %w", err)
	}
	sets := make([]string, 0, 4)
	args := make([]any, 0, 5)
	if input.Username != nil {
		if err := auth.ValidateCredentials(*input.Username, "valid password"); err != nil {
			return auth.Account{}, fmt.Errorf("%w: %w", ErrInvalidInput, err)
		}
		sets = append(sets, "username=?")
		args = append(args, strings.TrimSpace(*input.Username))
	}
	if input.Password != nil {
		if err := auth.ValidateCredentials("valid-user", *input.Password); err != nil {
			return auth.Account{}, fmt.Errorf("%w: %w", ErrInvalidInput, err)
		}
		hash, err := auth.HashPassword(*input.Password)
		if err != nil {
			return auth.Account{}, err
		}
		sets = append(sets, "password_hash=?")
		args = append(args, hash)
	}
	if input.Role != nil {
		if *input.Role != acl.RoleAdmin && *input.Role != acl.RoleUser {
			return auth.Account{}, ErrInvalidInput
		}
		if currentRole == string(acl.RoleAdmin) && active == 1 && *input.Role != acl.RoleAdmin {
			if err := ensureAnotherAdmin(ctx, tx, id); err != nil {
				return auth.Account{}, err
			}
		}
		sets = append(sets, "role=?")
		args = append(args, *input.Role)
	}
	if input.IsActive != nil {
		if !*input.IsActive && currentRole == string(acl.RoleAdmin) && active == 1 {
			if err := ensureAnotherAdmin(ctx, tx, id); err != nil {
				return auth.Account{}, err
			}
		}
		sets = append(sets, "is_active=?")
		if *input.IsActive {
			args = append(args, 1)
		} else {
			args = append(args, 0)
		}
	}
	if len(sets) == 0 {
		return auth.Account{}, ErrInvalidInput
	}
	sets = append(sets, "updated_at=?")
	args = append(args, formatTime(time.Now().UTC()), id)
	result, err := tx.ExecContext(ctx, "UPDATE users SET "+strings.Join(sets, ", ")+" WHERE id=? AND deleted_at IS NULL", args...)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: users.username") {
			return auth.Account{}, ErrUsernameTaken
		}
		return auth.Account{}, fmt.Errorf("update user: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return auth.Account{}, ErrUserNotFound
	}
	if input.Password != nil || (input.IsActive != nil && !*input.IsActive) {
		if err := s.auth.RevokeMobileSessionsForUserTx(ctx, tx, id); err != nil {
			return auth.Account{}, fmt.Errorf("revoke user mobile sessions: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", formatTime(time.Now().UTC()), id); err != nil {
			return auth.Account{}, fmt.Errorf("revoke user browser sessions: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return auth.Account{}, fmt.Errorf("commit user update: %w", err)
	}
	return s.get(ctx, id)
}

func (s *Service) Delete(ctx context.Context, principal acl.Principal, id string, input DeleteInput) error {
	if !acl.CanManageUsers(principal) {
		return ErrAdminRequired
	}
	if input.PhotoAction == "" {
		input.PhotoAction = "retain"
	}
	if input.PhotoAction != "retain" && input.PhotoAction != "transfer" {
		return ErrInvalidInput
	}
	if input.PhotoAction == "transfer" {
		if s.storage == nil {
			return errors.New("photo transfer requires storage")
		}
		// Moving files must not race a rescan, import or cleanup.
		release, err := s.maintenance.Acquire(maintenance.KindUserTransfer, "")
		if err != nil {
			return err
		}
		defer release()
	}
	if s.storage != nil {
		unlock := s.storage.LockMutations()
		defer unlock()
		if err := storage.CheckPendingTrash(ctx, s.db); err != nil {
			return err
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin user deletion: %w", err)
	}
	defer tx.Rollback()
	var role string
	var active int
	if err := tx.QueryRowContext(ctx, "SELECT role, is_active FROM users WHERE id=? AND deleted_at IS NULL", id).Scan(&role, &active); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUserNotFound
		}
		return fmt.Errorf("load user for deletion: %w", err)
	}
	if role == string(acl.RoleAdmin) && active == 1 {
		if err := ensureAnotherAdmin(ctx, tx, id); err != nil {
			return err
		}
	}
	now := formatTime(time.Now().UTC())
	if input.PhotoAction == "transfer" {
		if strings.TrimSpace(input.TransferToUserID) == "" {
			return ErrTransferRequired
		}
		if input.TransferToUserID == id {
			return ErrTransferInvalid
		}
		var targetActive int
		if err := tx.QueryRowContext(ctx, "SELECT is_active FROM users WHERE id=? AND deleted_at IS NULL", input.TransferToUserID).Scan(&targetActive); err != nil || targetActive != 1 {
			return ErrTransferInvalid
		}
	}
	if err := s.auth.RevokeMobileSessionsForUserTx(ctx, tx, id); err != nil {
		return fmt.Errorf("revoke deleted user mobile sessions: %w", err)
	}
	var moves []storageMove
	committed := false
	defer func() {
		if !committed {
			s.undoMoves(moves)
		}
	}()
	if input.PhotoAction == "transfer" {
		if moves, err = s.moveUserStorage(ctx, tx, id, input.TransferToUserID, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE folders SET owner_id=?, updated_at=? WHERE owner_id=?", input.TransferToUserID, now, id); err != nil {
			return fmt.Errorf("transfer folders: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "UPDATE photos SET owner_id=?, updated_at=? WHERE owner_id=?", input.TransferToUserID, now, id); err != nil {
			return fmt.Errorf("transfer photos: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM users WHERE id=?", id); err != nil {
			return fmt.Errorf("delete transferred user: %w", err)
		}
	} else {
		// Free the username for reuse while keeping it for display.
		if _, err := tx.ExecContext(ctx, "UPDATE users SET is_active=0, deleted_at=?, updated_at=?, deleted_username=username, username=? WHERE id=?", now, now, tombstoneUsername(id), id); err != nil {
			return fmt.Errorf("tombstone user: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", now, id); err != nil {
		return fmt.Errorf("revoke deleted user sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit user deletion: %w", err)
	}
	committed = true
	if input.PhotoAction == "transfer" {
		_ = s.storage.RemoveEmptyDir("users/" + id)
	}
	return nil
}

func ensureAnotherAdmin(ctx context.Context, tx *sql.Tx, excludingID string) error {
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM users WHERE role='admin' AND is_active=1 AND deleted_at IS NULL AND id<>?", excludingID).Scan(&count); err != nil {
		return fmt.Errorf("count administrators: %w", err)
	}
	if count == 0 {
		return ErrLastAdmin
	}
	return nil
}

func (s *Service) get(ctx context.Context, id string) (auth.Account, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, COALESCE(deleted_username, username), role, is_active, deleted_at, created_at, updated_at FROM users WHERE id=?`, id)
	account, err := scanAccount(row)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.Account{}, ErrUserNotFound
	}
	if err != nil {
		return auth.Account{}, fmt.Errorf("get user: %w", err)
	}
	return account, nil
}

type rowScanner interface{ Scan(...any) error }

func scanAccount(row rowScanner) (auth.Account, error) {
	var account auth.Account
	var role string
	var active int
	var deletedAt, created, updated sql.NullString
	if err := row.Scan(&account.ID, &account.Username, &role, &active, &deletedAt, &created, &updated); err != nil {
		return auth.Account{}, err
	}
	account.Role = acl.Role(role)
	account.IsActive = active == 1
	if deletedAt.Valid {
		value, err := time.Parse(time.RFC3339Nano, deletedAt.String)
		if err != nil {
			return auth.Account{}, err
		}
		account.DeletedAt = &value
	}
	account.CreatedAt, _ = time.Parse(time.RFC3339Nano, created.String)
	account.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updated.String)
	return account, nil
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

// tombstoneUsername is stored in place of a deleted user's name. It contains a
// control character, so it can never collide with a valid username.
func tombstoneUsername(id string) string { return "\x1fdeleted\x1f" + id }

// newUserID returns a random, unguessable ID. The ID also names the user's
// storage directory, so it is hex only.
func newUserID() string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic("crypto/rand unavailable")
	}
	return "u_" + hex.EncodeToString(raw[:])
}
