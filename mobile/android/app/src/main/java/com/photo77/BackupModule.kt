package com.photo77

import android.Manifest
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.ContentUris
import android.content.pm.PackageManager
import android.os.Build
import android.provider.MediaStore
import com.facebook.react.bridge.*
import java.io.File
import java.util.concurrent.Executors

class BackupModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  override fun getName() = "Photo77Backup"

  @ReactMethod
  fun schedule(enabled: Boolean, wifiOnly: Boolean, promise: Promise) {
    try {
      val scheduler = context.getSystemService(JobScheduler::class.java)
      if (!enabled) { scheduler.cancel(7718); promise.resolve(null); return }
      val job = JobInfo.Builder(7718, ComponentName(context, BackupJobService::class.java))
        // JS checks the actual transport before each file, including metered Wi-Fi.
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setPersisted(true).setPeriodic(15 * 60 * 1000L).build()
      check(scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS) { "无法安排后台备份" }
      promise.resolve(null)
    } catch (error: Exception) { promise.reject("BACKUP_SCHEDULE", error) }
  }

  @ReactMethod
  fun scan(after: String, promise: Promise) {
    executor.execute {
      try {
        val permission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        check(context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) { "请允许访问全部照片后启用自动备份" }
        val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val projection = arrayOf("_id", "_display_name", "mime_type", "_size", "date_modified")
        val args = android.os.Bundle().apply {
          putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "_id > ? AND is_pending = 0 AND is_trashed = 0")
          putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(after))
          putStringArray(android.content.ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf("_id"))
          putInt(android.content.ContentResolver.QUERY_ARG_SORT_DIRECTION, android.content.ContentResolver.QUERY_SORT_DIRECTION_ASCENDING)
          putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, 200)
        }
        val version = MediaStore.getVersion(context)
        val items = Arguments.createArray()
        var cursorId = after
        context.contentResolver.query(collection, projection, args, null)?.use { cursor ->
          while (cursor.moveToNext() && items.size() < 200) {
            val id = cursor.getLong(0)
            cursorId = id.toString()
            val item = Arguments.createMap()
            item.putString("id", id.toString())
            item.putString("uri", ContentUris.withAppendedId(collection, id).toString())
            item.putString("fingerprint", "$version:$id:${cursor.getLong(3)}:${cursor.getLong(4)}")
            item.putString("name", cursor.getString(1) ?: "photo.jpg")
            item.putString("mime", cursor.getString(2) ?: "image/jpeg")
            item.putDouble("size", cursor.getLong(3).toDouble())
            items.pushMap(item)
          }
        } ?: error("无法读取系统相册")
        promise.resolve(Arguments.createMap().apply {
          putArray("items", items)
          putString("next", cursorId)
        })
      } catch (error: Exception) { promise.reject("BACKUP_SCAN", error) }
    }
  }

  // Only one backup upload runs at a time. Reuse a bounded staging slot so a
  // process death cannot leave a copy of every photo in private storage.
  @ReactMethod
  fun stage(uri: String, promise: Promise) {
    executor.execute {
      val file = File(File(context.filesDir, "upload-staging").apply { mkdirs() }, "backup-current")
      try {
        val parsed = android.net.Uri.parse(uri)
        require(parsed.scheme == "content" && parsed.authority == "media")
        context.contentResolver.openInputStream(parsed)?.use { input ->
          file.outputStream().use { input.copyTo(it) }
        } ?: error("照片已删除或无法读取")
        promise.resolve(file.absolutePath)
      } catch (error: Exception) { file.delete(); promise.reject("BACKUP_READ", error) }
    }
  }
}
