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
	c := Config{Enabled: true, URL: "http://127.0.0.1:8091", Token: strings.Repeat("x", 32), AllowHTTP: true, Timeout: time.Second, MatchThreshold: .7, MatchMargin: .08, Concurrency: 1}
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

func TestSimilarPeopleUsesSavedVectorsWithinOwnerWithoutChangingGroups(t *testing.T) {
	w := &fakeWorker{fn: func(_ context.Context, pid string) (Analysis, error) {
		a := result(pid, true)
		v := make([]float32, 16)
		switch pid {
		case "2":
			v[0], v[1] = .8, .6
		case "4":
			v[1] = 1
		default:
			v[0] = 1
		}
		a.Faces[0].Embedding = base64.StdEncoding.EncodeToString(encodeVector(v))
		return a, nil
	}}
	s, db := fixture(t, w)
	s.cfg.MatchThreshold = 1 // Keep each face separate to simulate the reported split.
	for _, photo := range []struct{ id, owner string }{{"1", "a"}, {"2", "a"}, {"3", "b"}, {"4", "a"}} {
		addPhoto(t, db, photo.id, photo.owner)
	}
	j := start(t, s, "similar-key")
	waitJob(t, s, j.ID, "completed")
	var source, expected, other string
	for _, item := range []struct {
		photo string
		into  *string
	}{{"1", &source}, {"2", &expected}, {"4", &other}} {
		if err := db.QueryRow(`SELECT f.person_id FROM faces f JOIN face_analyses a ON a.id=f.analysis_id WHERE a.photo_id=?`, item.photo).Scan(item.into); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.SimilarPeople(context.Background(), source)
	if err != nil || len(got) != 2 || got[0].Person.ID != expected || got[0].Score < .79 || got[1].Person.ID != other {
		t.Fatalf("suggestions=%+v err=%v", got, err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM people WHERE merged_into IS NULL").Scan(&count); err != nil || count != 4 {
		t.Fatalf("suggestions changed groups: count=%d err=%v", count, err)
	}
}

func TestScanRunsBoundedConcurrentInferenceWithoutDuplicateItems(t *testing.T) {
	entered := make(chan string, 4)
	release := make(chan struct{})
	w := &fakeWorker{fn: func(_ context.Context, pid string) (Analysis, error) {
		entered <- pid
		<-release
		return result(pid, true), nil
	}}
	s, db := fixture(t, w)
	s.cfg.Concurrency = 4
	for i := 1; i <= 4; i++ {
		addPhoto(t, db, string(rune('0'+i)), "a")
	}
	j := start(t, s, "parallel-key")
	seen := map[string]bool{}
	for i := 0; i < 4; i++ {
		select {
		case pid := <-entered:
			if seen[pid] {
				t.Fatalf("duplicate inference for %s", pid)
			}
			seen[pid] = true
		case <-time.After(3 * time.Second):
			t.Fatal("scanner did not run four inferences concurrently")
		}
	}
	close(release)
	done := waitJob(t, s, j.ID, "completed")
	if done.Counts.Succeeded != 4 || w.calls.Load() != 4 {
		t.Fatalf("unexpected scan counts: %+v calls=%d", done, w.calls.Load())
	}
}

func TestConcurrentCancelRejectsEveryLateInference(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	w := &fakeWorker{fn: func(_ context.Context, pid string) (Analysis, error) {
		entered <- struct{}{}
		<-release
		return result(pid, true), nil
	}}
	s, db := fixture(t, w)
	s.cfg.Concurrency = 4
	for _, pid := range []string{"1", "2", "3", "4"} {
		addPhoto(t, db, pid, "a")
	}
	j := start(t, s, "parallel-cancel-key")
	for i := 0; i < 4; i++ {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("not all inferences started")
		}
	}
	if _, err := s.Control(context.Background(), j.ID, "cancel"); err != nil {
		t.Fatal(err)
	}
	close(release)
	waitJob(t, s, j.ID, "cancelled")
	var count int
	if err := db.QueryRow("SELECT count(*) FROM faces").Scan(&count); err != nil || count != 0 {
		t.Fatalf("late face results committed: %d, err=%v", count, err)
	}
}

func TestFullRescanReappliesThresholdAndPreservesNamedPerson(t *testing.T) {
	w := &fakeWorker{}
	s, db := fixture(t, w)
	s.cfg.MatchThreshold = 1
	addPhoto(t, db, "1", "a")
	addPhoto(t, db, "2", "a")
	j := start(t, s, "before-full-key")
	waitJob(t, s, j.ID, "completed")
	var named string
	if err := db.QueryRow(`SELECT f.person_id FROM faces f JOIN face_analyses a ON a.id=f.analysis_id WHERE a.photo_id='1'`).Scan(&named); err != nil {
		t.Fatal(err)
	}
	if err := s.Rename(context.Background(), named, "Alex", 1); err != nil {
		t.Fatal(err)
	}
	s.cfg.MatchThreshold = .7
	s.cfg.Concurrency = 4
	j, err := s.Start(context.Background(), "a", "full-rescan-key", "full", "")
	if err != nil {
		t.Fatal(err)
	}
	done := waitJob(t, s, j.ID, "completed")
	if done.Mode != "full" || done.Counts.Total != 2 || done.Counts.Succeeded != 2 || w.calls.Load() != 4 {
		t.Fatalf("full scan = %+v, calls=%d", done, w.calls.Load())
	}
	var distinct, namedFaces int
	if err := db.QueryRow("SELECT count(DISTINCT person_id) FROM faces").Scan(&distinct); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT count(*) FROM faces WHERE person_id=?", named).Scan(&namedFaces); err != nil {
		t.Fatal(err)
	}
	if distinct != 1 || namedFaces != 2 {
		t.Fatalf("full rescan did not regroup: distinct=%d named=%d", distinct, namedFaces)
	}
	var name string
	if err := db.QueryRow("SELECT name FROM people WHERE id=?", named).Scan(&name); err != nil || name != "Alex" {
		t.Fatalf("name=%q err=%v", name, err)
	}
}

