package com.photo77.upload.db

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/** Adds optional motion-photo companion metadata without changing existing tasks. */
val Migration2: Migration = object : Migration(1, 2) {
  override fun migrate(database: SupportSQLiteDatabase) {
    database.execSQL("ALTER TABLE upload_tasks ADD COLUMN motion_uri TEXT")
    database.execSQL("ALTER TABLE upload_tasks ADD COLUMN motion_display_name TEXT")
    database.execSQL("ALTER TABLE upload_tasks ADD COLUMN motion_mime_type TEXT")
    database.execSQL("ALTER TABLE upload_tasks ADD COLUMN motion_size_bytes INTEGER")
  }
}
