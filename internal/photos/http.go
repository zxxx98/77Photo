package photos

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/storage"
	"github.com/zxxx98/77Photo/internal/thumbnails"
)

const uploadPath = "/api/v1/photos/upload"

type HTTPHandler struct {
	service     *Service
	authService *auth.Service
	thumbnails  ThumbnailService
}

type ThumbnailService interface {
	Ensure(context.Context, string, int) (thumbnails.State, string, error)
}

func NewHTTPHandler(service *Service, authService *auth.Service) *HTTPHandler {
	return &HTTPHandler{service: service, authService: authService}
}

func (h *HTTPHandler) SetThumbnailService(service ThumbnailService) { h.thumbnails = service }

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == uploadPath {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
			return
		}
		h.upload(w, r)
		return
	}
	if r.URL.Path == "/api/v1/photos" || r.URL.Path == "/api/v1/photos/" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
			return
		}
		h.list(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/v1/photos/shared/") {
		folderID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/photos/shared/"), "/")
		if folderID == "" || strings.Contains(folderID, "/") || r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
			return
		}
		h.listShared(w, r, folderID)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/v1/photos/") {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/photos/"), "/")
	if id == "" {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	if strings.HasSuffix(id, "/move") {
		sourceID := strings.TrimSuffix(id, "/move")
		if sourceID == "" || strings.Contains(sourceID, "/") || r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
			return
		}
		h.move(w, r, sourceID)
		return
	}
	if strings.HasSuffix(id, "/thumbnail") {
		sourceID := strings.TrimSuffix(id, "/thumbnail")
		if sourceID == "" || strings.Contains(sourceID, "/") || r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
			return
		}
		h.thumbnail(w, r, sourceID)
		return
	}
	if strings.HasSuffix(id, "/preview") {
		sourceID := strings.TrimSuffix(id, "/preview")
		if sourceID == "" || strings.Contains(sourceID, "/") || r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
			return
		}
		h.preview(w, r, sourceID)
		return
	}
	if strings.HasSuffix(id, "/original") {
		sourceID := strings.TrimSuffix(id, "/original")
		if sourceID == "" || strings.Contains(sourceID, "/") || r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
			return
		}
		h.original(w, r, sourceID)
		return
	}
	if strings.Contains(id, "/") {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.get(w, r, id)
	case http.MethodPatch:
		h.rename(w, r, id)
	case http.MethodDelete:
		h.delete(w, r, id)
	default:
		w.Header().Set("Allow", "GET, PATCH, DELETE")
		writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
	}
}

func (h *HTTPHandler) list(w http.ResponseWriter, r *http.Request) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	filter := ListFilter{Cursor: r.URL.Query().Get("cursor")}
	if value := strings.TrimSpace(r.URL.Query().Get("folder_id")); value != "" {
		filter.FolderID = &value
	}
	if value := strings.TrimSpace(r.URL.Query().Get("from")); value != "" {
		parsed, parseErr := time.Parse(time.RFC3339Nano, value)
		if parseErr != nil || !strings.ContainsAny(value, "Z+-") {
			writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "from timestamp is invalid", nil)
			return
		}
		filter.From = &parsed
	}
	if value := strings.TrimSpace(r.URL.Query().Get("to")); value != "" {
		parsed, parseErr := time.Parse(time.RFC3339Nano, value)
		if parseErr != nil || !strings.ContainsAny(value, "Z+-") {
			writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "to timestamp is invalid", nil)
			return
		}
		filter.To = &parsed
	}
	if value := strings.TrimSpace(r.URL.Query().Get("limit")); value != "" {
		limit, parseErr := strconv.Atoi(value)
		if parseErr != nil {
			writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "limit is invalid", nil)
			return
		}
		filter.Limit = limit
	}
	page, err := h.service.List(r.Context(), principal(account), filter)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *HTTPHandler) listShared(w http.ResponseWriter, r *http.Request, folderID string) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	filter := ListFilter{Cursor: r.URL.Query().Get("cursor")}
	filter.FolderID = &folderID
	if value := strings.TrimSpace(r.URL.Query().Get("limit")); value != "" {
		limit, parseErr := strconv.Atoi(value)
		if parseErr != nil {
			writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "limit is invalid", nil)
			return
		}
		filter.Limit = limit
	}
	page, err := h.service.List(r.Context(), principal(account), filter)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *HTTPHandler) upload(w http.ResponseWriter, r *http.Request) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "multipart body is invalid", nil)
		return
	}
	folderID := strings.TrimSpace(r.URL.Query().Get("folder_id"))
	conflict := ConflictReject
	fileSeen := false
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "multipart body is invalid", nil)
			return
		}
		name := part.FormName()
		switch name {
		case "folder_id":
			value, readErr := io.ReadAll(io.LimitReader(part, 256))
			if readErr != nil {
				writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "folder_id field is invalid", nil)
				return
			}
			folderID = strings.TrimSpace(string(value))
		case "conflict":
			value, readErr := io.ReadAll(io.LimitReader(part, 32))
			if readErr != nil {
				writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "conflict field is invalid", nil)
				return
			}
			if strings.TrimSpace(string(value)) == string(ConflictRename) {
				conflict = ConflictRename
			}
		case "file":
			if fileSeen || folderID == "" {
				writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "folder_id must be provided before file", nil)
				return
			}
			fileSeen = true
			photo, uploadErr := h.service.Upload(r.Context(), principal(account), UploadInput{FolderID: folderID, Filename: part.FileName(), DeclaredMIME: part.Header.Get("Content-Type"), Conflict: conflict, Body: part})
			if uploadErr != nil {
				h.writeServiceError(w, r, uploadErr)
				return
			}
			writeJSON(w, http.StatusCreated, photo)
			return
		}
		_ = part.Close()
	}
	writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "exactly one file part is required", nil)
}

