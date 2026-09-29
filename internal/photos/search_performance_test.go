package photos

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/shares"
)

// Run explicitly with PHOTO_SEARCH_PERF=1 go test ./internal/photos -run TestSearchPerformance -v.
// This seeds a deterministic 100k-row database; keeping it opt-in avoids slowing normal tests.
func TestSearchPerformance(t *testing.T) {
	if os.Getenv("PHOTO_SEARCH_PERF") != "1" {
		t.Skip("set PHOTO_SEARCH_PERF=1 to seed the performance fixture")
	}
	ctx := context.Background()
	fixture := newUploadFixture(t, 1<<20)
	db := fixture.service.db
	authorizer := acl.NewAuthorizer(db)
	fixture.service.SetAuthorizer(authorizer)
	folderService := folders.NewService(db, fixture.store)
	folderService.SetAuthorizer(authorizer)
	privateFolder, err := folderService.Create(ctx, fixture.principal, folders.CreateInput{Name: "private-perf"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at) VALUES ('perf-member', 'perf-member', 'hash', 'user', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := shares.NewService(db).Create(ctx, fixture.principal, shares.CreateInput{FolderID: fixture.folderID, UserID: "perf-member", Permission: acl.PermissionRead}); err != nil {
		t.Fatal(err)
	}
	admin := fixture.principal
	member := acl.Principal{UserID: "perf-member", Role: acl.RoleUser}
	from, _ := time.Parse(time.RFC3339, "2026-09-01T00:00:00Z")
	to, _ := time.Parse(time.RFC3339, "2026-10-01T00:00:00Z")
	filters := []struct {
		name   string
		filter ListFilter
	}{
		{"all", ListFilter{Limit: 50}},
		{"date", ListFilter{From: &from, To: &to, Limit: 50}},
		{"folder", ListFilter{FolderID: &fixture.folderID, Limit: 50}},
		{"media", ListFilter{MediaType: "video", Limit: 50}},
		{"combined", ListFilter{FolderID: &fixture.folderID, From: &from, To: &to, MediaType: "photo", Query: "family-trip", Limit: 50}},
	}
	for _, size := range []int{10000, 100000} {
		seedSearchRows(t, ctx, fixture, privateFolder.ID, size)
		for _, user := range []struct {
			name      string
			principal acl.Principal
		}{{"admin", admin}, {"member", member}} {
			for _, scenario := range filters {
				page, err := fixture.service.List(ctx, user.principal, scenario.filter)
				if err != nil {
					t.Fatalf("%d %s %s: %v", size, user.name, scenario.name, err)
				}
				runtime.GC()
				var before, after runtime.MemStats
				runtime.ReadMemStats(&before)
				start := time.Now()
				page, err = fixture.service.List(ctx, user.principal, scenario.filter)
				elapsed := time.Since(start)
				runtime.ReadMemStats(&after)
				if err != nil {
					t.Fatal(err)
				}
				plan := searchQueryPlan(t, ctx, fixture.service, user.principal, scenario.filter)
				t.Logf("rows=%d user=%s filter=%s items=%d next=%t duration=%s alloc_bytes=%d plan=%s", size, user.name, scenario.name, len(page.Items), page.NextCursor != nil, elapsed, after.TotalAlloc-before.TotalAlloc, strings.Join(plan, " | "))
			}
		}
	}
}

func seedSearchRows(t *testing.T, ctx context.Context, fixture uploadFixture, privateFolderID string, target int) {
	t.Helper()
	var existing int
	if err := fixture.service.db.QueryRowContext(ctx, "SELECT count(*) FROM photos").Scan(&existing); err != nil {
		t.Fatal(err)
	}
	tx, err := fixture.service.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO photos (id, owner_id, folder_id, storage_path, filename, mime_type, size, checksum, captured_at, captured_at_source, file_created_at, indexed_at, source_revision, scan_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 100, ?, ?, 'file_mtime', ?, ?, 'seed', 'indexed', ?, ?)`)
	if err != nil {
		t.Fatal(err)
	}
	defer stmt.Close()
	for i := existing; i < target; i++ {
		id := fmt.Sprintf("perf-%06d", i)
		folderID := privateFolderID
		if i%2 == 0 {
			folderID = fixture.folderID
		}
		name := fmt.Sprintf("photo-%06d.jpg", i)
		if i%23 == 0 {
			name = fmt.Sprintf("family-trip-%06d.jpg", i)
		}
		mime := "image/jpeg"
		if i%5 == 0 {
			mime = "video/mp4"
		}
		captured := time.Date(2025, 10, 1, 12, 0, 0, 0, time.UTC).AddDate(0, 0, i%365).Format(time.RFC3339)
		if _, err := stmt.ExecContext(ctx, id, fixture.principal.UserID, folderID, id, name, mime, strings.Repeat("a", 64), captured, captured, captured, captured, captured); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}
	if err := stmt.Close(); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func searchQueryPlan(t *testing.T, ctx context.Context, service *Service, principal acl.Principal, filter ListFilter) []string {
	t.Helper()
	query := "EXPLAIN QUERY PLAN SELECT p.id FROM photos p INDEXED BY photos_active_timeline_idx"
	args := []any{}
	where := []string{"p.deleted_at IS NULL", "p.scan_status='indexed'"}
	if filter.FolderID != nil {
		query += ` JOIN (WITH RECURSIVE descendants(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id) SELECT id FROM descendants) d ON d.id=p.folder_id`
		args = append(args, *filter.FolderID)
	}
	appendVisibilityPredicate(&where, &args, principal, service.authorizer != nil)
	fromValue, toValue := "", ""
	if filter.From != nil {
		fromValue = filter.From.UTC().Format(time.RFC3339Nano)
	}
	if filter.To != nil {
		toValue = filter.To.UTC().Format(time.RFC3339Nano)
	}
	appendCapturedRange(&where, &args, fromValue, toValue)
	appendSearchPredicate(&where, &args, filter.Query, filter.MediaType)
	query += " WHERE " + strings.Join(where, " AND ") + " ORDER BY p.captured_at DESC, p.id DESC LIMIT 51"
	rows, err := service.db.QueryContext(ctx, query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	plan := []string{}
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return plan
}
