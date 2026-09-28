package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
)

// LoadServerIdentity persists one signing seed per database. Cloned deployments
// must use separate identities if they are intended to be separate servers.
func LoadServerIdentity(ctx context.Context, db *sql.DB) (ed25519.PrivateKey, error) {
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	if _, err := db.ExecContext(ctx, "INSERT OR IGNORE INTO server_identity(singleton, seed) VALUES(1, ?)", seed); err != nil {
		return nil, err
	}
	if err := db.QueryRowContext(ctx, "SELECT seed FROM server_identity WHERE singleton = 1").Scan(&seed); err != nil {
		return nil, err
	}
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("invalid server identity seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func identityHandler(key ed25519.PrivateKey) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		challenge := r.URL.Query().Get("challenge")
		nonce, err := hex.DecodeString(challenge)
		if err != nil || len(nonce) != 32 || challenge != hex.EncodeToString(nonce) {
			WriteError(w, http.StatusBadRequest, "INVALID_CHALLENGE", "expected a 32-byte lowercase hex challenge", RequestID(r.Context()), nil)
			return
		}
		message := []byte("77Photo/server-identity/v1:" + challenge)
		writeJSON(w, http.StatusOK, map[string]string{
			"public_key": hex.EncodeToString(key.Public().(ed25519.PublicKey)),
			"signature":  hex.EncodeToString(ed25519.Sign(key, message)),
		})
	}
}
