package sharelinks

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
	"github.com/zxxx98/77Photo/internal/thumbnails"
)

type shareLinkHTTPFixtureData struct {
	db      *sql.DB
	auth    *auth.Service
	session auth.Session
	owner   auth.Account
	store   storage.Store
	folder  folders.Folder
	photo   photos.Photo
	handler http.Handler
}

func shareLinkHTTPFixture(t *testing.T) shareLinkHTTPFixtureData {
	t.Helper()
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.NewService(db, time.Hour, false)
	owner, session, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folder, err := folders.NewService(db, store).Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "Summer trip"})
	if err != nil {
		t.Fatal(err)
	}
	photo, err := photos.NewService(db, store, 1<<20).Upload(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, photos.UploadInput{
		FolderID: folder.ID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(testJPEGBytes(t)),
	})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(db, store, nil, false)
	return shareLinkHTTPFixtureData{db: db, auth: authService, session: session, owner: owner, store: store, folder: folder, photo: photo, handler: NewHTTPHandler(service, authService)}
}

func TestCreatePhotoLinkRequiresCSRFAndReturnsPublicURL(t *testing.T) {
	fixture := shareLinkHTTPFixture(t)
	body := bytes.NewBufferString(`{"resource_type":"photo","resource_id":"` + fixture.photo.ID + `","duration":"7_days"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/share-links", body)
	request.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: fixture.session.Token})
	request.Header.Set("Content-Type", "application/json")
	withoutCSRF := httptest.NewRecorder()
	fixture.handler.ServeHTTP(withoutCSRF, request)
	if withoutCSRF.Code != http.StatusForbidden {
		t.Fatalf("without CSRF status = %d, want 403: %s", withoutCSRF.Code, withoutCSRF.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/share-links", body)
	request.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: fixture.session.Token})
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(auth.CSRFHeaderName(), fixture.session.CSRFToken)
	withCSRF := httptest.NewRecorder()
	fixture.handler.ServeHTTP(withCSRF, request)
	if withCSRF.Code != http.StatusCreated {
		t.Fatalf("with CSRF status = %d, want 201: %s", withCSRF.Code, withCSRF.Body.String())
	}
	var link Link
	if err := json.NewDecoder(withCSRF.Body).Decode(&link); err != nil {
		t.Fatal(err)
	}
	if link.ResourceType != ResourcePhoto || link.URL == "" || len(link.Token) != 0 || !bytes.HasPrefix([]byte(link.URL), []byte("/#/share/")) {
		t.Fatalf("link = %+v", link)
	}
}

func TestCreateFolderLinkRejectsInvalidDuration(t *testing.T) {
	fixture := shareLinkHTTPFixture(t)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/share-links", bytes.NewBufferString(`{"resource_type":"folder","resource_id":"`+fixture.folder.ID+`","duration":"tomorrow"}`))
	request.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: fixture.session.Token})
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(auth.CSRFHeaderName(), fixture.session.CSRFToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", response.Code, response.Body.String())
	}
}

func TestPasswordlessLinkCanBeReadWithoutLogin(t *testing.T) {
	fixture := shareLinkHTTPFixture(t)
	link := createHTTPShareLink(t, fixture, ResourcePhoto, fixture.photo.ID, DurationForever, "")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token+"/photos", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var payload struct {
		Items []PublicPhoto `json:"items"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Items) != 1 || payload.Items[0].Filename != fixture.photo.Filename {
		t.Fatalf("public photos = %+v", payload.Items)
	}
}

