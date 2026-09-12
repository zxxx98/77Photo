package acl

import (
	"context"
	"database/sql"
	"errors"
)

// Authorizer resolves folder permissions from the owner and any share on the
// folder or one of its ancestors. The closest/highest permission is enough
// because shares are inherited through the entire subtree.
type Authorizer struct{ db *sql.DB }

func NewAuthorizer(db *sql.DB) *Authorizer { return &Authorizer{db: db} }

func (a *Authorizer) Permission(ctx context.Context, principal Principal, folderID string) (Permission, error) {
	if principal.Role == RoleAdmin {
		return PermissionWrite, nil
	}
	var owner string
	if err := a.db.QueryRowContext(ctx, "SELECT owner_id FROM folders WHERE id=?", folderID).Scan(&owner); err != nil {
		return "", err
	}
	if owner == principal.UserID {
		return PermissionWrite, nil
	}
	var permission Permission
	err := a.db.QueryRowContext(ctx, `WITH RECURSIVE ancestors(id) AS (
SELECT ? UNION ALL SELECT f.parent_id FROM folders f JOIN ancestors a ON f.id=a.id WHERE f.parent_id IS NOT NULL
)
SELECT s.permission FROM shares s JOIN ancestors a ON a.id=s.resource_id
WHERE s.resource_type='folder' AND s.user_id=?
ORDER BY CASE s.permission WHEN 'write' THEN 0 ELSE 1 END LIMIT 1`, folderID, principal.UserID).Scan(&permission)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return permission, err
}

func (a *Authorizer) CanRead(ctx context.Context, principal Principal, folderID string) (bool, error) {
	permission, err := a.Permission(ctx, principal, folderID)
	return permission == PermissionRead || permission == PermissionWrite, err
}

func (a *Authorizer) CanWrite(ctx context.Context, principal Principal, folderID string) (bool, error) {
	permission, err := a.Permission(ctx, principal, folderID)
	return permission == PermissionWrite, err
}
