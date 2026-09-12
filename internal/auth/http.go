package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type HTTPHandler struct {
	service      *Service
	secureCookie bool
}

func NewHTTPHandler(service *Service, secureCookie bool) http.Handler {
	return &HTTPHandler{service: service, secureCookie: secureCookie}
}

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/api/v1/setup/admin":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		h.setup(w, r)
	case r.URL.Path == "/api/v1/auth/login":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		h.login(w, r)
	case r.URL.Path == "/api/v1/auth/logout":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		h.logout(w, r)
	case r.URL.Path == "/api/v1/auth/me":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		h.me(w, r)
	default:
		writeAuthError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
	}
}

func (h *HTTPHandler) setup(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	account, session, err := h.service.SetupAdmin(r.Context(), input.Username, input.Password)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeAuthSession(w, http.StatusCreated, account, session, h.secureCookie)
}

func (h *HTTPHandler) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	account, session, err := h.service.Authenticate(r.Context(), input.Username, input.Password)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeAuthSession(w, http.StatusOK, account, session, h.secureCookie)
}

func (h *HTTPHandler) logout(w http.ResponseWriter, r *http.Request) {
	account, session, token, err := h.authenticate(r)
	_ = account
	if err != nil {
		writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.service.ValidateCSRF(session, r.Header.Get(CSRFHeaderName())); err != nil {
		writeAuthError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	if err := h.service.Revoke(r.Context(), token); err != nil {
		writeAuthError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "could not revoke session", nil)
		return
	}
	ClearSessionCookie(w, h.secureCookie)
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) me(w http.ResponseWriter, r *http.Request) {
	account, _, _, err := h.authenticate(r)
	if err != nil {
		writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	writeJSON(w, http.StatusOK, account)
}

func (h *HTTPHandler) authenticate(r *http.Request) (Account, Session, string, error) {
	token := SessionTokenFromRequest(r)
	account, session, err := h.service.Current(r.Context(), token)
	return account, session, token, err
}

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrInvalidCredentials):
		writeAuthError(w, r, http.StatusUnauthorized, "INVALID_CREDENTIALS", "username or password is incorrect", nil)
	case errors.Is(err, ErrRateLimited):
		w.Header().Set("Retry-After", "60")
		writeAuthError(w, r, http.StatusTooManyRequests, "LOGIN_RATE_LIMITED", "too many login attempts; try again later", nil)
	case errors.Is(err, ErrSetupComplete):
		writeAuthError(w, r, http.StatusConflict, "SETUP_COMPLETE", "administrator setup is already complete", nil)
	default:
		if strings.Contains(err.Error(), "must be") {
			writeAuthError(w, r, http.StatusUnprocessableEntity, "INVALID_REQUEST", err.Error(), nil)
			return
		}
		writeAuthError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "request could not be completed", nil)
	}
}

func SessionTokenFromRequest(r *http.Request) string {
	cookie, err := r.Cookie(SessionCookieName())
	if err != nil {
		return ""
	}
	return cookie.Value
}

func (s *Service) AuthenticateRequest(ctx context.Context, r *http.Request) (Account, Session, string, error) {
	token := SessionTokenFromRequest(r)
	account, session, err := s.Current(ctx, token)
	return account, session, token, err
}

func writeAuthSession(w http.ResponseWriter, status int, account Account, session Session, secure bool) {
	SetSessionCookie(w, session, secure)
	w.Header().Set("X-CSRF-Token", session.CSRFToken)
	writeJSON(w, status, map[string]any{"user": account, "csrf_token": session.CSRFToken})
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeAuthError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body is invalid", nil)
		return false
	}
	return true
}

func writeAuthError(w http.ResponseWriter, r *http.Request, status int, code, message string, details map[string]any) {
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "request-id-missing"
	}
	payload := map[string]any{"error": map[string]any{"code": code, "message": message, "request_id": requestID}}
	if details != nil {
		payload["error"].(map[string]any)["details"] = details
	}
	writeJSON(w, status, payload)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func methodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": map[string]any{"code": "INVALID_REQUEST", "message": "method not allowed", "request_id": "request-id-missing"}})
}
