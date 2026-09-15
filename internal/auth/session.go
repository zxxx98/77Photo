package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/zxxx98/77Photo/internal/acl"
)

var (
	ErrSetupComplete      = errors.New("admin setup already complete")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrUnauthorized       = errors.New("unauthorized")
	ErrCSRF               = errors.New("invalid csrf token")
	ErrRateLimited        = errors.New("login rate limited")
)

const (
	sessionCookieName = "77photo_session"
	csrfCookieName    = "77photo_csrf"
	csrfHeaderName    = "X-CSRF-Token"
)

type Role = acl.Role

const (
	RoleAdmin = acl.RoleAdmin
	RoleUser  = acl.RoleUser
)

type Account struct {
	ID        string     `json:"id"`
	Username  string     `json:"username"`
	Role      Role       `json:"role"`
	IsActive  bool       `json:"is_active"`
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

type Session struct {
	ID        string
	UserID    string
	Token     string
	CSRFToken string
	ExpiresAt time.Time
}

type Service struct {
	db           *sql.DB
	ttl          time.Duration
	secureCookie bool
	limiter      *loginLimiter
}

func NewService(db *sql.DB, ttl time.Duration, secureCookie bool) *Service {
	return &Service{db: db, ttl: ttl, secureCookie: secureCookie, limiter: newLoginLimiter()}
}

func (s *Service) SetupRequired(ctx context.Context) (bool, error) {
	var count int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil {
		return false, fmt.Errorf("check admin setup: %w", err)
	}
	return count == 0, nil
}

func (s *Service) SetupAdmin(ctx context.Context, username, password string) (Account, Session, error) {
	if err := validateCredentials(username, password); err != nil {
		return Account{}, Session{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, Session{}, fmt.Errorf("begin admin setup: %w", err)
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil {
		return Account{}, Session{}, fmt.Errorf("check admin setup: %w", err)
	}
	if count != 0 {
		return Account{}, Session{}, ErrSetupComplete
	}
	hash, err := HashPassword(password)
	if err != nil {
		return Account{}, Session{}, err
	}
	now := time.Now().UTC()
	account := Account{ID: newID(), Username: strings.TrimSpace(username), Role: RoleAdmin, IsActive: true, CreatedAt: now, UpdatedAt: now}
	if _, err := tx.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES (?, ?, ?, ?, 1, ?, ?)`, account.ID, account.Username, hash, account.Role, formatTime(now), formatTime(now)); err != nil {
		return Account{}, Session{}, fmt.Errorf("create admin: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Account{}, Session{}, fmt.Errorf("commit admin setup: %w", err)
	}
	session, err := s.createSession(ctx, account.ID)
	if err != nil {
		return Account{}, Session{}, err
	}
	return account, session, nil
}

func (s *Service) Authenticate(ctx context.Context, username, password string) (Account, Session, error) {
	account, err := s.AuthenticateAccount(ctx, username, password)
	if err != nil {
		return Account{}, Session{}, err
	}
	session, err := s.createSession(ctx, account.ID)
	if err != nil {
		return Account{}, Session{}, err
	}
	return account, session, nil
}

func (s *Service) AuthenticateAccount(ctx context.Context, username, password string) (Account, error) {
	if !s.limiter.allow(username) {
		return Account{}, ErrRateLimited
	}
	var account Account
	var hash string
	var active int
	var deletedAt sql.NullString
	var created, updated string
	err := s.db.QueryRowContext(ctx, `SELECT id, username, password_hash, role, is_active, deleted_at, created_at, updated_at
FROM users WHERE username = ? COLLATE NOCASE`, strings.TrimSpace(username)).Scan(&account.ID, &account.Username, &hash, &account.Role, &active, &deletedAt, &created, &updated)
	if err != nil {
		s.limiter.failure(username)
		return Account{}, ErrInvalidCredentials
	}
	ok, verifyErr := VerifyPassword(hash, password)
	if verifyErr != nil || !ok || active == 0 || deletedAt.Valid {
		s.limiter.failure(username)
		return Account{}, ErrInvalidCredentials
	}
	account.IsActive = true
	account.CreatedAt, _ = parseTime(created)
	account.UpdatedAt, _ = parseTime(updated)
	if deletedAt.Valid {
		deleted, _ := parseTime(deletedAt.String)
		account.DeletedAt = &deleted
	}
	s.limiter.success(username)
	return account, nil
}

func (s *Service) Current(ctx context.Context, token string) (Account, Session, error) {
	if token == "" {
		return Account{}, Session{}, ErrUnauthorized
	}
	hash := hashToken(token)
	var account Account
	var session Session
	var active int
	var deletedAt sql.NullString
	var created, updated, expires, csrfHash string
	err := s.db.QueryRowContext(ctx, `SELECT s.id, s.user_id, s.expires_at, s.csrf_token_hash,
u.id, u.username, u.role, u.is_active, u.deleted_at, u.created_at, u.updated_at
FROM sessions s JOIN users u ON u.id = s.user_id
WHERE s.token_hash = ? AND s.revoked_at IS NULL`, hash).Scan(
		&session.ID, &session.UserID, &expires, &csrfHash,
		&account.ID, &account.Username, &account.Role, &active, &deletedAt, &created, &updated,
	)
	if err != nil || active == 0 || deletedAt.Valid {
		return Account{}, Session{}, ErrUnauthorized
	}
	session.ExpiresAt, err = parseTime(expires)
	if err != nil || !session.ExpiresAt.After(time.Now().UTC()) {
		return Account{}, Session{}, ErrUnauthorized
	}
	account.IsActive = true
	account.CreatedAt, _ = parseTime(created)
	account.UpdatedAt, _ = parseTime(updated)
	if deletedAt.Valid {
		deleted, _ := parseTime(deletedAt.String)
		account.DeletedAt = &deleted
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE sessions SET last_seen_at=? WHERE id=?", formatTime(time.Now().UTC()), session.ID); err != nil {
		return Account{}, Session{}, fmt.Errorf("update session activity: %w", err)
	}
	// The raw CSRF token is never stored; ValidateCSRF hashes a supplied value
	// and compares it with this session's persisted digest.
	session.CSRFToken = csrfHash
	return account, session, nil
}

// RotateCSRF replaces the persisted CSRF digest for an active session and
// returns the new opaque token. The raw token is only returned to the caller
// so it can be sent to the browser in a response header/cookie.
func (s *Service) RotateCSRF(ctx context.Context, sessionID string) (string, error) {
	if sessionID == "" {
		return "", ErrUnauthorized
	}
	token := randomToken()
	result, err := s.db.ExecContext(ctx, "UPDATE sessions SET csrf_token_hash=? WHERE id=? AND revoked_at IS NULL", hashToken(token), sessionID)
	if err != nil {
		return "", fmt.Errorf("rotate csrf token: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return "", fmt.Errorf("check rotated csrf token: %w", err)
	}
	if rows != 1 {
		return "", ErrUnauthorized
	}
	return token, nil
}

func (s *Service) Revoke(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	result, err := s.db.ExecContext(ctx, "UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL", formatTime(time.Now().UTC()), hashToken(token))
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	if _, err := result.RowsAffected(); err != nil {
		return fmt.Errorf("check revoked session: %w", err)
	}
	return nil
}

func (s *Service) createSession(ctx context.Context, userID string) (Session, error) {
	token := randomToken()
	csrf := randomToken()
	now := time.Now().UTC()
	session := Session{ID: newID(), UserID: userID, Token: token, CSRFToken: csrf, ExpiresAt: now.Add(s.ttl)}
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at, created_at, last_seen_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`, session.ID, userID, hashToken(token), hashToken(csrf), formatTime(session.ExpiresAt), formatTime(now), formatTime(now))
	if err != nil {
		return Session{}, fmt.Errorf("create session: %w", err)
	}
	return session, nil
}

func (s *Service) ValidateCSRF(session Session, supplied string) error {
	if supplied == "" || session.CSRFToken == "" {
		return ErrCSRF
	}
	// Current() returns the persisted hash in CSRFToken. Newly-created sessions
	// carry the raw token, so accept either representation without persisting a
	// secret in logs or cookies.
	if strings.HasPrefix(session.CSRFToken, "sha256:") {
		if constantTokenEqual(session.CSRFToken, hashToken(supplied)) {
			return nil
		}
		return ErrCSRF
	}
	if constantTokenEqual(session.CSRFToken, supplied) {
		return nil
	}
	return ErrCSRF
}

func SessionCookieName() string   { return sessionCookieName }
func CSRFTokenCookieName() string { return csrfCookieName }
func CSRFHeaderName() string      { return csrfHeaderName }

func SetSessionCookie(w http.ResponseWriter, session Session, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: session.Token, Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, Expires: session.ExpiresAt, MaxAge: int(time.Until(session.ExpiresAt).Seconds())})
}

