package maintenance

import (
	"encoding/json"
	"net/http"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
)

const statusPath = "/api/v1/admin/maintenance"

type HTTPHandler struct {
	lock        *Lock
	authService *auth.Service
}

// NewHTTPHandler exposes the running maintenance activity so clients can
// re-attach to a job after a page reload.
func NewHTTPHandler(lock *Lock, authService *auth.Service) http.Handler {
	return &HTTPHandler{lock: lock, authService: authService}
}

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != statusPath {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
		return
	}
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required")
		return
	}
	if authenticated.Account.Role != acl.RoleAdmin {
		writeError(w, r, http.StatusForbidden, "ADMIN_REQUIRED", "administrator access is required")
		return
	}
	var active *Activity
	if current, ok := h.lock.Current(); ok {
		active = &current
	}
	writeJSON(w, http.StatusOK, map[string]any{"active": active})
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "request-id-missing"
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{
		"code": code, "message": message, "request_id": requestID,
	}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
