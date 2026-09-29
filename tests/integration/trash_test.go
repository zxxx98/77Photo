package integration

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/zxxx98/77Photo/internal/photos"
)

func TestTrashHTTPPermissionsAndRecoveryLifecycle(t *testing.T) {
	f := newSecurityFixture(t)
	photoPath := "/api/v1/photos/" + f.photo.ID
	trashPath := "/api/v1/trash/photos/" + f.photo.ID
	if res := serve(f.handler, "DELETE", photoPath+"?confirm=true", "", f.ownerSession, false); res.Code != 403 {
		t.Fatalf("missing csrf: %d", res.Code)
	}
	if res := serve(f.handler, "DELETE", photoPath+"?confirm=true", "", f.memberSession, true); res.Code != 403 {
		t.Fatalf("read member delete: %d %s", res.Code, res.Body.String())
	}
	if res := serve(f.handler, "DELETE", photoPath+"?confirm=true", "", f.ownerSession, true); res.Code != 204 {
		t.Fatalf("trash: %d %s", res.Code, res.Body.String())
	}
	for _, path := range []string{photoPath, photoPath + "/original", photoPath + "/preview", photoPath + "/thumbnail?size=256"} {
		if res := serve(f.handler, "GET", path, "", f.memberSession, false); res.Code != 404 {
			t.Errorf("normal deleted media %s: %d", path, res.Code)
		}
	}
	for _, path := range []string{trashPath + "/preview", "/api/v1/trash/photos?scope=all"} {
		if res := serve(f.handler, "GET", path, "", f.memberSession, false); res.Code != 403 {
			t.Errorf("private trash %s: %d", path, res.Code)
		}
	}
	for _, test := range []struct{ method, path, body string }{
		{"POST", trashPath + "/restore", "{}"}, {"DELETE", trashPath + "?confirm=true", ""}, {"POST", trashPath + "/retry", "{}"},
	} {
		if res := serve(f.handler, test.method, test.path, test.body, f.memberSession, true); res.Code != 403 {
			t.Errorf("member %s: %d", test.path, res.Code)
		}
	}
	res := serve(f.handler, "GET", "/api/v1/trash/photos?scope=mine", "", f.ownerSession, false)
	var page photos.TrashPage
	if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &page) != nil || len(page.Items) != 1 {
		t.Fatalf("owner list: %d %s", res.Code, res.Body.String())
	}
	if bytes.Contains(res.Body.Bytes(), []byte("storage_path")) || !strings.Contains(res.Header().Get("Cache-Control"), "no-store") {
		t.Fatal("trash response exposes paths or cacheable data")
	}
	if res := serve(f.handler, "GET", trashPath+"/preview", "", f.ownerSession, false); res.Code != http.StatusAccepted && res.Code != http.StatusOK {
		t.Fatalf("owner preview: %d %s", res.Code, res.Body.String())
	}
	if res := serve(f.handler, "POST", trashPath+"/restore", "{}", f.ownerSession, false); res.Code != 403 {
		t.Fatalf("restore csrf: %d", res.Code)
	}
	if res := serve(f.handler, "POST", trashPath+"/restore", "{}", f.ownerSession, true); res.Code != 200 {
		t.Fatalf("restore: %d %s", res.Code, res.Body.String())
	}
	if res := serve(f.handler, "GET", photoPath+"/original", "", f.memberSession, false); res.Code != 200 || !bytes.Equal(res.Body.Bytes(), testJPEG(t)) {
		t.Fatalf("restored shared original: %d", res.Code)
	}
	if res := serve(f.handler, "DELETE", photoPath+"?confirm=true", "", f.ownerSession, true); res.Code != 204 {
		t.Fatalf("trash again: %d", res.Code)
	}
	if res := serve(f.handler, "DELETE", trashPath, "", f.ownerSession, true); res.Code != 422 {
		t.Fatalf("permanent confirmation: %d", res.Code)
	}
	for i := 0; i < 2; i++ {
		if res := serve(f.handler, "DELETE", trashPath+"?confirm=true", "", f.ownerSession, true); res.Code != 204 {
			t.Fatalf("purge attempt %d: %d %s", i, res.Code, res.Body.String())
		}
	}
	if res := serve(f.handler, "POST", trashPath+"/restore", "{}", f.ownerSession, true); res.Code != 404 {
		t.Fatalf("purged restore: %d", res.Code)
	}
}
