package photos

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/shares"
	"github.com/zxxx98/77Photo/internal/storage"
)

// mapFixture has an administrator who owns a private and a shared folder, a
// member who can read the shared folder, and a stranger with no access.
type mapFixture struct {
	db            *sql.DB
	auth          *auth.Service
	service       *Service
	admin         acl.Principal
	member        acl.Principal
	stranger      acl.Principal
	adminToken    string
	memberToken   string
	privateFolder string
	sharedFolder  string
	uploads       int
}

func newMapFixture(t *testing.T) *mapFixture {
	t.Helper()
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.NewService(db, time.Hour, false)
	owner, adminSession, err := authService.SetupAdmin(ctx, "owner", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"member", "stranger"} {
		hash, err := auth.HashPassword(name + " secure password")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES (?, ?, ?, 'user', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, name, name, hash); err != nil {
			t.Fatal(err)
		}
	}
	_, memberSession, err := authService.Authenticate(ctx, "member", "member secure password")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	admin := acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}
	authorizer := acl.NewAuthorizer(db)
	folderService := folders.NewService(db, store)
	folderService.SetAuthorizer(authorizer)
	privateFolder, err := folderService.Create(ctx, admin, folders.CreateInput{Name: "private"})
	if err != nil {
		t.Fatal(err)
	}
	sharedFolder, err := folderService.Create(ctx, admin, folders.CreateInput{Name: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := shares.NewService(db).Create(ctx, admin, shares.CreateInput{FolderID: sharedFolder.ID, UserID: "member", Permission: acl.PermissionRead}); err != nil {
		t.Fatal(err)
	}
	service := NewService(db, store, 1<<20)
	service.SetAuthorizer(authorizer)
	return &mapFixture{
		db: db, auth: authService, service: service,
		admin:         admin,
		member:        acl.Principal{UserID: "member", Role: acl.RoleUser},
		stranger:      acl.Principal{UserID: "stranger", Role: acl.RoleUser},
		adminToken:    adminSession.Token,
		memberToken:   memberSession.Token,
		privateFolder: privateFolder.ID,
		sharedFolder:  sharedFolder.ID,
	}
}

// add uploads a distinct JPEG and then sets its position and capture time
// directly, which keeps the tests independent of EXIF fixtures.
func (f *mapFixture) add(t *testing.T, folderID, name string, latitude, longitude *float64, captured string) Photo {
	t.Helper()
	f.uploads++
	photo, err := f.service.Upload(context.Background(), f.admin, UploadInput{FolderID: folderID, Filename: name, DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2+f.uploads, 2))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE photos SET gps_latitude=?, gps_longitude=?, captured_at=? WHERE id=?", latitude, longitude, captured, photo.ID); err != nil {
		t.Fatal(err)
	}
	return photo
}

func (f *mapFixture) set(t *testing.T, id, assignment string) {
	t.Helper()
	if _, err := f.db.Exec("UPDATE photos SET "+assignment+" WHERE id=?", id); err != nil {
		t.Fatal(err)
	}
}

func coordinate(value float64) *float64 { return &value }

func ids(items []Photo) []string {
	result := make([]string, len(items))
	for i, item := range items {
		result[i] = item.ID
	}
	return result
}

func assertIDs(t *testing.T, label string, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s = %v, want %v", label, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s = %v, want %v", label, got, want)
		}
	}
}

func TestParseBBox(t *testing.T) {
	valid := map[string]BBox{
		"120,30,122,32":          {West: 120, South: 30, East: 122, North: 32},
		" -10 , -5 , 10 , 5 ":    {West: -10, South: -5, East: 10, North: 5},
		"170,-20,-170,-10":       {West: 170, South: -20, East: -170, North: -10},
		"-180,-90,180,90":        {West: -180, South: -90, East: 180, North: 90},
		"121.5,31.2,121.5,31.25": {West: 121.5, South: 31.2, East: 121.5, North: 31.25},
	}
	for value, want := range valid {
		got, err := ParseBBox(value)
		if err != nil || got != want {
			t.Fatalf("ParseBBox(%q) = %+v, %v; want %+v", value, got, err, want)
		}
	}
	for _, value := range []string{"", "1,2,3", "1,2,3,4,5", "a,b,c,d", "0,10,1,5", "0,-91,1,0", "0,0,1,91", "-181,0,0,1", "0,0,181,1", "NaN,0,1,1", "0,0,Inf,1"} {
		if box, err := ParseBBox(value); !errors.Is(err, ErrInvalidFilter) {
			t.Fatalf("ParseBBox(%q) = %+v, %v; want ErrInvalidFilter", value, box, err)
		}
	}
}

