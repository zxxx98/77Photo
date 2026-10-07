// Package duplicates finds exact copies and reviewable visual similarities.
package duplicates

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/faces"
	"github.com/zxxx98/77Photo/internal/maintenance"
	"github.com/zxxx98/77Photo/internal/photos"
)

var ErrInvalid = errors.New("invalid duplicate request")
var ErrChanged = errors.New("duplicate group changed; refresh and review again")
var ErrDisabled = errors.New("AI similarity is disabled")

type Service struct {
	db      *sql.DB
	photos  *photos.Service
	preview faces.Preview
	worker  Worker
	ai      bool
	lock    *maintenance.Lock
	ctx     context.Context
	mu      sync.Mutex
	cancel  context.CancelFunc
	running bool
	wg      sync.WaitGroup
}

func NewService(ctx context.Context, db *sql.DB, p *photos.Service, preview faces.Preview, worker Worker, ai bool, lock *maintenance.Lock) (*Service, error) {
	s := &Service{db: db, photos: p, preview: preview, worker: worker, ai: ai, lock: lock, ctx: ctx}
	_, e := db.ExecContext(ctx, "UPDATE duplicate_jobs SET status='paused',error='SERVER_RESTART',updated_at=? WHERE status='running'", now())
	return s, e
}
func (s *Service) Close() {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func randomID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "dup_" + hex.EncodeToString(b[:])
}
func digest(text string) string { h := sha256.Sum256([]byte(text)); return hex.EncodeToString(h[:]) }

type Item struct {
	OwnerName string `json:"-"`
	photos.Photo
	Review     photos.DuplicateReview `json:"review"`
	FolderPath string                 `json:"folder_path"`
	Motion     bool                   `json:"is_live_photo"`
	Favorite   bool                   `json:"has_favorites"`
	Shared     bool                   `json:"has_shares"`
	Annotated  bool                   `json:"has_face_annotations"`
	Sharpness  float64                `json:"sharpness"`
	Exposure   float64                `json:"exposure"`
}
type Group struct {
	OwnerName   string  `json:"owner_name"`
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	Version     string  `json:"version"`
	Owner       string  `json:"owner_id"`
	Score       float64 `json:"score"`
	Reason      string  `json:"reason"`
	Items       []Item  `json:"items"`
	Recommended string  `json:"recommended_id"`
}
type Page struct {
	Items   []Group `json:"items"`
	Next    string  `json:"next_cursor"`
	Skipped int     `json:"skipped"`
}

func (s *Service) item(ctx context.Context, id string) (Item, error) {
	p, e := s.photos.Get(ctx, acl.Principal{Role: acl.RoleAdmin}, id)
	if e != nil {
		return Item{}, e
	}
	if p.ScanStatus != "indexed" || !strings.HasPrefix(p.MIMEType, "image/") {
		return Item{}, ErrChanged
	}
	motion, e := s.photos.DuplicateMotion(ctx, p)
	if e != nil {
		return Item{}, e
	}
	it := Item{Photo: p, Review: photos.DuplicateReview{ID: p.ID, Revision: p.SourceRevision, Checksum: p.Checksum, Motion: motion}, Motion: motion != "static"}
	e = s.db.QueryRowContext(ctx, `SELECT f.storage_path,u.username,
 EXISTS(SELECT 1 FROM photo_favorites WHERE photo_id=p.id),
 EXISTS(SELECT 1 FROM share_links WHERE resource_type='photo' AND resource_id=p.id AND revoked_at IS NULL),
 EXISTS(SELECT 1 FROM faces fa JOIN face_analyses a ON a.id=fa.analysis_id WHERE a.photo_id=p.id AND a.checksum=p.checksum AND a.owner_id=p.owner_id AND (fa.person_id IS NOT NULL OR fa.ignored=1))
 FROM photos p JOIN folders f ON f.id=p.folder_id JOIN users u ON u.id=p.owner_id WHERE p.id=? AND p.deleted_at IS NULL`, id).Scan(&it.FolderPath, &it.OwnerName, &it.Favorite, &it.Shared, &it.Annotated)
	if e != nil {
		return Item{}, e
	}
	it.FolderPath = strings.Replace(it.FolderPath, "users/"+p.OwnerID, it.OwnerName, 1)
	_ = s.db.QueryRowContext(ctx, "SELECT sharpness,exposure FROM duplicate_features WHERE photo_id=? AND checksum=? AND owner_id=? ORDER BY pipeline LIMIT 1", id, p.Checksum, p.OwnerID).Scan(&it.Sharpness, &it.Exposure)
	return it, nil
}
func finishGroup(g *Group) {
	sort.Slice(g.Items, func(i, j int) bool { return g.Items[i].ID < g.Items[j].ID })
	text := g.ID
	best := 0
	score := func(it Item) float64 {
		value := float64(it.Width)*float64(it.Height) + it.Exposure*100000 + it.Sharpness*100
		if it.Favorite {
			value += 1e14
		}
		if it.Shared {
			value += 1e13
		}
		if it.Annotated {
			value += 1e12
		}
		return value
	}
	for i, it := range g.Items {
		text += "\x00" + it.ID + "\x00" + it.SourceRevision + "\x00" + it.Checksum + "\x00" + it.Review.Motion
		if score(it) > score(g.Items[best]) {
			best = i
		}
	}
	g.Version = digest(text)
	if len(g.Items) > 0 {
		g.Recommended = g.Items[best].ID
		g.OwnerName = g.Items[0].OwnerName
	}
}

