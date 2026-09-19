package photos

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/media"
)

const livePhotoPathPrefix = "/api/v1/live-photos/"

var (
	ErrInvalidLivePhoto   = errors.New("live photo requires a supported still image")
	ErrLiveMotionNotFound = errors.New("live photo motion not found")
)

type LiveVideoInput struct {
	Filename     string
	DeclaredMIME string
	Body         io.Reader
}

type LivePhotoUploadInput struct {
	Still  UploadInput
	Motion *LiveVideoInput
}

func liveMotionStoragePath(photoID string) string {
	return filepath.ToSlash(filepath.Join(".77photo", "live", photoID+".motion"))
}

func legacyLiveMotionStoragePath(photoID string) string {
	return filepath.ToSlash(filepath.Join(".77photo", "live", photoID+".mov"))
}

func (s *Service) liveMotionPath(photoID string) string {
	return liveMotionStoragePath(photoID)
}

// UploadLivePhoto stores the still and optional companion as one logical
// operation. If the companion fails validation, the just-created still is
// deleted before the error is returned.
func (s *Service) UploadLivePhoto(ctx context.Context, principal acl.Principal, input LivePhotoUploadInput) (Photo, error) {
	photo, err := s.Upload(ctx, principal, input.Still)
	if err != nil || input.Motion == nil {
		return photo, err
	}
	if err := s.AttachLiveVideo(ctx, principal, photo.ID, *input.Motion); err != nil {
		if cleanupErr := s.Delete(context.WithoutCancel(ctx), principal, photo.ID, true); cleanupErr != nil {
			s.logLivePhotoRollbackFailure(photo.ID, cleanupErr)
		}
		return Photo{}, err
	}
	return photo, nil
}

func (s *Service) logLivePhotoRollbackFailure(photoID string, err error) {
	if s.logger != nil {
		s.logger.Error("live photo rollback failed", "photo_id", photoID, "error", err)
	}
}

