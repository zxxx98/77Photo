package importer

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/zxxx98/77Photo/internal/media"
	"github.com/zxxx98/77Photo/internal/photos"
)

// A Live pair follows the still's timestamp, even when its video was exported
// on another day. Reserve basenames (not just filenames) to prevent unrelated
// files from becoming false Live pairs after flattening source directories.
func (s *Service) organizeGroup(ctx context.Context, userID string, group []fileMove, reserved map[string]map[string]bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	primary := group[0].source
	for _, move := range group {
		if strings.HasPrefix(media.MIMEForExtension(move.source), "image/") {
			primary = move.source
			break
		}
	}
	path, err := s.storage.ResolvePath(primary)
	if err != nil {
		return err
	}
	captured, err := photos.CaptureTime(path, media.MIMEForExtension(primary), s.mediaTools)
	if err != nil {
		return err
	}
	directory := filepath.ToSlash(filepath.Join("users", userID, "Imported", captured.UTC().Format("2006/01/02")))
	used, ok := reserved[directory]
	if !ok {
		used = make(map[string]bool)
		absolute, err := s.storage.ResolvePath(directory)
		if err != nil {
			return err
		}
		entries, err := os.ReadDir(absolute)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		for _, entry := range entries {
			used[strings.ToLower(strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())))] = true
		}
		reserved[directory] = used
	}
	base := strings.TrimSuffix(filepath.Base(primary), filepath.Ext(primary))
	name := base
	for suffix := 2; used[strings.ToLower(name)]; suffix++ {
		name = fmt.Sprintf("%s_%d", base, suffix)
	}
	extensions := make(map[string]bool)
	for _, move := range group {
		extension := strings.ToLower(filepath.Ext(move.source))
		if extensions[extension] {
			return fmt.Errorf("ambiguous import pair: %s", primary)
		}
		extensions[extension] = true
	}
	used[strings.ToLower(name)] = true
	for i := range group {
		group[i].destination = filepath.ToSlash(filepath.Join(directory, name+filepath.Ext(group[i].source)))
	}
	return nil
}
