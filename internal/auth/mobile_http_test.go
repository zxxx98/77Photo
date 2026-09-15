package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	dbstore "github.com/zxxx98/77Photo/internal/database"
)

func TestMobileLoginReturnsTokensWithoutBrowserSessionMaterial(t *testing.T) {
	service, server, _ := newMobileHTTPTestServer(t)
	before := countMobileHTTPRows(t, service, "sessions")

	client := &http.Client{}
	login := doJSON(t, client, server.URL+"/api/v1/mobile/auth/login", http.MethodPost,
		`{"username":"admin","password":"correct horse battery staple","device_name":"Pixel 9","platform":"android","app_version":"1.0.0"}`, "")
	if login.StatusCode != http.StatusOK {
		login.Body.Close()
		t.Fatalf("login = %d", login.StatusCode)
	}
	assertNoMobileBrowserMaterial(t, login)
	payload, err := io.ReadAll(login.Body)
	login.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var body MobileSessionResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.AccessToken == "" || body.RefreshToken == "" || body.User.ID == "" {
		t.Fatalf("mobile response = %+v", body)
	}
	if body.Device.Name != "Pixel 9" || body.Device.Platform != "android" || body.Device.AppVersion != "1.0.0" {
		t.Fatalf("mobile device = %+v", body.Device)
	}
	var wire map[string]any
	if err := json.Unmarshal(payload, &wire); err != nil {
		t.Fatal(err)
	}
	device, ok := wire["device"].(map[string]any)
	if !ok {
		t.Fatalf("mobile device wire value = %#v", wire["device"])
	}
	if _, ok := device["user_id"]; !ok {
		t.Fatalf("mobile device wire fields = %#v, want user_id", device)
	}
	if _, ok := device["UserID"]; ok {
		t.Fatalf("mobile device wire fields = %#v, contains Go field name", device)
	}
	if got := countMobileHTTPRows(t, service, "sessions"); got != before {
		t.Fatalf("browser sessions after mobile login = %d, want %d", got, before)
	}
}

func TestMobileRefreshRotatesTokens(t *testing.T) {
	_, server, _ := newMobileHTTPTestServer(t)
	client := &http.Client{}
	login := mobileHTTPLogin(t, client, server.URL)

	refresh := doJSON(t, client, server.URL+"/api/v1/mobile/auth/refresh", http.MethodPost,
		`{"refresh_token":"`+login.RefreshToken+`"}`, "")
	if refresh.StatusCode != http.StatusOK {
		refresh.Body.Close()
		t.Fatalf("refresh = %d", refresh.StatusCode)
	}
	assertNoMobileBrowserMaterial(t, refresh)
	var rotated MobileSessionResponse
	decodeJSON(t, refresh, &rotated)
	if rotated.AccessToken == login.AccessToken || rotated.RefreshToken == login.RefreshToken {
		t.Fatalf("refresh did not rotate tokens: before=%+v after=%+v", login, rotated)
	}
	if rotated.User.ID != login.User.ID || rotated.Device.ID != login.Device.ID {
		t.Fatalf("refresh identity = user %q/device %q, want user %q/device %q", rotated.User.ID, rotated.Device.ID, login.User.ID, login.Device.ID)
	}

	reused := doJSON(t, client, server.URL+"/api/v1/mobile/auth/refresh", http.MethodPost,
		`{"refresh_token":"`+login.RefreshToken+`"}`, "")
	if reused.StatusCode != http.StatusUnauthorized {
		reused.Body.Close()
		t.Fatalf("reused refresh = %d, want 401", reused.StatusCode)
	}
	var reusedBody map[string]any
	decodeJSON(t, reused, &reusedBody)
	if reusedBody["error"].(map[string]any)["code"] != "AUTH_REQUIRED" {
		t.Fatalf("reused refresh error = %#v", reusedBody)
	}
}

func TestMobileLogoutRevokesBearerDeviceSession(t *testing.T) {
	_, server, _ := newMobileHTTPTestServer(t)
	client := &http.Client{}
	login := mobileHTTPLogin(t, client, server.URL)

	logout := mobileHTTPBearerRequest(t, client, server.URL+"/api/v1/mobile/auth/logout", http.MethodPost, login.AccessToken, "")
	if logout.StatusCode != http.StatusNoContent {
		logout.Body.Close()
		t.Fatalf("logout = %d, want 204", logout.StatusCode)
	}
	assertNoMobileBrowserMaterial(t, logout)
	logout.Body.Close()

	devices := mobileHTTPBearerRequest(t, client, server.URL+"/api/v1/mobile/devices", http.MethodGet, login.AccessToken, "")
	if devices.StatusCode != http.StatusUnauthorized {
		devices.Body.Close()
		t.Fatalf("devices after logout = %d, want 401", devices.StatusCode)
	}
	devices.Body.Close()
}

