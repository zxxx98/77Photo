package photos

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
)

// BBox is a geographic box in degrees, ordered west, south, east, north as in
// GeoJSON. West greater than east means the box crosses the antimeridian.
type BBox struct {
	West, South, East, North float64
}

// ParseBBox parses the "west,south,east,north" query form.
func ParseBBox(value string) (BBox, error) {
	parts := strings.Split(value, ",")
	if len(parts) != 4 {
		return BBox{}, ErrInvalidFilter
	}
	var numbers [4]float64
	for i, part := range parts {
		number, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
		if err != nil {
			return BBox{}, ErrInvalidFilter
		}
		numbers[i] = number
	}
	box := BBox{West: numbers[0], South: numbers[1], East: numbers[2], North: numbers[3]}
	if !box.Valid() {
		return BBox{}, ErrInvalidFilter
	}
	return box, nil
}

// Valid reports whether every edge is finite and inside the coordinate range.
func (b BBox) Valid() bool {
	for _, value := range []float64{b.West, b.South, b.East, b.North} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return b.South >= -90 && b.North <= 90 && b.South <= b.North &&
		b.West >= -180 && b.West <= 180 && b.East >= -180 && b.East <= 180
}

// String is the canonical form bound into pagination cursors.
func (b BBox) String() string {
	values := []float64{b.West, b.South, b.East, b.North}
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = strconv.FormatFloat(value, 'f', -1, 64)
	}
	return strings.Join(parts, ",")
}

func appendBBoxPredicate(where *[]string, args *[]any, box *BBox) {
	if box == nil {
		return
	}
	// Both range forms are false for NULL, so unlocated photos drop out.
	*where = append(*where, "p.gps_latitude BETWEEN ? AND ?")
	*args = append(*args, box.South, box.North)
	if box.West <= box.East {
		*where = append(*where, "p.gps_longitude BETWEEN ? AND ?")
	} else {
		*where = append(*where, "(p.gps_longitude>=? OR p.gps_longitude<=?)")
	}
	*args = append(*args, box.West, box.East)
}

// MapPoint is a located photo as drawn on the map.
type MapPoint struct {
	ID         string
	Latitude   float64
	Longitude  float64
	CapturedAt string
}

// MapPoints is every located photo a principal can see, newest first, plus
// the number of visible photos overall so clients can report coverage.
type MapPoints struct {
	Items       []MapPoint
	TotalPhotos int
}

// MapPoints loads the whole located set in one query. Clients cluster and
// filter it locally, so panning and zooming never hit the server.
func (s *Service) MapPoints(ctx context.Context, principal acl.Principal) (MapPoints, error) {
	where := []string{"p.deleted_at IS NULL", "p.scan_status='indexed'"}
	args := make([]any, 0, 2)
	appendVisibilityPredicate(&where, &args, principal, s.authorizer != nil)
	var result MapPoints
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM photos p WHERE "+strings.Join(where, " AND "), args...).Scan(&result.TotalPhotos); err != nil {
		return MapPoints{}, fmt.Errorf("count visible photos: %w", err)
	}
	where = append(where, "p.gps_latitude IS NOT NULL", "p.gps_longitude IS NOT NULL")
	rows, err := s.db.QueryContext(ctx, "SELECT p.id, p.gps_latitude, p.gps_longitude, p.captured_at FROM photos p WHERE "+strings.Join(where, " AND ")+" ORDER BY p.captured_at DESC, p.id DESC", args...)
	if err != nil {
		return MapPoints{}, fmt.Errorf("list map points: %w", err)
	}
	defer rows.Close()
	result.Items = make([]MapPoint, 0, 256)
	for rows.Next() {
		var point MapPoint
		if err := rows.Scan(&point.ID, &point.Latitude, &point.Longitude, &point.CapturedAt); err != nil {
			return MapPoints{}, fmt.Errorf("scan map point: %w", err)
		}
		result.Items = append(result.Items, point)
	}
	if err := rows.Err(); err != nil {
		return MapPoints{}, fmt.Errorf("list map points: %w", err)
	}
	return result, nil
}

// MarshalJSON writes each item as a compact [id, latitude, longitude,
// captured_at] array. Coordinates are rounded to six decimals (about 0.1 m);
// a large library sends tens of thousands of points in one response.
func (m MapPoints) MarshalJSON() ([]byte, error) {
	buf := make([]byte, 0, 64+72*len(m.Items))
	buf = append(buf, `{"items":[`...)
	for i, point := range m.Items {
		if i > 0 {
			buf = append(buf, ',')
		}
		buf = append(buf, '[')
		buf = appendJSONString(buf, point.ID)
		buf = append(buf, ',')
		buf = strconv.AppendFloat(buf, roundCoordinate(point.Latitude), 'f', -1, 64)
		buf = append(buf, ',')
		buf = strconv.AppendFloat(buf, roundCoordinate(point.Longitude), 'f', -1, 64)
		buf = append(buf, ',')
		buf = appendJSONString(buf, point.CapturedAt)
		buf = append(buf, ']')
	}
	buf = append(buf, `],"total_photos":`...)
	buf = strconv.AppendInt(buf, int64(m.TotalPhotos), 10)
	return append(buf, '}'), nil
}

func roundCoordinate(value float64) float64 {
	return math.Round(value*1e6) / 1e6
}

// appendJSONString copies IDs and timestamps directly; they are plain ASCII.
// Anything else goes through the standard encoder for correct escaping.
func appendJSONString(buf []byte, value string) []byte {
	for i := 0; i < len(value); i++ {
		if c := value[i]; c < 0x20 || c > 0x7e || c == '"' || c == '\\' || c == '<' || c == '>' || c == '&' {
			encoded, _ := json.Marshal(value)
			return append(buf, encoded...)
		}
	}
	buf = append(buf, '"')
	buf = append(buf, value...)
	return append(buf, '"')
}
