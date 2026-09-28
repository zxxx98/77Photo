package faces

import (
	"context"
	"database/sql"
	"errors"
	"sort"
)

// ErrManualFaceUnmatched leaves the old analysis intact for human review.
var ErrManualFaceUnmatched = errors.New("manually corrected face missing from rescan")

type preservedFace struct {
	id, person string
	box        [4]float64
	ignored    bool
	exclusions []string
}

func loadPreservedFaces(ctx context.Context, tx *sql.Tx, analysisID string) ([]preservedFace, error) {
	rows, err := tx.QueryContext(ctx, `SELECT f.id,coalesce(f.person_id,''),f.x,f.y,f.width,f.height,f.ignored
 FROM faces f LEFT JOIN people pe ON pe.id=f.person_id WHERE f.analysis_id=? AND
 (f.manual=1 OR f.ignored=1 OR coalesce(pe.name,'')<>'' OR EXISTS(SELECT 1 FROM face_exclusions x WHERE x.face_id=f.id))`, analysisID)
	if err != nil {
		return nil, err
	}
	faces := []preservedFace{}
	for rows.Next() {
		var f preservedFace
		if err = rows.Scan(&f.id, &f.person, &f.box[0], &f.box[1], &f.box[2], &f.box[3], &f.ignored); err != nil {
			break
		}
		faces = append(faces, f)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range faces {
		xrows, e := tx.QueryContext(ctx, "SELECT person_id FROM face_exclusions WHERE face_id=?", faces[i].id)
		if e != nil {
			return nil, e
		}
		for xrows.Next() {
			var person string
			if e = xrows.Scan(&person); e != nil {
				break
			}
			faces[i].exclusions = append(faces[i].exclusions, person)
		}
		if e == nil {
			e = xrows.Err()
		}
		xrows.Close()
		if e != nil {
			return nil, e
		}
	}
	return faces, nil
}

func overlap(a, b [4]float64) float64 {
	x1, y1 := max(a[0], b[0]), max(a[1], b[1])
	x2, y2 := min(a[0]+a[2], b[0]+b[2]), min(a[1]+a[3], b[1]+b[3])
	if x2 <= x1 || y2 <= y1 {
		return 0
	}
	intersection := (x2 - x1) * (y2 - y1)
	return intersection / (a[2]*a[3] + b[2]*b[3] - intersection)
}

// matchPreservedFaces returns the old protected face for each new detection.
// An unmatched correction aborts only that photo's replacement.
func matchPreservedFaces(old []preservedFace, fresh []Detection) ([]*preservedFace, error) {
	assigned := make([]*preservedFace, len(fresh))
	type pair struct {
		old, fresh int
		score      float64
	}
	pairs := []pair{}
	for i, face := range old {
		for j, detection := range fresh {
			if score := overlap(face.box, detection.Box); score >= .5 {
				pairs = append(pairs, pair{i, j, score})
			}
		}
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].score > pairs[j].score })
	used := make([]bool, len(old))
	for _, p := range pairs {
		if !used[p.old] && assigned[p.fresh] == nil {
			assigned[p.fresh] = &old[p.old]
			used[p.old] = true
		}
	}
	for _, found := range used {
		if !found {
			return nil, ErrManualFaceUnmatched
		}
	}
	return assigned, nil
}
