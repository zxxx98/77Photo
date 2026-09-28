ALTER TABLE face_jobs ADD COLUMN scan_all INTEGER NOT NULL DEFAULT 0 CHECK(scan_all IN (0,1));
ALTER TABLE face_jobs ADD COLUMN regroup_only INTEGER NOT NULL DEFAULT 0 CHECK(regroup_only IN (0,1));
CREATE INDEX faces_representatives ON faces(person_id,manual DESC,score DESC,id);
