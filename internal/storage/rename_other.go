//go:build !linux

package storage

func renameNoReplace(oldPath, newPath string) error {
	return renameNoReplaceFallback(oldPath, newPath)
}
