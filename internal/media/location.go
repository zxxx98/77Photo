package media

import (
	"regexp"
	"strconv"
	"strings"
)

// iso6709Degrees matches the decimal-degree form of ISO 6709 that cameras
// write into QuickTime and MP4 containers, e.g. "+31.2304+121.4737+012.345/".
// Degree-minute forms have more integer digits and deliberately do not match.
var iso6709Degrees = regexp.MustCompile(`^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?(?:CRS[A-Za-z0-9_:.]*)?/?$`)

// ParseISO6709 extracts latitude and longitude from an ISO 6709 location
// string. Altitude is ignored. Range checks are left to callers so that the
// same validation applies to EXIF and container locations.
func ParseISO6709(value string) (latitude, longitude float64, ok bool) {
	match := iso6709Degrees.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return 0, 0, false
	}
	latitude, err := strconv.ParseFloat(match[1], 64)
	if err != nil {
		return 0, 0, false
	}
	longitude, err = strconv.ParseFloat(match[2], 64)
	if err != nil {
		return 0, 0, false
	}
	return latitude, longitude, true
}
