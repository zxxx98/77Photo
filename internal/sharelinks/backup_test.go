package sharelinks

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/zxxx98/77Photo/internal/acl"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/storage"
)

// Rehearses a consistent SQLite snapshot paired with the referenced original.
func TestShareManagementSurvivesBackupRestore(t *testing.T) {
	fixture := shareLinkHTTPFixture(t)
	ctx := context.Background()
	principal := acl.Principal{UserID: fixture.owner.ID, Role: acl.RoleAdmin}
	link, err := NewService(fixture.db, fixture.store, nil, false).Create(ctx, principal, CreateInput{ResourceType: ResourcePhoto, ResourceID: fixture.photo.ID, Duration: DurationForever})
	if err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(t.TempDir(), "snapshot.db")
	if _, err := fixture.db.ExecContext(ctx, "VACUUM INTO ?", backupPath); err != nil {
		t.Fatal(err)
	}
	sourcePath, err := fixture.store.ResolvePath(fixture.photo.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	restoredStore, err := storage.New(filepath.Join(t.TempDir(), "restored-photos"))
	if err != nil {
		t.Fatal(err)
	}
	targetPath := filepath.Join(restoredStore.Root(), filepath.FromSlash(fixture.photo.StoragePath))
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetPath, original, 0o640); err != nil {
		t.Fatal(err)
	}
	restoredDB, err := dbstore.Open(ctx, backupPath)
	if err != nil {
		t.Fatal(err)
	}
	defer restoredDB.Close()
	var users, photos int
	if err := restoredDB.QueryRowContext(ctx, "SELECT count(*) FROM users").Scan(&users); err != nil {
		t.Fatal(err)
	}
	if err := restoredDB.QueryRowContext(ctx, "SELECT count(*) FROM photos").Scan(&photos); err != nil {
		t.Fatal(err)
	}
	if users != 1 || photos != 1 {
		t.Fatalf("restored users=%d photos=%d", users, photos)
	}
	digest, _, err := restoredStore.FileDigest(fixture.photo.StoragePath)
	if err != nil || digest != fixture.photo.Checksum {
		t.Fatalf("restored digest=%q, %v", digest, err)
	}
	shares := NewService(restoredDB, restoredStore, nil, false)
	page, err := shares.ListManaged(ctx, principal, ManageFilter{})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != link.ID || page.Items[0].Status != "active" {
		t.Fatalf("restored managed shares=%+v, %v", page, err)
	}
	if _, err := shares.PublicPhoto(ctx, link.Token, "", fixture.photo.ID); err != nil {
		t.Fatalf("restored public photo=%v", err)
	}
	var integrity string
	if err := restoredDB.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("restored integrity=%q, %v", integrity, err)
	}
}
