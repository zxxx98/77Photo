package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// FileDigest rejects symlinks so a trash manifest always describes an actual
// regular file, not a link whose target can change between moves.
func (s Store) FileDigest(relative string) (string, int64, error) {
	path, err := s.ResolvePath(relative)
	if err != nil {
		return "", 0, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", 0, err
	}
	if !info.Mode().IsRegular() {
		return "", 0, ErrInvalidPath
	}
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

// MoveFileDurable replays a journaled move safely, including a crash after
// destination creation but before source unlink. Never overwrite a destination.
func (s Store) MoveFileDurable(from, to, checksum string) error {
	source, err := s.ResolvePath(from)
	if err != nil {
		return err
	}
	destination, err := s.ResolvePath(to)
	if err != nil {
		return err
	}
	if digest, _, err := s.FileDigest(to); err == nil {
		if digest != checksum {
			return fmt.Errorf("destination changed: %w", os.ErrExist)
		}
		if digest, _, err = s.FileDigest(from); errors.Is(err, os.ErrNotExist) {
			return syncDirectories(filepath.Dir(source), filepath.Dir(destination))
		} else if err != nil {
			return err
		} else if digest != checksum {
			return fmt.Errorf("source changed")
		}
		if err := os.Remove(source); err != nil {
			return err
		}
		return syncDirectories(filepath.Dir(source), filepath.Dir(destination))
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if digest, _, err := s.FileDigest(from); err != nil {
		return err
	} else if digest != checksum {
		return fmt.Errorf("source changed")
	}
	if err := makeDirectoriesDurable(filepath.Dir(destination)); err != nil {
		return err
	}
	if err := renameNoReplace(source, destination); err == nil {
		return syncDirectories(filepath.Dir(source), filepath.Dir(destination))
	} else if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	// Cross-device moves use an exclusively created temporary file, so an
	// unrelated file beside the restore target can never be truncated.
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.CreateTemp(filepath.Dir(destination), ".77photo-moving-*")
	if err != nil {
		return err
	}
	temp := output.Name()
	defer os.Remove(temp)
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(output, h), input)
	if err == nil && hex.EncodeToString(h.Sum(nil)) != checksum {
		err = fmt.Errorf("copied source changed")
	}
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	if err != nil {
		_ = os.Remove(temp)
		return err
	}
	if closeErr != nil {
		_ = os.Remove(temp)
		return closeErr
	}
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if err := os.Chtimes(temp, info.ModTime(), info.ModTime()); err != nil {
		return err
	}
	if err := renameNoReplace(temp, destination); err != nil {
		return err
	}
	if err := syncDirectories(filepath.Dir(destination)); err != nil {
		return err
	}
	if err := os.Remove(source); err != nil {
		return err
	}
	return syncDirectories(filepath.Dir(source))
}

func (s Store) RemoveFileDurable(relative string) error {
	path, err := s.ResolvePath(relative)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDirectories(filepath.Dir(path))
}

func syncDirectories(paths ...string) error {
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		err = f.Sync()
		_ = f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// Persist each newly created directory entry before moving the only original.
func makeDirectoriesDurable(path string) error {
	if info, err := os.Stat(path); err == nil {
		if !info.IsDir() {
			return ErrInvalidPath
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	parent := filepath.Dir(path)
	if err := makeDirectoriesDurable(parent); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0o750); err != nil && !os.IsExist(err) {
		return err
	}
	return syncDirectories(parent, path)
}
