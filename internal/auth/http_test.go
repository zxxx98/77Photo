package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	dbstore "github.com/zxxx98/77Photo/internal/database"
)

func TestHTTPSetupLoginMeAndLogout(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := NewService(db, time.Hour, false)
	handler := NewHTTPHandler(service, false)
	server := httptest.NewServer(handler)
	defer server.Close()
	client := &http.Client{Jar: mustCookieJar(t)}

	setup := doJSON(t, client, server.URL+"/api/v1/setup/admin", http.MethodPost, `{"username":"admin","password":"correct horse battery staple"}`, "")
	if setup.StatusCode != http.StatusCreated {
		t.Fatalf("setup status = %d, want 201", setup.StatusCode)
	}
	var authBody struct {
		CSRFToken string  `json:"csrf_token"`
		User      Account `json:"user"`
	}
	decodeJSON(t, setup, &authBody)
	if authBody.User.Role != RoleAdmin || authBody.CSRFToken == "" {
		t.Fatalf("setup body = %+v", authBody)
	}
	if len(client.Jar.Cookies(mustParseURL(t, server.URL))) == 0 {
		t.Fatal("setup did not set a session cookie")
	}

	meReq, _ := http.NewRequest(http.MethodGet, server.URL+"/api/v1/auth/me", nil)
	meResp, err := client.Do(meReq)
	if err != nil {
		t.Fatal(err)
	}
	if meResp.StatusCode != http.StatusOK {
		t.Fatalf("me status = %d, want 200", meResp.StatusCode)
	}
	if meResp.Header.Get(CSRFHeaderName()) != authBody.CSRFToken {
		t.Fatalf("me csrf header = %q, want %q", meResp.Header.Get(CSRFHeaderName()), authBody.CSRFToken)
	}
	_ = meResp.Body.Close()

	logoutReq, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/auth/logout", nil)
	logoutReq.Header.Set(CSRFHeaderName(), authBody.CSRFToken)
	logoutResp, err := client.Do(logoutReq)
	if err != nil {
		t.Fatal(err)
	}
	if logoutResp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout status = %d, want 204", logoutResp.StatusCode)
	}
	_ = logoutResp.Body.Close()

	meAfter, err := client.Do(meReq)
	if err != nil {
		t.Fatal(err)
	}
	if meAfter.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me after logout status = %d, want 401", meAfter.StatusCode)
	}
	_ = meAfter.Body.Close()
}

func TestHTTPSetupStatusTracksInitialization(t *testing.T) {
	service, _ := newAuthService(t)
	server := httptest.NewServer(NewHTTPHandler(service, false))
	defer server.Close()

	assertRequired := func(want bool) {
		t.Helper()
		resp, err := http.Get(server.URL + "/api/v1/setup/status")
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("status response = %d, cache=%q", resp.StatusCode, resp.Header.Get("Cache-Control"))
		}
		var body struct {
			Required bool `json:"required"`
		}
		decodeJSON(t, resp, &body)
		if body.Required != want {
			t.Fatalf("required = %v, want %v", body.Required, want)
		}
	}

	assertRequired(true)
	if _, _, err := service.SetupAdmin(context.Background(), "owner", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	assertRequired(false)

	resp := doJSON(t, http.DefaultClient, server.URL+"/api/v1/setup/status", http.MethodPost, `{}`, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST setup status = %d, want 405", resp.StatusCode)
	}
}

func TestHTTPMeRestoresMissingCSRFTokenCookie(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := NewService(db, time.Hour, false)
	_, session, err := service.SetupAdmin(context.Background(), "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewHTTPHandler(service, false))
	defer server.Close()

	meReq, _ := http.NewRequest(http.MethodGet, server.URL+"/api/v1/auth/me", nil)
	meReq.AddCookie(&http.Cookie{Name: SessionCookieName(), Value: session.Token})
	meResp, err := http.DefaultClient.Do(meReq)
	if err != nil {
		t.Fatal(err)
	}
	defer meResp.Body.Close()
	if meResp.StatusCode != http.StatusOK {
		t.Fatalf("me status = %d, want 200", meResp.StatusCode)
	}
	csrf := meResp.Header.Get(CSRFHeaderName())
	if csrf == "" || csrf == session.CSRFToken {
		t.Fatalf("me csrf header = %q, want a rotated token", csrf)
	}
	var csrfCookie *http.Cookie
	for _, cookie := range meResp.Cookies() {
		if cookie.Name == CSRFTokenCookieName() {
			csrfCookie = cookie
			break
		}
	}
	if csrfCookie == nil || csrfCookie.Value != csrf {
		t.Fatalf("me csrf cookie = %#v, want token %q", csrfCookie, csrf)
	}

	logoutReq, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/auth/logout", nil)
	logoutReq.AddCookie(&http.Cookie{Name: SessionCookieName(), Value: session.Token})
	logoutReq.AddCookie(csrfCookie)
	logoutReq.Header.Set(CSRFHeaderName(), csrf)
	logoutResp, err := http.DefaultClient.Do(logoutReq)
	if err != nil {
		t.Fatal(err)
	}
	defer logoutResp.Body.Close()
	if logoutResp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout status = %d, want 204", logoutResp.StatusCode)
	}
}

func TestHTTPLoginFailureIsUniform(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := NewService(db, time.Hour, false)
	if _, _, err := service.SetupAdmin(context.Background(), "admin", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandler(service, false)
	server := httptest.NewServer(handler)
	defer server.Close()
	client := &http.Client{}
	wrong := doJSON(t, client, server.URL+"/api/v1/auth/login", http.MethodPost, `{"username":"admin","password":"wrong password"}`, "")
	unknown := doJSON(t, client, server.URL+"/api/v1/auth/login", http.MethodPost, `{"username":"nobody","password":"wrong password"}`, "")
	if wrong.StatusCode != http.StatusUnauthorized || unknown.StatusCode != http.StatusUnauthorized {
		t.Fatalf("statuses = %d and %d, want both 401", wrong.StatusCode, unknown.StatusCode)
	}
	var wrongBody, unknownBody map[string]any
	decodeJSON(t, wrong, &wrongBody)
	decodeJSON(t, unknown, &unknownBody)
	if wrongBody["error"].(map[string]any)["code"] != unknownBody["error"].(map[string]any)["code"] {
		t.Fatalf("error codes differ: %#v vs %#v", wrongBody, unknownBody)
	}
}

func mustCookieJar(t *testing.T) http.CookieJar {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return jar
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func doJSON(t *testing.T, client *http.Client, endpoint, method, body, csrf string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, endpoint, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if csrf != "" {
		req.Header.Set(CSRFHeaderName(), csrf)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func decodeJSON(t *testing.T, resp *http.Response, target any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(target); err != nil {
		t.Fatal(err)
	}
}
