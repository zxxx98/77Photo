package acl

import "testing"

func TestOwnerAndAdminPermissions(t *testing.T) {
	owner := Principal{UserID: "alice", Role: RoleUser}
	admin := Principal{UserID: "root", Role: RoleAdmin}
	other := Principal{UserID: "bob", Role: RoleUser}
	if !CanRead(owner, "alice", "") || !CanWrite(owner, "alice", "") {
		t.Fatal("owner should have read/write access")
	}
	if !CanRead(admin, "alice", "") || !CanWrite(admin, "alice", "") || !CanManageUsers(admin) {
		t.Fatal("admin should have full access")
	}
	if CanRead(other, "alice", "") || CanWrite(other, "alice", "") {
		t.Fatal("unrelated user should have no private access")
	}
}

func TestSharedReadAndWriteBoundaries(t *testing.T) {
	member := Principal{UserID: "bob", Role: RoleUser}
	if !CanRead(member, "alice", PermissionRead) || CanWrite(member, "alice", PermissionRead) {
		t.Fatal("read share should be read-only")
	}
	if !CanRead(member, "alice", PermissionWrite) || !CanWrite(member, "alice", PermissionWrite) {
		t.Fatal("write share should allow read and write")
	}
}