func TestFullRescanKeepsOldAnalysisWhenManualFaceDisappears(t *testing.T) {
	var noFace atomic.Bool
	w := &fakeWorker{fn: func(_ context.Context, pid string) (Analysis, error) { return result(pid, !noFace.Load()), nil }}
	s, db := fixture(t, w)
	addPhoto(t, db, "1", "a")
	j := start(t, s, "before-missing-key")
	waitJob(t, s, j.ID, "completed")
	people, _, err := s.People(context.Background(), "")
	if err != nil || len(people) != 1 {
		t.Fatalf("people=%+v err=%v", people, err)
	}
	faces, _, err := s.FaceList(context.Background(), people[0].ID, "")
	if err != nil || len(faces) != 1 {
		t.Fatalf("faces=%+v err=%v", faces, err)
	}
	if err := s.Assign(context.Background(), faces[0].ID, "", false, faces[0].Revision); err != nil {
		t.Fatal(err)
	}
	noFace.Store(true)
	j, err = s.Start(context.Background(), "a", "missing-full-key", "full", "")
	if err != nil {
		t.Fatal(err)
	}
	done := waitJob(t, s, j.ID, "completed_with_errors")
	if done.Counts.Failed != 1 {
		t.Fatalf("full scan = %+v", done)
	}
	failed, _, err := s.FailedItems(context.Background(), j.ID, "")
	if err != nil || len(failed) != 1 || failed[0].Error != "MANUAL_FACE_UNMATCHED" {
		t.Fatalf("failed items=%+v err=%v", failed, err)
	}
	var faceCount int
	if err := db.QueryRow("SELECT count(*) FROM faces").Scan(&faceCount); err != nil || faceCount != 1 {
		t.Fatalf("manual face lost: count=%d err=%v", faceCount, err)
	}
}

func TestFullRescanPreservesManualExclusionOnMatchedFace(t *testing.T) {
	w := &fakeWorker{}
	s, db := fixture(t, w)
	addPhoto(t, db, "1", "a")
	addPhoto(t, db, "2", "a")
	j := start(t, s, "before-exclusion-key")
	waitJob(t, s, j.ID, "completed")
	var oldFace, originalPerson string
	if err := db.QueryRow(`SELECT f.id,f.person_id FROM faces f JOIN face_analyses a ON a.id=f.analysis_id WHERE a.photo_id='1'`).Scan(&oldFace, &originalPerson); err != nil {
		t.Fatal(err)
	}
	if err := s.Assign(context.Background(), oldFace, "", false, 1); err != nil {
		t.Fatal(err)
	}
	var correctedPerson string
	if err := db.QueryRow("SELECT person_id FROM faces WHERE id=?", oldFace).Scan(&correctedPerson); err != nil {
		t.Fatal(err)
	}
	j, err := s.Start(context.Background(), "a", "exclusion-full-key", "full", "")
	if err != nil {
		t.Fatal(err)
	}
	waitJob(t, s, j.ID, "completed")
	var newFace, person string
	var manual bool
	if err := db.QueryRow(`SELECT f.id,f.person_id,f.manual FROM faces f JOIN face_analyses a ON a.id=f.analysis_id WHERE a.photo_id='1'`).Scan(&newFace, &person, &manual); err != nil {
		t.Fatal(err)
	}
	if newFace == oldFace || person != correctedPerson || !manual {
		t.Fatalf("manual correction lost: old=%s new=%s person=%s", oldFace, newFace, person)
	}
	var exclusions int
	if err := db.QueryRow("SELECT count(*) FROM face_exclusions WHERE face_id=? AND person_id=?", newFace, originalPerson).Scan(&exclusions); err != nil || exclusions != 1 {
		t.Fatalf("exclusion lost: count=%d err=%v", exclusions, err)
	}
}