func (h *HTTPHandler) get(w http.ResponseWriter, r *http.Request, id string) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	photo, err := h.service.Get(r.Context(), principal(account), id)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, photo)
}

func (h *HTTPHandler) thumbnail(w http.ResponseWriter, r *http.Request, id string) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if h.thumbnails == nil {
		writeError(w, r, http.StatusServiceUnavailable, "THUMBNAIL_UNAVAILABLE", "thumbnail service is unavailable", nil)
		return
	}
	if _, err := h.service.Get(r.Context(), principal(account), id); err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	size, err := strconv.Atoi(r.URL.Query().Get("size"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "thumbnail size is invalid", nil)
		return
	}
	state, path, err := h.thumbnails.Ensure(r.Context(), id, size)
	if err != nil {
		switch {
		case errors.Is(err, thumbnails.ErrQueueFull):
			writeJSON(w, http.StatusAccepted, map[string]any{"status": string(thumbnails.Pending), "photo_id": id})
		case errors.Is(err, thumbnails.ErrInvalidSize):
			writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "thumbnail size is invalid", nil)
		case errors.Is(err, thumbnails.ErrUnsupported):
			writeError(w, r, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "thumbnail is not available for this media", nil)
		default:
			writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "thumbnail could not be prepared", nil)
		}
		return
	}
	if state != thumbnails.Ready {
		writeJSON(w, http.StatusAccepted, map[string]any{"status": string(state), "photo_id": id})
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, r, http.StatusAccepted, "THUMBNAIL_PENDING", "thumbnail is still being generated", nil)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("Vary", "Cookie")
	http.ServeContent(w, r, filepath.Base(path), time.Time{}, file)
}

func (h *HTTPHandler) preview(w http.ResponseWriter, r *http.Request, id string) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	photo, err := h.service.Get(r.Context(), principal(account), id)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	if strings.HasPrefix(photo.MIMEType, "video/") {
		h.serveOriginal(w, r, photo, "private, max-age=60")
		return
	}
	if h.thumbnails == nil {
		writeError(w, r, http.StatusServiceUnavailable, "THUMBNAIL_UNAVAILABLE", "thumbnail service is unavailable", nil)
		return
	}
	state, path, err := h.thumbnails.Ensure(r.Context(), id, 1280)
	if err != nil {
		if errors.Is(err, thumbnails.ErrQueueFull) {
			writeJSON(w, http.StatusAccepted, map[string]any{"status": string(thumbnails.Pending), "photo_id": id})
			return
		}
		if errors.Is(err, thumbnails.ErrInvalidSize) || errors.Is(err, thumbnails.ErrUnsupported) {
			writeError(w, r, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "preview is not available for this media", nil)
			return
		}
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "preview could not be prepared", nil)
		return
	}
	if state != thumbnails.Ready {
		writeJSON(w, http.StatusAccepted, map[string]any{"status": string(state), "photo_id": id})
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeJSON(w, http.StatusAccepted, map[string]any{"status": string(thumbnails.Pending), "photo_id": id})
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("Vary", "Cookie")
	http.ServeContent(w, r, filepath.Base(path), time.Time{}, file)
}

