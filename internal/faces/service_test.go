package faces

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/maintenance"
)

var testProfile = Profile{API: "1", Pipeline: "test-pipeline", Model: "test-model", Dimension: 16, Device: "cuda"}

type fakeWorker struct {
	calls atomic.Int32
	fn    func(context.Context, string) (Analysis, error)
}

func (w *fakeWorker) Health(context.Context) (Profile, error) { return testProfile, nil }
func (w *fakeWorker) Analyze(ctx context.Context, id string, _ Profile, _ []byte) (Analysis, error) {
	w.calls.Add(1)
	if w.fn != nil {
		return w.fn(ctx, id)
	}
	return result(id, true), nil
}
func result(pid string, hasFace bool) Analysis {
	a := Analysis{Profile: testProfile, RequestID: pid}
	a.Image.Width = 64
	a.Image.Height = 64
	a.Faces = []Detection{}
	if hasFace {
		v := make([]float32, 16)
		v[0] = 1
		f := Detection{Index: 0, Box: [4]float64{.1, .1, .5, .5}, Score: .99, Encoding: "float32-le-base64", Embedding: base64.StdEncoding.EncodeToString(encodeVector(v))}
		f.Quality.Usable = true
		a.Faces = append(a.Faces, f)
	}
	return a
}
func fixture(t *testing.T, w Worker) (*Service, *sql.DB) {
	t.Helper()
	db, e := database.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	for _, owner := range []string{"a", "b"} {
		_, e = db.Exec("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES(?,?,'hash','admin','now','now')", owner, owner)
		if e != nil {
			t.Fatal(e)
		}
		_, e = db.Exec("INSERT INTO folders(id,owner_id,storage_path,name,created_at,updated_at) VALUES(?,?,?,?,'now','now')", owner, owner, owner, owner)
		if e != nil {
			t.Fatal(e)
		}
	}
	var b bytes.Buffer
	_ = jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, 64, 64)), nil)
	c := Config{Enabled: true, URL: "http://127.0.0.1:8091", Token: strings.Repeat("x", 32), AllowHTTP: true, Timeout: time.Second, MatchThreshold: .7, MatchMargin: .08}
	s, e := NewService(context.Background(), db, c, w, func(context.Context, string) ([]byte, error) { return b.Bytes(), nil }, &maintenance.Lock{})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(s.Close)
	return s, db
}
func addPhoto(t *testing.T, db *sql.DB, pid, owner string) {
	t.Helper()
	_, e := db.Exec(`INSERT INTO photos(id,owner_id,folder_id,storage_path,filename,mime_type,size,checksum,captured_at,captured_at_source,indexed_at,source_revision,created_at,updated_at) VALUES(?,?,?,?,?,'image/jpeg',100,?,'now','file_mtime','now','revision','now','now')`, pid, owner, owner, pid, pid+".jpg", strings.Repeat("0", 64))
	if e != nil {
		t.Fatal(e)
	}
}
func waitJob(t *testing.T, s *Service, jid, status string) Job {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		j, e := s.Job(context.Background(), jid)
		if e != nil {
			t.Fatal(e)
		}
		if j.Status == status {
			s.wg.Wait()
			return j
		}
		time.Sleep(5 * time.Millisecond)
	}
	j, _ := s.Job(context.Background(), jid)
	t.Fatalf("wanted %s got %+v", status, j)
	return j
}
func start(t *testing.T, s *Service, key string) Job {
	t.Helper()
	j, e := s.Start(context.Background(), "a", key, "incremental", "")
	if e != nil {
		t.Fatal(e)
	}
	return j
}
func TestIncrementalIdempotentMatchingAndIsolation(t *testing.T) {
	w := &fakeWorker{}
	s, db := fixture(t, w)
	addPhoto(t, db, "1", "a")
	addPhoto(t, db, "2", "a")
	addPhoto(t, db, "3", "b")
	j := start(t, s, "first-key")
	done := waitJob(t, s, j.ID, "completed")
	if done.Counts.Succeeded != 3 {
		t.Fatal(done)
	}
	people, _, e := s.People(context.Background(), "")
	if e != nil || len(people) != 2 {
		t.Fatalf("people=%+v err=%v", people, e)
	}
	same := start(t, s, "first-key")
	if same.ID != j.ID {
		t.Fatal("idempotency failed")
	}
	j = start(t, s, "second-key")
	done = waitJob(t, s, j.ID, "completed")
	if done.Counts.Total != 0 || w.calls.Load() != 3 {
		t.Fatal("incremental repeated work")
	}
	if e = s.Rename(context.Background(), people[0].ID, "Family", people[0].Revision); e != nil {
		t.Fatal(e)
	}
	if e = s.Rename(context.Background(), people[0].ID, "Stale", people[0].Revision); !errors.Is(e, ErrConflict) {
		t.Fatal("stale update accepted")
	}
	if e = s.Merge(context.Background(), people[0].ID, people[1].ID, people[0].Revision+1, people[1].Revision); !errors.Is(e, ErrConflict) {
		t.Fatal("cross owner merge accepted")
	}
}
func TestNoFaceIsSuccessfulAndSkippedNextTime(t *testing.T) {
	w := &fakeWorker{fn: func(_ context.Context, pid string) (Analysis, error) { return result(pid, false), nil }}
	s, db := fixture(t, w)
	addPhoto(t, db, "1", "a")
	j := start(t, s, "no-face-key")
	waitJob(t, s, j.ID, "completed")
	j = start(t, s, "no-face-key2")
	waitJob(t, s, j.ID, "completed")
	if w.calls.Load() != 1 {
		t.Fatal("no-face was scanned twice")
	}
}
func TestCancelRejectsLateResponse(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	w := &fakeWorker{fn: func(_ context.Context, pid string) (Analysis, error) {
		close(entered)
		<-release
		return result(pid, true), nil
	}}
	s, db := fixture(t, w)
	addPhoto(t, db, "1", "a")
	j := start(t, s, "cancel-key")
	<-entered
	if _, e := s.Control(context.Background(), j.ID, "cancel"); e != nil {
		t.Fatal(e)
	}
	close(release)
	waitJob(t, s, j.ID, "cancelled")
	var n int
	db.QueryRow("SELECT count(*) FROM faces").Scan(&n)
	if n != 0 {
		t.Fatal("late response committed")
	}
}
func TestDeleteDuringInferenceAndHardDeleteCascade(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	w := &fakeWorker{fn: func(_ context.Context, pid string) (Analysis, error) {
		close(entered)
		<-release
		return result(pid, true), nil
	}}
	s, db := fixture(t, w)
	addPhoto(t, db, "1", "a")
	j := start(t, s, "delete-key")
	<-entered
	if _, e := db.Exec("UPDATE photos SET deleted_at='now' WHERE id='1'"); e != nil {
		t.Fatal(e)
	}
	close(release)
	done := waitJob(t, s, j.ID, "completed")
	if done.Counts.Skipped != 1 {
		t.Fatal(done)
	}
}
func TestPauseResumeAndRestartRecovery(t *testing.T) {
	entered := make(chan struct{})
	w := &fakeWorker{}
	w.fn = func(ctx context.Context, pid string) (Analysis, error) {
		if w.calls.Load() == 1 {
			close(entered)
			<-ctx.Done()
			return Analysis{}, ctx.Err()
		}
		return result(pid, true), nil
	}
	s, db := fixture(t, w)
	addPhoto(t, db, "1", "a")
	j := start(t, s, "resume-key")
	<-entered
	if _, e := s.Control(context.Background(), j.ID, "pause"); e != nil {
		t.Fatal(e)
	}
	waitJob(t, s, j.ID, "paused")
	if _, e := s.Control(context.Background(), j.ID, "resume"); e != nil {
		t.Fatal(e)
	}
	waitJob(t, s, j.ID, "completed")
	_, e := db.Exec("UPDATE face_jobs SET status='running' WHERE id=?", j.ID)
	if e != nil {
		t.Fatal(e)
	}
	recovered, e := NewService(context.Background(), db, s.cfg, w, s.preview, &maintenance.Lock{})
	if e != nil {
		t.Fatal(e)
	}
	defer recovered.Close()
	got, e := recovered.Job(context.Background(), j.ID)
	if e != nil || got.Status != "paused" || got.Counts.Succeeded != 1 {
		t.Fatalf("%+v %v", got, e)
	}
}
func TestManualCorrectionAndInvalidation(t *testing.T) {
	w := &fakeWorker{}
	s, db := fixture(t, w)
	addPhoto(t, db, "1", "a")
	addPhoto(t, db, "2", "a")
	j := start(t, s, "manual-key")
	waitJob(t, s, j.ID, "completed")
	ps, _, _ := s.People(context.Background(), "")
	fs, _, e := s.FaceList(context.Background(), ps[0].ID, "")
	if e != nil || len(fs) != 2 {
		t.Fatalf("%+v %v", fs, e)
	}
	if e = s.Assign(context.Background(), fs[0].ID, "", false, fs[0].Revision); e != nil {
		t.Fatal(e)
	}
	j = start(t, s, "manual-key2")
	waitJob(t, s, j.ID, "completed")
	ps, _, _ = s.People(context.Background(), "")
	if len(ps) != 2 {
		t.Fatal("manual decision lost")
	}
	if _, e = db.Exec("UPDATE photos SET owner_id='b' WHERE id=?", fs[0].PhotoID); e != nil {
		t.Fatal(e)
	}
	var count int
	db.QueryRow("SELECT count(*) FROM faces WHERE id=?", fs[0].ID).Scan(&count)
	if count != 0 {
		t.Fatal("owner change left old labels")
	}
	if _, e = db.Exec("DELETE FROM photos WHERE id=?", fs[1].PhotoID); e != nil {
		t.Fatal(e)
	}
	db.QueryRow("SELECT count(*) FROM faces").Scan(&count)
	if count != 0 {
		t.Fatal("hard delete left face vectors")
	}
}
func TestAnalysisRejectsMalformedVectors(t *testing.T) {
	for _, mutate := range []func(*Analysis){func(a *Analysis) { a.Faces[0].Embedding = "bad" }, func(a *Analysis) { a.Model = "different" }, func(a *Analysis) { a.Faces[0].Box[0] = 2 }, func(a *Analysis) { a.Faces[0].Index = 3 }, func(a *Analysis) { a.Faces[0].Embedding = base64.StdEncoding.EncodeToString(make([]byte, 64)) }} {
		a := result("x", true)
		mutate(&a)
		if validateAnalysis(&a, "x", testProfile) == nil {
			t.Fatal("accepted malformed result")
		}
	}
}
func TestClientDoesNotForwardTokenOnRedirect(t *testing.T) {
	var hit atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer server.Close()
	c := NewClient(Config{URL: server.URL, Token: strings.Repeat("x", 32), Timeout: time.Second})
	if _, e := c.Health(context.Background()); e == nil {
		t.Fatal("redirect accepted")
	}
	if hit.Load() != 0 {
		t.Fatal("token forwarded")
	}
}
func TestHTTPAdminAndCSRF(t *testing.T) {
	db, e := database.Open(context.Background(), filepath.Join(t.TempDir(), "auth.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	a := auth.NewService(db, time.Hour, false)
	_, session, e := a.SetupAdmin(context.Background(), "admin", "correct horse battery staple")
	if e != nil {
		t.Fatal(e)
	}
	s, e := NewService(context.Background(), db, Config{}, &fakeWorker{}, nil, &maintenance.Lock{})
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	h := NewHandler(s, a)
	for _, tt := range []struct {
		method, path, token string
		want                int
	}{{"GET", "/api/v1/admin/people", "", 401}, {"GET", "/api/v1/admin/people", session.Token, 200}, {"POST", "/api/v1/admin/faces/test", session.Token, 403}} {
		r := httptest.NewRequest(tt.method, tt.path, nil)
		if tt.token != "" {
			r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: tt.token})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tt.want {
			t.Fatalf("%s got %d %s", tt.path, w.Code, w.Body)
		}
	}
	if _, e = db.Exec("UPDATE users SET role='user'"); e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("GET", "/api/v1/admin/people", nil)
	r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: session.Token})
	out := httptest.NewRecorder()
	h.ServeHTTP(out, r)
	if out.Code != 403 {
		t.Fatalf("member got %d", out.Code)
	}
}
