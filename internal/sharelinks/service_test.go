package sharelinks

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/storage"
)

type shareLinkFixtureData struct {
	db       *sql.DB
	store    storage.Store
	owner    auth.Account
	photoID  string
	folderID string
}

func shareLinkFixture(t *testing.T) shareLinkFixtureData {
	t.Helper()
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	hash, err := auth.HashPassword("owner secure password")
	if err != nil {
		t.Fatal(err)
	}
	owner := auth.Account{ID: "u_owner", Username: "owner", Role: acl.RoleAdmin, IsActive: true}
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES (?, ?, ?, 'admin', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, owner.ID, owner.Username, hash); err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folderID := "f_root"
	if _, err := db.ExecContext(ctx, `INSERT INTO folders (id, owner_id, name, storage_path, created_at, updated_at)
VALUES (?, ?, 'Summer trip', 'users/u_owner/Summer trip', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, folderID, owner.ID); err != nil {
		t.Fatal(err)
	}
	photoID := "p_photo"
	if _, err := db.ExecContext(ctx, `INSERT INTO photos (id, owner_id, folder_id, storage_path, filename, mime_type, size, checksum, captured_at, captured_at_source, indexed_at, source_revision, created_at, updated_at)
VALUES (?, ?, ?, 'users/u_owner/Summer trip/photo.jpg', 'photo.jpg', 'image/jpeg', 1, ?, '2026-01-01T00:00:00Z', 'file_mtime', '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, photoID, owner.ID, folderID, strings.Repeat("a", 64), strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	return shareLinkFixtureData{db: db, store: store, owner: owner, photoID: photoID, folderID: folderID}
}

func TestCreateUsesRequestedDuration(t *testing.T) {
	for _, test := range []struct {
		name     string
		duration Duration
		want     time.Duration
	}{
		{name: "one day", duration: DurationOneDay, want: 24 * time.Hour},
		{name: "seven days", duration: DurationSevenDays, want: 7 * 24 * time.Hour},
		{name: "forever", duration: DurationForever},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := shareLinkFixture(t)
			before := time.Now().UTC()
			link, err := NewService(fixture.db, fixture.store, nil, false).Create(context.Background(), acl.Principal{UserID: fixture.owner.ID, Role: acl.RoleAdmin}, CreateInput{
				ResourceType: ResourcePhoto,
				ResourceID:   fixture.photoID,
				Duration:     test.duration,
			})
			if err != nil {
				t.Fatal(err)
			}
			if test.want == 0 {
				if link.ExpiresAt != nil {
					t.Fatalf("ExpiresAt = %v, want forever", link.ExpiresAt)
				}
				return
			}
			if link.ExpiresAt == nil {
				t.Fatal("ExpiresAt = nil, want an expiry")
			}
			actual := link.ExpiresAt.Sub(before)
			if actual < test.want-time.Second || actual > test.want+time.Second {
				t.Fatalf("ExpiresAt = %v, want about %v after %v", link.ExpiresAt, test.want, before)
			}
		})
	}
}

func TestCreateStoresOnlyDigests(t *testing.T) {
	fixture := shareLinkFixture(t)
	password := "correct horse battery staple"
	link, err := NewService(fixture.db, fixture.store, nil, false).Create(context.Background(), acl.Principal{UserID: fixture.owner.ID, Role: acl.RoleAdmin}, CreateInput{
		ResourceType: ResourcePhoto,
		ResourceID:   fixture.photoID,
		Duration:     DurationSevenDays,
		Password:     password,
	})
	if err != nil {
		t.Fatal(err)
	}
	var tokenHash, passwordHash string
	if err := fixture.db.QueryRow("SELECT token_hash, password_hash FROM share_links WHERE id=?", link.ID).Scan(&tokenHash, &passwordHash); err != nil {
		t.Fatal(err)
	}
	if tokenHash == "" || tokenHash == link.Token || strings.Contains(passwordHash, password) {
		t.Fatalf("stored secrets are unsafe: token_hash=%q password_hash=%q", tokenHash, passwordHash)
	}
	if !link.PasswordProtected || !strings.HasPrefix(link.URL, "/#/share/") {
		t.Fatalf("link = %+v", link)
	}
}

func TestInspectReturnsReadableResourceMetadata(t *testing.T) {
	fixture := shareLinkFixture(t)
	service := NewService(fixture.db, fixture.store, nil, false)
	link, err := service.Create(context.Background(), acl.Principal{UserID: fixture.owner.ID, Role: acl.RoleAdmin}, CreateInput{ResourceType: ResourcePhoto, ResourceID: fixture.photoID, Duration: DurationForever})
	if err != nil {
		t.Fatal(err)
	}
	share, err := service.Inspect(context.Background(), link.Token)
	if err != nil {
		t.Fatal(err)
	}
	if share.Name != "photo.jpg" || share.FolderName != "Summer trip" || share.PasswordRequired {
		t.Fatalf("share metadata = %+v", share)
	}
}
