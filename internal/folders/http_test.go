package folders

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
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestHTTPFolderListCreateAndDetails(t *testing.T) {
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
	mobile, err := authService.CreateMobileSession(ctx, admin.ID, auth.MobileDeviceInput{Name: "Pixel", Platform: "android", AppVersion: "1"})
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandler(NewService(db, store), authService)

	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/folders", nil)
	listReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	listRes := httptest.NewRecorder()
	handler.ServeHTTP(listRes, listReq)
	if listRes.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200: %s", listRes.Code, listRes.Body.String())
	}

	bearerListReq := httptest.NewRequest(http.MethodGet, "/api/v1/folders", nil)
	bearerListReq.Header.Set("Authorization", "Bearer "+mobile.AccessToken)
	bearerListRes := httptest.NewRecorder()
	handler.ServeHTTP(bearerListRes, bearerListReq)
	if bearerListRes.Code != http.StatusOK {
		t.Fatalf("bearer list status = %d, want 200: %s", bearerListRes.Code, bearerListRes.Body.String())
	}

	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/folders", strings.NewReader(`{"name":"2026"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createReq.Header.Set("Authorization", "Bearer "+mobile.AccessToken)
	createRes := httptest.NewRecorder()
	handler.ServeHTTP(createRes, createReq)
	if createRes.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201: %s", createRes.Code, createRes.Body.String())
	}
	var folder Folder
	if err := json.NewDecoder(createRes.Body).Decode(&folder); err != nil {
		t.Fatal(err)
	}
	detailReq := httptest.NewRequest(http.MethodGet, "/api/v1/folders/"+folder.ID, nil)
	detailReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	detailRes := httptest.NewRecorder()
	handler.ServeHTTP(detailRes, detailReq)
	if detailRes.Code != http.StatusOK {
		t.Fatalf("detail status = %d, want 200", detailRes.Code)
	}
	_ = admin
}
