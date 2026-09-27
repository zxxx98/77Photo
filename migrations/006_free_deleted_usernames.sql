-- Deleted (tombstoned) accounts keep their row so retained photos still have
-- an owner, but their username must become available again. The display name
-- moves to deleted_username and username gets a placeholder containing a
-- control character, which no valid username can contain.
ALTER TABLE users ADD COLUMN deleted_username TEXT;

UPDATE users
SET deleted_username = username,
    username = char(31) || 'deleted' || char(31) || id
WHERE deleted_at IS NOT NULL;
