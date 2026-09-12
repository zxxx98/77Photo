package photos

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestListPhotosUsesStableCursorWithoutDuplicates(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	for index, name := range []string{"one.jpg", "two.jpg", "three.jpg"} {
		if _, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: name, DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2+index, 2)), Conflict: ConflictRename}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.service.db.Exec("UPDATE photos SET captured_at=?", "2026-09-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	first, err := fixture.service.List(ctx, fixture.principal, ListFilter{FolderID: &fixture.folderID, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || first.NextCursor == nil {
		t.Fatalf("first page = (%d, %v), want two items and cursor", len(first.Items), first.NextCursor)
	}
	second, err := fixture.service.List(ctx, fixture.principal, ListFilter{FolderID: &fixture.folderID, Limit: 2, Cursor: *first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID || second.Items[0].ID == first.Items[1].ID {
		t.Fatalf("second page = %+v, contains duplicate or wrong count", second.Items)
	}
	if second.NextCursor != nil {
		t.Fatalf("final cursor = %v, want null", second.NextCursor)
	}
}

func TestListPhotosRejectsTamperedCursor(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	if _, err := fixture.service.List(context.Background(), fixture.principal, ListFilter{Cursor: "this-is-not-a-valid-signed-cursor"}); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("List(tampered cursor) error = %v, want ErrInvalidCursor", err)
	}
}

func TestListPhotosRejectsCursorBoundToDifferentFilter(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	for index, name := range []string{"one.jpg", "two.jpg"} {
		if _, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: name, DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2+index, 2))}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := fixture.service.List(ctx, fixture.principal, ListFilter{FolderID: &fixture.folderID, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if first.NextCursor == nil {
		t.Fatal("first page cursor = nil, want cursor")
	}
	if _, err := fixture.service.List(ctx, fixture.principal, ListFilter{Limit: 1, Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("List(different filter) error = %v, want ErrInvalidCursor", err)
	}
}