// SetCSRFTokenCookie uses the double-submit pattern: the token is readable by
// the browser so a restored session can repopulate the in-memory API client,
// while the session cookie remains HttpOnly.
func SetCSRFTokenCookie(w http.ResponseWriter, token string, expiresAt time.Time, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: csrfCookieName, Value: token, Path: "/", HttpOnly: false, Secure: secure, SameSite: http.SameSiteLaxMode, Expires: expiresAt, MaxAge: int(time.Until(expiresAt).Seconds())})
}

func ClearSessionCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0).UTC()})
	http.SetCookie(w, &http.Cookie{Name: csrfCookieName, Value: "", Path: "/", HttpOnly: false, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0).UTC()})
}

func validateCredentials(username, password string) error {
	if strings.TrimSpace(username) == "" || utf8.RuneCountInString(username) > 64 {
		return fmt.Errorf("username must be 1-64 characters")
	}
	if utf8.RuneCountInString(password) < 12 || utf8.RuneCountInString(password) > 256 {
		return fmt.Errorf("password must be 12-256 characters")
	}
	return nil
}

func newID() string { return randomToken()[:22] }

func randomToken() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic("crypto/rand unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func hashToken(token string) string {
	digest := sha256.Sum256([]byte(token))
	return fmt.Sprintf("sha256:%x", digest[:])
}

func constantTokenEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func parseTime(value string) (time.Time, error) { return time.Parse(time.RFC3339Nano, value) }

type loginLimiter struct {
	mu      sync.Mutex
	entries map[string]loginAttempt
}

type loginAttempt struct {
	count       int
	windowStart time.Time
	blockedTill time.Time
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{entries: make(map[string]loginAttempt)} }

func (l *loginLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	entry := l.entries[strings.ToLower(strings.TrimSpace(key))]
	if !entry.blockedTill.IsZero() && now.Before(entry.blockedTill) {
		return false
	}
	if entry.windowStart.IsZero() || now.Sub(entry.windowStart) >= 15*time.Minute {
		entry = loginAttempt{windowStart: now}
	}
	l.entries[strings.ToLower(strings.TrimSpace(key))] = entry
	return true
}

func (l *loginLimiter) failure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	normalized := strings.ToLower(strings.TrimSpace(key))
	entry := l.entries[normalized]
	if entry.windowStart.IsZero() || time.Since(entry.windowStart) >= 15*time.Minute {
		entry = loginAttempt{windowStart: time.Now()}
	}
	entry.count++
	if entry.count >= 5 {
		entry.blockedTill = time.Now().Add(time.Minute)
	}
	l.entries[normalized] = entry
}

func (l *loginLimiter) success(key string) {
	l.mu.Lock()
	delete(l.entries, strings.ToLower(strings.TrimSpace(key)))
	l.mu.Unlock()
}
