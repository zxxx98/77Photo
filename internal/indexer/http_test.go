package indexer

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestHTTPRescanRequiresAdminAndReturnsJob(t *testing.T) {
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
	handler := NewHTTPHandler(NewService(db, store, photos.NewService(db, store, 1<<20)), authService)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/rescan", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+mobile.AccessToken)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusAccepted {
		t.Fatalf("start status = %d: %s", res.Code, res.Body.String())
	}
	var job Job
	if err := json.NewDecoder(res.Body).Decode(&job); err != nil || job.ID == "" {
		t.Fatalf("job = %+v err=%v", job, err)
	}
}
