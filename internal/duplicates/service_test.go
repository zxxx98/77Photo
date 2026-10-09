package duplicates

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/maintenance"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

type fixture struct {
	s     *Service
	db    *sql.DB
	store storage.Store
	p     *photos.Service
	raw   []byte
	lock  *maintenance.Lock
	calls atomic.Int32
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	db, e := database.Open(ctx, filepath.Join(t.TempDir(), "db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	store, e := storage.New(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	p := photos.NewService(db, store, 1<<20)
	lock := &maintenance.Lock{}
	p.SetMaintenanceLock(lock)
	f := &fixture{db: db, store: store, p: p, lock: lock, raw: testJPEG(0, 92)}
	for _, owner := range []string{"a", "b"} {
		_, e = db.Exec("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES(?,?,'hash','user','now','now')", owner, owner)
		if e != nil {
			t.Fatal(e)
		}
		for n := 0; n < 2; n++ {
			id := fmt.Sprintf("%s%d", owner, n)
			_, e = db.Exec("INSERT INTO folders(id,owner_id,storage_path,name,created_at,updated_at) VALUES(?,?,?,?,'now','now')", id, owner, "users/"+owner+"/"+id, id)
			if e != nil {
				t.Fatal(e)
			}
		}
	}
	s, e := NewService(ctx, db, p, func(context.Context, string) ([]byte, error) { f.calls.Add(1); return f.raw, nil }, nil, false, lock)
	if e != nil {
		t.Fatal(e)
	}
	f.s = s
	t.Cleanup(s.Close)
	return f
}
func (f *fixture) add(t *testing.T, id, owner, folder string, raw []byte) {
	t.Helper()
	path := "users/" + owner + "/" + folder + "/" + id + ".jpg"
	abs, e := f.store.ResolvePath(path)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.MkdirAll(filepath.Dir(abs), 0750); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(abs, raw, 0600); e != nil {
		t.Fatal(e)
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(raw))
	_, e = f.db.Exec(`INSERT INTO photos(id,owner_id,folder_id,storage_path,filename,mime_type,size,width,height,checksum,captured_at,captured_at_source,file_created_at,indexed_at,source_revision,created_at,updated_at)
 VALUES(?,?,?,?,?,'image/jpeg',?,256,256,?,'2026-10-01T10:00:00Z','exif','2026-10-01T10:00:00Z','2026-10-01T10:00:00Z',?,'2026-10-01T10:00:00Z','2026-10-01T10:00:00Z')`, id, owner, folder, path, id+".jpg", len(raw), sum, sum)
	if e != nil {
		t.Fatal(e)
	}
}
func (f *fixture) motion(t *testing.T, id string, raw []byte) {
	t.Helper()
	path, e := f.store.ResolvePath(".77photo/live/" + id + ".motion")
	if e != nil {
		t.Fatal(e)
	}
	if e = os.MkdirAll(filepath.Dir(path), 0750); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	_, e = f.db.Exec("INSERT INTO photo_motion_sources(photo_id,kind,source_path,photo_checksum) SELECT id,'uploaded','',checksum FROM photos WHERE id=?", id)
	if e != nil {
		t.Fatal(e)
	}
}
func exactInput(g Group, keep string, ids ...string) CleanupInput {
	return CleanupInput{GroupID: g.ID, Version: g.Version, Kind: g.Kind, Keep: keep, Remove: ids, Confirm: true}
}

var admin = acl.Principal{Role: acl.RoleAdmin, UserID: "admin"}

func testJPEG(seed, quality int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, 256, 256))
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			v := uint8((x*x + 3*y + seed*17) % 256)
			img.Set(x, y, color.RGBA{v, uint8((x + y*2) % 256), uint8(x ^ y), 255})
		}
	}
	var b bytes.Buffer
	_ = jpeg.Encode(&b, img, &jpeg.Options{Quality: quality})
	return b.Bytes()
}

