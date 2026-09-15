package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type MobileSessionResponse struct {
	AccessToken           string       `json:"access_token"`
	AccessTokenExpiresAt  time.Time    `json:"access_token_expires_at"`
	RefreshToken          string       `json:"refresh_token"`
	RefreshTokenExpiresAt time.Time    `json:"refresh_token_expires_at"`
	Device                MobileDevice `json:"device"`
	User                  Account      `json:"user"`
}

type MobileHTTPHandler struct {
	service *Service
}

const (
	mobileLoginPath   = "/api/v1/mobile/auth/login"
	mobileRefreshPath = "/api/v1/mobile/auth/refresh"
	mobileLogoutPath  = "/api/v1/mobile/auth/logout"
	mobileDevicesPath = "/api/v1/mobile/devices"
)

func NewMobileHTTPHandler(service *Service) http.Handler {
	return &MobileHTTPHandler{service: service}
}

func (h *MobileHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == mobileLoginPath:
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		h.login(w, r)
	case r.URL.Path == mobileRefreshPath:
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		h.refresh(w, r)
	case r.URL.Path == mobileLogoutPath:
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		h.logout(w, r)
	case r.URL.Path == mobileDevicesPath || r.URL.Path == mobileDevicesPath+"/":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		h.listDevices(w, r)
	case strings.HasPrefix(r.URL.Path, mobileDevicesPath+"/"):
		deviceID := strings.TrimPrefix(r.URL.Path, mobileDevicesPath+"/")
		if deviceID == "" || strings.Contains(deviceID, "/") {
			writeAuthError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
			return
		}
		if r.Method != http.MethodDelete {
			methodNotAllowed(w, http.MethodDelete)
			return
		}
		h.deleteDevice(w, r, deviceID)
	default:
		writeAuthError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
	}
}

func (h *MobileHTTPHandler) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username   string `json:"username"`
		Password   string `json:"password"`
		DeviceName string `json:"device_name"`
		Platform   string `json:"platform"`
		AppVersion string `json:"app_version"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	account, err := h.service.AuthenticateAccount(r.Context(), input.Username, input.Password)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	session, err := h.service.CreateMobileSession(r.Context(), account.ID, MobileDeviceInput{
		Name: input.DeviceName, Platform: input.Platform, AppVersion: input.AppVersion,
	})
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeMobileSession(w, session, account)
}

func (h *MobileHTTPHandler) refresh(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RefreshToken string `json:"refresh_token"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	session, err := h.service.RefreshMobileSession(r.Context(), input.RefreshToken)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	account, err := h.service.mobileAccount(r.Context(), session.Device.UserID)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeMobileSession(w, session, account)
}

func (h *MobileHTTPHandler) logout(w http.ResponseWriter, r *http.Request) {
	principal, err := h.authenticateBearer(r)
	if err != nil {
		writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.service.RevokeMobileDevice(r.Context(), principal.Account.ID, principal.DeviceID); err != nil {
		if errors.Is(err, ErrUnauthorized) {
			writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
			return
		}
		writeAuthError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "request could not be completed", nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *MobileHTTPHandler) listDevices(w http.ResponseWriter, r *http.Request) {
	principal, err := h.authenticateBearer(r)
	if err != nil {
		writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	devices, err := h.service.ListMobileDevices(r.Context(), principal.Account.ID)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": devices})
}

func (h *MobileHTTPHandler) deleteDevice(w http.ResponseWriter, r *http.Request, deviceID string) {
	principal, err := h.authenticateBearer(r)
	if err != nil {
		writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.service.RevokeMobileDevice(r.Context(), principal.Account.ID, deviceID); err != nil {
		if errors.Is(err, ErrUnauthorized) {
			writeAuthError(w, r, http.StatusNotFound, "NOT_FOUND", "device not found", nil)
			return
		}
		writeAuthError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "request could not be completed", nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *MobileHTTPHandler) authenticateBearer(r *http.Request) (BearerPrincipal, error) {
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return BearerPrincipal{}, ErrUnauthorized
	}
	return h.service.CurrentBearer(r.Context(), parts[1])
}

func (h *MobileHTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrInvalidCredentials):
		writeAuthError(w, r, http.StatusUnauthorized, "INVALID_CREDENTIALS", "username or password is incorrect", nil)
	case errors.Is(err, ErrRateLimited):
		w.Header().Set("Retry-After", "60")
		writeAuthError(w, r, http.StatusTooManyRequests, "LOGIN_RATE_LIMITED", "too many login attempts; try again later", nil)
	case errors.Is(err, ErrUnauthorized), errors.Is(err, ErrRefreshReuse):
		writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
	default:
		if strings.Contains(err.Error(), "must be") {
			writeAuthError(w, r, http.StatusUnprocessableEntity, "INVALID_REQUEST", err.Error(), nil)
			return
		}
		writeAuthError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "request could not be completed", nil)
	}
}

func writeMobileSession(w http.ResponseWriter, session MobileSession, account Account) {
	writeJSON(w, http.StatusOK, MobileSessionResponse{
		AccessToken:           session.AccessToken,
		AccessTokenExpiresAt:  session.AccessTokenExpiresAt,
		RefreshToken:          session.RefreshToken,
		RefreshTokenExpiresAt: session.RefreshTokenExpiresAt,
		Device:                session.Device,
		User:                  account,
	})
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
	s.limiter.success(username)
	return account, nil
}

func (s *Service) mobileAccount(ctx context.Context, userID string) (Account, error) {
	var account Account
	var active int
	var deletedAt sql.NullString
	var created, updated string
	err := s.db.QueryRowContext(ctx, `SELECT id, username, role, is_active, deleted_at, created_at, updated_at
FROM users WHERE id=?`, userID).Scan(&account.ID, &account.Username, &account.Role, &active, &deletedAt, &created, &updated)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Account{}, ErrUnauthorized
		}
		return Account{}, fmt.Errorf("load mobile account: %w", err)
	}
	if active != 1 || deletedAt.Valid {
		return Account{}, ErrUnauthorized
	}
	account.IsActive = true
	account.CreatedAt, err = parseTime(created)
	if err != nil {
		return Account{}, fmt.Errorf("parse mobile account creation time: %w", err)
	}
	account.UpdatedAt, err = parseTime(updated)
	if err != nil {
		return Account{}, fmt.Errorf("parse mobile account update time: %w", err)
	}
	return account, nil
}
