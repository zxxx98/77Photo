package acl

// Role is intentionally small in V1. New permissions should be added here so
// every HTTP and service entry point uses the same decision functions.
type Role string

const (
	RoleAdmin Role = "admin"
	RoleUser  Role = "user"
)

type Permission string

const (
	PermissionRead  Permission = "read"
	PermissionWrite Permission = "write"
)

type Principal struct {
	UserID string
	Role   Role
}

func CanManageUsers(p Principal) bool { return p.Role == RoleAdmin }

func CanRead(p Principal, ownerID string, inherited Permission) bool {
	if p.Role == RoleAdmin || p.UserID == ownerID {
		return true
	}
	return inherited == PermissionRead || inherited == PermissionWrite
}

func CanWrite(p Principal, ownerID string, inherited Permission) bool {
	if p.Role == RoleAdmin || p.UserID == ownerID {
		return true
	}
	return inherited == PermissionWrite
}

func CanManageShare(p Principal, ownerID string) bool {
	return p.Role == RoleAdmin || p.UserID == ownerID
}
