package photos

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
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
	if r.URL.Path != uploadPath {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
		return
	}
	h.upload(w, r)
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

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeError(w, r, http.StatusForbidden, "WRITE_FORBIDDEN", "photo folder is not writable", nil)
	case errors.Is(err, ErrNotFound):
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "folder not found", nil)
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
	default:
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "upload could not be completed", nil)
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