func (s *Service) Groups(ctx context.Context, kind, cursor string) (Page, error) {
	if kind == "exact" {
		return s.exactGroups(ctx, cursor)
	}
	if kind != "perceptual" && kind != "ai" {
		return Page{}, ErrInvalid
	}
	rows, e := s.db.QueryContext(ctx, `SELECT d.id,d.photo_a,d.photo_b,d.owner_id,d.score,d.reason FROM duplicate_pairs d
 JOIN duplicate_pair_generations gen ON gen.kind=d.kind AND gen.generation=d.generation
 JOIN photos a ON a.id=d.photo_a JOIN photos b ON b.id=d.photo_b
 WHERE d.kind=? AND d.id>? AND a.deleted_at IS NULL AND b.deleted_at IS NULL
 AND a.scan_status='indexed' AND b.scan_status='indexed' AND a.checksum=d.checksum_a AND b.checksum=d.checksum_b
 AND a.owner_id=d.owner_id AND b.owner_id=d.owner_id ORDER BY d.id LIMIT 21`, kind, cursor)
	if e != nil {
		return Page{}, e
	}
	type pair struct {
		id, a, b, owner, reason string
		score                   float64
	}
	pairs := []pair{}
	for rows.Next() {
		var p pair
		if e = rows.Scan(&p.id, &p.a, &p.b, &p.owner, &p.score, &p.reason); e != nil {
			break
		}
		pairs = append(pairs, p)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return Page{}, e
	}
	page := Page{Items: []Group{}}
	if len(pairs) > 20 {
		page.Next = pairs[19].id
		pairs = pairs[:20]
	}
	for _, p := range pairs {
		a, e := s.item(ctx, p.a)
		if e != nil {
			page.Skipped++
			continue
		}
		b, e := s.item(ctx, p.b)
		if e != nil {
			page.Skipped++
			continue
		}
		g := Group{ID: p.id, Owner: p.owner, Kind: kind, Score: p.score, Reason: p.reason, Items: []Item{a, b}}
		finishGroup(&g)
		page.Items = append(page.Items, g)
	}
	return page, nil
}

