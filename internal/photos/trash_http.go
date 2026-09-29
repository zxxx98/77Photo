package photos

import (
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/maintenance"
	"github.com/zxxx98/77Photo/internal/storage"
	"github.com/zxxx98/77Photo/internal/thumbnails"
)

type TrashHTTPHandler struct{ *HTTPHandler }

func NewTrashHTTPHandler(service *Service, authService *auth.Service, thumbs ThumbnailService) *TrashHTTPHandler {
	h := NewHTTPHandler(service, authService)
	h.SetThumbnailService(thumbs)
	return &TrashHTTPHandler{h}
}

type TrashBatchResult struct {
	CompletedIDs []string            `json:"completed_ids"`
	Failed       []BulkDeleteFailure `json:"failed"`
	HasMore      bool                `json:"has_more,omitempty"`
}

func (h *TrashHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie, Authorization")
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, 401, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		if err = h.authService.AuthorizeWrite(r, authenticated); err != nil {
			writeError(w, r, 403, "CSRF_INVALID", "csrf token is invalid", nil)
			return
		}
	}
	p := principal(authenticated.Account)
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/trash/photos")
	if path == "" || path == "/" {
		if r.Method != "GET" {
			w.Header().Set("Allow", "GET")
			writeError(w, r, 405, "INVALID_REQUEST", "method not allowed", nil)
			return
		}
		limit := 50
		if value := r.URL.Query().Get("limit"); value != "" {
			limit, err = strconv.Atoi(value)
			if err != nil {
				h.trashError(w, r, ErrInvalidFilter)
				return
			}
		}
		scope := r.URL.Query().Get("scope")
		if scope != "" && scope != "mine" && scope != "all" {
			h.trashError(w, r, ErrInvalidFilter)
			return
		}
		page, err := h.service.ListTrash(r.Context(), p, r.URL.Query().Get("cursor"), limit, scope == "all")
		if err != nil {
			h.trashError(w, r, err)
			return
		}
		writeJSON(w, 200, page)
		return
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 1 && (parts[0] == "batch-restore" || parts[0] == "batch-delete" || parts[0] == "empty") && r.Method == "POST" {
		h.batch(w, r, p, parts[0])
		return
	}
	if len(parts) == 1 && r.Method == "DELETE" {
		if r.URL.Query().Get("confirm") != "true" {
			h.trashError(w, r, ErrConfirmationRequired)
			return
		}
		err = h.service.PurgeTrash(r.Context(), p, parts[0], true)
		if err != nil && !errors.Is(err, ErrNotFound) {
			h.trashError(w, r, err)
			return
		}
		w.WriteHeader(204)
		return
	}
	if len(parts) == 2 && parts[1] == "restore" && r.Method == "POST" {
		var input RestoreInput
		if !decodeBody(w, r, &input) {
			return
		}
		photo, err := h.service.RestoreTrash(r.Context(), p, parts[0], input)
		if err != nil {
			h.trashError(w, r, err)
			return
		}
		writeJSON(w, 200, photo)
		return
	}
	if len(parts) == 2 && parts[1] == "retry" && r.Method == "POST" {
		release, err := h.service.trashLock()
		if err != nil {
			h.trashError(w, r, err)
			return
		}
		defer release()
		_, record, err := h.service.authorizeTrash(r.Context(), p, parts[0])
		if err == nil {
			err = h.service.finishTrashOperation(r.Context(), record)
		}
		if err != nil {
			h.trashError(w, r, err)
			return
		}
		w.WriteHeader(204)
		return
	}
	if len(parts) == 2 && parts[1] == "preview" && r.Method == "GET" {
		h.trashPreview(w, r, p, parts[0])
		return
	}
	writeError(w, r, 404, "NOT_FOUND", "route not found", nil)
}