func (h *HTTPHandler) original(w http.ResponseWriter, r *http.Request, id string) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	photo, err := h.service.Get(r.Context(), principal(account), id)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	h.serveOriginal(w, r, photo, "private, no-store")
}

func (h *HTTPHandler) serveOriginal(w http.ResponseWriter, r *http.Request, photo Photo, cacheControl string) {
	path, err := h.service.storage.ResolvePath(photo.StoragePath)
	if err != nil {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "photo file not found", nil)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, r, http.StatusNotFound, "NOT_FOUND", "photo file not found", nil)
			return
		}
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "photo file could not be opened", nil)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", photo.MIMEType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": photo.Filename}))
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("Vary", "Cookie")
	http.ServeContent(w, r, photo.Filename, photoModTime(photo), file)
}

func photoModTime(photo Photo) time.Time {
	if photo.FileCreatedAt != nil {
		return photo.FileCreatedAt.UTC()
	}
	return time.Time{}
}

func (h *HTTPHandler) rename(w http.ResponseWriter, r *http.Request, id string) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	var input RenameInput
	if !decodeBody(w, r, &input) {
		return
	}
	photo, err := h.service.Rename(r.Context(), principal(account), id, input)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, photo)
}

func (h *HTTPHandler) move(w http.ResponseWriter, r *http.Request, id string) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	var input struct {
		TargetFolderID string           `json:"target_folder_id"`
		Conflict       ConflictStrategy `json:"conflict"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if input.Conflict == "" {
		input.Conflict = ConflictReject
	}
	photo, err := h.service.MoveWithConflict(r.Context(), principal(account), id, input.TargetFolderID, input.Conflict)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, photo)
}

func (h *HTTPHandler) delete(w http.ResponseWriter, r *http.Request, id string) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	confirmed, err := strconv.ParseBool(r.URL.Query().Get("confirm"))
	if err != nil {
		confirmed = false
	}
	if err := h.service.Delete(r.Context(), principal(account), id, confirmed); err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body is invalid", nil)
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body is invalid", nil)
		return false
	}
	return true
}

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		code, message := "WRITE_FORBIDDEN", "photo folder is not writable"
		if r.Method == http.MethodGet {
			code, message = "READ_FORBIDDEN", "photo is not accessible"
		}
		writeError(w, r, http.StatusForbidden, code, message, nil)
	case errors.Is(err, ErrNotFound):
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "photo not found", nil)
	case errors.Is(err, ErrInvalidCursor), errors.Is(err, ErrInvalidFilter):
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "photo query is invalid", nil)
	case errors.Is(err, ErrCursorExpired):
		writeError(w, r, http.StatusGone, "CURSOR_EXPIRED", "cursor expired; restart pagination without cursor", nil)
	case errors.Is(err, storage.ErrInvalidName):
		writeError(w, r, http.StatusUnprocessableEntity, "INVALID_REQUEST", "filename is invalid", nil)
	case errors.Is(err, ErrUploadTooLarge):
		writeError(w, r, http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "upload exceeds the configured maximum size", nil)
	case errors.Is(err, ErrUnsupportedMedia):
		writeError(w, r, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "media type or extension is not supported", nil)
	case errors.Is(err, ErrInvalidMedia):
		writeError(w, r, http.StatusUnprocessableEntity, "INVALID_MEDIA", "media content is invalid", nil)
	case errors.Is(err, ErrPixelLimit):
		writeError(w, r, http.StatusUnprocessableEntity, "PIXEL_LIMIT_EXCEEDED", "image dimensions exceed the decode limit", nil)
	case errors.Is(err, ErrNameConflict):
		writeError(w, r, http.StatusConflict, "NAME_CONFLICT", "a file with this name already exists", nil)
	case errors.Is(err, ErrDuplicatePhoto):
		details := map[string]any{}
		var duplicate *DuplicateError
		if errors.As(err, &duplicate) {
			details["existing_photo_id"] = duplicate.ExistingPhotoID
		}
		writeError(w, r, http.StatusConflict, "DUPLICATE_PHOTO", "the same file already exists in this folder", details)
	case errors.Is(err, ErrConfirmationRequired):
		writeError(w, r, http.StatusUnprocessableEntity, "CONFIRMATION_REQUIRED", "explicit confirmation is required before permanent deletion", nil)
	default:
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "photo operation could not be completed", nil)
	}
}

func principal(account auth.Account) acl.Principal {
	return acl.Principal{UserID: account.ID, Role: account.Role}
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string, details map[string]any) {
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