func TestProtectedLinkRequiresUnlockBeforePhotoList(t *testing.T) {
	fixture := shareLinkHTTPFixture(t)
	link := createHTTPShareLink(t, fixture, ResourcePhoto, fixture.photo.ID, DurationForever, "correct horse battery staple")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token+"/photos", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || !bytes.Contains(response.Body.Bytes(), []byte("SHARE_PASSWORD_REQUIRED")) {
		t.Fatalf("locked status/body = %d/%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/share-links/"+link.Token+"/unlock", bytes.NewBufferString(`{"password":"correct horse battery staple"}`))
	request.Header.Set("Content-Type", "application/json")
	unlockResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(unlockResponse, request)
	if unlockResponse.Code != http.StatusOK {
		t.Fatalf("unlock status = %d: %s", unlockResponse.Code, unlockResponse.Body.String())
	}
	cookie := unlockResponse.Result().Cookies()
	if len(cookie) != 1 || cookie[0].Name != "77photo_share_access" || !cookie[0].HttpOnly {
		t.Fatalf("unlock cookies = %+v", cookie)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token+"/photos", nil)
	request.AddCookie(cookie[0])
	readResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(readResponse, request)
	if readResponse.Code != http.StatusOK {
		t.Fatalf("unlocked status = %d: %s", readResponse.Code, readResponse.Body.String())
	}
}

func TestWrongPasswordExpiredAndRevokedLinksAreUnavailable(t *testing.T) {
	fixture := shareLinkHTTPFixture(t)
	link := createHTTPShareLink(t, fixture, ResourcePhoto, fixture.photo.ID, DurationForever, "correct horse battery staple")
	wrongRequest := httptest.NewRequest(http.MethodPost, "/api/v1/share-links/"+link.Token+"/unlock", bytes.NewBufferString(`{"password":"wrong password"}`))
	wrongResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(wrongResponse, wrongRequest)
	if wrongResponse.Code != http.StatusUnauthorized || !bytes.Contains(wrongResponse.Body.Bytes(), []byte("SHARE_PASSWORD_INVALID")) {
		t.Fatalf("wrong password status/body = %d/%s", wrongResponse.Code, wrongResponse.Body.String())
	}

	if _, err := fixture.db.Exec("UPDATE share_links SET expires_at=? WHERE id=?", time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), link.ID); err != nil {
		t.Fatal(err)
	}
	expiredRequest := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token, nil)
	expiredResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(expiredResponse, expiredRequest)
	if expiredResponse.Code != http.StatusNotFound || !bytes.Contains(expiredResponse.Body.Bytes(), []byte("SHARE_UNAVAILABLE")) {
		t.Fatalf("expired status/body = %d/%s", expiredResponse.Code, expiredResponse.Body.String())
	}

	revokedLink := createHTTPShareLink(t, fixture, ResourcePhoto, fixture.photo.ID, DurationForever, "")
	if _, err := fixture.db.Exec("UPDATE share_links SET revoked_at=? WHERE id=?", time.Now().UTC().Format(time.RFC3339Nano), revokedLink.ID); err != nil {
		t.Fatal(err)
	}
	revokedRequest := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+revokedLink.Token, nil)
	revokedResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(revokedResponse, revokedRequest)
	if revokedResponse.Code != http.StatusNotFound || !bytes.Contains(revokedResponse.Body.Bytes(), []byte("SHARE_UNAVAILABLE")) {
		t.Fatalf("revoked status/body = %d/%s", revokedResponse.Code, revokedResponse.Body.String())
	}
}

func TestPhotoLinkCannotReadAnotherPhoto(t *testing.T) {
	fixture := shareLinkHTTPFixture(t)
	other, err := photos.NewService(fixture.db, fixture.store, 1<<20).Upload(context.Background(), acl.Principal{UserID: fixture.owner.ID, Role: acl.RoleAdmin}, photos.UploadInput{
		FolderID: fixture.folder.ID, Filename: "other.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(testJPEGBytesVariant(t, color.RGBA{R: 255})),
	})
	if err != nil {
		t.Fatal(err)
	}
	link := createHTTPShareLink(t, fixture, ResourcePhoto, fixture.photo.ID, DurationForever, "")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token+"/photos/"+other.ID+"/preview", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || !bytes.Contains(response.Body.Bytes(), []byte("SHARE_UNAVAILABLE")) {
		t.Fatalf("out-of-scope status/body = %d/%s", response.Code, response.Body.String())
	}
}

