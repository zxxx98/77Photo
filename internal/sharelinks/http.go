package sharelinks

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/thumbnails"
)

const (
	shareLinksPath       = "/api/v1/share-links"
	shareAccessCookie    = "77photo_share_access"
	sharePasswordMessage = "the share link password is incorrect"
)

type HTTPHandler struct {
	service     *Service
	authService *auth.Service
}

func NewHTTPHandler(service *Service, authService *auth.Service) http.Handler {
	return &HTTPHandler{service: service, authService: authService}
}

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == shareLinksPath || r.URL.Path == shareLinksPath+"/" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, r, http.MethodPost)
			return
		}
		h.create(w, r)
		return
	}
	if !strings.HasPrefix(r.URL.Path, shareLinksPath+"/") {
		writeError(w, r, http.StatusNotFound, "SHARE_UNAVAILABLE", "shared item is unavailable", nil)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, shareLinksPath+"/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, r, http.StatusNotFound, "SHARE_UNAVAILABLE", "shared item is unavailable", nil)
		return
	}
	token := parts[0]
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		h.metadata(w, r, token)
	case len(parts) == 2 && parts[1] == "unlock" && r.Method == http.MethodPost:
		h.unlock(w, r, token)
	case len(parts) == 2 && parts[1] == "photos" && r.Method == http.MethodGet:
		h.photos(w, r, token)
	case len(parts) == 4 && parts[1] == "photos" && parts[3] == "preview" && r.Method == http.MethodGet:
		h.preview(w, r, token, parts[2])
	default:
		writeError(w, r, http.StatusNotFound, "SHARE_UNAVAILABLE", "shared item is unavailable", nil)
	}
}

func (h *HTTPHandler) create(w http.ResponseWriter, r *http.Request) {
	if h.authService == nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
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
	account := authenticated.Account
	var input CreateInput
	if !decodeBody(w, r, &input) {
		return
	}
	link, err := h.service.Create(r.Context(), acl.Principal{UserID: account.ID, Role: account.Role}, input)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, link)
}

func (h *HTTPHandler) metadata(w http.ResponseWriter, r *http.Request, token string) {
	share, err := h.service.Inspect(r.Context(), token)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, share)
}

func (h *HTTPHandler) unlock(w http.ResponseWriter, r *http.Request, token string) {
	var input struct {
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	accessToken, share, err := h.service.Unlock(r.Context(), token, input.Password)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	expiresAt := time.Now().UTC().Add(24 * time.Hour)
	if share.ExpiresAt != nil && share.ExpiresAt.Before(expiresAt) {
		expiresAt = *share.ExpiresAt
	}
	maxAge := int(time.Until(expiresAt).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(w, &http.Cookie{
		Name:     shareAccessCookie,
		Value:    accessToken,
		Path:     shareLinksPath + "/" + token,
		HttpOnly: true,
		Secure:   h.service.secureCookies,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
		MaxAge:   maxAge,
	})
	writeJSON(w, http.StatusOK, share)
}

func (h *HTTPHandler) photos(w http.ResponseWriter, r *http.Request, token string) {
	items, err := h.service.ListPhotos(r.Context(), token, accessTokenFromRequest(r))
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *HTTPHandler) preview(w http.ResponseWriter, r *http.Request, token, photoID string) {
	photo, err := h.service.PublicPhoto(r.Context(), token, accessTokenFromRequest(r), photoID)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	if strings.HasPrefix(photo.MIMEType, "video/") {
		h.serveMedia(w, r, photo, photo.StoragePath)
		return
	}
	if h.service.thumbnails == nil {
		writeError(w, r, http.StatusServiceUnavailable, "THUMBNAIL_UNAVAILABLE", "preview is temporarily unavailable", nil)
		return
	}
	state, path, err := h.service.thumbnails.Ensure(r.Context(), photo.ID, 1280)
	if err != nil {
		if errors.Is(err, thumbnails.ErrQueueFull) {
			writeJSON(w, http.StatusAccepted, map[string]any{"status": string(thumbnails.Pending), "photo_id": photo.ID})
			return
		}
		writeError(w, r, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "preview is not available for this media", nil)
		return
	}
	if state != thumbnails.Ready {
		writeJSON(w, http.StatusAccepted, map[string]any{"status": string(state), "photo_id": photo.ID})
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeJSON(w, http.StatusAccepted, map[string]any{"status": string(thumbnails.Pending), "photo_id": photo.ID})
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": photo.Filename}))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Cookie")
	http.ServeContent(w, r, filepath.Base(path), time.Time{}, file)
}

func (h *HTTPHandler) serveMedia(w http.ResponseWriter, r *http.Request, photo PublicPhoto, relativePath string) {
	path, err := h.service.storage.ResolvePath(relativePath)
	if err != nil {
		writeError(w, r, http.StatusNotFound, "SHARE_UNAVAILABLE", "shared item is unavailable", nil)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, r, http.StatusNotFound, "SHARE_UNAVAILABLE", "shared item is unavailable", nil)
			return
		}
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "preview could not be opened", nil)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", photo.MIMEType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": photo.Filename}))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Cookie")
	http.ServeContent(w, r, photo.Filename, time.Time{}, file)
}

func accessTokenFromRequest(r *http.Request) string {
	cookie, err := r.Cookie(shareAccessCookie)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeError(w, r, http.StatusForbidden, "SHARE_FORBIDDEN", "you cannot share this item", nil)
	case errors.Is(err, ErrInvalid):
		writeError(w, r, http.StatusUnprocessableEntity, "INVALID_REQUEST", "share link request is invalid", nil)
	case errors.Is(err, ErrPasswordRequired):
		writeError(w, r, http.StatusUnauthorized, "SHARE_PASSWORD_REQUIRED", "a password is required to view this share", nil)
	case errors.Is(err, ErrInvalidPassword):
		writeError(w, r, http.StatusUnauthorized, "SHARE_PASSWORD_INVALID", sharePasswordMessage, nil)
	case errors.Is(err, ErrOutOfScope), errors.Is(err, ErrUnavailable):
		writeError(w, r, http.StatusNotFound, "SHARE_UNAVAILABLE", "shared item is unavailable", nil)
	default:
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "share link operation could not be completed", nil)
	}
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

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string, details map[string]any) {
	requestID := r.Header.Get("X-Request-ID")
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
	writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
}
