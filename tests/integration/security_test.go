package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/httpapi"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/shares"
	"github.com/zxxx98/77Photo/internal/storage"
	"github.com/zxxx98/77Photo/internal/thumbnails"
	"github.com/zxxx98/77Photo/internal/users"
)

type securityFixture struct {
	handler       http.Handler
	auth          *auth.Service
	owner         auth.Account
	ownerSession  auth.Session
	member        auth.Account
	memberSession auth.Session
	folder        folders.Folder
	photo         photos.Photo
}

func newSecurityFixture(t *testing.T) securityFixture {
	t.Helper()
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.NewService(db, time.Hour, false)
	admin, _, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	userService := users.NewService(db, authService)
	owner, err := userService.Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, users.CreateInput{Username: "alice", Password: "alice secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	member, err := userService.Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, users.CreateInput{Username: "bob", Password: "bob secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	owner, ownerSession, err := authService.Authenticate(ctx, owner.Username, "alice secure password")
	if err != nil {
		t.Fatal(err)
	}
	member, memberSession, err := authService.Authenticate(ctx, member.Username, "bob secure password")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	authorizer := acl.NewAuthorizer(db)
	folderService := folders.NewService(db, store)
	folderService.SetAuthorizer(authorizer)
	folder, err := folderService.Create(ctx, acl.Principal{UserID: owner.ID, Role: owner.Role}, folders.CreateInput{Name: "family"})
	if err != nil {
		t.Fatal(err)
	}
	photoService := photos.NewService(db, store, 1<<20)
	photoService.SetAuthorizer(authorizer)
	photo, err := photoService.Upload(ctx, acl.Principal{UserID: owner.ID, Role: owner.Role}, photos.UploadInput{FolderID: folder.ID, Filename: "family.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(testJPEG(t))})
	if err != nil {
		t.Fatal(err)
	}
	shareService := shares.NewService(db)
	if _, err := shareService.Create(ctx, acl.Principal{UserID: owner.ID, Role: owner.Role}, shares.CreateInput{FolderID: folder.ID, UserID: member.ID, Permission: acl.PermissionRead}); err != nil {
		t.Fatal(err)
	}
	thumbnailService, err := thumbnails.NewService(photoService, store, filepath.Join(t.TempDir(), "cache"), 1, 8)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(thumbnailService.Close)
	photoService.SetCacheInvalidator(thumbnailService)
	photoService.SetThumbnailEnqueuer(thumbnailService)
	handler := httpapi.NewHandlerWithServices(httpapi.HealthChecks{}, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)), httpapi.Services{
		Auth: authService, Users: userService, Folders: folderService, Photos: photoService,
		Thumbnails: thumbnailService, Shares: shareService,
	})
	return securityFixture{handler: handler, auth: authService, owner: owner, ownerSession: ownerSession, member: member, memberSession: memberSession, folder: folder, photo: photo}
}

func TestSecurityPermissionMatrixAcrossResources(t *testing.T) {
	fixture := newSecurityFixture(t)
	photoPath := "/api/v1/photos/" + fixture.photo.ID
	member := func(method, path, body string, csrf bool) *httptest.ResponseRecorder {
		t.Helper()
		return serve(fixture.handler, method, path, body, fixture.memberSession, csrf)
	}
	owner := func(method, path, body string, csrf bool) *httptest.ResponseRecorder {
		t.Helper()
		return serve(fixture.handler, method, path, body, fixture.ownerSession, csrf)
	}

	if got := member(http.MethodGet, photoPath, "", false); got.Code != http.StatusOK {
		t.Fatalf("shared metadata status = %d: %s", got.Code, got.Body.String())
	}
	for _, endpoint := range []string{
		photoPath + "/original",
		photoPath + "/preview",
		photoPath + "/thumbnail?size=256",
		"/api/v1/photos/shared/" + fixture.folder.ID + "/",
		"/api/v1/folders/" + fixture.folder.ID,
		"/api/v1/folders?parent_id=" + fixture.folder.ID,
	} {
		got := member(http.MethodGet, endpoint, "", false)
		if got.Code != http.StatusOK && got.Code != http.StatusAccepted {
			t.Errorf("shared read %s status = %d: %s", endpoint, got.Code, got.Body.String())
		}
	}

	// A read share cannot mutate media, folders or sharing records. Check both
	// a missing token (CSRF guard) and a valid token (ACL guard).
	if got := member(http.MethodPatch, photoPath, `{"name":"renamed.jpg"}`, false); got.Code != http.StatusForbidden || !strings.Contains(got.Body.String(), "CSRF_INVALID") {
		t.Fatalf("missing CSRF rename = %d: %s", got.Code, got.Body.String())
	}
	for _, request := range []struct {
		method, path, body string
	}{
		{http.MethodPatch, photoPath, `{"name":"renamed.jpg"}`},
		{http.MethodPost, photoPath + "/move", `{"target_folder_id":"` + fixture.folder.ID + `"}`},
		{http.MethodDelete, photoPath + "?confirm=true", ""},
		{http.MethodPost, "/api/v1/folders", `{"name":"child","parent_id":"` + fixture.folder.ID + `"}`},
		{http.MethodPost, "/api/v1/shares", `{"folder_id":"` + fixture.folder.ID + `","user_id":"` + fixture.owner.ID + `","permission":"write"}`},
	} {
		got := member(request.method, request.path, request.body, true)
		if got.Code != http.StatusForbidden {
			t.Errorf("read member write %s %s status = %d: %s", request.method, request.path, got.Code, got.Body.String())
		}
	}
	uploadBody, uploadType := multipartBody(t, fixture.folder.ID)
	uploadReq := httptest.NewRequest(http.MethodPost, "/api/v1/photos/upload", uploadBody)
	uploadReq.Header.Set("Content-Type", uploadType)
	uploadReq.Header.Set(auth.CSRFHeaderName(), fixture.memberSession.CSRFToken)
	uploadReq.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: fixture.memberSession.Token})
	uploadRes := httptest.NewRecorder()
	fixture.handler.ServeHTTP(uploadRes, uploadReq)
	if uploadRes.Code != http.StatusForbidden {
		t.Fatalf("read member upload status = %d: %s", uploadRes.Code, uploadRes.Body.String())
	}

	// The owner can revoke the share, after which every previously readable
	// endpoint is denied even when the member knows the opaque photo ID.
	sharesBefore := owner(http.MethodGet, "/api/v1/shares", "", false)
	if sharesBefore.Code != http.StatusOK {
		t.Fatalf("owner shares list status = %d: %s", sharesBefore.Code, sharesBefore.Body.String())
	}
	var payload struct {
		Items []shares.Share `json:"items"`
	}
	if err := json.NewDecoder(sharesBefore.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Items) != 1 {
		t.Fatalf("owner shares = %+v, want one", payload.Items)
	}
	if got := owner(http.MethodDelete, "/api/v1/shares/"+payload.Items[0].ID, "", true); got.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d: %s", got.Code, got.Body.String())
	}
	for _, endpoint := range []string{photoPath, photoPath + "/original", "/api/v1/photos/shared/" + fixture.folder.ID + "/"} {
		if got := member(http.MethodGet, endpoint, "", false); got.Code != http.StatusForbidden {
			t.Errorf("revoked member %s status = %d: %s", endpoint, got.Code, got.Body.String())
		}
	}
}