func (s *Service) AttachLiveVideo(ctx context.Context, principal acl.Principal, photoID string, input LiveVideoInput) error {
	if input.Body == nil || s.maxSize < 1 {
		return ErrUploadFailed
	}
	photo, err := s.Get(ctx, principal, photoID)
	if err != nil {
		return err
	}
	if !s.canWrite(ctx, principal, photo) {
		return ErrForbidden
	}
	if photo.MIMEType != "image/jpeg" && photo.MIMEType != "image/png" && photo.MIMEType != "image/heic" && photo.MIMEType != "image/heif" {
		return ErrInvalidLivePhoto
	}
	extension := strings.ToLower(filepath.Ext(strings.TrimSpace(input.Filename)))
	switch extension {
	case ".mov":
		if input.DeclaredMIME != "" && !strings.EqualFold(input.DeclaredMIME, "video/quicktime") && !strings.EqualFold(input.DeclaredMIME, "application/octet-stream") {
			return ErrUnsupportedMedia
		}
	case ".mp4":
		if input.DeclaredMIME != "" && !strings.EqualFold(input.DeclaredMIME, "video/mp4") && !strings.EqualFold(input.DeclaredMIME, "application/octet-stream") {
			return ErrUnsupportedMedia
		}
	default:
		return ErrUnsupportedMedia
	}

	liveDir, err := s.storage.ResolvePath(filepath.ToSlash(filepath.Join(".77photo", "live")))
	if err != nil {
		return fmt.Errorf("resolve live photo storage: %w", err)
	}
	if err := os.MkdirAll(liveDir, 0o750); err != nil {
		return fmt.Errorf("create live photo storage: %w", err)
	}
	temporary, err := os.CreateTemp(liveDir, ".77photo-live-*.tmp")
	if err != nil {
		return fmt.Errorf("create live photo temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	_, head, _, err := streamToFile(temporary, input.Body, s.maxSize)
	if err != nil {
		cleanup()
		if errors.Is(err, ErrUploadTooLarge) {
			return err
		}
		return fmt.Errorf("%w: %v", ErrUploadFailed, err)
	}
	switch extension {
	case ".mov":
		if !looksLikeQuickTime(head) {
			cleanup()
			return ErrInvalidMedia
		}
	case ".mp4":
		if _, inspectErr := media.InspectBytes(input.Filename, "video/mp4", head); inspectErr != nil {
			cleanup()
			return ErrInvalidMedia
		}
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("%w: sync live photo motion: %v", ErrUploadFailed, err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("%w: close live photo motion: %v", ErrUploadFailed, err)
	}
	if s.mediaTools != nil {
		valid, probeErr := s.mediaTools.ProbeVideo(ctx, temporaryPath)
		if probeErr != nil {
			_ = os.Remove(temporaryPath)
			return fmt.Errorf("%w: validate live photo motion: %v", ErrInvalidMedia, probeErr)
		}
		if !valid {
			_ = os.Remove(temporaryPath)
			return ErrInvalidMedia
		}
	}

	finalPath, err := s.storage.ResolvePath(liveMotionStoragePath(photoID))
	if err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("resolve live photo motion: %w", err)
	}
	backupPath := finalPath + ".bak"
	hadExisting := false
	if _, err := os.Stat(finalPath); err == nil {
		_ = os.Remove(backupPath)
		if err := os.Rename(finalPath, backupPath); err != nil {
			_ = os.Remove(temporaryPath)
			return fmt.Errorf("%w: preserve existing live photo motion: %v", ErrUploadFailed, err)
		}
		hadExisting = true
	} else if !os.IsNotExist(err) {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("%w: inspect live photo motion: %v", ErrUploadFailed, err)
	}
	if err := os.Rename(temporaryPath, finalPath); err != nil {
		if hadExisting {
			_ = os.Rename(backupPath, finalPath)
		}
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("%w: store live photo motion: %v", ErrUploadFailed, err)
	}
	if hadExisting {
		_ = os.Remove(backupPath)
	}
	return nil
}

func (s *Service) LiveVideoPath(ctx context.Context, principal acl.Principal, photoID string) (Photo, string, error) {
	photo, err := s.Get(ctx, principal, photoID)
	if err != nil {
		return Photo{}, "", err
	}
	paths := []string{liveMotionStoragePath(photoID), legacyLiveMotionStoragePath(photoID)}
	for _, relative := range paths {
		path, resolveErr := s.storage.ResolvePath(relative)
		if resolveErr != nil {
			return Photo{}, "", resolveErr
		}
		info, statErr := os.Stat(path)
		if statErr == nil && info.Mode().IsRegular() {
			return photo, path, nil
		}
		if statErr != nil && !os.IsNotExist(statErr) {
			return Photo{}, "", statErr
		}
	}
	return Photo{}, "", ErrLiveMotionNotFound
}

func (s *Service) LivePhotoIDs(ctx context.Context, principal acl.Principal, ids []string) []string {
	result := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, _, err := s.LiveVideoPath(ctx, principal, id); err == nil {
			result = append(result, id)
		}
	}
	return result
}

func (s *Service) RemoveLiveVideo(ctx context.Context, principal acl.Principal, photoID string) error {
	photo, err := s.Get(ctx, principal, photoID)
	if err != nil {
		return err
	}
	if !s.canWrite(ctx, principal, photo) {
		return ErrForbidden
	}
	return s.removeLiveMotionArtifacts(photoID)
}

func (s *Service) removeLiveMotionArtifacts(photoID string) error {
	for _, relative := range []string{liveMotionStoragePath(photoID), legacyLiveMotionStoragePath(photoID)} {
		path, err := s.storage.ResolvePath(relative)
		if err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func looksLikeQuickTime(head []byte) bool {
	return len(head) >= 12 && string(head[4:8]) == "ftyp" && string(head[8:12]) == "qt  "
}

func motionMIME(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return "video/quicktime"
	}
	defer file.Close()
	head := make([]byte, 512)
	n, _ := file.Read(head)
	head = head[:n]
	if mediaLooksLikeWebM(head) {
		return "video/webm"
	}
	if len(head) >= 12 && string(head[4:8]) == "ftyp" {
		major := string(head[8:12])
		if major == "qt  " {
			return "video/quicktime"
		}
		return "video/mp4"
	}
	return "video/quicktime"
}

func mediaLooksLikeWebM(head []byte) bool {
	return len(head) >= 4 && head[0] == 0x1a && head[1] == 0x45 && head[2] == 0xdf && head[3] == 0xa3
}

type LiveHTTPHandler struct {
	service     *Service
	authService *auth.Service
}

func NewLiveHTTPHandler(service *Service, authService *auth.Service) *LiveHTTPHandler {
	return &LiveHTTPHandler{service: service, authService: authService}
}

func (h *LiveHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, livePhotoPathPrefix) {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	suffix := strings.Trim(strings.TrimPrefix(r.URL.Path, livePhotoPathPrefix), "/")
	if suffix == "status" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
			return
		}
		h.status(w, r)
		return
	}
	if suffix == "" || strings.Contains(suffix, "/") {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.get(w, r, suffix)
	case http.MethodPost:
		h.attach(w, r, suffix)
	case http.MethodDelete:
		h.remove(w, r, suffix)
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
	}
}

