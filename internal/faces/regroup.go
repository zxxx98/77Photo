package faces

import (
	"context"
	"database/sql"
	"errors"
)

// regroupOne reapplies the current matching policy to saved embeddings. Face
// IDs, boxes, exclusions and manually confirmed assignments remain unchanged.
func (s *Service) regroupOne(ctx context.Context, jid string, profile Profile, pid, checksum, owner string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var analysisID string
	err = tx.QueryRowContext(ctx, `SELECT a.id FROM face_analyses a JOIN photos p ON p.id=a.photo_id
 JOIN face_jobs j ON j.id=? WHERE p.id=? AND p.checksum=? AND p.owner_id=? AND p.deleted_at IS NULL
 AND p.scan_status='indexed' AND j.status='running' AND a.checksum=p.checksum AND a.owner_id=p.owner_id AND a.pipeline_id=?`, jid, pid, checksum, owner, profile.Pipeline).Scan(&analysisID)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.ExecContext(ctx, "UPDATE face_items SET status='skipped',error='PHOTO_CHANGED' WHERE job_id=? AND photo_id=? AND status='pending'", jid, pid)
		if err != nil {
			return err
		}
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	type savedFace struct {
		id, person                       string
		blob                             []byte
		manual, ignored, named, excluded bool
	}
	rows, err := tx.QueryContext(ctx, `SELECT f.id,coalesce(f.person_id,''),f.embedding,f.manual,f.ignored,
 coalesce(pe.name,'')<>'',EXISTS(SELECT 1 FROM face_exclusions x WHERE x.face_id=f.id)
 FROM faces f LEFT JOIN people pe ON pe.id=f.person_id WHERE f.analysis_id=? ORDER BY f.face_index`, analysisID)
	if err != nil {
		return err
	}
	faces := []savedFace{}
	for rows.Next() {
		var f savedFace
		if err = rows.Scan(&f.id, &f.person, &f.blob, &f.manual, &f.ignored, &f.named, &f.excluded); err != nil {
			break
		}
		faces = append(faces, f)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	used := map[string]bool{}
	for _, face := range faces {
		if (face.manual || face.ignored || face.named || face.excluded) && face.person != "" {
			used[face.person] = true
		}
	}
	for _, face := range faces {
		if face.manual || face.ignored || face.named || face.excluded || len(face.blob) != profile.Dimension*4 {
			continue
		}
		person, e := s.match(ctx, tx, owner, pid, jid, true, decodeVector(face.blob), used)
		if e != nil {
			return e
		}
		if person == "" {
			person = id("pe_")
			if _, e = tx.ExecContext(ctx, "INSERT INTO people(id,owner_id,created_at) VALUES(?,?,?)", person, owner, now()); e != nil {
				return e
			}
		}
		used[person] = true
		if person != face.person {
			if _, e = tx.ExecContext(ctx, "UPDATE faces SET person_id=?,revision=revision+1 WHERE id=?", person, face.id); e != nil {
				return e
			}
		}
	}
	_, err = tx.ExecContext(ctx, "UPDATE face_items SET status='succeeded',error='' WHERE job_id=? AND photo_id=? AND status='pending'", jid, pid)
	if err != nil {
		return err
	}
	return tx.Commit()
}
