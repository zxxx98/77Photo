package httpapi

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zxxx98/77Photo/internal/database"
)

func TestServerIdentityPersistsAndSignsChallenges(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "photos.db")
	db, err := database.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := LoadServerIdentity(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = database.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	second, err := LoadServerIdentity(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Equal(second) {
		t.Fatal("identity changed on restart")
	}
	handler := NewHandlerWithServices(HealthChecks{}, nil, Services{Identity: second})
	challenge := strings.Repeat("a1", 32)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/server/identity?challenge="+challenge, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var payload struct {
		PublicKey string `json:"public_key"`
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	key, err := hex.DecodeString(payload.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := hex.DecodeString(payload.Signature)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(key, []byte("77Photo/server-identity/v1:"+challenge), signature) {
		t.Fatal("invalid proof")
	}
	if ed25519.Verify(key, []byte("77Photo/server-identity/v1:"+strings.Repeat("b2", 32)), signature) {
		t.Fatal("proof reused for another challenge")
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("proof must not be cached")
	}
	for _, bad := range []string{"", "aa", strings.Repeat("z", 64), strings.Repeat("AA", 32), strings.Repeat("a", 66)} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/server/identity?challenge="+bad, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("challenge %q: status = %d", bad, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/server/identity?challenge="+challenge, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d", rec.Code)
	}
}