func TestPreservedFaceMatchingUsesBoxesNotDetectionOrder(t *testing.T) {
	old := []preservedFace{{id: "left", box: [4]float64{.1, .1, .3, .3}}, {id: "right", box: [4]float64{.6, .1, .3, .3}}}
	fresh := []Detection{{Box: [4]float64{.6, .1, .3, .3}}, {Box: [4]float64{.1, .1, .3, .3}}}
	matched, err := matchPreservedFaces(old, fresh)
	if err != nil || matched[0].id != "right" || matched[1].id != "left" {
		t.Fatalf("box matching=%+v err=%v", matched, err)
	}
}

type offlineWorker struct{}

func (offlineWorker) Health(context.Context) (Profile, error) {
	return Profile{}, &WorkerError{"WORKER_OFFLINE", true}
}
func (offlineWorker) Analyze(context.Context, string, Profile, []byte) (Analysis, error) {
	return Analysis{}, &WorkerError{"WORKER_OFFLINE", true}
}

func TestRegroupUsesSavedVectorsOfflineAndPreservesManualLabels(t *testing.T) {
	w := &fakeWorker{fn: func(_ context.Context, pid string) (Analysis, error) {
		a := result(pid, true)
		if pid == "3" {
			v := make([]float32, 16)
			v[1] = 1
			a.Faces[0].Embedding = base64.StdEncoding.EncodeToString(encodeVector(v))
		}
		return a, nil
	}}
	s, db := fixture(t, w)
	s.cfg.MatchThreshold = 1
	for _, pid := range []string{"1", "2", "3"} {
		addPhoto(t, db, pid, "a")
	}
	j := start(t, s, "before-regroup-key")
	waitJob(t, s, j.ID, "completed")
	ids := map[string]string{}
	groups := map[string]string{}
	for _, pid := range []string{"1", "2", "3"} {
		var faceID, group string
		if err := db.QueryRow(`SELECT f.id,f.person_id FROM faces f JOIN face_analyses a ON a.id=f.analysis_id WHERE a.photo_id=?`, pid).Scan(&faceID, &group); err != nil {
			t.Fatal(err)
		}
		ids[pid], groups[pid] = faceID, group
	}
	if err := s.Rename(context.Background(), groups["1"], "Alex", 1); err != nil {
		t.Fatal(err)
	}
	if err := s.Assign(context.Background(), ids["3"], "", false, 1); err != nil {
		t.Fatal(err)
	}
	var manualGroup string
	if err := db.QueryRow("SELECT person_id FROM faces WHERE id=?", ids["3"]).Scan(&manualGroup); err != nil {
		t.Fatal(err)
	}
	s.cfg.MatchThreshold = .7
	s.worker = offlineWorker{}
	j, err := s.Start(context.Background(), "a", "regroup-all-key", "regroup", "")
	if err != nil {
		t.Fatal(err)
	}
	done := waitJob(t, s, j.ID, "completed")
	if done.Mode != "regroup" || done.Counts.Succeeded != 3 || w.calls.Load() != 3 {
		t.Fatalf("regroup=%+v worker calls=%d", done, w.calls.Load())
	}
	for _, item := range []struct{ photo, want string }{{"1", groups["1"]}, {"2", groups["1"]}, {"3", manualGroup}} {
		var faceID, person string
		if err := db.QueryRow(`SELECT f.id,f.person_id FROM faces f JOIN face_analyses a ON a.id=f.analysis_id WHERE a.photo_id=?`, item.photo).Scan(&faceID, &person); err != nil {
			t.Fatal(err)
		}
		if faceID != ids[item.photo] || person != item.want {
			t.Fatalf("photo %s changed face or manual group: face=%s person=%s", item.photo, faceID, person)
		}
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
