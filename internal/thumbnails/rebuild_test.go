package thumbnails

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/zxxx98/77Photo/internal/acl"
	_ "modernc.org/sqlite"
)

func TestRebuildRegeneratesExistingVariants(t *testing.T) {
	store, loader, photo := newThumbnailFixture(t, "p_rebuild", "rev-1")
	thumbnailService, err := NewService(loader, store, filepath.Join(t.TempDir(), "cache"), 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	thumbnailService.Start(ctx)
	defer thumbnailService.Close()

	if _, _, err := thumbnailService.Ensure(ctx, photo.ID, 256); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		_, err := os.Stat(thumbnailService.CachePath(photo.ID, photo.SourceRevision, 1280))
		return err == nil
	})
	for _, size := range []int{256, 512, 1280} {
		if err := os.WriteFile(thumbnailService.CachePath(photo.ID, photo.SourceRevision, size), []byte("stale"), 0o640); err != nil {
			t.Fatal(err)
		}
	}

	db := newRebuildTestDB(t)
	if _, err := db.Exec(`INSERT INTO photos (id, mime_type, scan_status, deleted_at) VALUES (?, ?, 'indexed', NULL)`, photo.ID, photo.MIMEType); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO photos (id, mime_type, scan_status, deleted_at) VALUES ('p_unsupported', 'image/gif', 'indexed', NULL)`); err != nil {
		t.Fatal(err)
	}

	rebuild := NewRebuildServiceWithContext(ctx, db, thumbnailService)
	started, err := rebuild.Start(ctx, acl.Principal{UserID: "u_admin", Role: acl.RoleAdmin})
	if err != nil {
		t.Fatal(err)
	}
	rebuild.Wait()
	job, err := rebuild.Get(ctx, acl.Principal{UserID: "u_admin", Role: acl.RoleAdmin}, started.ID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != RebuildCompleted {
		t.Fatalf("status = %q, want %q (error=%v)", job.Status, RebuildCompleted, job.Error)
	}
	if job.Counts.Total != 1 || job.Counts.Processed != 1 || job.Counts.Regenerated != 1 || job.Counts.Failed != 0 {
		t.Fatalf("counts = %+v, want total=1 processed=1 regenerated=1 failed=0", job.Counts)
	}
	for _, size := range []int{256, 512, 1280} {
		data, err := os.ReadFile(thumbnailService.CachePath(photo.ID, photo.SourceRevision, size))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Equal(data, []byte("stale")) || !bytes.HasPrefix(data, []byte("RIFF")) {
			t.Fatalf("variant %d was not regenerated as WebP", size)
		}
	}
}

func TestIncrementalRebuildOnlyRepairsMissingVariants(t *testing.T) {
	store, loader, photo := newThumbnailFixture(t, "p_incremental", "rev-1")
	thumbnailService, err := NewService(loader, store, filepath.Join(t.TempDir(), "cache"), 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	thumbnailService.Start(ctx)
	defer thumbnailService.Close()

	if _, _, err := thumbnailService.Ensure(ctx, photo.ID, 256); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		_, err := os.Stat(thumbnailService.CachePath(photo.ID, photo.SourceRevision, 1280))
		return err == nil
	})

	path256 := thumbnailService.CachePath(photo.ID, photo.SourceRevision, 256)
	path512 := thumbnailService.CachePath(photo.ID, photo.SourceRevision, 512)
	path1280 := thumbnailService.CachePath(photo.ID, photo.SourceRevision, 1280)
	before256, err := os.ReadFile(path256)
	if err != nil {
		t.Fatal(err)
	}
	before1280, err := os.ReadFile(path1280)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path512); err != nil {
		t.Fatal(err)
	}

	db := newRebuildTestDB(t)
	if _, err := db.Exec(`INSERT INTO photos (id, mime_type, scan_status, deleted_at) VALUES (?, ?, 'indexed', NULL)`, photo.ID, photo.MIMEType); err != nil {
		t.Fatal(err)
	}

	rebuild := NewRebuildServiceWithContext(ctx, db, thumbnailService)
	started, err := rebuild.StartWithMode(ctx, acl.Principal{UserID: "u_admin", Role: acl.RoleAdmin}, RebuildModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	if started.Mode != RebuildModeIncremental {
		t.Fatalf("mode = %q, want %q", started.Mode, RebuildModeIncremental)
	}
	rebuild.Wait()
	job, err := rebuild.Get(ctx, acl.Principal{UserID: "u_admin", Role: acl.RoleAdmin}, started.ID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != RebuildCompleted {
		t.Fatalf("status = %q, want %q (error=%v)", job.Status, RebuildCompleted, job.Error)
	}
	if job.Counts.Total != 1 || job.Counts.Processed != 1 || job.Counts.Regenerated != 1 || job.Counts.Failed != 0 {
		t.Fatalf("counts = %+v, want total=1 processed=1 regenerated=1 failed=0", job.Counts)
	}

	after256, err := os.ReadFile(path256)
	if err != nil {
		t.Fatal(err)
	}
	after1280, err := os.ReadFile(path1280)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before256, after256) || !bytes.Equal(before1280, after1280) {
		t.Fatal("incremental rebuild replaced an existing thumbnail variant")
	}
	data512, err := os.ReadFile(path512)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data512, []byte("RIFF")) {
		t.Fatal("missing 512 variant was not regenerated as WebP")
	}

	second, err := rebuild.StartWithMode(ctx, acl.Principal{UserID: "u_admin", Role: acl.RoleAdmin}, RebuildModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	rebuild.Wait()
	secondJob, err := rebuild.Get(ctx, acl.Principal{UserID: "u_admin", Role: acl.RoleAdmin}, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if secondJob.Counts.Total != 0 || secondJob.Counts.Processed != 0 {
		t.Fatalf("second incremental counts = %+v, want no candidates", secondJob.Counts)
	}
}

func TestRebuildIncludesSupportedVideoMedia(t *testing.T) {
	db := newRebuildTestDB(t)
	for _, item := range []struct {
		id       string
		mimeType string
	}{
		{id: "p_mp4", mimeType: "video/mp4"},
		{id: "p_webm", mimeType: "video/webm"},
		{id: "p_quicktime", mimeType: "video/quicktime"},
		{id: "p_gif", mimeType: "image/gif"},
	} {
		if _, err := db.Exec(`INSERT INTO photos (id, mime_type, scan_status, deleted_at) VALUES (?, ?, 'indexed', NULL)`, item.id, item.mimeType); err != nil {
			t.Fatal(err)
		}
	}

	service := NewRebuildServiceWithContext(context.Background(), db, nil)
	ids, err := service.loadCandidateIDs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"p_mp4", "p_quicktime", "p_webm"}
	if len(ids) != len(want) {
		t.Fatalf("candidate ids = %#v, want %#v", ids, want)
	}
	for index := range want {
		if ids[index] != want[index] {
			t.Fatalf("candidate ids = %#v, want %#v", ids, want)
		}
	}
}

func TestRebuildRequiresAdministrator(t *testing.T) {
	db := newRebuildTestDB(t)
	service := NewRebuildServiceWithContext(context.Background(), db, nil)
	if _, err := service.Start(context.Background(), acl.Principal{UserID: "u_user", Role: acl.RoleUser}); err != ErrRebuildForbidden {
		t.Fatalf("Start() error = %v, want %v", err, ErrRebuildForbidden)
	}
	if _, err := service.Get(context.Background(), acl.Principal{UserID: "u_user", Role: acl.RoleUser}, "missing"); err != ErrRebuildForbidden {
		t.Fatalf("Get() error = %v, want %v", err, ErrRebuildForbidden)
	}
}

func newRebuildTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "rebuild.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE photos (
		id TEXT PRIMARY KEY,
		mime_type TEXT NOT NULL,
		scan_status TEXT NOT NULL,
		deleted_at TEXT
	)`); err != nil {
		t.Fatal(err)
	}
	return db
}
