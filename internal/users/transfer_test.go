package users

import (
	"bytes"
	"context"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestDeleteWithTransferMovesFilesIntoRecipientRoot(t *testing.T) {
	service, _, admin := newUserService(t)
	ctx := context.Background()
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	service.SetStorage(store)

	alice, err := service.Create(ctx, admin, CreateInput{Username: "alice", Password: "alice's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	bob, err := service.Create(ctx, admin, CreateInput{Username: "bob", Password: "bob's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	alicePrincipal := acl.Principal{UserID: alice.ID, Role: acl.RoleUser}
	folder, err := folders.NewService(service.db, store).Create(ctx, alicePrincipal, folders.CreateInput{Name: "Trip"})
	if err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	photo, err := photos.NewService(service.db, store, 1<<20).Upload(ctx, alicePrincipal, photos.UploadInput{FolderID: folder.ID, Filename: "beach.jpg", DeclaredMIME: "image/jpeg", Body: &encoded})
	if err != nil {
		t.Fatal(err)
	}
	// Bob already has an unindexed "Trip" directory on disk.
	if err := store.MakeDir("users/" + bob.ID + "/Trip"); err != nil {
		t.Fatal(err)
	}

	if err := service.Delete(ctx, admin, alice.ID, DeleteInput{PhotoAction: "transfer", TransferToUserID: bob.ID}); err != nil {
		t.Fatalf("Delete(transfer) error = %v", err)
	}

	var owner, photoPath string
	if err := service.db.QueryRowContext(ctx, "SELECT owner_id, storage_path FROM photos WHERE id=?", photo.ID).Scan(&owner, &photoPath); err != nil {
		t.Fatal(err)
	}
	wantPrefix := "users/" + bob.ID + "/Trip (2)/"
	if owner != bob.ID || !strings.HasPrefix(photoPath, wantPrefix) {
		t.Fatalf("photo owner=%s path=%s, want bob under %s", owner, photoPath, wantPrefix)
	}
	resolved, err := store.ResolvePath(photoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(resolved); err != nil {
		t.Fatalf("transferred original missing on disk: %v", err)
	}
	var folderName, folderPath string
	if err := service.db.QueryRowContext(ctx, "SELECT name, storage_path FROM folders WHERE id=?", folder.ID).Scan(&folderName, &folderPath); err != nil {
		t.Fatal(err)
	}
	if folderName != "Trip (2)" || folderPath != "users/"+bob.ID+"/Trip (2)" {
		t.Fatalf("folder = %q at %q", folderName, folderPath)
	}
	if _, err := os.Stat(filepath.Join(store.Root(), "users", alice.ID)); !os.IsNotExist(err) {
		t.Fatalf("deleted user's root still present: %v", err)
	}
}
