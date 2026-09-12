package photos

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/storage"
)

const uploadPath = "/api/v1/photos/upload"

type HTTPHandler struct {
	service     *Service
	authService *auth.Service
}

func NewHTTPHandler(service *Service, authService *auth.Service) http.Handler {
	return &HTTPHandler{service: service, authService: authService}
}

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
	return true
}

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeError(w, r, http.StatusForbidden, "WRITE_FORBIDDEN", "photo folder is not writable", nil)
	case errors.Is(err, ErrNotFound):
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "photo not found", nil)
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