func TestExactGroupsSeparateOwnersAndCompleteMotion(t *testing.T) {
	f := newFixture(t)
	for _, p := range []struct{ id, owner, folder string }{{"p1", "a", "a0"}, {"p2", "a", "a1"}, {"p3", "a", "a0"}, {"p4", "a", "a1"}, {"p5", "a", "a0"}, {"other", "b", "b0"}} {
		f.add(t, p.id, p.owner, p.folder, f.raw)
	}
	f.motion(t, "p3", []byte("same motion"))
	f.motion(t, "p4", []byte("same motion"))
	f.motion(t, "p5", []byte("another motion"))
	if _, e := f.s.item(context.Background(), "p1"); e != nil {
		t.Fatal("item:", e)
	}
	page, e := f.s.Groups(context.Background(), "exact", "")
	if e != nil {
		t.Fatal(e)
	}
	if len(page.Items) != 2 {
		t.Fatalf("groups=%+v", page)
	}
	for _, g := range page.Items {
		if g.Owner != "a" || len(g.Items) != 2 {
			t.Fatalf("wrong group %+v", g)
		}
		for _, it := range g.Items {
			if it.ID == "p5" || it.ID == "other" {
				t.Fatal("distinct motion or owner grouped")
			}
		}
	}
}
func TestCleanupRetryAndRestore(t *testing.T) {
	f := newFixture(t)
	f.add(t, "p1", "a", "a0", f.raw)
	f.add(t, "p2", "a", "a1", f.raw)
	f.motion(t, "p1", []byte("motion"))
	f.motion(t, "p2", []byte("motion"))
	page, e := f.s.Groups(context.Background(), "exact", "")
	if e != nil {
		t.Fatal(e)
	}
	in := exactInput(page.Items[0], "p1", "p2")
	for n := 0; n < 2; n++ {
		result, e := f.s.Cleanup(context.Background(), admin, in)
		if e != nil || len(result.DeletedIDs) != 1 || len(result.Failed) != 0 {
			t.Fatalf("attempt %d=%+v %v", n, result, e)
		}
	}
	if _, e = f.p.Get(context.Background(), admin, "p1"); e != nil {
		t.Fatal("keeper lost", e)
	}
	if _, e = f.p.Get(context.Background(), admin, "p2"); !errors.Is(e, photos.ErrNotFound) {
		t.Fatalf("copy visible %v", e)
	}
	if _, e = f.p.RestoreTrash(context.Background(), admin, "p2", photos.RestoreInput{}); e != nil {
		t.Fatal(e)
	}
	page, e = f.s.Groups(context.Background(), "exact", "")
	if e != nil || len(page.Items) != 1 {
		t.Fatalf("restore groups=%+v %v", page, e)
	}
	it, e := f.s.item(context.Background(), "p2")
	if e != nil || !it.Motion {
		t.Fatalf("motion not restored %v", e)
	}
}
func TestCleanupRejectsStaleOrChangedKeeperBeforeDeleting(t *testing.T) {
	for _, change := range []string{"revision", "original", "motion"} {
		t.Run(change, func(t *testing.T) {
			f := newFixture(t)
			f.add(t, "p1", "a", "a0", f.raw)
			f.add(t, "p2", "a", "a1", f.raw)
			page, e := f.s.Groups(context.Background(), "exact", "")
			if e != nil {
				t.Fatal(e)
			}
			in := exactInput(page.Items[0], "p1", "p2")
			switch change {
			case "revision":
				_, e = f.db.Exec("UPDATE photos SET source_revision='changed' WHERE id='p1'")
			case "original":
				p, _ := f.p.Get(context.Background(), admin, "p1")
				path, _ := f.store.ResolvePath(p.StoragePath)
				e = os.WriteFile(path, []byte("modified on disk"), 0600)
			case "motion":
				f.motion(t, "p1", []byte("added motion"))
			}
			if e != nil {
				t.Fatal(e)
			}
			if _, e = f.s.Cleanup(context.Background(), admin, in); e == nil {
				t.Fatal("stale keeper accepted")
			}
			if _, e = f.p.Get(context.Background(), admin, "p2"); e != nil {
				t.Fatal("copy removed before validation", e)
			}
		})
	}
}
func TestOpposingConcurrentCleanupAlwaysKeepsOne(t *testing.T) {
	f := newFixture(t)
	f.add(t, "p1", "a", "a0", f.raw)
	f.add(t, "p2", "a", "a1", f.raw)
	page, e := f.s.Groups(context.Background(), "exact", "")
	if e != nil {
		t.Fatal(e)
	}
	g := page.Items[0]
	var wg sync.WaitGroup
	wg.Add(2)
	for _, in := range []CleanupInput{exactInput(g, "p1", "p2"), exactInput(g, "p2", "p1")} {
		go func(in CleanupInput) { defer wg.Done(); _, _ = f.s.Cleanup(context.Background(), admin, in) }(in)
	}
	wg.Wait()
	var active int
	_ = f.db.QueryRow("SELECT count(*) FROM photos WHERE deleted_at IS NULL").Scan(&active)
	if active != 1 {
		t.Fatalf("remaining=%d", active)
	}
}
func TestCleanupRequiresReviewAndOwnerIsolation(t *testing.T) {
	f := newFixture(t)
	f.add(t, "p1", "a", "a0", f.raw)
	f.add(t, "p2", "a", "a1", f.raw)
	f.add(t, "p3", "b", "b0", f.raw)
	page, _ := f.s.Groups(context.Background(), "exact", "")
	g := page.Items[0]
	for _, in := range []CleanupInput{exactInput(g, "p1", "p1"), exactInput(g, "p1", "p3"), exactInput(g, "p1", "p2", "p2"), {GroupID: g.ID, Version: g.Version, Kind: g.Kind, Keep: "p1", Remove: []string{"p2"}, Confirm: false}} {
		if _, e := f.s.Cleanup(context.Background(), admin, in); e == nil {
			t.Fatal("invalid cleanup accepted")
		}
	}
	if _, e := f.s.Cleanup(context.Background(), acl.Principal{Role: acl.RoleUser, UserID: "a"}, exactInput(g, "p1", "p2")); !errors.Is(e, photos.ErrForbidden) {
		t.Fatalf("user cleanup %v", e)
	}
}
func waitJob(t *testing.T, s *Service, id string) Job {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		j, e := s.Job(context.Background(), id)
		if e != nil {
			t.Fatal(e)
		}
		if j.Status != "running" {
			s.wg.Wait()
			return j
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job timeout")
	return Job{}
}
func TestPerceptualScanIsIncrementalAndSurvivesPause(t *testing.T) {
	f := newFixture(t)
	f.add(t, "p1", "a", "a0", f.raw)
	f.add(t, "p2", "a", "a1", testJPEG(0, 75))
	f.add(t, "other", "b", "b0", testJPEG(0, 60))
	j, e := f.s.Start(context.Background(), "perceptual")
	if e != nil {
		t.Fatal(e)
	}
	j = waitJob(t, f.s, j.ID)
	if j.Status != "completed" || j.Processed != 3 || j.Failed != 0 {
		t.Fatalf("job=%+v", j)
	}
	page, e := f.s.Groups(context.Background(), "perceptual", "")
	if e != nil || len(page.Items) != 1 {
		t.Fatalf("pairs=%+v %v", page, e)
	}
	calls := f.calls.Load()
	j, e = f.s.Start(context.Background(), "perceptual")
	if e != nil {
		t.Fatal(e)
	}
	waitJob(t, f.s, j.ID)
	if f.calls.Load() != calls {
		t.Fatal("unchanged photos reanalyzed")
	}
	f.add(t, "new", "a", "a0", testJPEG(1, 90))
	entered := make(chan struct{})
	f.s.preview = func(ctx context.Context, _ string) ([]byte, error) {
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	j, e = f.s.Start(context.Background(), "perceptual")
	if e != nil {
		t.Fatal(e)
	}
	<-entered
	same, e := f.s.Start(context.Background(), "perceptual")
	if e != nil || same.ID != j.ID {
		t.Fatal("duplicate job created")
	}
	if _, e = f.s.Control(context.Background(), j.ID, "pause"); e != nil {
		t.Fatal(e)
	}
	f.s.wg.Wait()
	f.s.preview = func(context.Context, string) ([]byte, error) { return f.raw, nil }
	if _, e = f.s.Control(context.Background(), j.ID, "resume"); e != nil {
		t.Fatal(e)
	}
	j = waitJob(t, f.s, j.ID)
	if j.Status != "completed" || j.Processed != 4 {
		t.Fatalf("resumed=%+v", j)
	}
}

type fakeWorker struct {
	calls    atomic.Int32
	verified bool
}

var testProfile = Profile{API: "1", Pipeline: "image-test", Model: "whole-image", Dimension: 16, Device: "cuda"}

func (w *fakeWorker) Health(context.Context) (Profile, error) { return testProfile, nil }
func (w *fakeWorker) Analyze(_ context.Context, id string, p Profile, _ []byte) (Analysis, error) {
	w.calls.Add(1)
	v := make([]float32, 16)
	v[0] = 1
	return Analysis{Profile: p, RequestID: id, Vector: v, Local: json.RawMessage(`{"points":"","descriptors":""}`)}, nil
}
func (w *fakeWorker) Verify(context.Context, Profile, string, string) (bool, error) {
	return w.verified, nil
}
func TestAIMatchingRequiresVisualEvidenceOrRealCaptureTime(t *testing.T) {
	f := newFixture(t)
	f.add(t, "p1", "a", "a0", f.raw)
	f.add(t, "p2", "a", "a1", testJPEG(7, 90))
	w := &fakeWorker{}
	f.s.worker = w
	f.s.ai = true
	key := pipelineKey("ai", testProfile)
	v := make([]float32, 16)
	v[0] = 1
	for _, id := range []string{"p1", "p2"} {
		hash := "0000000000000000"
		if id == "p2" {
			hash = "7fffffffffffffff"
		}
		_, e := f.db.Exec("INSERT INTO duplicate_features(photo_id,checksum,owner_id,pipeline,phash,sharpness,exposure,embedding,local_features) SELECT id,checksum,owner_id,?,?,100,1,?,'{}' FROM photos WHERE id=?", key, hash, vectorBytes(v), id)
		if e != nil {
			t.Fatal(e)
		}
	}
	_, _ = f.db.Exec("UPDATE photos SET captured_at_source='file_mtime'")
	if e := f.s.match(context.Background(), "ai", testProfile, key); e != nil {
		t.Fatal(e)
	}
	page, _ := f.s.Groups(context.Background(), "ai", "")
	if len(page.Items) != 0 {
		t.Fatal("semantic match treated as duplicate")
	}
	w.verified = true
	if e := f.s.match(context.Background(), "ai", testProfile, key); e != nil {
		t.Fatal(e)
	}
	page, e := f.s.Groups(context.Background(), "ai", "")
	if e != nil || len(page.Items) != 1 || page.Items[0].Reason != "local_features" {
		t.Fatalf("verified=%+v %v", page, e)
	}
	_, _ = f.db.Exec("UPDATE photos SET checksum=? WHERE id='p2'", strings.Repeat("a", 64))
	page, _ = f.s.Groups(context.Background(), "ai", "")
	if len(page.Items) != 0 {
		t.Fatal("stale pair visible")
	}
}
func TestHashAndQualityOnRecompressedImage(t *testing.T) {
	a, sharp, exposure, e := analyzePreview(testJPEG(0, 95))
	if e != nil {
		t.Fatal(e)
	}
	b, _, _, e := analyzePreview(testJPEG(0, 65))
	if e != nil {
		t.Fatal(e)
	}
	if hamming(a, b) > 6 || sharp <= 8 || exposure <= 0 {
		t.Fatalf("distance=%d quality=%v exposure=%v", hamming(a, b), sharp, exposure)
	}
	var raw bytes.Buffer
	_ = jpeg.Encode(&raw, image.NewRGBA(image.Rect(0, 0, 256, 256)), nil)
	_, flat, _, _ := analyzePreview(raw.Bytes())
	if flat >= sharp {
		t.Fatal("flat image sharper than detail")
	}
}

func TestAIScanReusesFeaturesAndAnalyzesNewOrChangedPhotos(t *testing.T) {
	f := newFixture(t)
	f.add(t, "p1", "a", "a0", f.raw)
	f.add(t, "p2", "a", "a1", testJPEG(7, 90))
	w := &fakeWorker{}
	f.s.worker = w
	f.s.ai = true
	scan := func(total int, calls int32) {
		t.Helper()
		j, err := f.s.Start(context.Background(), "ai")
		if err != nil {
			t.Fatal(err)
		}
		j = waitJob(t, f.s, j.ID)
		if j.Status != "completed" || j.Total != total || j.Processed != total || j.Failed != 0 {
			t.Fatalf("job=%+v", j)
		}
		if got := w.calls.Load(); got != calls {
			t.Fatalf("AI analysis calls=%d, want %d", got, calls)
		}
	}
	scan(2, 2)
	scan(2, 2)
	f.add(t, "new", "a", "a0", testJPEG(1, 90))
	scan(3, 3)
	if _, err := f.db.Exec("UPDATE photos SET checksum=?,source_revision='changed' WHERE id='p1'", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	scan(3, 4)
	// Missing current-pipeline features (including earlier failed analyses) are retried.
	if _, err := f.db.Exec("DELETE FROM duplicate_features WHERE photo_id='p2'"); err != nil {
		t.Fatal(err)
	}
	scan(3, 5)
}
