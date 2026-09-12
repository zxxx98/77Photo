package storage

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	ErrInvalidPath = errors.New("invalid storage path")
	ErrOutsideRoot = errors.New("storage path escapes configured root")
	ErrInvalidName = errors.New("invalid file or folder name")
)

type Store struct {
	root string
}

func New(root string) (Store, error) {
	if strings.TrimSpace(root) == "" {
		return Store{}, fmt.Errorf("storage root must not be empty")
	}
	abs, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return Store{}, fmt.Errorf("resolve storage root: %w", err)
	}
	if err := os.MkdirAll(abs, 0o750); err != nil {
		return Store{}, fmt.Errorf("create storage root: %w", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return Store{}, fmt.Errorf("stat storage root: %w", err)
	}
	if !info.IsDir() {
		return Store{}, fmt.Errorf("storage root is not a directory")
	}
	return Store{root: abs}, nil
}

func (s Store) Root() string { return s.root }

// ResolvePath resolves a server-generated path relative to the configured
// storage root. It is intended for paths read from the database, never for
// client-supplied values.
func (s Store) ResolvePath(relative string) (string, error) {
	return s.resolveWithin(s.root, filepath.FromSlash(relative))
}

func (s Store) UserRoot(userID string) (string, error) {
	if err := validateComponent(userID); err != nil {
		return "", err
	}
	return filepath.Join(s.root, "users", userID), nil
}

func (s Store) SharedRoot(folderID string) (string, error) {
	if err := validateComponent(folderID); err != nil {
		return "", err
	}
	return filepath.Join(s.root, "shared", folderID), nil
}

func (s Store) EnsureUserRoot(userID string) error {
	root, err := s.UserRoot(userID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return fmt.Errorf("create user root: %w", err)
	}
	_, err = s.resolveWithin(root, "")
	return err
}

func (s Store) EnsureSharedRoot(folderID string) error {
	root, err := s.SharedRoot(folderID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return fmt.Errorf("create shared root: %w", err)
	}
	_, err = s.resolveWithin(root, "")
	return err
}

func (s Store) MakeUserDir(userID, relative string) error {
	root, err := s.UserRoot(userID)
	if err != nil {
		return err
	}
	path, err := s.resolveWithin(root, relative)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(path, 0o750); err != nil {
		return fmt.Errorf("create user directory: %w", err)
	}
	return nil
}

func (s Store) ResolveUserPath(userID, relative string) (string, error) {
	root, err := s.UserRoot(userID)
	if err != nil {
		return "", err
	}
	return s.resolveWithin(root, relative)
}

func (s Store) ResolveSharedPath(folderID, relative string) (string, error) {
	root, err := s.SharedRoot(folderID)
	if err != nil {
		return "", err
	}
	return s.resolveWithin(root, relative)
}

func (s Store) resolveWithin(root, relative string) (string, error) {
	if strings.ContainsRune(relative, '\x00') || strings.Contains(relative, "\\") || filepath.IsAbs(relative) {
		return "", ErrInvalidPath
	}
	clean := filepath.Clean(relative)
	if clean == "." {
		clean = ""
	}
	rootAbs, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return "", fmt.Errorf("resolve path root: %w", err)
	}
	candidate := filepath.Join(rootAbs, clean)
	if !isWithin(rootAbs, candidate) {
		return "", ErrOutsideRoot
	}
	rootResolved, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return "", fmt.Errorf("resolve path root symlinks: %w", err)
	}
	if info, statErr := os.Lstat(candidate); statErr == nil {
		_ = info
		resolved, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			return "", fmt.Errorf("resolve path symlinks: %w", err)
		}
		if !isWithin(rootResolved, resolved) {
			return "", ErrOutsideRoot
		}
		return candidate, nil
	} else if !os.IsNotExist(statErr) {
		return "", fmt.Errorf("inspect storage path: %w", statErr)
	}

	// The final path may not exist yet. Resolve the nearest existing ancestor
	// so a symlink inserted in any parent directory still cannot escape.
	ancestor := candidate
	for {
		if _, statErr := os.Lstat(ancestor); statErr == nil {
			resolved, evalErr := filepath.EvalSymlinks(ancestor)
			if evalErr != nil {
				return "", fmt.Errorf("resolve parent symlinks: %w", evalErr)
			}
			if !isWithin(rootResolved, resolved) {
				return "", ErrOutsideRoot
			}
			return candidate, nil
		} else if !os.IsNotExist(statErr) {
			return "", fmt.Errorf("inspect storage parent: %w", statErr)
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", ErrOutsideRoot
		}
		ancestor = parent
	}
}

func isWithin(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func ValidateName(name string) error {
	if !utf8.ValidString(name) || strings.TrimSpace(name) == "" || name == "." || name == ".." || len([]byte(name)) > 255 {
		return ErrInvalidName
	}
	for _, r := range name {
		if r == '/' || r == '\\' || r == '\x00' || unicode.IsControl(r) {
			return ErrInvalidName
		}
	}
	return nil
}

func validateComponent(value string) error {
	if value == "" || len(value) > 64 || value == "." || value == ".." {
		return ErrInvalidPath
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-' {
			return ErrInvalidPath
		}
	}
	return nil
}
