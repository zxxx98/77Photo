ALTER TABLE share_links ADD COLUMN owner_id TEXT;
ALTER TABLE share_links ADD COLUMN resource_name TEXT NOT NULL DEFAULT '';

UPDATE share_links SET
    owner_id = CASE resource_type
        WHEN 'photo' THEN (SELECT owner_id FROM photos WHERE id=resource_id)
        ELSE (SELECT owner_id FROM folders WHERE id=resource_id)
    END,
    resource_name = COALESCE(CASE resource_type
        WHEN 'photo' THEN (SELECT filename FROM photos WHERE id=resource_id)
        ELSE (SELECT name FROM folders WHERE id=resource_id)
    END, '');

CREATE INDEX share_links_owner_page_idx ON share_links(owner_id, created_at DESC, id DESC);
