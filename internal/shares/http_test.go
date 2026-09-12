package shares

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
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestHTTPShareCreateListAndRevoke(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	owner, session, err := authService.SetupAdmin(ctx, "owner", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	member, err := createShareUser(ctx, db, "member", "u_member")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folder, err := folders.NewService(db, store).Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandler(NewService(db), authService)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(auth.CSRFHeaderName(), session.CSRFToken)
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res
	}
	created := request(http.MethodPost, "/api/v1/shares", `{"folder_id":"`+folder.ID+`","user_id":"`+member.ID+`","permission":"read"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d: %s", created.Code, created.Body.String())
	}
	var share Share
	if err := json.NewDecoder(created.Body).Decode(&share); err != nil {
		t.Fatal(err)
	}
	if got := request(http.MethodGet, "/api/v1/shares", ""); got.Code != http.StatusOK {
		t.Fatalf("list status = %d", got.Code)
	}
	if got := request(http.MethodDelete, "/api/v1/shares/"+share.ID, ""); got.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d: %s", got.Code, got.Body.String())
	}
}
