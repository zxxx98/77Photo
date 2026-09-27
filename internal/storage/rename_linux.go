package storage

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// renameNoReplace atomically renames oldPath to newPath, failing with
// os.ErrExist if newPath already exists.
func renameNoReplace(oldPath, newPath string) error {
	err := unix.Renameat2(unix.AT_FDCWD, oldPath, unix.AT_FDCWD, newPath, unix.RENAME_NOREPLACE)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, unix.EEXIST):
		return os.ErrExist
	case errors.Is(err, unix.EINVAL), errors.Is(err, unix.ENOSYS), errors.Is(err, unix.ENOTSUP):
		// Some filesystems (network/FUSE mounts) do not support the flag.
		return renameNoReplaceFallback(oldPath, newPath)
	default:
		return &os.LinkError{Op: "rename", Old: oldPath, New: newPath, Err: err}
	}
}
