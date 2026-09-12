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
)

func TestHTTPMultipartUploadStreamsAndReturnsPhoto(t *testing.T) {
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
	handler := NewHTTPHandler(NewService(db, store, 1<<20), authService)
	body, contentType := multipartUpload(t, folder.ID, "photo.jpg", jpegTestBytes(t))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/photos/upload", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set(auth.CSRFHeaderName(), session.CSRFToken)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
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
