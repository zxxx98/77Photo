package duplicates

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/zxxx98/77Photo/internal/maintenance"
)

type Job struct {
	ID        string `json:"id"`
	Mode      string `json:"mode"`
	Pipeline  string `json:"pipeline"`
	Status    string `json:"status"`
	Total     int    `json:"total"`
	Processed int    `json:"processed"`
	Failed    int    `json:"failed"`
	Error     string `json:"error"`
	Created   string `json:"created_at"`
	Updated   string `json:"updated_at"`
}

func (s *Service) Job(ctx context.Context, id string) (Job, error) {
	var j Job
	e := s.db.QueryRowContext(ctx, "SELECT id,mode,pipeline,status,total,processed,failed,error,created_at,updated_at FROM duplicate_jobs WHERE id=?", id).Scan(&j.ID, &j.Mode, &j.Pipeline, &j.Status, &j.Total, &j.Processed, &j.Failed, &j.Error, &j.Created, &j.Updated)
	return j, e
}
func (s *Service) Jobs(ctx context.Context) ([]Job, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT id FROM duplicate_jobs ORDER BY created_at DESC LIMIT 10")
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			break
		}
		ids = append(ids, id)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return nil, e
	}
	jobs := []Job{}
	for _, id := range ids {
		j, e := s.Job(ctx, id)
		if e != nil {
			return nil, e
		}
		jobs = append(jobs, j)
	}
	return jobs, nil
}
func (s *Service) profile(ctx context.Context, mode string) (Profile, error) {
	if mode == "perceptual" {
		return Profile{Pipeline: perceptualPipeline}, nil
	}
	if mode != "ai" {
		return Profile{}, ErrInvalid
	}
	if !s.ai || s.worker == nil {
		return Profile{}, ErrDisabled
	}
	return s.worker.Health(ctx)
}
func pipelineKey(mode string, p Profile) string {
	if mode == "perceptual" {
		return perceptualPipeline
	}
	return perceptualPipeline + "+" + p.Pipeline
}

