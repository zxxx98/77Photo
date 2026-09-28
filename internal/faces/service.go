package faces

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"image"
	"image/jpeg"
	"os"
	"sync"
	"time"

	"github.com/zxxx98/77Photo/internal/maintenance"
	"github.com/zxxx98/77Photo/internal/thumbnails"
	_ "golang.org/x/image/webp"
)

var ErrConflict = errors.New("face task or revision conflict")
var ErrInvalid = errors.New("invalid face request")
var ErrDisabled = errors.New("face recognition is disabled")

type Preview func(context.Context, string) ([]byte, error)
type Service struct {
	db      *sql.DB
	cfg     Config
	worker  Worker
	preview Preview
	lock    *maintenance.Lock
	ctx     context.Context
	mu      sync.Mutex
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

func NewService(ctx context.Context, db *sql.DB, cfg Config, worker Worker, preview Preview, lock *maintenance.Lock) (*Service, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	s := &Service{db: db, cfg: cfg, worker: worker, preview: preview, lock: lock, ctx: ctx}
	_, err := db.ExecContext(ctx, "UPDATE face_jobs SET status='paused',error='SERVER_RESTART',updated_at=? WHERE status='running'", now())
	return s, err
}
func (s *Service) Close() {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
}
func id(prefix string) string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return prefix + hex.EncodeToString(b[:])
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func PreviewFromThumbnails(t *thumbnails.Service, concurrency int) Preview {
	gate := make(chan struct{}, min(2, max(1, concurrency))) // Bound R5S decoding and avatar work.
	return func(ctx context.Context, id string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		select {
		case gate <- struct{}{}:
			defer func() { <-gate }()
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		for {
			state, path, err := t.Ensure(ctx, id, 1280)
			if err != nil && !errors.Is(err, thumbnails.ErrQueueFull) {
				return nil, err
			}
			if state == thumbnails.Ready {
				f, e := os.Open(path)
				if e != nil {
					return nil, e
				}
				img, _, e := image.Decode(f)
				_ = f.Close()
				if e != nil {
					return nil, e
				}
				var b bytes.Buffer
				e = jpeg.Encode(&b, img, &jpeg.Options{Quality: 90})
				return b.Bytes(), e
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
}

type Counts struct {
	Total     int `json:"total"`
	Pending   int `json:"pending"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Skipped   int `json:"skipped"`
	Cancelled int `json:"cancelled"`
}
type Job struct {
	ID      string `json:"id"`
	Mode    string `json:"mode"`
	Status  string `json:"status"`
	Error   string `json:"error"`
	Created string `json:"created_at"`
	Updated string `json:"updated_at"`
	Counts  Counts `json:"counts"`
}
type FailedItem struct {
	PhotoID  string `json:"photo_id"`
	Filename string `json:"filename"`
	Error    string `json:"error"`
}

func (s *Service) FailedItems(ctx context.Context, jid, cursor string) ([]FailedItem, string, error) {
	if _, err := s.Job(ctx, jid); err != nil {
		return nil, "", err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT i.photo_id,coalesce(p.filename,''),i.error FROM face_items i
 LEFT JOIN photos p ON p.id=i.photo_id WHERE i.job_id=? AND i.status='failed' AND i.photo_id>?
 ORDER BY i.photo_id LIMIT 101`, jid, cursor)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []FailedItem{}
	for rows.Next() {
		var item FailedItem
		if err = rows.Scan(&item.PhotoID, &item.Filename, &item.Error); err != nil {
			return nil, "", err
		}
		out = append(out, item)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > 100 {
		out = out[:100]
		next = out[99].PhotoID
	}
	return out, next, nil
}

func (s *Service) Job(ctx context.Context, jid string) (Job, error) {
	var j Job
	err := s.db.QueryRowContext(ctx, `SELECT id,CASE WHEN regroup_only=1 THEN 'regroup' WHEN scan_all=1 THEN 'full' ELSE mode END,status,error,created_at,updated_at FROM face_jobs WHERE id=?`, jid).Scan(&j.ID, &j.Mode, &j.Status, &j.Error, &j.Created, &j.Updated)
	if err != nil {
		return j, err
	}
	err = s.db.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(status='pending'),0),coalesce(sum(status='succeeded'),0),coalesce(sum(status='failed'),0),coalesce(sum(status='skipped'),0),coalesce(sum(status='cancelled'),0) FROM face_items WHERE job_id=?`, jid).Scan(&j.Counts.Total, &j.Counts.Pending, &j.Counts.Succeeded, &j.Counts.Failed, &j.Counts.Skipped, &j.Counts.Cancelled)
	return j, err
}
func (s *Service) Jobs(ctx context.Context) ([]Job, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT id FROM face_jobs ORDER BY created_at DESC LIMIT 30")
	if e != nil {
		return nil, e
	}
	var ids []string
	for rows.Next() {
		var x string
		if e = rows.Scan(&x); e != nil {
			break
		}
		ids = append(ids, x)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return nil, e
	}
	out := []Job{}
	for _, x := range ids {
		j, e := s.Job(ctx, x)
		if e != nil {
			return nil, e
		}
		out = append(out, j)
	}
	return out, nil
}
func (s *Service) Test(ctx context.Context) (Profile, error) {
	if !s.cfg.Enabled {
		return Profile{}, ErrDisabled
	}
	p, e := s.worker.Health(ctx)
	if e != nil {
		return p, e
	}
	if e = validateProfile(p); e != nil {
		return p, e
	}
	var old Profile
	e = s.db.QueryRowContext(ctx, "SELECT pipeline_id,model_id,dimension FROM face_profile WHERE id=1").Scan(&old.Pipeline, &old.Model, &old.Dimension)
	if e == nil && (p.Pipeline != old.Pipeline || p.Model != old.Model || p.Dimension != old.Dimension) {
		return p, &WorkerError{"MODEL_MISMATCH", false}
	}
	if errors.Is(e, sql.ErrNoRows) {
		e = nil
	}
	return p, e
}
func (s *Service) profileForMode(ctx context.Context, mode string) (Profile, error) {
	if mode != "regroup" {
		return s.Test(ctx)
	}
	var p Profile
	err := s.db.QueryRowContext(ctx, "SELECT pipeline_id,model_id,dimension FROM face_profile WHERE id=1").Scan(&p.Pipeline, &p.Model, &p.Dimension)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrInvalid
	}
	return p, err
}
func (s *Service) Start(ctx context.Context, creator, key, mode, folder string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.cfg.Enabled {
		return Job{}, ErrDisabled
	}
	if len(key) < 8 || len(key) > 128 || (mode != "incremental" && mode != "retry_failed" && mode != "full" && mode != "regroup") || ((mode == "full" || mode == "regroup") && folder != "") {
		return Job{}, ErrInvalid
	}
	var existing string
	err := s.db.QueryRowContext(ctx, "SELECT id FROM face_jobs WHERE idempotency_key=?", key).Scan(&existing)
	if err == nil {
		return s.Job(ctx, existing)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Job{}, err
	}
	if s.cancel != nil {
		return Job{}, ErrConflict
	}
	err = s.db.QueryRowContext(ctx, "SELECT id FROM face_jobs WHERE status IN ('running','paused','paused_offline') LIMIT 1").Scan(&existing)
	if err == nil {
		return Job{}, ErrConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Job{}, err
	}
	p, err := s.profileForMode(ctx, mode)
	if err != nil {
		return Job{}, err
	}
	jid := id("fj_")
	release, err := s.lock.Acquire(maintenance.KindFaceScan, jid)
	if err != nil {
		return Job{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		release()
		return Job{}, err
	}
	defer tx.Rollback()
	if folder != "" {
		var found int
		if err = tx.QueryRowContext(ctx, "SELECT 1 FROM folders WHERE id=?", folder).Scan(&found); err != nil {
			release()
			return Job{}, ErrInvalid
		}
	}
	_, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO face_profile(id,pipeline_id,model_id,dimension) VALUES(1,?,?,?)", p.Pipeline, p.Model, p.Dimension)
	if err == nil {
		dbMode := mode
		if mode == "full" || mode == "regroup" {
			dbMode = "incremental"
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO face_jobs(id,creator_id,idempotency_key,mode,folder_id,scan_all,regroup_only,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'running',?,?)", jid, creator, key, dbMode, folder, mode == "full", mode == "regroup", now(), now())
	}
	// SQL materializes the fixed candidate set without loading photo metadata into Go memory.
	if err == nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO face_items(job_id,photo_id,checksum,owner_id,status)
 SELECT ?,p.id,p.checksum,p.owner_id,'pending' FROM photos p WHERE p.deleted_at IS NULL AND p.scan_status='indexed'
 AND p.mime_type IN ('image/jpeg','image/png','image/heic','image/heif')
 AND (?='' OR p.folder_id IN (WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id) SELECT id FROM tree))
	 AND (?='full' OR (?='regroup' AND EXISTS(SELECT 1 FROM face_analyses a WHERE a.photo_id=p.id AND a.checksum=p.checksum AND a.owner_id=p.owner_id AND a.pipeline_id=?)) OR (? NOT IN ('full','regroup') AND NOT EXISTS(SELECT 1 FROM face_analyses a WHERE a.photo_id=p.id AND a.checksum=p.checksum AND a.owner_id=p.owner_id AND a.pipeline_id=?)))
	 AND (?!='retry_failed' OR EXISTS(SELECT 1 FROM face_items i WHERE i.photo_id=p.id AND i.checksum=p.checksum AND i.status='failed'))`, jid, folder, folder, mode, mode, p.Pipeline, mode, p.Pipeline, mode)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		release()
		return Job{}, err
	}
	s.launch(jid, p, release)
	return s.Job(ctx, jid)
}
func (s *Service) launch(jid string, p Profile, release func()) {
	ctx, cancel := context.WithCancel(s.ctx)
	s.cancel = cancel
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()
		defer func() { s.mu.Lock(); s.cancel = nil; release(); s.mu.Unlock() }()
		s.run(ctx, jid, p)
	}()
}
func (s *Service) Control(ctx context.Context, jid, action string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j, err := s.Job(ctx, jid)
	if err != nil {
		return j, err
	}
	if action == "resume" {
		if !s.cfg.Enabled {
			return j, ErrDisabled
		}
		if s.cancel != nil || (j.Status != "paused" && j.Status != "paused_offline") {
			return j, ErrConflict
		}
		p, e := s.profileForMode(ctx, j.Mode)
		if e != nil {
			return j, e
		}
		release, e := s.lock.Acquire(maintenance.KindFaceScan, jid)
		if e != nil {
			return j, e
		}
		_, e = s.db.ExecContext(ctx, "UPDATE face_jobs SET status='running',error='',updated_at=? WHERE id=?", now(), jid)
		if e != nil {
			release()
			return j, e
		}
		s.launch(jid, p, release)
	} else {
		if action != "pause" && action != "cancel" {
			return j, ErrInvalid
		}
		if j.Status != "running" && j.Status != "paused" && j.Status != "paused_offline" {
			return j, ErrConflict
		}
		status := "paused"
		if action == "cancel" {
			status = "cancelled"
		}
		tx, e := s.db.BeginTx(ctx, nil)
		if e != nil {
			return j, e
		}
		defer tx.Rollback()
		_, e = tx.ExecContext(ctx, "UPDATE face_jobs SET status=?,updated_at=? WHERE id=?", status, now(), jid)
		if e == nil && action == "cancel" {
			_, e = tx.ExecContext(ctx, "UPDATE face_items SET status='cancelled' WHERE job_id=? AND status='pending'", jid)
		}
		if e == nil {
			e = tx.Commit()
		}
		if e != nil {
			return j, e
		}
		if s.cancel != nil {
			s.cancel()
		}
	}
	return s.Job(ctx, jid)
}
func (s *Service) finish(jid, status, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.db.Exec("UPDATE face_jobs SET status=?,error=?,updated_at=? WHERE id=? AND status='running'", status, reason, now(), jid)
}
func (s *Service) run(ctx context.Context, jid string, p Profile) {
	type scanItem struct{ photo, checksum, owner string }
	parallelism := max(1, s.cfg.Concurrency)
	var full, regroup bool
	if err := s.db.QueryRowContext(ctx, "SELECT scan_all,regroup_only FROM face_jobs WHERE id=?", jid).Scan(&full, &regroup); err != nil {
		s.finish(jid, "failed", "DATABASE_ERROR")
		return
	}
	if regroup {
		parallelism = 1
	}
	for {
		if ctx.Err() != nil {
			s.finish(jid, "paused", "INTERRUPTED")
			return
		}
		rows, e := s.db.QueryContext(ctx, "SELECT photo_id,checksum,owner_id FROM face_items WHERE job_id=? AND status='pending' ORDER BY photo_id LIMIT ?", jid, parallelism)
		if e != nil {
			s.finish(jid, "failed", "DATABASE_ERROR")
			return
		}
		items := make([]scanItem, 0, parallelism)
		for rows.Next() {
			var item scanItem
			if e = rows.Scan(&item.photo, &item.checksum, &item.owner); e != nil {
				break
			}
			items = append(items, item)
		}
		if e == nil {
			e = rows.Err()
		}
		rows.Close() // Release the only SQLite connection before workers commit.
		if e != nil {
			s.finish(jid, "failed", "DATABASE_ERROR")
			return
		}
		if len(items) == 0 {
			j, err := s.Job(ctx, jid)
			if err != nil {
				s.finish(jid, "failed", "DATABASE_ERROR")
				return
			}
			status := "completed"
			if j.Counts.Failed > 0 {
				status = "completed_with_errors"
			}
			s.finish(jid, status, "")
			return
		}
		batchCtx, cancel := context.WithCancel(ctx)
		results := make(chan string, len(items))
		for _, item := range items {
			go func(item scanItem) {
				results <- s.processOne(batchCtx, jid, p, item.photo, item.checksum, item.owner, full, regroup)
			}(item)
		}
		reason := ""
		for range items {
			if result := <-results; result != "" && reason == "" {
				reason = result
				cancel()
			}
		}
		cancel()
		if ctx.Err() != nil {
			s.finish(jid, "paused", "INTERRUPTED")
			return
		}
		if reason != "" {
			status := "failed"
			if reason == "WORKER_OFFLINE" {
				status = "paused_offline"
			}
			s.finish(jid, status, reason)
			return
		}
	}
}

func (s *Service) processOne(ctx context.Context, jid string, p Profile, pid, checksum, owner string, full, regroup bool) string {
	if regroup {
		if err := s.regroupOne(ctx, jid, p, pid, checksum, owner); err != nil && ctx.Err() == nil {
			return "DATABASE_ERROR"
		}
		return ""
	}
	var revision string
	e := s.db.QueryRowContext(ctx, "SELECT source_revision FROM photos WHERE id=? AND checksum=? AND owner_id=? AND deleted_at IS NULL AND scan_status='indexed'", pid, checksum, owner).Scan(&revision)
	if errors.Is(e, sql.ErrNoRows) {
		if e = s.item(ctx, jid, pid, "skipped", "PHOTO_CHANGED"); e != nil && ctx.Err() == nil {
			return "DATABASE_ERROR"
		}
		return ""
	}
	if e != nil {
		if ctx.Err() != nil {
			return ""
		}
		return "DATABASE_ERROR"
	}
	img, e := s.preview(ctx, pid)
	if e != nil {
		if ctx.Err() != nil {
			return ""
		}
		if e = s.item(ctx, jid, pid, "failed", "PREVIEW_FAILED"); e != nil && ctx.Err() == nil {
			return "DATABASE_ERROR"
		}
		return ""
	}
	var a Analysis
	for attempt := 0; attempt < 3; attempt++ {
		a, e = s.worker.Analyze(ctx, pid, p, img)
		if e == nil || !retryable(e) || ctx.Err() != nil {
			break
		}
		if attempt < 2 {
			select {
			case <-ctx.Done():
			case <-time.After(time.Duration(attempt+1) * time.Second):
			}
		}
	}
	if ctx.Err() != nil {
		return ""
	}
	if e != nil {
		if retryable(e) {
			return "WORKER_OFFLINE"
		}
		var we *WorkerError
		if errors.As(e, &we) && (we.Code == "WORKER_HTTP_422" || we.Code == "WORKER_HTTP_413") {
			if e = s.item(ctx, jid, pid, "failed", we.Code); e != nil && ctx.Err() == nil {
				return "DATABASE_ERROR"
			}
			return ""
		}
		return "WORKER_REJECTED"
	}
	if e = validateAnalysis(&a, pid, p); e != nil {
		return "WORKER_PROTOCOL"
	}
	config, _, e := image.DecodeConfig(bytes.NewReader(img))
	if e != nil || config.Width != a.Image.Width || config.Height != a.Image.Height {
		return "WORKER_DIMENSIONS"
	}
	if e = s.commit(ctx, jid, pid, checksum, owner, revision, p, a, full); e != nil && ctx.Err() == nil {
		if errors.Is(e, ErrManualFaceUnmatched) {
			if e = s.item(ctx, jid, pid, "failed", "MANUAL_FACE_UNMATCHED"); e != nil && ctx.Err() == nil {
				return "DATABASE_ERROR"
			}
			return ""
		}
		return "DATABASE_ERROR"
	}
	return ""
}
func (s *Service) item(ctx context.Context, jid, pid, status, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	result, err := s.db.ExecContext(ctx, "UPDATE face_items SET status=?,error=? WHERE job_id=? AND photo_id=? AND status='pending' AND EXISTS(SELECT 1 FROM face_jobs WHERE id=? AND status='running')", status, reason, jid, pid, jid)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConflict
	}
	return nil
}
func (s *Service) commit(ctx context.Context, jid, pid, checksum, owner, revision string, p Profile, a Analysis, full bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var valid int
	e = tx.QueryRowContext(ctx, `SELECT 1 FROM photos p,face_jobs j WHERE p.id=? AND p.checksum=? AND p.owner_id=? AND p.source_revision=? AND p.deleted_at IS NULL AND p.scan_status='indexed' AND j.id=? AND j.status='running'`, pid, checksum, owner, revision, jid).Scan(&valid)
	if errors.Is(e, sql.ErrNoRows) {
		_, e = tx.ExecContext(ctx, "UPDATE face_items SET status='skipped',error='PHOTO_CHANGED' WHERE job_id=? AND photo_id=? AND status='pending'", jid, pid)
		if e != nil {
			return e
		}
		return tx.Commit()
	}
	if e != nil {
		return e
	}
	var aid string
	e = tx.QueryRowContext(ctx, "SELECT id FROM face_analyses WHERE photo_id=? AND checksum=? AND pipeline_id=?", pid, checksum, p.Pipeline).Scan(&aid)
	existed := e == nil
	var kept []*preservedFace
	if errors.Is(e, sql.ErrNoRows) {
		aid = id("fa_")
		_, e = tx.ExecContext(ctx, "INSERT INTO face_analyses(id,photo_id,checksum,owner_id,pipeline_id,width,height,created_at) VALUES(?,?,?,?,?,?,?,?)", aid, pid, checksum, owner, p.Pipeline, a.Image.Width, a.Image.Height, now())
		if e != nil {
			return e
		}
	} else if e != nil {
		return e
	} else if full {
		old, err := loadPreservedFaces(ctx, tx, aid)
		if err != nil {
			return err
		}
		kept, err = matchPreservedFaces(old, a.Faces)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM faces WHERE analysis_id=?", aid); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE face_analyses SET width=?,height=?,created_at=? WHERE id=?", a.Image.Width, a.Image.Height, now(), aid); err != nil {
			return err
		}
	}
	if existed && !full {
		// An incremental retry cannot replace a successful existing analysis.
	} else {
		used := map[string]bool{}
		for _, saved := range kept {
			if saved != nil && saved.person != "" {
				used[saved.person] = true
			}
		}
		for i, f := range a.Faces {
			person := ""
			ignored, manual := false, false
			var exclusions []string
			if kept != nil && kept[i] != nil {
				person, ignored, manual = kept[i].person, kept[i].ignored, true
				exclusions = kept[i].exclusions
			} else if len(f.Vector) > 0 {
				person, e = s.match(ctx, tx, owner, pid, jid, full, f.Vector, used)
				if e != nil {
					return e
				}
				if person == "" {
					person = id("pe_")
					if _, e = tx.ExecContext(ctx, "INSERT INTO people(id,owner_id,created_at) VALUES(?,?,?)", person, owner, now()); e != nil {
						return e
					}
				}
			}
			if person != "" {
				used[person] = true
			}
			var personValue any
			if person != "" {
				personValue = person
			}
			faceID := id("fc_")
			_, e = tx.ExecContext(ctx, `INSERT INTO faces(id,analysis_id,face_index,x,y,width,height,score,embedding,person_id,manual,ignored) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, faceID, aid, f.Index, f.Box[0], f.Box[1], f.Box[2], f.Box[3], f.Score, encodeVector(f.Vector), personValue, manual, ignored)
			if e != nil {
				return e
			}
			for _, excluded := range exclusions {
				if _, e = tx.ExecContext(ctx, "INSERT INTO face_exclusions(face_id,person_id) VALUES(?,?)", faceID, excluded); e != nil {
					return e
				}
			}
		}
	}
	_, e = tx.ExecContext(ctx, "UPDATE face_items SET status='succeeded',error='' WHERE job_id=? AND photo_id=?", jid, pid)
	if e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Service) match(ctx context.Context, tx *sql.Tx, owner, pid, jid string, full bool, v []float32, used map[string]bool) (string, error) {
	// At most three representatives per person, streamed to avoid a full vector cache on R5S.
	rows, e := tx.QueryContext(ctx, `SELECT person_id,embedding FROM (
 SELECT f.person_id,f.embedding,row_number() OVER(PARTITION BY f.person_id ORDER BY f.manual DESC,f.score DESC,f.id) rn
 FROM faces f JOIN face_analyses a ON a.id=f.analysis_id JOIN photos p ON p.id=a.photo_id JOIN people pe ON pe.id=f.person_id
 WHERE pe.owner_id=? AND pe.merged_into IS NULL AND f.ignored=0 AND length(f.embedding)>0 AND p.deleted_at IS NULL AND p.scan_status='indexed' AND a.checksum=p.checksum AND a.owner_id=p.owner_id AND p.id<>?
 AND (?=0 OR f.manual=1 OR pe.name<>'' OR EXISTS(SELECT 1 FROM face_items i WHERE i.job_id=? AND i.photo_id=p.id AND i.status='succeeded'))
 ) WHERE rn<=3`, owner, pid, full, jid)
	if e != nil {
		return "", e
	}
	defer rows.Close()
	best, second := -1.0, -1.0
	winner := ""
	scores := map[string]float64{}
	for rows.Next() {
		var person string
		var blob []byte
		if e = rows.Scan(&person, &blob); e != nil {
			return "", e
		}
		if used[person] || len(blob) != len(v)*4 {
			continue
		}
		score := 0.0
		for i, x := range decodeVector(blob) {
			score += float64(x) * float64(v[i])
		}
		if old, ok := scores[person]; !ok || score > old {
			scores[person] = score
		}
	}
	if e = rows.Err(); e != nil {
		return "", e
	}
	for person, score := range scores {
		if score > best {
			second = best
			best = score
			winner = person
		} else if score > second {
			second = score
		}
	}
	// Threshold 1 disables automatic matching until the model is calibrated.
	if s.cfg.MatchThreshold >= 1 || best < s.cfg.MatchThreshold || best-second < s.cfg.MatchMargin {
		return "", nil
	}
	return winner, nil
}