func TestMobileDeviceListAndDelete(t *testing.T) {
	service, server, account := newMobileHTTPTestServer(t)
	client := &http.Client{}
	login := mobileHTTPLogin(t, client, server.URL)
	second, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "iPad", Platform: "ios", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}

	list := mobileHTTPBearerRequest(t, client, server.URL+"/api/v1/mobile/devices", http.MethodGet, login.AccessToken, "")
	if list.StatusCode != http.StatusOK {
		list.Body.Close()
		t.Fatalf("device list = %d", list.StatusCode)
	}
	assertNoMobileBrowserMaterial(t, list)
	var listBody struct {
		Items []MobileDevice `json:"items"`
	}
	decodeJSON(t, list, &listBody)
	if len(listBody.Items) != 2 || listBody.Items[0].ID != second.Device.ID {
		t.Fatalf("device list = %+v", listBody.Items)
	}

	deleted := mobileHTTPBearerRequest(t, client, server.URL+"/api/v1/mobile/devices/"+second.Device.ID, http.MethodDelete, login.AccessToken, "")
	if deleted.StatusCode != http.StatusNoContent {
		deleted.Body.Close()
		t.Fatalf("device delete = %d, want 204", deleted.StatusCode)
	}
	assertNoMobileBrowserMaterial(t, deleted)
	deleted.Body.Close()
	if _, err := service.CurrentBearer(context.Background(), second.AccessToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("deleted device access = %v, want unauthorized", err)
	}
}

func TestMobileDeletingAnotherUsersDeviceReturnsNotFound(t *testing.T) {
	service, server, _ := newMobileHTTPTestServer(t)
	other := createMobileTestAccount(t, service, "other")
	otherSession, err := service.CreateMobileSession(context.Background(), other.ID, MobileDeviceInput{Name: "Other phone", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{}
	owner := mobileHTTPLogin(t, client, server.URL)

	deleted := mobileHTTPBearerRequest(t, client, server.URL+"/api/v1/mobile/devices/"+otherSession.Device.ID, http.MethodDelete, owner.AccessToken, "")
	if deleted.StatusCode != http.StatusNotFound {
		deleted.Body.Close()
		t.Fatalf("another user's device delete = %d, want 404", deleted.StatusCode)
	}
	assertNoMobileBrowserMaterial(t, deleted)
	var body map[string]any
	decodeJSON(t, deleted, &body)
	if body["error"].(map[string]any)["code"] != "NOT_FOUND" {
		t.Fatalf("another user's device error = %#v", body)
	}
}

func TestMobileProtectedRoutesRequireBearerAccess(t *testing.T) {
	_, server, _ := newMobileHTTPTestServer(t)
	client := &http.Client{}
	for _, endpoint := range []string{
		"/api/v1/mobile/auth/logout",
		"/api/v1/mobile/devices",
		"/api/v1/mobile/devices/device-id",
	} {
		method := http.MethodGet
		if strings.HasSuffix(endpoint, "logout") {
			method = http.MethodPost
		} else if strings.Contains(endpoint, "/device-id") {
			method = http.MethodDelete
		}
		response := doJSON(t, client, server.URL+endpoint, method, `{}`, "")
		if response.StatusCode != http.StatusUnauthorized {
			response.Body.Close()
			t.Fatalf("%s %s = %d, want 401", method, endpoint, response.StatusCode)
		}
		assertNoMobileBrowserMaterial(t, response)
		response.Body.Close()
	}
}

func TestMobileMethodsRejectUnsupportedMethods(t *testing.T) {
	_, server, _ := newMobileHTTPTestServer(t)
	client := &http.Client{}
	tests := []struct {
		name, endpoint, method, allow string
	}{
		{name: "login", endpoint: "/api/v1/mobile/auth/login", method: http.MethodGet, allow: http.MethodPost},
		{name: "refresh", endpoint: "/api/v1/mobile/auth/refresh", method: http.MethodGet, allow: http.MethodPost},
		{name: "logout", endpoint: "/api/v1/mobile/auth/logout", method: http.MethodGet, allow: http.MethodPost},
		{name: "list", endpoint: "/api/v1/mobile/devices", method: http.MethodPost, allow: http.MethodGet},
		{name: "delete", endpoint: "/api/v1/mobile/devices/device-id", method: http.MethodPost, allow: http.MethodDelete},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := doJSON(t, client, server.URL+test.endpoint, test.method, `{}`, "")
			if response.StatusCode != http.StatusMethodNotAllowed {
				response.Body.Close()
				t.Fatalf("status = %d, want 405", response.StatusCode)
			}
			if response.Header.Get("Allow") != test.allow {
				response.Body.Close()
				t.Fatalf("Allow = %q, want %q", response.Header.Get("Allow"), test.allow)
			}
			response.Body.Close()
		})
	}
}

