package users

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
)

func TestHTTPAdminUserLifecycleAndCSRF(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, adminSession, err := authService.SetupAdmin(context.Background(), "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(db, authService)
	handler := NewHTTPHandler(service, authService)

	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/users", nil)
	auth.SetSessionCookie(httptest.NewRecorder(), adminSession, false)
	listReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: adminSession.Token})
	listResp := httptest.NewRecorder()
	handler.ServeHTTP(listResp, listReq)
	if listResp.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", listResp.Code)
	}

	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/users", strings.NewReader(`{"username":"alice","password":"alice's secure password","role":"user"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createReq.Header.Set(auth.CSRFHeaderName(), adminSession.CSRFToken)
	createReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: adminSession.Token})
	createResp := httptest.NewRecorder()
	handler.ServeHTTP(createResp, createReq)
	if createResp.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201: %s", createResp.Code, createResp.Body.String())
	}
	var created auth.Account
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Username != "alice" {
		t.Fatalf("created = %+v", created)
	}

	noCSRFReq := httptest.NewRequest(http.MethodPost, "/api/v1/users", strings.NewReader(`{"username":"bob","password":"bob's secure password","role":"user"}`))
	noCSRFReq.Header.Set("Content-Type", "application/json")
	noCSRFReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: adminSession.Token})
	noCSRFResp := httptest.NewRecorder()
	handler.ServeHTTP(noCSRFResp, noCSRFReq)
	if noCSRFResp.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF status = %d, want 403", noCSRFResp.Code)
	}
	_ = admin
}

func TestHTTPNonAdminCannotListUsers(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, _, err := authService.SetupAdmin(context.Background(), "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(db, authService)
	alice, err := service.Create(context.Background(), acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, CreateInput{Username: "alice", Password: "alice's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	_, aliceSession, err := authService.Authenticate(context.Background(), "alice", "alice's secure password")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandler(service, authService)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/users", nil)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: aliceSession.Token})
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", res.Code)
	}
	_ = alice
}
