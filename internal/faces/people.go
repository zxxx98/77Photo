package faces

import (
	"context"
	"strings"
	"unicode/utf8"
)

type Person struct {
	ID       string `json:"id"`
	Owner    string `json:"owner_id"`
	Name     string `json:"name"`
	Revision int    `json:"revision"`
	Count    int    `json:"photo_count"`
	Cover    string `json:"cover_face_id"`
}
type FaceView struct {
	Owner    string     `json:"owner_id"`
	ID       string     `json:"id"`
	PhotoID  string     `json:"photo_id"`
	PersonID string     `json:"person_id"`
	Filename string     `json:"filename"`
	Revision int        `json:"revision"`
	Ignored  bool       `json:"ignored"`
	Box      [4]float64 `json:"bbox"`
}

const validFace = ` p.deleted_at IS NULL AND p.scan_status='indexed' AND a.checksum=p.checksum AND a.owner_id=p.owner_id `

func (s *Service) People(ctx context.Context, cursor string) ([]Person, string, error) {
	rows, e := s.db.QueryContext(ctx, `SELECT pe.id,pe.owner_id,pe.name,pe.revision,count(DISTINCT p.id),min(f.id) FROM people pe
 JOIN faces f ON f.person_id=pe.id JOIN face_analyses a ON a.id=f.analysis_id JOIN photos p ON p.id=a.photo_id
 WHERE pe.merged_into IS NULL AND f.ignored=0 AND pe.id>? AND `+validFace+` GROUP BY pe.id ORDER BY pe.id LIMIT 101`, cursor)
	if e != nil {
		return nil, "", e
	}
	defer rows.Close()
	out := []Person{}
	for rows.Next() {
		var x Person
		if e = rows.Scan(&x.ID, &x.Owner, &x.Name, &x.Revision, &x.Count, &x.Cover); e != nil {
			return nil, "", e
		}
		out = append(out, x)
	}
	next := ""
	if len(out) > 100 {
		out = out[:100]
		next = out[99].ID
	}
	return out, next, rows.Err()
}
func (s *Service) FaceList(ctx context.Context, person, cursor string) ([]FaceView, string, error) {
	predicate := "f.person_id=? AND f.ignored=0"
	if person == "unassigned" {
		predicate = "(f.person_id IS NULL OR f.ignored=1) AND ?='unassigned'"
	}
	rows, e := s.db.QueryContext(ctx, `SELECT f.id,p.id,p.owner_id,coalesce(f.person_id,''),p.filename,f.revision,f.ignored,f.x,f.y,f.width,f.height FROM faces f JOIN face_analyses a ON a.id=f.analysis_id JOIN photos p ON p.id=a.photo_id WHERE `+predicate+` AND f.id>? AND `+validFace+` ORDER BY f.id LIMIT 26`, person, cursor)
	if e != nil {
		return nil, "", e
	}
	defer rows.Close()
	out := []FaceView{}
	for rows.Next() {
		var x FaceView
		if e = rows.Scan(&x.ID, &x.PhotoID, &x.Owner, &x.PersonID, &x.Filename, &x.Revision, &x.Ignored, &x.Box[0], &x.Box[1], &x.Box[2], &x.Box[3]); e != nil {
			return nil, "", e
		}
		out = append(out, x)
	}
	next := ""
	if len(out) > 25 {
		out = out[:25]
		next = out[24].ID
	}
	return out, next, rows.Err()
}
func (s *Service) Rename(ctx context.Context, pid, name string, revision int) error {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > 80 {
		return ErrInvalid
	}
	r, e := s.db.ExecContext(ctx, "UPDATE people SET name=?,revision=revision+1 WHERE id=? AND revision=? AND merged_into IS NULL", name, pid, revision)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n != 1 {
		return ErrConflict
	}
	return nil
}
func (s *Service) Merge(ctx context.Context, target, source string, revision, sourceRevision int) error {
	if target == source {
		return ErrInvalid
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var owner string
	e = tx.QueryRowContext(ctx, "SELECT owner_id FROM people WHERE id=? AND revision=? AND merged_into IS NULL", target, revision).Scan(&owner)
	if e != nil {
		return ErrConflict
	}
	var same string
	e = tx.QueryRowContext(ctx, "SELECT owner_id FROM people WHERE id=? AND revision=? AND merged_into IS NULL", source, sourceRevision).Scan(&same)
	if e != nil || same != owner {
		return ErrConflict
	}
	// An explicit merge overrides old exclusions against the target for these faces.
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"DELETE FROM face_exclusions WHERE person_id=? AND face_id IN (SELECT id FROM faces WHERE person_id=?)", []any{target, source}},
		{"INSERT OR IGNORE INTO face_exclusions(face_id,person_id) SELECT face_id,? FROM face_exclusions WHERE person_id=? AND face_id NOT IN (SELECT id FROM faces WHERE person_id IN (?,?))", []any{target, source, target, source}},
		{"DELETE FROM face_exclusions WHERE person_id=?", []any{source}},
		{"UPDATE faces SET person_id=?,manual=1,revision=revision+1 WHERE person_id=?", []any{target, source}},
		{"UPDATE people SET merged_into=?,revision=revision+1 WHERE id=?", []any{target, source}},
		{"UPDATE people SET revision=revision+1 WHERE id=?", []any{target}},
	} {
		if _, e = tx.ExecContext(ctx, q.sql, q.args...); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func (s *Service) Assign(ctx context.Context, fid, person string, ignored bool, revision int) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var owner, old string
	e = tx.QueryRowContext(ctx, `SELECT a.owner_id,coalesce(f.person_id,'') FROM faces f JOIN face_analyses a ON a.id=f.analysis_id JOIN photos p ON p.id=a.photo_id WHERE f.id=? AND f.revision=? AND `+validFace, fid, revision).Scan(&owner, &old)
	if e != nil {
		return ErrConflict
	}
	if ignored {
		person = old
	} else if person == "" {
		person = id("pe_")
		_, e = tx.ExecContext(ctx, "INSERT INTO people(id,owner_id,created_at) VALUES(?,?,?)", person, owner, now())
		if e != nil {
			return e
		}
	} else {
		var o string
		e = tx.QueryRowContext(ctx, "SELECT owner_id FROM people WHERE id=? AND merged_into IS NULL", person).Scan(&o)
		if e != nil || o != owner {
			return ErrInvalid
		}
	}
	if old != "" && old != person {
		if _, e = tx.ExecContext(ctx, "INSERT OR IGNORE INTO face_exclusions(face_id,person_id) VALUES(?,?)", fid, old); e != nil {
			return e
		}
	}
	if _, e = tx.ExecContext(ctx, "DELETE FROM face_exclusions WHERE face_id=? AND person_id=?", fid, person); e != nil {
		return e
	}
	var value any
	if person != "" {
		value = person
	}
	if _, e = tx.ExecContext(ctx, "UPDATE faces SET person_id=?,ignored=?,manual=1,revision=revision+1 WHERE id=?", value, ignored, fid); e != nil {
		return e
	}
	_, e = tx.ExecContext(ctx, "UPDATE people SET revision=revision+1 WHERE id IN (?,?)", old, person)
	if e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Service) facePhoto(ctx context.Context, fid string) (string, [4]float64, error) {
	var pid string
	var b [4]float64
	e := s.db.QueryRowContext(ctx, `SELECT p.id,f.x,f.y,f.width,f.height FROM faces f JOIN face_analyses a ON a.id=f.analysis_id JOIN photos p ON p.id=a.photo_id WHERE f.id=? AND `+validFace, fid).Scan(&pid, &b[0], &b[1], &b[2], &b[3])
	return pid, b, e
}