func TestFolderLinkContainsOnlyDescendantPhotos(t *testing.T) {
	fixture := shareLinkHTTPFixture(t)
	folderService := folders.NewService(fixture.db, fixture.store)
	parentID := fixture.folder.ID
	child, err := folderService.Create(context.Background(), acl.Principal{UserID: fixture.owner.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "Day one", ParentID: &parentID})
	if err != nil {
		t.Fatal(err)
	}
	childPhoto, err := photos.NewService(fixture.db, fixture.store, 1<<20).Upload(context.Background(), acl.Principal{UserID: fixture.owner.ID, Role: acl.RoleAdmin}, photos.UploadInput{
		FolderID: child.ID, Filename: "child.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(testJPEGBytesVariant(t, color.RGBA{G: 255})),
	})
	if err != nil {
		t.Fatal(err)
	}
	unrelatedFolder, err := folderService.Create(context.Background(), acl.Principal{UserID: fixture.owner.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "Private", ParentID: nil})
	if err != nil {
		t.Fatal(err)
	}
	unrelatedPhoto, err := photos.NewService(fixture.db, fixture.store, 1<<20).Upload(context.Background(), acl.Principal{UserID: fixture.owner.ID, Role: acl.RoleAdmin}, photos.UploadInput{
		FolderID: unrelatedFolder.ID, Filename: "unrelated.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(testJPEGBytesVariant(t, color.RGBA{B: 255})),
	})
	if err != nil {
		t.Fatal(err)
	}
	link := createHTTPShareLink(t, fixture, ResourceFolder, fixture.folder.ID, DurationForever, "")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token+"/photos", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("folder list status = %d: %s", response.Code, response.Body.String())
	}
	var payload struct {
		Items []PublicPhoto `json:"items"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Items) != 2 {
		t.Fatalf("folder photos = %+v, want root and descendant", payload.Items)
	}
	for _, item := range payload.Items {
		if item.ID == unrelatedPhoto.ID {
			t.Fatalf("folder share leaked unrelated photo: %+v", item)
		}
	}
	_ = childPhoto
}

func TestPublicPreviewUsesInlineDisposition(t *testing.T) {
	fixture := shareLinkHTTPFixture(t)
	previewPath := filepath.Join(t.TempDir(), "preview.webp")
	if err := os.WriteFile(previewPath, []byte("RIFF preview"), 0o640); err != nil {
		t.Fatal(err)
	}
	service := NewService(fixture.db, fixture.store, readyThumbnail{path: previewPath}, false)
	handler := NewHTTPHandler(service, fixture.auth)
	link := createHTTPShareLinkWithHandler(t, fixture, handler, ResourcePhoto, fixture.photo.ID, DurationForever, "")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token+"/photos/"+fixture.photo.ID+"/preview", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.HasPrefix(response.Header().Get("Content-Disposition"), "inline") {
		t.Fatalf("preview response = %d headers=%v", response.Code, response.Header())
	}
}

type readyThumbnail struct{ path string }

func (f readyThumbnail) Ensure(context.Context, string, int) (thumbnails.State, string, error) {
	return thumbnails.Ready, f.path, nil
}

func createHTTPShareLinkWithHandler(t *testing.T, fixture shareLinkHTTPFixtureData, handler http.Handler, resourceType ResourceType, resourceID string, duration Duration, password string) Link {
	t.Helper()
	input := `{"resource_type":"` + string(resourceType) + `","resource_id":"` + resourceID + `","duration":"` + string(duration) + `"}`
	if password != "" {
		input = `{"resource_type":"` + string(resourceType) + `","resource_id":"` + resourceID + `","duration":"` + string(duration) + `","password":"` + password + `"}`
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/share-links", bytes.NewBufferString(input))
	request.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: fixture.session.Token})
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(auth.CSRFHeaderName(), fixture.session.CSRFToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create link status = %d: %s", response.Code, response.Body.String())
	}
	var link Link
	if err := json.NewDecoder(response.Body).Decode(&link); err != nil {
		t.Fatal(err)
	}
	link.Token = strings.TrimPrefix(link.URL, "/#/share/")
	return link
}

func createHTTPShareLink(t *testing.T, fixture shareLinkHTTPFixtureData, resourceType ResourceType, resourceID string, duration Duration, password string) Link {
	t.Helper()
	input := `{"resource_type":"` + string(resourceType) + `","resource_id":"` + resourceID + `","duration":"` + string(duration) + `"}`
	if password != "" {
		input = `{"resource_type":"` + string(resourceType) + `","resource_id":"` + resourceID + `","duration":"` + string(duration) + `","password":"` + password + `"}`
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/share-links", bytes.NewBufferString(input))
	request.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: fixture.session.Token})
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(auth.CSRFHeaderName(), fixture.session.CSRFToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create link status = %d: %s", response.Code, response.Body.String())
	}
	var link Link
	if err := json.NewDecoder(response.Body).Decode(&link); err != nil {
		t.Fatal(err)
	}
	link.Token = strings.TrimPrefix(link.URL, "/#/share/")
	return link
}

func testJPEGBytes(t *testing.T) []byte {
	return testJPEGBytesVariant(t, color.RGBA{R: 1, G: 1, B: 1, A: 255})
}

func testJPEGBytesVariant(t *testing.T, fill color.Color) []byte {
	t.Helper()
	var body bytes.Buffer
	imageValue := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			imageValue.Set(x, y, fill)
		}
	}
	if err := jpeg.Encode(&body, imageValue, nil); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}