func (h *TrashHTTPHandler) batch(w http.ResponseWriter, r *http.Request, p acl.Principal, action string) {
	var input struct {
		IDs      []string         `json:"ids"`
		Confirm  bool             `json:"confirm"`
		Scope    string           `json:"scope"`
		Before   string           `json:"before"`
		FolderID string           `json:"folder_id"`
		Conflict ConflictStrategy `json:"conflict"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if action != "batch-restore" && !input.Confirm {
		h.trashError(w, r, ErrConfirmationRequired)
		return
	}
	result := TrashBatchResult{CompletedIDs: []string{}, Failed: []BulkDeleteFailure{}}
	var deletedBefore *time.Time
	if action == "empty" {
		if input.Scope != "mine" && input.Scope != "all" {
			h.trashError(w, r, ErrInvalidFilter)
			return
		}
		if input.Scope == "all" && p.Role != acl.RoleAdmin {
			h.trashError(w, r, ErrForbidden)
			return
		}
		before, err := time.Parse(time.RFC3339Nano, input.Before)
		if err != nil || before.After(time.Now().Add(time.Minute)) {
			h.trashError(w, r, ErrInvalidFilter)
			return
		}
		deletedBefore = &before
		query := `SELECT t.photo_id FROM trash_items t JOIN photos p ON p.id=t.photo_id WHERE t.deleted_at<=? AND t.state='trashed'`
		args := []any{formatTime(before)}
		if input.Scope == "mine" {
			query += " AND p.owner_id=?"
			args = append(args, p.UserID)
		}
		query += " ORDER BY t.deleted_at,t.photo_id LIMIT 101"
		rows, err := h.service.db.QueryContext(r.Context(), query, args...)
		if err != nil {
			h.trashError(w, r, err)
			return
		}
		input.IDs = nil
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				break
			}
			input.IDs = append(input.IDs, id)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			h.trashError(w, r, err)
			return
		}
		if len(input.IDs) > 100 {
			result.HasMore = true
			input.IDs = input.IDs[:100]
		}
	} else if len(input.IDs) < 1 || len(input.IDs) > 500 {
		h.trashError(w, r, ErrInvalidFilter)
		return
	}
	seen := map[string]bool{}
	for _, id := range input.IDs {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		var err error
		if action == "batch-restore" {
			_, err = h.service.RestoreTrash(r.Context(), p, id, RestoreInput{FolderID: input.FolderID, Conflict: input.Conflict})
		} else {
			err = h.service.purgeTrash(r.Context(), p, id, true, nil, deletedBefore)
		}
		if errors.Is(err, ErrNotFound) && action != "batch-restore" {
			err = nil
		}
		if err != nil {
			result.Failed = append(result.Failed, BulkDeleteFailure{ID: id, Code: trashErrorCode(err)})
		} else {
			result.CompletedIDs = append(result.CompletedIDs, id)
		}
	}
	writeJSON(w, 200, result)
}

func (h *TrashHTTPHandler) trashPreview(w http.ResponseWriter, r *http.Request, p acl.Principal, id string) {
	_, record, err := h.service.authorizeTrash(r.Context(), p, id)
	if err != nil {
		h.trashError(w, r, err)
		return
	}
	if record.State != "trashed" {
		h.trashError(w, r, ErrTrashPending)
		return
	}
	if h.thumbnails == nil {
		writeError(w, r, 503, "THUMBNAIL_UNAVAILABLE", "preview is unavailable", nil)
		return
	}
	state, path, err := h.thumbnails.Ensure(r.Context(), id, 512)
	if errors.Is(err, thumbnails.ErrQueueFull) || err == nil && state != thumbnails.Ready {
		writeJSON(w, 202, thumbnailPendingPayload(id))
		return
	}
	if err != nil {
		h.trashError(w, r, err)
		return
	}
	// Revalidate after asynchronous thumbnail work and before opening the file.
	_, record, err = h.service.authorizeTrash(r.Context(), p, id)
	if err != nil {
		h.trashError(w, r, err)
		return
	}
	if record.State != "trashed" {
		h.trashError(w, r, ErrTrashPending)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		h.trashError(w, r, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "image/webp")
	http.ServeContent(w, r, "preview.webp", time.Time{}, file)
}

func trashErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrForbidden):
		return "WRITE_FORBIDDEN"
	case errors.Is(err, ErrNotFound):
		return "NOT_FOUND"
	case errors.Is(err, ErrNameConflict), errors.Is(err, os.ErrExist):
		return "NAME_CONFLICT"
	case errors.Is(err, ErrTrashChanged):
		return "SOURCE_CHANGED"
	case errors.Is(err, ErrTrashPending), errors.Is(err, storage.ErrRecoveryRequired):
		return "TRASH_RECOVERY_REQUIRED"
	case errors.Is(err, maintenance.ErrBusy):
		return "MAINTENANCE_IN_PROGRESS"
	case errors.Is(err, ErrConfirmationRequired):
		return "CONFIRMATION_REQUIRED"
	case errors.Is(err, ErrInvalidFilter):
		return "INVALID_REQUEST"
	default:
		return "INTERNAL_ERROR"
	}
}

func (h *TrashHTTPHandler) trashError(w http.ResponseWriter, r *http.Request, err error) {
	code := trashErrorCode(err)
	status := 500
	switch code {
	case "WRITE_FORBIDDEN":
		status = 403
	case "NOT_FOUND":
		status = 404
	case "NAME_CONFLICT", "SOURCE_CHANGED", "TRASH_RECOVERY_REQUIRED", "MAINTENANCE_IN_PROGRESS":
		status = 409
	case "CONFIRMATION_REQUIRED":
		status = 422
	case "INVALID_REQUEST":
		status = 400
	}
	if errors.Is(err, ErrInvalidCursor) || errors.Is(err, ErrCursorExpired) {
		h.writeServiceError(w, r, err)
		return
	}
	writeError(w, r, status, code, "trash operation could not be completed", maintenance.Details(err))
}
