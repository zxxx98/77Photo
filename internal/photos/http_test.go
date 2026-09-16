package photos

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"path/filepath"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/storage"
	"github.com/zxxx98/77Photo/internal/thumbnails"
)

func TestHTTPMultipartUploadStreamsAndReturnsPhoto(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, _, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	mobile, err := authService.CreateMobileSession(ctx, admin.ID, auth.MobileDeviceInput{Name: "Pixel", Platform: "android", AppVersion: "1"})
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folder, err := folders.NewService(db, store).Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "uploads"})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandler(NewService(db, store, 1<<20), authService)
	body, contentType := multipartUpload(t, folder.ID, "photo.jpg", jpegTestBytes(t))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/photos/upload", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+mobile.AccessToken)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, want 201: %s", res.Code, res.Body.String())
	}
	var photo Photo
	if err := json.NewDecoder(res.Body).Decode(&photo); err != nil {
		t.Fatal(err)
	}
	if photo.Filename != "photo.jpg" || photo.Width == 0 || photo.Checksum == "" {
		t.Fatalf("photo = %+v", photo)
	}
}

func TestHTTPLogicalLiveUploadCreatesOnePhoto(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, session, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folder, err := folders.NewService(db, store).Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "uploads"})
	if err != nil {
		t.Fatal(err)
	}
	photoService := NewService(db, store, 1<<20)
	handler := NewHTTPHandler(photoService, authService)
	body, contentType := logicalMultipartUpload(t, folder.ID, jpegTestBytes(t), quickTimeBytes())
	req := httptest.NewRequest(http.MethodPost, "/api/v1/photos/live-upload", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set(auth.CSRFHeaderName(), session.CSRFToken)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", res.Code, res.Body.String())
	}
	var photo Photo
	if err := json.NewDecoder(res.Body).Decode(&photo); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM photos").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("photo rows = %d, want 1", count)
	}
	if _, _, err := photoService.LiveVideoPath(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, photo.ID); err != nil {
		t.Fatalf("logical upload motion = %v", err)
	}
}

func TestHTTPLiveUploadCleansUpAfterRequestCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, session, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folder, err := folders.NewService(db, store).Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "uploads"})
	if err != nil {
		t.Fatal(err)
	}
	photoService := NewService(db, store, 1<<20)
	photoService.SetThumbnailEnqueuer(cancelingThumbnailEnqueuer{cancel: cancel})
	handler := NewHTTPHandler(photoService, authService)
	body, contentType := logicalMultipartUpload(t, folder.ID, jpegTestBytes(t), quickTimeBytes())
	req := httptest.NewRequest(http.MethodPost, "/api/v1/photos/live-upload", body).WithContext(ctx)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set(auth.CSRFHeaderName(), session.CSRFToken)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500: %s", res.Code, res.Body.String())
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM photos").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("photo rows = %d, want 0 after canceled request cleanup", count)
	}
}

func TestHTTPUploadTooLargeUsesContractError(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, session, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folder, err := folders.NewService(db, store).Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "uploads"})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandler(NewService(db, store, 8), authService)
	body, contentType := multipartUpload(t, folder.ID, "photo.jpg", jpegTestBytes(t))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/photos/upload", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set(auth.CSRFHeaderName(), session.CSRFToken)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413: %s", res.Code, res.Body.String())
	}
}