func TestListFiltersByBBox(t *testing.T) {
	f := newMapFixture(t)
	ctx := context.Background()
	shanghai := f.add(t, f.privateFolder, "shanghai.jpg", coordinate(31.2304), coordinate(121.4737), "2024-05-01T00:00:00Z")
	beijing := f.add(t, f.privateFolder, "beijing.jpg", coordinate(39.9042), coordinate(116.4074), "2025-05-01T00:00:00Z")
	fijiEast := f.add(t, f.privateFolder, "fiji-east.jpg", coordinate(-17.7134), coordinate(178.065), "2023-05-01T00:00:00Z")
	fijiWest := f.add(t, f.privateFolder, "fiji-west.jpg", coordinate(-16.5), coordinate(-179.9), "2022-05-01T00:00:00Z")
	f.add(t, f.privateFolder, "unlocated.jpg", nil, nil, "2026-05-01T00:00:00Z")

	list := func(filter ListFilter) []string {
		t.Helper()
		page, err := f.service.List(ctx, f.admin, filter)
		if err != nil {
			t.Fatal(err)
		}
		return ids(page.Items)
	}
	assertIDs(t, "shanghai box", list(ListFilter{BBox: &BBox{West: 120, South: 30, East: 122, North: 32}}), shanghai.ID)
	assertIDs(t, "antimeridian box", list(ListFilter{BBox: &BBox{West: 170, South: -20, East: -170, North: -10}}), fijiEast.ID, fijiWest.ID)
	assertIDs(t, "world box", list(ListFilter{BBox: &BBox{West: -180, South: -90, East: 180, North: 90}}), beijing.ID, shanghai.ID, fijiEast.ID, fijiWest.ID)
	from := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	assertIDs(t, "china box in 2025", list(ListFilter{BBox: &BBox{West: 100, South: 20, East: 130, North: 45}, From: &from, To: &to}), beijing.ID)
	if _, err := f.service.List(ctx, f.admin, ListFilter{BBox: &BBox{West: 0, South: 10, East: 1, North: 5}}); !errors.Is(err, ErrInvalidFilter) {
		t.Fatalf("List(inverted box) error = %v, want ErrInvalidFilter", err)
	}
}

