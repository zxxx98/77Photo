package auth

import (
	"encoding/json"
	"errors"
	"io"
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
	case r.URL.Path == "/api/v1/setup/status":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, r, http.MethodGet)
			return
		}
		h.setupStatus(w, r)
	case r.URL.Path == "/api/v1/setup/admin":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, r, http.MethodPost)
			return
		}
		h.setup(w, r)
	case r.URL.Path == "/api/v1/auth/login":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, r, http.MethodPost)
			return
		}
		h.login(w, r)
	case r.URL.Path == "/api/v1/auth/logout":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, r, http.MethodPost)
			return
		}
		h.logout(w, r)
	case r.URL.Path == "/api/v1/auth/me":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, r, http.MethodGet)
			return
		}
		h.me(w, r)
	default:
		writeAuthError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
	}
}

func (h *HTTPHandler) setupStatus(w http.ResponseWriter, r *http.Request) {
	required, err := h.service.SetupRequired(r.Context())
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"required": required})
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
	authenticated, err := h.service.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.service.AuthorizeWrite(r, authenticated); err != nil {
		writeAuthError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	if authenticated.Method == AuthMethodBearer {
		if err := h.service.RevokeMobileDevice(r.Context(), authenticated.Account.ID, authenticated.DeviceID); err != nil {
			if errors.Is(err, ErrUnauthorized) {
				writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
				return
			}
			writeAuthError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "could not revoke mobile device", nil)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := h.service.Revoke(r.Context(), authenticated.Credential); err != nil {
		writeAuthError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "could not revoke session", nil)
		return
	}
	ClearSessionCookie(w, h.secureCookie)
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) me(w http.ResponseWriter, r *http.Request) {
	authenticated, err := h.service.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeAuthError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if authenticated.Method == AuthMethodCookie {
		csrfToken := CSRFTokenFromRequest(r)
		if h.service.ValidateCSRF(authenticated.Session, csrfToken) != nil {
			csrfToken, err = h.service.RotateCSRF(r.Context(), authenticated.Session.ID)
			if err != nil {
				writeAuthError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "could not refresh csrf token", nil)
				return
			}
			SetCSRFTokenCookie(w, csrfToken, authenticated.Session.ExpiresAt, h.secureCookie)
		}
		w.Header().Set(CSRFHeaderName(), csrfToken)
	}
	writeJSON(w, http.StatusOK, authenticated.Account)
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

func CSRFTokenFromRequest(r *http.Request) string {
	cookie, err := r.Cookie(CSRFTokenCookieName())
	if err != nil {
		return ""
	}
	return cookie.Value
}

func writeAuthSession(w http.ResponseWriter, status int, account Account, session Session, secure bool) {
	SetSessionCookie(w, session, secure)
	SetCSRFTokenCookie(w, session.CSRFToken, session.ExpiresAt, secure)
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
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
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

func methodNotAllowed(w http.ResponseWriter, r *http.Request, allowed string) {
	w.Header().Set("Allow", allowed)
	writeAuthError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
}
