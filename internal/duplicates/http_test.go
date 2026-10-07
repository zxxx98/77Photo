package duplicates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/auth"
)

func TestHTTPRequiresAdminAndCSRFAndRejectsMalformedActions(t *testing.T) {
	f := newFixture(t)
	a := auth.NewService(f.db, time.Hour, false)
	hash, e := auth.HashPassword("correct horse battery staple")
	if e != nil {
		t.Fatal(e)
	}
	_, e = f.db.Exec("UPDATE users SET password_hash=?,role=CASE WHEN id='a' THEN 'admin' ELSE 'user' END", hash)
	if e != nil {
		t.Fatal(e)
	}
	_, adminSession, e := a.Authenticate(context.Background(), "a", "correct horse battery staple")
	if e != nil {
		t.Fatal(e)
	}
	_, userSession, e := a.Authenticate(context.Background(), "b", "correct horse battery staple")
	if e != nil {
		t.Fatal(e)
	}
	h := NewHandler(f.s, a)
	for _, c := range []struct {
		method, path, body, token, csrf string
		status                          int
	}{
		{"GET", "config", "", "", "", 401},
		{"GET", "groups", "", userSession.Token, "", 403},
		{"GET", "config", "", adminSession.Token, "", 200},
		{"POST", "jobs", `{"mode":"perceptual"}`, adminSession.Token, "", 403},
		{"POST", "jobs", `{"mode":"invalid"}`, adminSession.Token, adminSession.CSRFToken, 400},
		{"POST", "jobs", `{"mode":"perceptual","extra":true}`, adminSession.Token, adminSession.CSRFToken, 400},
		{"POST", "jobs", `{"mode":"perceptual"}{}`, adminSession.Token, adminSession.CSRFToken, 400},
		{"POST", "cleanup", `{"confirm":false}`, adminSession.Token, adminSession.CSRFToken, 400},
		{"GET", "groups?kind=unknown", "", adminSession.Token, "", 400},
	} {
		r := httptest.NewRequest(c.method, "/api/v1/admin/duplicates/"+c.path, strings.NewReader(c.body))
		if c.token != "" {
			r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: c.token})
		}
		if c.csrf != "" {
			r.Header.Set("X-CSRF-Token", c.csrf)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.status {
			t.Fatalf("%s %s = %d %s", c.method, c.path, w.Code, w.Body.String())
		}
	}
}