func (h *LiveHTTPHandler) authenticate(r *http.Request) (acl.Principal, auth.RequestAuth, error) {
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		return acl.Principal{}, auth.RequestAuth{}, err
	}
	return principal(authenticated.Account), authenticated, nil
}

func (h *LiveHTTPHandler) status(w http.ResponseWriter, r *http.Request) {
	principalValue, _, err := h.authenticate(r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	raw := strings.TrimSpace(r.URL.Query().Get("ids"))
	if raw == "" {
		writeJSON(w, http.StatusOK, map[string]any{"live_photo_ids": []string{}})
		return
	}
	ids := strings.Split(raw, ",")
	if len(ids) > 100 {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "too many photo ids", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"live_photo_ids": h.service.LivePhotoIDs(r.Context(), principalValue, ids)})
}

func (h *LiveHTTPHandler) get(w http.ResponseWriter, r *http.Request, photoID string) {
	principalValue, _, err := h.authenticate(r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	photo, path, err := h.service.LiveVideoPath(r.Context(), principalValue, photoID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		h.writeError(w, r, ErrLiveMotionNotFound)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	contentType := motionMIME(path)
	motionExtension := ".mov"
	if contentType == "video/mp4" {
		motionExtension = ".mp4"
	} else if contentType == "video/webm" {
		motionExtension = ".webm"
	}
	motionName := strings.TrimSuffix(photo.Filename, filepath.Ext(photo.Filename)) + motionExtension
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": motionName}))
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("Vary", "Cookie, Authorization")
	http.ServeContent(w, r, motionName, info.ModTime(), file)
}

func (h *LiveHTTPHandler) attach(w http.ResponseWriter, r *http.Request, photoID string) {
	principalValue, authenticated, err := h.authenticate(r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.AuthorizeWrite(r, authenticated); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "multipart body is invalid", nil)
		return
	}
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
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		if fileSeen {
			_ = part.Close()
			writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "exactly one file part is required", nil)
			return
		}
		fileSeen = true
		err = h.service.AttachLiveVideo(r.Context(), principalValue, photoID, LiveVideoInput{Filename: part.FileName(), DeclaredMIME: part.Header.Get("Content-Type"), Body: part})
		_ = part.Close()
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "exactly one file part is required", nil)
}

func (h *LiveHTTPHandler) remove(w http.ResponseWriter, r *http.Request, photoID string) {
	principalValue, authenticated, err := h.authenticate(r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.AuthorizeWrite(r, authenticated); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	if err := h.service.RemoveLiveVideo(r.Context(), principalValue, photoID); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *LiveHTTPHandler) writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeError(w, r, http.StatusForbidden, "WRITE_FORBIDDEN", "photo folder is not writable", nil)
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrLiveMotionNotFound):
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "live photo motion not found", nil)
	case errors.Is(err, ErrUploadTooLarge):
		writeError(w, r, http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "upload exceeds the configured maximum size", nil)
	case errors.Is(err, ErrUnsupportedMedia):
		writeError(w, r, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "live photo motion must be a MOV or MP4 file", nil)
	case errors.Is(err, ErrInvalidMedia), errors.Is(err, ErrInvalidLivePhoto):
		writeError(w, r, http.StatusUnprocessableEntity, "INVALID_MEDIA", "live photo pair is invalid", nil)
	default:
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "live photo operation could not be completed", nil)
	}
}

var _ = time.Time{}