func (s *Service) exactGroups(ctx context.Context, cursor string) (Page, error) {
	owner, sum := "", ""
	if cursor != "" {
		raw, e := base64.RawURLEncoding.DecodeString(cursor)
		if e != nil {
			return Page{}, ErrInvalid
		}
		parts := strings.Split(string(raw), "\x00")
		if len(parts) != 2 {
			return Page{}, ErrInvalid
		}
		owner, sum = parts[0], parts[1]
	}
	rows, e := s.db.QueryContext(ctx, `SELECT owner_id,checksum FROM photos WHERE deleted_at IS NULL AND scan_status='indexed' AND mime_type LIKE 'image/%'
 AND (owner_id>? OR (owner_id=? AND checksum>?)) GROUP BY owner_id,checksum HAVING count(*)>1 ORDER BY owner_id,checksum LIMIT 11`, owner, owner, sum)
	if e != nil {
		return Page{}, e
	}
	keys := [][2]string{}
	for rows.Next() {
		var k [2]string
		if e = rows.Scan(&k[0], &k[1]); e != nil {
			break
		}
		keys = append(keys, k)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return Page{}, e
	}
	page := Page{Items: []Group{}}
	if len(keys) > 10 {
		page.Next = base64.RawURLEncoding.EncodeToString([]byte(keys[9][0] + "\x00" + keys[9][1]))
		keys = keys[:10]
	}
	for _, k := range keys {
		ids, e := s.photoIDs(ctx, k[0], k[1])
		if e != nil {
			return page, e
		}
		byMotion := map[string][]Item{}
		for _, id := range ids {
			it, e := s.item(ctx, id)
			if e != nil {
				page.Skipped++
				continue
			}
			if it.OwnerID != k[0] || it.Checksum != k[1] {
				page.Skipped++
				continue
			}
			byMotion[it.Review.Motion] = append(byMotion[it.Review.Motion], it)
		}
		motions := []string{}
		for m := range byMotion {
			motions = append(motions, m)
		}
		sort.Strings(motions)
		for _, m := range motions {
			items := byMotion[m]
			if len(items) < 2 {
				continue
			}
			g := Group{ID: "exact_" + digest(k[0]+"\x00"+k[1]+"\x00"+m), Kind: "exact", Owner: k[0], Score: 1, Reason: "identical", Items: items}
			finishGroup(&g)
			page.Items = append(page.Items, g)
		}
	}
	return page, nil
}
func (s *Service) photoIDs(ctx context.Context, owner, sum string) ([]string, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT id FROM photos WHERE owner_id=? AND checksum=? AND deleted_at IS NULL AND scan_status='indexed' AND mime_type LIKE 'image/%' ORDER BY id", owner, sum)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			return nil, e
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

type CleanupInput struct {
	GroupID string   `json:"group_id"`
	Version string   `json:"version"`
	Kind    string   `json:"kind"`
	Keep    string   `json:"keep_id"`
	Remove  []string `json:"remove_ids"`
	Confirm bool     `json:"confirm"`
}

func (s *Service) Cleanup(ctx context.Context, principal acl.Principal, in CleanupInput) (photos.BulkDeleteResult, error) {
	empty := photos.BulkDeleteResult{}
	if principal.Role != acl.RoleAdmin {
		return empty, photos.ErrForbidden
	}
	if !in.Confirm || in.Keep == "" || len(in.Remove) == 0 || len(in.Remove) > 500 {
		return empty, ErrInvalid
	}
	requestJSON, _ := json.Marshal(in)
	requestID := digest(principal.UserID + "\x00" + string(requestJSON))
	var keepJSON, removeJSON string
	var exact bool
	err := s.db.QueryRowContext(ctx, "SELECT keeper_json,remove_json,exact FROM duplicate_cleanup_requests WHERE id=?", requestID).Scan(&keepJSON, &removeJSON, &exact)
	if err == nil {
		var keep photos.DuplicateReview
		var remove []photos.DuplicateReview
		if json.Unmarshal([]byte(keepJSON), &keep) != nil || json.Unmarshal([]byte(removeJSON), &remove) != nil {
			return empty, ErrChanged
		}
		return s.photos.TrashReviewed(ctx, principal, keep, remove, exact)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return empty, err
	}
	keeper, e := s.item(ctx, in.Keep)
	if e != nil {
		return empty, e
	}
	g := Group{ID: in.GroupID, Kind: in.Kind, Owner: keeper.OwnerID}
	if in.Kind == "exact" {
		if in.GroupID != "exact_"+digest(keeper.OwnerID+"\x00"+keeper.Checksum+"\x00"+keeper.Review.Motion) {
			return empty, ErrChanged
		}
		ids, e := s.photoIDs(ctx, keeper.OwnerID, keeper.Checksum)
		if e != nil {
			return empty, e
		}
		for _, id := range ids {
			it, e := s.item(ctx, id)
			if e != nil {
				continue
			}
			if it.Review.Motion == keeper.Review.Motion {
				g.Items = append(g.Items, it)
			}
		}
	} else if in.Kind == "perceptual" || in.Kind == "ai" {
		var a, b, ca, cb, owner string
		e = s.db.QueryRowContext(ctx, "SELECT d.photo_a,d.photo_b,d.checksum_a,d.checksum_b,d.owner_id FROM duplicate_pairs d JOIN duplicate_pair_generations g ON g.kind=d.kind AND g.generation=d.generation WHERE d.id=? AND d.kind=?", in.GroupID, in.Kind).Scan(&a, &b, &ca, &cb, &owner)
		if e != nil {
			return empty, e
		}
		ia, e := s.item(ctx, a)
		if e != nil {
			return empty, e
		}
		ib, e := s.item(ctx, b)
		if e != nil {
			return empty, e
		}
		if ia.OwnerID != owner || ib.OwnerID != owner || ia.Checksum != ca || ib.Checksum != cb {
			return empty, ErrChanged
		}
		g.Items = []Item{ia, ib}
	} else {
		return empty, ErrInvalid
	}
	finishGroup(&g)
	if in.Version != g.Version {
		return empty, ErrChanged
	}
	members := map[string]photos.DuplicateReview{}
	for _, it := range g.Items {
		members[it.ID] = it.Review
	}
	keep, ok := members[in.Keep]
	if !ok {
		return empty, ErrInvalid
	}
	remove := []photos.DuplicateReview{}
	for _, id := range in.Remove {
		r, ok := members[id]
		if !ok || id == in.Keep {
			return empty, ErrInvalid
		}
		remove = append(remove, r)
	}
	keeperBytes, _ := json.Marshal(keep)
	removeBytes, _ := json.Marshal(remove)
	if _, err = s.db.ExecContext(ctx, "INSERT INTO duplicate_cleanup_requests(id,keeper_json,remove_json,exact) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING", requestID, string(keeperBytes), string(removeBytes), in.Kind == "exact"); err != nil {
		return empty, err
	}
	return s.photos.TrashReviewed(ctx, principal, keep, remove, in.Kind == "exact")
}

// Snapshot IDs are stable; matching never merges a chain of similar pairs.
func pairID(kind, pipeline, a, b string) string {
	if a > b {
		a, b = b, a
	}
	return "pair_" + digest(fmt.Sprint(kind, "\x00", pipeline, "\x00", a, "\x00", b))
}
