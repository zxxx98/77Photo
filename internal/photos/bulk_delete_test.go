package photos

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestBulkDeleteHTTPHandlerDeletesPhotosAndLiveMotion(t *testing.T) {
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
	principalValue := acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}

	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folderService := folders.NewService(db, store)
	firstFolder, err := folderService.Create(ctx, principalValue, folders.CreateInput{Name: "first"})
	if err != nil {
		t.Fatal(err)
	}
	secondFolder, err := folderService.Create(ctx, principalValue, folders.CreateInput{Name: "second"})
	if err != nil {
		t.Fatal(err)
	}

	photoService := NewService(db, store, 1<<20)
	first, err := photoService.Upload(ctx, principalValue, UploadInput{FolderID: firstFolder.ID, Filename: "one.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegTestBytes(t))})
	if err != nil {
		t.Fatal(err)
	}
	second, err := photoService.Upload(ctx, principalValue, UploadInput{FolderID: secondFolder.ID, Filename: "two.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegTestBytes(t))})
	if err != nil {
		t.Fatal(err)
	}
	if err := photoService.AttachLiveVideo(ctx, principalValue, first.ID, LiveVideoInput{Filename: "one.mov", DeclaredMIME: "video/quicktime", Body: bytes.NewReader(quickTimeBytes())}); err != nil {
		t.Fatal(err)
	}

	handler := NewBulkDeleteHTTPHandler(photoService, authService)

	unconfirmed := httptest.NewRequest(http.MethodPost, "/api/v1/photos/batch-delete", bytes.NewBufferString(`{"ids":["`+first.ID+`"],"confirm":false}`))
	unconfirmed.Header.Set("Content-Type", "application/json")
	unconfirmed.Header.Set(auth.CSRFHeaderName(), session.CSRFToken)
	unconfirmed.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	unconfirmedRes := httptest.NewRecorder()
	handler.ServeHTTP(unconfirmedRes, unconfirmed)
	if unconfirmedRes.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unconfirmed status = %d, want 422: %s", unconfirmedRes.Code, unconfirmedRes.Body.String())
	}

	body, err := json.Marshal(map[string]any{"ids": []string{first.ID, second.ID, first.ID}, "confirm": true})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/photos/batch-delete", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.CSRFHeaderName(), session.CSRFToken)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", res.Code, res.Body.String())
	}

	var result BulkDeleteResult
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if len(result.DeletedIDs) != 2 || len(result.Failed) != 0 {
		t.Fatalf("result = %+v, want two deleted and no failures", result)
	}

	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM photos").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("photo rows = %d, want 0", count)
	}
	if _, _, err := photoService.LiveVideoPath(ctx, principalValue, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("live video after delete error = %v, want ErrNotFound", err)
	}
	motionPath, err := store.ResolvePath(liveMotionStoragePath(first.ID))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(motionPath); !os.IsNotExist(err) {
		t.Fatalf("live motion artifact still exists: %v", err)
	}
}
