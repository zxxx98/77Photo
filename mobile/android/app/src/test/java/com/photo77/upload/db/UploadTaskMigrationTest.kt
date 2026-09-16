package com.photo77.upload.db

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UploadTaskMigrationTest {
  @Test
  fun versionOneUploadTasksGainNullableMotionColumns() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val helper = FrameworkSQLiteOpenHelperFactory().create(
      SupportSQLiteOpenHelper.Configuration.builder(context)
        .name(null)
        .callback(object : SupportSQLiteOpenHelper.Callback(1) {
          override fun onCreate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE upload_tasks (id TEXT NOT NULL PRIMARY KEY, batch_id TEXT NOT NULL, content_uri TEXT NOT NULL, display_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER, server_id TEXT NOT NULL, user_id TEXT, device_id TEXT NOT NULL, session_id TEXT, folder_id TEXT NOT NULL, state TEXT NOT NULL, sent_bytes INTEGER NOT NULL, attempts INTEGER NOT NULL, last_error_code TEXT, last_error_message TEXT, created_at_epoch_ms INTEGER NOT NULL, started_at_epoch_ms INTEGER, completed_at_epoch_ms INTEGER, next_retry_at_epoch_ms INTEGER, lease_owner TEXT, lease_until_epoch_ms INTEGER)")
          }

          override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
        })
        .build(),
    )
    val db = helper.writableDatabase

    Migration2.migrate(db)

    db.query("PRAGMA table_info(upload_tasks)").use { cursor ->
      val nameIndex = cursor.getColumnIndexOrThrow("name")
      val nullableMotionColumns = mutableListOf<String>()
      while (cursor.moveToNext()) {
        val name = cursor.getString(nameIndex)
        if (name.startsWith("motion_")) nullableMotionColumns += name
      }
      assertEquals(
        listOf("motion_uri", "motion_display_name", "motion_mime_type", "motion_size_bytes"),
        nullableMotionColumns,
      )
    }
    db.close()
  }
}