func (s *Service) Start(ctx context.Context, mode string) (Job, error) {
	if mode != "perceptual" && mode != "ai" {
		return Job{}, ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var active string
	e := s.db.QueryRowContext(ctx, "SELECT id FROM duplicate_jobs WHERE status IN ('running','paused')").Scan(&active)
	if e == nil {
		return s.Job(ctx, active)
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return Job{}, e
	}
	if s.running {
		return Job{}, maintenance.ErrBusy
	}
	p, e := s.profile(ctx, mode)
	if e != nil {
		return Job{}, e
	}
	id := randomID()
	release, e := s.lock.Acquire(maintenance.KindDuplicateScan, id)
	if e != nil {
		return Job{}, e
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		release()
		return Job{}, e
	}
	defer tx.Rollback()
	_, e = tx.ExecContext(ctx, "INSERT INTO duplicate_jobs(id,mode,pipeline,status,created_at,updated_at) VALUES(?,?,?,'running',?,?)", id, mode, p.Pipeline, now(), now())
	if e == nil {
		_, e = tx.ExecContext(ctx, `INSERT INTO duplicate_job_items(job_id,photo_id,checksum,owner_id)
 SELECT ?,id,checksum,owner_id FROM photos WHERE deleted_at IS NULL AND scan_status='indexed' AND mime_type LIKE 'image/%'`, id)
	}
	if e == nil {
		_, e = tx.ExecContext(ctx, "UPDATE duplicate_jobs SET total=(SELECT count(*) FROM duplicate_job_items WHERE job_id=?) WHERE id=?", id, id)
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		release()
		return Job{}, e
	}
	s.launch(id, mode, p, release)
	return s.Job(ctx, id)
}
func (s *Service) Control(ctx context.Context, id, action string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j, e := s.Job(ctx, id)
	if e != nil {
		return j, e
	}
	if action == "pause" || action == "cancel" {
		if j.Status != "running" && j.Status != "paused" {
			return j, ErrChanged
		}
		status := "paused"
		if action == "cancel" {
			status = "cancelled"
		}
		_, e = s.db.ExecContext(ctx, "UPDATE duplicate_jobs SET status=?,updated_at=? WHERE id=?", status, now(), id)
		if e == nil && s.cancel != nil {
			s.cancel()
		}
		if e != nil {
			return j, e
		}
		return s.Job(ctx, id)
	}
	if action != "resume" || j.Status != "paused" {
		return j, ErrInvalid
	}
	if s.running {
		return j, maintenance.ErrBusy
	}
	p, e := s.profile(ctx, j.Mode)
	if e != nil {
		return j, e
	}
	if p.Pipeline != j.Pipeline {
		return j, ErrChanged
	}
	release, e := s.lock.Acquire(maintenance.KindDuplicateScan, id)
	if e != nil {
		return j, e
	}
	_, e = s.db.ExecContext(ctx, "UPDATE duplicate_jobs SET status='running',error='',updated_at=? WHERE id=?", now(), id)
	if e != nil {
		release()
		return j, e
	}
	s.launch(id, j.Mode, p, release)
	return s.Job(ctx, id)
}

// launch is called with mu held; cancellation never releases maintenance early.
func (s *Service) launch(id, mode string, p Profile, release func()) {
	ctx, cancel := context.WithCancel(s.ctx)
	s.cancel = cancel
	s.running = true
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()
		defer func() { release(); s.mu.Lock(); s.cancel = nil; s.running = false; s.mu.Unlock() }()
		e := s.run(ctx, id, mode, p)
		finalCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		status, message := "completed", ""
		if e != nil {
			status = "failed"
			message = "SCAN_FAILED"
			if ctx.Err() != nil {
				status = "paused"
				message = "SCAN_INTERRUPTED"
			}
		}
		_, _ = s.db.ExecContext(finalCtx, "UPDATE duplicate_jobs SET status=?,error=?,updated_at=? WHERE id=? AND status='running'", status, message, now(), id)
	}()
}
func (s *Service) run(ctx context.Context, id, mode string, p Profile) error {
	key := pipelineKey(mode, p)
	for {
		if e := ctx.Err(); e != nil {
			return e
		}
		var pid, checksum, owner, revision string
		e := s.db.QueryRowContext(ctx, `SELECT i.photo_id,i.checksum,i.owner_id,coalesce(p.source_revision,'') FROM duplicate_job_items i
  LEFT JOIN photos p ON p.id=i.photo_id WHERE i.job_id=? AND i.status='pending' ORDER BY i.photo_id LIMIT 1`, id).Scan(&pid, &checksum, &owner, &revision)
		if errors.Is(e, sql.ErrNoRows) {
			break
		}
		if e != nil {
			return e
		}
		status, message := "done", ""
		var valid, cached bool
		e = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM photos WHERE id=? AND checksum=? AND owner_id=? AND source_revision=? AND deleted_at IS NULL AND scan_status='indexed'),
  EXISTS(SELECT 1 FROM duplicate_features WHERE photo_id=? AND checksum=? AND owner_id=? AND pipeline=?)`, pid, checksum, owner, revision, pid, checksum, owner, key).Scan(&valid, &cached)
		if e != nil {
			return e
		}
		if !valid {
			status = "skipped"
		} else if !cached {
			raw, e := s.preview(ctx, pid)
			var h uint64
			var sharp, exposure float64
			var vector []byte
			local := ""
			if e == nil {
				h, sharp, exposure, e = analyzePreview(raw)
			}
			if e == nil && mode == "ai" {
				var a Analysis
				a, e = s.worker.Analyze(ctx, pid, p, raw)
				if e == nil {
					vector = vectorBytes(a.Vector)
					local = string(a.Local)
				}
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if e != nil {
				status = "failed"
				message = "ANALYSIS_FAILED"
			} else {
				// Commit only if the input remained valid while preview/inference ran.
				result, e := s.db.ExecContext(ctx, `INSERT INTO duplicate_features(photo_id,checksum,owner_id,pipeline,phash,sharpness,exposure,embedding,local_features)
    SELECT id,checksum,owner_id,?,?,?,?,?,? FROM photos WHERE id=? AND checksum=? AND owner_id=? AND source_revision=? AND deleted_at IS NULL AND scan_status='indexed'
    ON CONFLICT(photo_id,pipeline) DO UPDATE SET checksum=excluded.checksum,owner_id=excluded.owner_id,phash=excluded.phash,sharpness=excluded.sharpness,exposure=excluded.exposure,embedding=excluded.embedding,local_features=excluded.local_features`, key, fmt.Sprintf("%016x", h), sharp, exposure, vector, local, pid, checksum, owner, revision)
				if e != nil {
					return e
				}
				if n, _ := result.RowsAffected(); n == 0 {
					status = "skipped"
				}
			}
		}
		tx, e := s.db.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, "UPDATE duplicate_job_items SET status=?,error=? WHERE job_id=? AND photo_id=?", status, message, id, pid)
		if e == nil {
			_, e = tx.ExecContext(ctx, `UPDATE duplicate_jobs SET processed=processed+1,failed=failed+?,updated_at=? WHERE id=?`, boolInt(status == "failed"), now(), id)
		}
		if e == nil {
			e = tx.Commit()
		}
		_ = tx.Rollback()
		if e != nil {
			return e
		}
	}
	return s.match(ctx, mode, p, key)
}
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Service) loadFeatures(ctx context.Context, key, owner string) ([]feature, error) {
	rows, e := s.db.QueryContext(ctx, `SELECT f.photo_id,f.owner_id,f.checksum,f.phash,f.sharpness,f.exposure,f.embedding,p.captured_at,p.captured_at_source
 FROM duplicate_features f JOIN photos p ON p.id=f.photo_id WHERE f.pipeline=? AND f.owner_id=? AND p.owner_id=f.owner_id
 AND p.checksum=f.checksum AND p.deleted_at IS NULL AND p.scan_status='indexed' ORDER BY f.photo_id`, key, owner)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []feature{}
	for rows.Next() {
		var f feature
		var h string
		var raw []byte
		if e = rows.Scan(&f.ID, &f.Owner, &f.Checksum, &h, &f.Sharpness, &f.Exposure, &raw, &f.Captured, &f.CapturedSource); e != nil {
			return nil, e
		}
		f.Hash = parseHash(h)
		f.Vector = vectorFromBytes(raw)
		items = append(items, f)
	}
	return items, rows.Err()
}
func (s *Service) match(ctx context.Context, mode string, p Profile, key string) error {
	rows, e := s.db.QueryContext(ctx, "SELECT DISTINCT owner_id FROM duplicate_features WHERE pipeline=? ORDER BY owner_id", key)
	if e != nil {
		return e
	}
	owners := []string{}
	for rows.Next() {
		var owner string
		if e = rows.Scan(&owner); e != nil {
			break
		}
		owners = append(owners, owner)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return e
	}
	// Persist bounded batches under an unpublished generation. Switching the
	// visible generation is one statement, not a library-sized transaction.
	generation := randomID()
	type match struct {
		a, b, ca, cb, owner, reason string
		score                       float64
	}
	matches := []match{}
	flush := func() error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		for _, m := range matches {
			_, err = tx.ExecContext(ctx, `INSERT INTO duplicate_pairs(id,kind,photo_a,photo_b,checksum_a,checksum_b,owner_id,pipeline,generation,score,reason)
			SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM photos WHERE id=? AND checksum=? AND owner_id=? AND deleted_at IS NULL AND scan_status='indexed')
			AND EXISTS(SELECT 1 FROM photos WHERE id=? AND checksum=? AND owner_id=? AND deleted_at IS NULL AND scan_status='indexed')`, pairID(mode, key+"@"+generation, m.a, m.b), mode, m.a, m.b, m.ca, m.cb, m.owner, key, generation, m.score, m.reason, m.a, m.ca, m.owner, m.b, m.cb, m.owner)
			if err != nil {
				return err
			}
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		matches = matches[:0]
		return nil
	}
	for _, owner := range owners {
		items, e := s.loadFeatures(ctx, key, owner)
		if e != nil {
			return e
		}
		hashes := newHashIndex()
		var vectors *vectorIndex
		if mode == "ai" {
			vectors = newVectorIndex(p.Dimension)
		}
		for i, f := range items {
			if e = ctx.Err(); e != nil {
				return e
			}
			candidates := hashes.candidates(f.Hash)
			if vectors != nil {
				for j := range vectors.candidates(f.Vector) {
					candidates[j] = true
				}
			}
			type candidate struct {
				index    int
				score    float64
				distance int
			}
			ranked := []candidate{}
			for j := range candidates {
				other := items[j]
				if other.Checksum == f.Checksum {
					continue
				}
				d := hamming(f.Hash, other.Hash)
				score := 1 - float64(d)/63
				if mode == "ai" {
					score = cosine(f.Vector, other.Vector)
					if score < .92 {
						continue
					}
				} else if d > 6 || f.Sharpness < 8 || other.Sharpness < 8 {
					continue
				}
				ranked = append(ranked, candidate{j, score, d})
			}
			sort.Slice(ranked, func(a, b int) bool {
				if ranked[a].score == ranked[b].score {
					return ranked[a].index < ranked[b].index
				}
				return ranked[a].score > ranked[b].score
			})
			if len(ranked) > 8 {
				ranked = ranked[:8]
			}
			for _, c := range ranked {
				other := items[c.index]
				reason := "visual_hash"
				if mode == "ai" {
					if c.distance <= 6 && f.Sharpness >= 8 && other.Sharpness >= 8 {
						reason = "visual_hash_ai"
					} else {
						var a, b string
						if e = s.db.QueryRowContext(ctx, "SELECT local_features FROM duplicate_features WHERE photo_id=? AND pipeline=?", f.ID, key).Scan(&a); e != nil {
							return e
						}
						if e = s.db.QueryRowContext(ctx, "SELECT local_features FROM duplicate_features WHERE photo_id=? AND pipeline=?", other.ID, key).Scan(&b); e != nil {
							return e
						}
						verified, e := s.worker.Verify(ctx, p, a, b)
						if e != nil {
							return e
						}
						if verified {
							reason = "local_features"
						} else if burst(f, other) {
							reason = "burst"
						} else {
							continue
						}
					}
				}
				matches = append(matches, match{other.ID, f.ID, other.Checksum, f.Checksum, owner, reason, c.score})
				if len(matches) >= 200 {
					if e = flush(); e != nil {
						return e
					}
				}
			}
			hashes.add(f.Hash, i)
			if vectors != nil {
				vectors.add(f.Vector, i)
			}
		}
	}
	if len(matches) > 0 {
		if e = flush(); e != nil {
			return e
		}
	}
	_, e = s.db.ExecContext(ctx, "INSERT INTO duplicate_pair_generations(kind,generation) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET generation=excluded.generation", mode, generation)
	if e != nil {
		return e
	}
	for {
		result, err := s.db.ExecContext(ctx, "DELETE FROM duplicate_pairs WHERE id IN (SELECT id FROM duplicate_pairs WHERE kind=? AND generation!=? LIMIT 500)", mode, generation)
		if err != nil {
			return err
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			return nil
		}
	}
}

func burst(a, b feature) bool {
	if a.CapturedSource != "exif" || b.CapturedSource != "exif" {
		return false
	}
	ta, e := time.Parse(time.RFC3339Nano, a.Captured)
	if e != nil {
		return false
	}
	tb, e := time.Parse(time.RFC3339Nano, b.Captured)
	if e != nil {
		return false
	}
	d := ta.Sub(tb)
	return d >= -3*time.Second && d <= 3*time.Second
}
