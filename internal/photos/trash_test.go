package photos

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/storage"
)

func trashPhoto(t *testing.T, f uploadFixture, name string) Photo {
	t.Helper()
	p, err := f.service.Upload(context.Background(), f.principal, UploadInput{FolderID: f.folderID, Filename: name, DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 3, 2))})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestTrashRestoresOriginalAndUploadedMotionAfterRestart(t *testing.T) {
	f := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	p := trashPhoto(t, f, "keep.jpg")
	if err := f.service.AttachLiveVideo(ctx, f.principal, p.ID, LiveVideoInput{Filename: "keep.mov", DeclaredMIME: "video/quicktime", Body: bytes.NewReader(quickTimeBytes())}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.db.Exec(`INSERT INTO share_links(id,resource_type,resource_id,token_hash,created_at,updated_at) VALUES('trash-link','photo',?,'hash','2026-01-01','2026-01-01')`, p.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Delete(ctx, f.principal, p.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Delete(ctx, f.principal, p.ID, true); err != nil {
		t.Fatalf("retry delete: %v", err)
	}
	if _, err := f.service.Get(ctx, f.principal, p.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted photo visible: %v", err)
	}
	page, err := f.service.ListTrash(ctx, f.principal, "", 50, false)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("trash: %+v %v", page, err)
	}
	if page.RetentionDays != 30 {
		t.Fatalf("retention=%d", page.RetentionDays)
	}
	if err := folders.NewService(f.service.db, f.store).Delete(ctx, f.principal, f.folderID); !errors.Is(err, folders.ErrNotEmpty) {
		t.Fatalf("trash folder deletion: %v", err)
	}
	restarted := NewService(f.service.db, f.store, 1<<20)
	if err := restarted.RecoverTrash(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := restarted.RestoreTrash(ctx, f.principal, p.ID, RestoreInput{})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != p.ID || got.Checksum != p.Checksum || got.StoragePath != p.StoragePath {
		t.Fatalf("restored=%+v", got)
	}
	digest, _, err := f.store.FileDigest(got.StoragePath)
	if err != nil || digest != p.Checksum {
		t.Fatalf("restored original differs: %s %v", digest, err)
	}
	_, motion, err := restarted.LiveVideoPath(ctx, f.principal, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(motion)
	if err != nil || !bytes.Equal(data, quickTimeBytes()) {
		t.Fatalf("motion differs: %v", err)
	}
	var revoked string
	if err := f.service.db.QueryRow("SELECT revoked_at FROM share_links WHERE id='trash-link'").Scan(&revoked); err != nil || revoked == "" {
		t.Fatalf("link revived: %v", err)
	}
	if _, err := restarted.RestoreTrash(ctx, f.principal, p.ID, RestoreInput{}); err != nil {
		t.Fatalf("retry restore: %v", err)
	}
}

func TestPurgeKeepsRevokedShareManagementRecord(t *testing.T) {
	f := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	p := trashPhoto(t, f, "old.jpg")
	if _, err := f.service.db.Exec(`INSERT INTO share_links(id,resource_type,resource_id,token_hash,created_at,updated_at)
VALUES('sl_purged','photo',?,'purged-hash','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, p.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Delete(ctx, f.principal, p.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := f.service.PurgeTrash(ctx, f.principal, p.ID, true); err != nil {
		t.Fatal(err)
	}
	var name, owner, revoked string
	if err := f.service.db.QueryRow(`SELECT resource_name,owner_id,revoked_at FROM share_links WHERE id='sl_purged'`).Scan(&name, &owner, &revoked); err != nil {
		t.Fatal(err)
	}
	if name != "old.jpg" || owner != f.principal.UserID || revoked == "" {
		t.Fatalf("retained share = %q %q %q", name, owner, revoked)
	}
}

func TestDiscardKeepsRevokedShareManagementRecord(t *testing.T) {
	f := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	p := trashPhoto(t, f, "broken.jpg")
	if _, err := f.service.db.Exec(`INSERT INTO share_links(id,resource_type,resource_id,token_hash,created_at,updated_at)
VALUES('sl_discard','photo',?,'discard-hash','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, p.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Discard(ctx, f.principal, p.ID, true); err != nil {
		t.Fatal(err)
	}
	var name, owner, revoked string
	if err := f.service.db.QueryRow(`SELECT resource_name,owner_id,revoked_at FROM share_links WHERE id='sl_discard'`).Scan(&name, &owner, &revoked); err != nil {
		t.Fatal(err)
	}
	if name != "broken.jpg" || owner != f.principal.UserID || revoked == "" {
		t.Fatalf("retained discard share = %q %q %q", name, owner, revoked)
	}
}

func TestTrashRecoversFilesystemMovesWhenDatabaseFinalizeFails(t *testing.T) {
	for _, phase := range []string{"moving", "restoring", "purging"} {
		t.Run(phase, func(t *testing.T) {
			f := newUploadFixture(t, 1<<20)
			ctx := context.Background()
			p := trashPhoto(t, f, "fault.jpg")
			if phase != "moving" {
				if err := f.service.Delete(ctx, f.principal, p.ID, true); err != nil {
					t.Fatal(err)
				}
			}
			trigger := `CREATE TRIGGER fail_trash_finalize BEFORE UPDATE OF state ON trash_items WHEN NEW.state='trashed' BEGIN SELECT RAISE(ABORT,'fault'); END`
			if phase != "moving" {
				trigger = `CREATE TRIGGER fail_trash_finalize BEFORE DELETE ON trash_items BEGIN SELECT RAISE(ABORT,'fault'); END`
			}
			if _, err := f.service.db.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			var err error
			switch phase {
			case "moving":
				err = f.service.Delete(ctx, f.principal, p.ID, true)
			case "restoring":
				_, err = f.service.RestoreTrash(ctx, f.principal, p.ID, RestoreInput{})
			case "purging":
				err = f.service.PurgeTrash(ctx, f.principal, p.ID, true)
			}
			if err == nil {
				t.Fatal("injected failure not reached")
			}
			if _, err := f.service.Get(ctx, f.principal, p.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("half finished photo exposed: %v", err)
			}
			if _, err := folders.NewService(f.service.db, f.store).Rename(ctx, f.principal, f.folderID, folders.RenameInput{Name: "unsafe"}); !errors.Is(err, storage.ErrRecoveryRequired) {
				t.Fatalf("pending operation must block path mutations: %v", err)
			}
			if _, err := f.service.db.Exec("DROP TRIGGER fail_trash_finalize"); err != nil {
				t.Fatal(err)
			}
			restarted := NewService(f.service.db, f.store, 1<<20)
			if err := restarted.RecoverTrash(ctx); err != nil {
				t.Fatal(err)
			}
			if phase == "moving" {
				if _, err := restarted.RestoreTrash(ctx, f.principal, p.ID, RestoreInput{}); err != nil {
					t.Fatal(err)
				}
			}
			if phase != "purging" {
				got, err := restarted.Get(ctx, f.principal, p.ID)
				if err != nil {
					t.Fatal(err)
				}
				digest, _, err := f.store.FileDigest(got.StoragePath)
				if err != nil || digest != p.Checksum {
					t.Fatalf("lost file: %s %v", digest, err)
				}
			} else {
				var n int
				_ = f.service.db.QueryRow("SELECT count(*) FROM photos WHERE id=?", p.ID).Scan(&n)
				if n != 0 {
					t.Fatal("purged index remains")
				}
			}
		})
	}
}

func TestTrashRestoreConflictAndScannedCompanion(t *testing.T) {
	f := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	p := trashPhoto(t, f, "pair.jpg")
	companion := filepath.ToSlash(filepath.Join(filepath.Dir(p.StoragePath), "pair.MOV"))
	path, _ := f.store.ResolvePath(companion)
	if err := os.WriteFile(path, quickTimeBytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.service.AttachLiveVideo(ctx, f.principal, p.ID, LiveVideoInput{Filename: "pair.MOV", Body: bytes.NewReader(quickTimeBytes())}); err != nil {
		t.Fatal(err)
	}
	if err := f.service.SetScannedMotionSource(ctx, p.ID, companion); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Delete(ctx, f.principal, p.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("companion left to be rescanned: %v", err)
	}
	replacement := trashPhoto(t, f, "pair.jpg")
	if _, err := f.service.RestoreTrash(ctx, f.principal, p.ID, RestoreInput{}); !errors.Is(err, ErrNameConflict) {
		t.Fatalf("restore must not overwrite: %v", err)
	}
	got, err := f.service.RestoreTrash(ctx, f.principal, p.ID, RestoreInput{Conflict: ConflictRename})
	if err != nil {
		t.Fatal(err)
	}
	if got.Filename != "pair (1).jpg" {
		t.Fatalf("name=%s", got.Filename)
	}
	newCompanion := filepath.ToSlash(filepath.Join(filepath.Dir(got.StoragePath), "pair (1).MOV"))
	if _, _, err := f.store.FileDigest(newCompanion); err != nil {
		t.Fatal(err)
	}
	if got, err := f.service.Get(ctx, f.principal, replacement.ID); err != nil || got.Filename != "pair.jpg" {
		t.Fatalf("replacement changed: %+v %v", got, err)
	}
}

func TestTrashOwnerScopeExpiryAndConcurrentRestore(t *testing.T) {
	f := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	p := trashPhoto(t, f, "scope.jpg")
	if err := f.service.Delete(ctx, f.principal, p.ID, true); err != nil {
		t.Fatal(err)
	}
	other := acl.Principal{UserID: "other", Role: acl.RoleUser}
	page, err := f.service.ListTrash(ctx, other, "", 50, false)
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("private trash leaked: %+v %v", page, err)
	}
	if _, err := f.service.ListTrash(ctx, other, "", 50, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("all scope=%v", err)
	}
	if _, err := f.service.RestoreTrash(ctx, other, p.ID, RestoreInput{}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("restore=%v", err)
	}
	if err := f.service.PurgeTrash(ctx, other, p.ID, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("purge=%v", err)
	}
	if err := f.service.PurgeTrash(ctx, f.principal, p.ID, false); !errors.Is(err, ErrConfirmationRequired) {
		t.Fatalf("confirmation=%v", err)
	}
	if _, err := f.service.db.Exec("UPDATE trash_items SET expires_at=? WHERE photo_id=?", formatTime(time.Now().Add(-time.Hour)), p.ID); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = f.service.ExpireTrash(ctx, time.Now()) }()
	go func() { defer wg.Done(); _, _ = f.service.RestoreTrash(ctx, f.principal, p.ID, RestoreInput{}) }()
	wg.Wait()
	got, err := f.service.Get(ctx, f.principal, p.ID)
	if err == nil {
		digest, _, err := f.store.FileDigest(got.StoragePath)
		if err != nil || digest != p.Checksum {
			t.Fatalf("restored file purged: %v", err)
		}
	} else if !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestTrashRejectsChangedSourceWithoutHidingPhoto(t *testing.T) {
	f := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	p := trashPhoto(t, f, "changed.jpg")
	path, _ := f.store.ResolvePath(p.StoragePath)
	if err := os.WriteFile(path, []byte("external replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Delete(ctx, f.principal, p.ID, true); !errors.Is(err, ErrTrashChanged) {
		t.Fatalf("changed file=%v", err)
	}
	if _, err := f.service.Get(ctx, f.principal, p.ID); err != nil {
		t.Fatalf("failed delete hid original: %v", err)
	}
}