func TestHTTPThumbnailQueuesMissingVariantThenServesWebP(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, session, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	photoService := NewService(db, store, 1<<20)
	folder, err := folders.NewService(db, store).Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "uploads"})
	if err != nil {
		t.Fatal(err)
	}
	thumbs, err := thumbnails.NewService(photoService, store, filepath.Join(t.TempDir(), "cache"), 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer thumbs.Close()
	handler := NewHTTPHandler(photoService, authService)
	handler.SetThumbnailService(thumbs)
	body, contentType := multipartUpload(t, folder.ID, "photo.jpg", jpegTestBytes(t))
	uploadReq := httptest.NewRequest(http.MethodPost, "/api/v1/photos/upload", body)
	uploadReq.Header.Set("Content-Type", contentType)
	uploadReq.Header.Set(auth.CSRFHeaderName(), session.CSRFToken)
	uploadReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	uploadRes := httptest.NewRecorder()
	handler.ServeHTTP(uploadRes, uploadReq)
	if uploadRes.Code != http.StatusCreated {
		t.Fatalf("upload status = %d: %s", uploadRes.Code, uploadRes.Body.String())
	}
	var photo Photo
	if err := json.NewDecoder(uploadRes.Body).Decode(&photo); err != nil {
		t.Fatal(err)
	}
	thumbnailReq := httptest.NewRequest(http.MethodGet, "/api/v1/photos/"+photo.ID+"/thumbnail?size=256", nil)
	thumbnailReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	pendingRes := httptest.NewRecorder()
	handler.ServeHTTP(pendingRes, thumbnailReq)
	if pendingRes.Code != http.StatusAccepted {
		t.Fatalf("pending thumbnail status = %d: %s", pendingRes.Code, pendingRes.Body.String())
	}
	var pending struct {
		Status       string `json:"status"`
		RetryAfterMS int    `json:"retry_after_ms"`
	}
	if err := json.NewDecoder(pendingRes.Body).Decode(&pending); err != nil {
		t.Fatal(err)
	}
	if pending.Status != string(thumbnails.Pending) || pending.RetryAfterMS < 50 {
		t.Fatalf("pending thumbnail response = %+v, want status pending and retry_after_ms >= 50", pending)
	}
	thumbs.Start(ctx)
	waitForThumbnail(t, func() bool {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/photos/"+photo.ID+"/thumbnail?size=256", nil)
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res.Code == http.StatusOK && bytes.HasPrefix(res.Body.Bytes(), []byte("RIFF"))
	})
}

func TestHTTPListAndOriginalRangeUsePhotoACL(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, session, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	photoService := NewService(db, store, 1<<20)
	folder, err := folders.NewService(db, store).Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "uploads"})
	if err != nil {
		t.Fatal(err)
	}
	photo, err := photoService.Upload(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, UploadInput{FolderID: folder.ID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegTestBytes(t))})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandler(photoService, authService)
	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/photos?limit=10", nil)
	listReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	listRes := httptest.NewRecorder()
	handler.ServeHTTP(listRes, listReq)
	if listRes.Code != http.StatusOK || !bytes.Contains(listRes.Body.Bytes(), []byte(photo.ID)) {
		t.Fatalf("list response = %d %s", listRes.Code, listRes.Body.String())
	}
	rangeReq := httptest.NewRequest(http.MethodGet, "/api/v1/photos/"+photo.ID+"/original", nil)
	rangeReq.Header.Set("Range", "bytes=0-4")
	rangeReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	rangeRes := httptest.NewRecorder()
	handler.ServeHTTP(rangeRes, rangeReq)
	if rangeRes.Code != http.StatusPartialContent || rangeRes.Header().Get("Content-Range") == "" || rangeRes.Header().Get("Vary") != "Cookie, Authorization" || len(rangeRes.Body.Bytes()) != 5 {
		t.Fatalf("range response = %d headers=%v len=%d", rangeRes.Code, rangeRes.Header(), len(rangeRes.Body.Bytes()))
	}
}

func waitForThumbnail(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("thumbnail did not become ready")
}

func multipartUpload(t *testing.T, folderID, filename string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("folder_id", folderID); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="`+filename+`"`)
	header.Set("Content-Type", "image/jpeg")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}

func jpegTestBytes(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var body bytes.Buffer
	if err := jpeg.Encode(&body, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func logicalMultipartUpload(t *testing.T, folderID string, still, motion []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("folder_id", folderID); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("conflict", "reject"); err != nil {
		t.Fatal(err)
	}
	stillHeader := make(textproto.MIMEHeader)
	stillHeader.Set("Content-Disposition", `form-data; name="file"; filename="photo.jpg"`)
	stillHeader.Set("Content-Type", "image/jpeg")
	part, err := writer.CreatePart(stillHeader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(still); err != nil {
		t.Fatal(err)
	}
	motionHeader := make(textproto.MIMEHeader)
	motionHeader.Set("Content-Disposition", `form-data; name="motion"; filename="photo.mov"`)
	motionHeader.Set("Content-Type", "video/quicktime")
	part, err = writer.CreatePart(motionHeader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(motion); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}
