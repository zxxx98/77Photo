package users

import (
	"bytes"
	"context"
	"image"
	"image/jpeg"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestTransferredTrashRestoresUnderNewOwner(t *testing.T) {
	s, _, admin := newUserService(t)
	ctx := context.Background()
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	s.SetStorage(store)
	alice, err := s.Create(ctx, admin, CreateInput{Username: "alice", Password: "a secure alice password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	bob, err := s.Create(ctx, admin, CreateInput{Username: "bob", Password: "a secure bob password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	owner := acl.Principal{UserID: alice.ID, Role: acl.RoleUser}
	folder, err := folders.NewService(s.db, store).Create(ctx, owner, folders.CreateInput{Name: "Memories"})
	if err != nil {
		t.Fatal(err)
	}
	var data bytes.Buffer
	if err := jpeg.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	pservice := photos.NewService(s.db, store, 1<<20)
	p, err := pservice.Upload(ctx, owner, photos.UploadInput{FolderID: folder.ID, Filename: "old.jpg", DeclaredMIME: "image/jpeg", Body: &data})
	if err != nil {
		t.Fatal(err)
	}
	if err := pservice.Delete(ctx, owner, p.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, admin, alice.ID, DeleteInput{PhotoAction: "transfer", TransferToUserID: bob.ID}); err != nil {
		t.Fatal(err)
	}
	newOwner := acl.Principal{UserID: bob.ID, Role: acl.RoleUser}
	page, err := pservice.ListTrash(ctx, newOwner, "", 50, false)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("transferred trash: %+v %v", page, err)
	}
	restored, err := pservice.RestoreTrash(ctx, newOwner, p.ID, photos.RestoreInput{})
	if err != nil {
		t.Fatal(err)
	}
	if restored.OwnerID != bob.ID || !strings.HasPrefix(restored.StoragePath, "users/"+bob.ID+"/") {
		t.Fatalf("restored owner/path: %+v", restored)
	}
	digest, _, err := store.FileDigest(restored.StoragePath)
	if err != nil || digest != p.Checksum {
		t.Fatalf("lost transferred original: %s %v", digest, err)
	}
}