func TestMobileRejectsUnknownJSONFields(t *testing.T) {
	_, server, _ := newMobileHTTPTestServer(t)
	response := doJSON(t, &http.Client{}, server.URL+"/api/v1/mobile/auth/login", http.MethodPost,
		`{"username":"admin","password":"correct horse battery staple","device_name":"Pixel 9","platform":"android","app_version":"1.0.0","unexpected":true}`, "")
	if response.StatusCode != http.StatusBadRequest {
		response.Body.Close()
		t.Fatalf("unknown field status = %d, want 400", response.StatusCode)
	}
	var body map[string]any
	decodeJSON(t, response, &body)
	if body["error"].(map[string]any)["code"] != "INVALID_REQUEST" {
		t.Fatalf("unknown field error = %#v", body)
	}
}

func TestMobileLoginFailureIsUniform(t *testing.T) {
	_, server, _ := newMobileHTTPTestServer(t)
	client := &http.Client{}
	wrong := doJSON(t, client, server.URL+"/api/v1/mobile/auth/login", http.MethodPost,
		`{"username":"admin","password":"wrong password","device_name":"Pixel 9","platform":"android","app_version":"1.0.0"}`, "")
	unknown := doJSON(t, client, server.URL+"/api/v1/mobile/auth/login", http.MethodPost,
		`{"username":"nobody","password":"wrong password","device_name":"Pixel 9","platform":"android","app_version":"1.0.0"}`, "")
	if wrong.StatusCode != http.StatusUnauthorized || unknown.StatusCode != http.StatusUnauthorized {
		wrong.Body.Close()
		unknown.Body.Close()
		t.Fatalf("statuses = %d and %d, want both 401", wrong.StatusCode, unknown.StatusCode)
	}
	var wrongBody, unknownBody map[string]any
	decodeJSON(t, wrong, &wrongBody)
	decodeJSON(t, unknown, &unknownBody)
	wrongError := wrongBody["error"].(map[string]any)
	unknownError := unknownBody["error"].(map[string]any)
	if wrongError["code"] != "INVALID_CREDENTIALS" || wrongError["code"] != unknownError["code"] || wrongError["message"] != unknownError["message"] {
		t.Fatalf("error responses differ: %#v vs %#v", wrongBody, unknownBody)
	}
}

func TestMobileLoginDatabaseFailureIsInternalAndNotCredentialFailure(t *testing.T) {
	service, server, _ := newMobileHTTPTestServer(t)
	if err := service.db.Close(); err != nil {
		t.Fatal(err)
	}

	response := doJSON(t, &http.Client{}, server.URL+"/api/v1/mobile/auth/login", http.MethodPost,
		`{"username":"admin","password":"correct horse battery staple","device_name":"Pixel 9","platform":"android","app_version":"1.0.0"}`, "")
	if response.StatusCode != http.StatusInternalServerError {
		response.Body.Close()
		t.Fatalf("closed database login = %d, want 500", response.StatusCode)
	}
	var body map[string]any
	decodeJSON(t, response, &body)
	if body["error"].(map[string]any)["code"] != "INTERNAL_ERROR" {
		t.Fatalf("closed database error = %#v", body)
	}
	service.limiter.mu.Lock()
	attempt := service.limiter.entries["admin"]
	service.limiter.mu.Unlock()
	if attempt.count != 0 {
		t.Fatalf("closed database failure count = %d, want 0", attempt.count)
	}
}

func newMobileHTTPTestServer(t *testing.T) (*Service, *httptest.Server, Account) {
	t.Helper()
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(db, time.Hour, false)
	account, _, err := service.SetupAdmin(context.Background(), "admin", "correct horse battery staple")
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	server := httptest.NewServer(NewMobileHTTPHandler(service))
	t.Cleanup(func() {
		server.Close()
		_ = db.Close()
	})
	return service, server, account
}

func mobileHTTPLogin(t *testing.T, client *http.Client, baseURL string) MobileSessionResponse {
	t.Helper()
	response := doJSON(t, client, baseURL+"/api/v1/mobile/auth/login", http.MethodPost,
		`{"username":"admin","password":"correct horse battery staple","device_name":"Pixel 9","platform":"android","app_version":"1.0.0"}`, "")
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		t.Fatalf("login = %d", response.StatusCode)
	}
	assertNoMobileBrowserMaterial(t, response)
	var body MobileSessionResponse
	decodeJSON(t, response, &body)
	return body
}

func mobileHTTPBearerRequest(t *testing.T, client *http.Client, endpoint, method, accessToken, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, endpoint, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func assertNoMobileBrowserMaterial(t *testing.T, response *http.Response) {
	t.Helper()
	if response.Header.Get("Set-Cookie") != "" || response.Header.Get(CSRFHeaderName()) != "" {
		t.Fatalf("mobile response emitted browser session material: %v", response.Header)
	}
}

func countMobileHTTPRows(t *testing.T, service *Service, table string) int {
	t.Helper()
	var count int
	if err := service.db.QueryRowContext(context.Background(), "SELECT count(*) FROM "+table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
