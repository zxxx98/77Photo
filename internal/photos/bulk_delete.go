package photos

import (
	"errors"
	"net/http"
	"strings"

	"github.com/zxxx98/77Photo/internal/auth"
)

const maxBulkDeletePhotos = 500

type BulkDeleteFailure struct {
	ID   string `json:"id"`
	Code string `json:"code"`
}

type BulkDeleteResult struct {
	DeletedIDs []string            `json:"deleted_ids"`
	Failed     []BulkDeleteFailure `json:"failed"`
}

type BulkDeleteHTTPHandler struct {
	service     *Service
	authService *auth.Service
}

func NewBulkDeleteHTTPHandler(service *Service, authService *auth.Service) *BulkDeleteHTTPHandler {
	return &BulkDeleteHTTPHandler{service: service, authService: authService}
}

func (h *BulkDeleteHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/v1/photos/batch-delete" {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
		return
	}

	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.AuthorizeWrite(r, authenticated); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}

	var input struct {
		IDs     []string `json:"ids"`
		Confirm bool     `json:"confirm"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if !input.Confirm {
		writeError(w, r, http.StatusUnprocessableEntity, "CONFIRMATION_REQUIRED", "explicit confirmation is required before permanent deletion", nil)
		return
	}

	ids := make([]string, 0, len(input.IDs))
	seen := make(map[string]struct{}, len(input.IDs))
	for _, raw := range input.IDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 || len(ids) > maxBulkDeletePhotos {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "ids must contain between 1 and 500 unique photo ids", nil)
		return
	}

	result := BulkDeleteResult{
		DeletedIDs: make([]string, 0, len(ids)),
		Failed:     make([]BulkDeleteFailure, 0),
	}
	principalValue := principal(authenticated.Account)
	for _, id := range ids {
		if err := h.service.Delete(r.Context(), principalValue, id, true); err != nil {
			result.Failed = append(result.Failed, BulkDeleteFailure{ID: id, Code: bulkDeleteErrorCode(err)})
			continue
		}
		result.DeletedIDs = append(result.DeletedIDs, id)
	}

	writeJSON(w, http.StatusOK, result)
}

func bulkDeleteErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrForbidden):
		return "WRITE_FORBIDDEN"
	case errors.Is(err, ErrNotFound):
		return "NOT_FOUND"
	default:
		return "INTERNAL_ERROR"
	}
}
