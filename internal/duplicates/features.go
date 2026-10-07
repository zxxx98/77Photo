package duplicates

import (
	"bytes"
	"encoding/binary"
	"image"
	_ "image/jpeg"
	"math"
	"math/bits"
	"sort"
	"strconv"

	"golang.org/x/image/draw"
)

const perceptualPipeline = "phash-dct32-quality-v1"

var dctBasis = func() [8][32]float64 {
	var basis [8][32]float64
	for frequency := range basis {
		for pixel := range basis[frequency] {
			basis[frequency][pixel] = math.Cos(float64((2*pixel+1)*frequency) * math.Pi / 64)
		}
	}
	return basis
}()

type feature struct {
	ID, Owner, Checksum, Captured, CapturedSource, Local string
	Hash                                                 uint64
	Sharpness, Exposure                                  float64
	Vector                                               []float32
}

// pHash uses the median of the 63 AC coefficients, so exposure shifts do not
// dominate the fingerprint. Quality is measured on a fixed-size preview.
func analyzePreview(raw []byte) (uint64, float64, float64, error) {
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return 0, 0, 0, err
	}
	gray := image.NewGray(image.Rect(0, 0, 32, 32))
	draw.CatmullRom.Scale(gray, gray.Bounds(), src, src.Bounds(), draw.Src, nil)
	coeff := make([]float64, 64)
	for v := 0; v < 8; v++ {
		for u := 0; u < 8; u++ {
			sum := 0.0
			for y := 0; y < 32; y++ {
				for x := 0; x < 32; x++ {
					sum += float64(gray.GrayAt(x, y).Y) * dctBasis[u][x] * dctBasis[v][y]
				}
			}
			coeff[v*8+u] = sum
		}
	}
	ordered := append([]float64{}, coeff[1:]...)
	sort.Float64s(ordered)
	median := ordered[len(ordered)/2]
	hash := uint64(0)
	for i, v := range coeff[1:] {
		if v > median {
			hash |= 1 << i
		}
	}
	quality := image.NewGray(image.Rect(0, 0, 256, 256))
	draw.CatmullRom.Scale(quality, quality.Bounds(), src, src.Bounds(), draw.Src, nil)
	sum, squares := 0.0, 0.0
	clipped := 0
	for y := 1; y < 255; y++ {
		for x := 1; x < 255; x++ {
			c := float64(quality.GrayAt(x, y).Y)
			lap := 4*c - float64(quality.GrayAt(x-1, y).Y) - float64(quality.GrayAt(x+1, y).Y) - float64(quality.GrayAt(x, y-1).Y) - float64(quality.GrayAt(x, y+1).Y)
			sum += lap
			squares += lap * lap
			if c < 8 || c > 247 {
				clipped++
			}
		}
	}
	n := float64(254 * 254)
	return hash, math.Max(0, squares/n-(sum/n)*(sum/n)), 1 - float64(clipped)/n, nil
}

func vectorBytes(v []float32) []byte {
	raw := make([]byte, len(v)*4)
	for i, x := range v {
		binary.LittleEndian.PutUint32(raw[i*4:], math.Float32bits(x))
	}
	return raw
}
func vectorFromBytes(raw []byte) []float32 {
	v := make([]float32, len(raw)/4)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
	}
	return v
}
func cosine(a, b []float32) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return -1
	}
	s := 0.0
	for i := range a {
		s += float64(a[i]) * float64(b[i])
	}
	return math.Min(1, math.Max(-1, s))
}
func parseHash(s string) uint64 { h, _ := strconv.ParseUint(s, 16, 64); return h }

// A multi-index splits a 63-bit hash into seven disjoint parts. At distance
// <=6, at least one part must match. Buckets are capped to keep flat scenes
// and enormous bursts from generating quadratic candidate lists.
type hashIndex [7]map[uint64][]int

func newHashIndex() hashIndex {
	var h hashIndex
	for i := range h {
		h[i] = map[uint64][]int{}
	}
	return h
}
func (h hashIndex) add(hash uint64, i int) {
	for part := range h {
		key := (hash >> uint(part*9)) & 511
		b := h[part][key]
		if len(b) < 128 {
			h[part][key] = append(b, i)
		}
	}
}
func (h hashIndex) candidates(hash uint64) map[int]bool {
	out := map[int]bool{}
	for part := range h {
		for _, i := range h[part][(hash>>uint(part*9))&511] {
			out[i] = true
		}
	}
	return out
}

// Deterministic random-hyperplane LSH retrieves visually close vectors without
// constructing the all-pairs similarity matrix. Probe adjacent buckets too.
type vectorIndex struct {
	buckets [6]map[uint16][]int
	planes  [6][16][]float32
}

func newVectorIndex(dim int) *vectorIndex {
	idx := &vectorIndex{}
	seed := uint64(0x77)
	for t := range idx.buckets {
		idx.buckets[t] = map[uint16][]int{}
		for b := range idx.planes[t] {
			p := make([]float32, dim)
			for d := range p {
				seed ^= seed << 13
				seed ^= seed >> 7
				seed ^= seed << 17
				if seed&1 == 0 {
					p[d] = -1
				} else {
					p[d] = 1
				}
			}
			idx.planes[t][b] = p
		}
	}
	return idx
}
func (v *vectorIndex) key(t int, x []float32) uint16 {
	var key uint16
	for b, p := range v.planes[t] {
		if cosine(x, p) > 0 {
			key |= 1 << b
		}
	}
	return key
}
func (v *vectorIndex) add(x []float32, i int) {
	for t := range v.buckets {
		k := v.key(t, x)
		b := v.buckets[t][k]
		if len(b) < 128 {
			v.buckets[t][k] = append(b, i)
		}
	}
}
func (v *vectorIndex) candidates(x []float32) map[int]bool {
	out := map[int]bool{}
	for t := range v.buckets {
		k := v.key(t, x)
		for _, i := range v.buckets[t][k] {
			out[i] = true
		}
		for b := 0; b < 16; b++ {
			for _, i := range v.buckets[t][k^(1<<b)] {
				out[i] = true
			}
		}
	}
	return out
}
func hamming(a, b uint64) int { return bits.OnesCount64(a ^ b) }