func TestSecurityRejectsEncodedPathAndKeepsSessionRevocation(t *testing.T) {
	fixture := newSecurityFixture(t)
	request := serve(fixture.handler, http.MethodGet, "/api/v1/photos/%2e%2e%2fetc%2fpasswd", "", fixture.memberSession, false)
	if request.Code != http.StatusNotFound && request.Code != http.StatusForbidden {
		t.Fatalf("encoded traversal status = %d: %s", request.Code, request.Body.String())
	}
	if err := fixture.auth.Revoke(context.Background(), fixture.memberSession.Token); err != nil {
		t.Fatal(err)
	}
	if got := serve(fixture.handler, http.MethodGet, "/api/v1/auth/me", "", fixture.memberSession, false); got.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session status = %d: %s", got.Code, got.Body.String())
	}
}

func serve(handler http.Handler, method, path, body string, session auth.Session, csrf bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	if csrf {
		req.Header.Set(auth.CSRFHeaderName(), session.CSRFToken)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func testJPEG(t *testing.T) []byte {
	t.Helper()
	var body bytes.Buffer
	if err := jpeg.Encode(&body, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func multipartBody(t *testing.T, folderID string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("folder_id", folderID); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="upload.jpg"`)
	header.Set("Content-Type", "image/jpeg")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(testJPEG(t)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}