func TestListBBoxPaginatesAndBindsCursor(t *testing.T) {
	f := newMapFixture(t)
	ctx := context.Background()
	newest := f.add(t, f.privateFolder, "newest.jpg", coordinate(31.23), coordinate(121.47), "2026-03-01T00:00:00Z")
	older := f.add(t, f.privateFolder, "older.jpg", coordinate(31.24), coordinate(121.48), "2026-02-01T00:00:00Z")
	oldest := f.add(t, f.privateFolder, "oldest.jpg", coordinate(31.25), coordinate(121.49), "2026-01-01T00:00:00Z")
	f.add(t, f.privateFolder, "elsewhere.jpg", coordinate(39.9), coordinate(116.4), "2025-01-01T00:00:00Z")
	box := &BBox{West: 121, South: 31, East: 122, North: 32}

	first, err := f.service.List(ctx, f.admin, ListFilter{BBox: box, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	assertIDs(t, "first page", ids(first.Items), newest.ID, older.ID)
	if first.NextCursor == nil {
		t.Fatal("first page cursor = nil, want cursor")
	}
	second, err := f.service.List(ctx, f.admin, ListFilter{BBox: box, Limit: 2, Cursor: *first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	// The next-page probe must apply the box too, or the older photo outside
	// it would produce a cursor for an empty page.
	assertIDs(t, "second page", ids(second.Items), oldest.ID)
	if second.NextCursor != nil {
		t.Fatalf("second page cursor = %v, want none", *second.NextCursor)
	}
	for _, other := range []*BBox{nil, {West: 120, South: 31, East: 122, North: 32}} {
		if _, err := f.service.List(ctx, f.admin, ListFilter{BBox: other, Limit: 2, Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalidCursor) {
			t.Fatalf("List(cursor with box %v) error = %v, want ErrInvalidCursor", other, err)
		}
	}
}

func TestListBBoxEndsWithoutCursorWhenOnlyOutsidePhotosRemain(t *testing.T) {
	f := newMapFixture(t)
	ctx := context.Background()
	first := f.add(t, f.privateFolder, "inside-1.jpg", coordinate(31.23), coordinate(121.47), "2026-03-01T00:00:00Z")
	second := f.add(t, f.privateFolder, "inside-2.jpg", coordinate(31.24), coordinate(121.48), "2026-02-01T00:00:00Z")
	f.add(t, f.privateFolder, "outside.jpg", coordinate(39.9), coordinate(116.4), "2026-01-01T00:00:00Z")

	page, err := f.service.List(ctx, f.admin, ListFilter{BBox: &BBox{West: 121, South: 31, East: 122, North: 32}, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	assertIDs(t, "page", ids(page.Items), first.ID, second.ID)
	if page.NextCursor != nil {
		t.Fatal("cursor emitted although no located photo remains in the box")
	}
}

func TestMapPointsFollowTimelineVisibility(t *testing.T) {
	f := newMapFixture(t)
	ctx := context.Background()
	home := f.add(t, f.privateFolder, "home.jpg", coordinate(31.2304), coordinate(121.4737), "2026-05-01T00:00:00Z")
	f.add(t, f.privateFolder, "no-gps.jpg", nil, nil, "2026-04-01T00:00:00Z")
	deleted := f.add(t, f.privateFolder, "deleted.jpg", coordinate(31.1), coordinate(121.1), "2026-03-01T00:00:00Z")
	missing := f.add(t, f.privateFolder, "missing.jpg", coordinate(31.2), coordinate(121.2), "2026-03-02T00:00:00Z")
	trip := f.add(t, f.sharedFolder, "trip.jpg", coordinate(-33.8568), coordinate(151.2153), "2026-06-01T00:00:00Z")
	paired := f.add(t, f.sharedFolder, "paired.jpg", coordinate(-33.8), coordinate(151.2), "2026-06-02T00:00:00Z")
	f.set(t, deleted.ID, "deleted_at='2026-09-01T00:00:00Z'")
	f.set(t, missing.ID, "scan_status='missing'")
	f.set(t, paired.ID, "scan_status='paired'")

	checks := []struct {
		name      string
		principal acl.Principal
		wantIDs   []string
		wantTotal int
	}{
		{"administrator sees the whole family", f.admin, []string{trip.ID, home.ID}, 3},
		{"member sees shared folders", f.member, []string{trip.ID}, 1},
		{"stranger sees nothing", f.stranger, nil, 0},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			points, err := f.service.MapPoints(ctx, check.principal)
			if err != nil {
				t.Fatal(err)
			}
			got := make([]string, len(points.Items))
			for i, point := range points.Items {
				got[i] = point.ID
			}
			assertIDs(t, "points", got, check.wantIDs...)
			if points.TotalPhotos != check.wantTotal {
				t.Fatalf("total photos = %d, want %d", points.TotalPhotos, check.wantTotal)
			}
		})
	}
	points, err := f.service.MapPoints(ctx, f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if first := points.Items[0]; first.Latitude != -33.8568 || first.Longitude != 151.2153 || first.CapturedAt != "2026-06-01T00:00:00Z" {
		t.Fatalf("first point = %+v, want trip position and capture time", first)
	}
}

func TestMapPointsMarshalJSONIsCompact(t *testing.T) {
	encoded, err := MapPoints{Items: []MapPoint{
		{ID: "p_1", Latitude: 31.23041649, Longitude: -122.0840001, CapturedAt: "2026-09-01T08:30:00Z"},
		{ID: `odd"id`, Latitude: -0.5, Longitude: 179.9999996, CapturedAt: "2026-08-01T00:00:00.5Z"},
	}, TotalPhotos: 5}.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	want := `{"items":[["p_1",31.230416,-122.084,"2026-09-01T08:30:00Z"],["odd\"id",-0.5,180,"2026-08-01T00:00:00.5Z"]],"total_photos":5}`
	if string(encoded) != want {
		t.Fatalf("encoded = %s\nwant      %s", encoded, want)
	}
	empty, err := MapPoints{}.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(empty) != `{"items":[],"total_photos":0}` || !json.Valid(empty) {
		t.Fatalf("empty = %s", empty)
	}
}
