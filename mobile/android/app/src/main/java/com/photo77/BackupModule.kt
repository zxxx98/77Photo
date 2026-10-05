package com.photo77

import android.Manifest
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.os.SystemClock
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

class BackupModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  override fun getName() = "Photo77Backup"

  @ReactMethod
  fun startVisible(scope: String, promise: Promise) {
    try {
      check(context.currentActivity != null) { "请在应用内启动可见视频备份" }
      check(scope.isNotBlank()) { "备份目标不可用" }
      context.getSharedPreferences("visible-backup", android.content.Context.MODE_PRIVATE)
        .edit().putString("scope", scope).remove("fingerprint").remove("action").commit()
      val token = UUID.randomUUID().toString()
      val intent = Intent(context, VisibleBackupService::class.java)
        .setAction(VisibleBackupService.ACTION_START)
        .putExtra(VisibleBackupService.EXTRA_SCOPE, scope)
        .putExtra(VisibleBackupService.EXTRA_LAUNCH_TOKEN, token)
      ContextCompat.startForegroundService(context, intent)
      val handler = Handler(Looper.getMainLooper())
      val startedAt = SystemClock.uptimeMillis()
      handler.post(object : Runnable {
        override fun run() {
          if (VisibleBackupService.runningToken == token) { promise.resolve(null); return }
          if (SystemClock.uptimeMillis() - startedAt >= 4500) {
            context.stopService(intent)
            context.getSharedPreferences("visible-backup", android.content.Context.MODE_PRIVATE).edit().clear().apply()
            promise.reject("BACKUP_VISIBLE_START", "前台通知未能启动，请重试")
            return
          }
          handler.postDelayed(this, 100)
        }
      })
    } catch (error: Exception) {
      context.getSharedPreferences("visible-backup", android.content.Context.MODE_PRIVATE).edit().clear().apply()
      promise.reject("BACKUP_VISIBLE_START", error)
    }
  }

  @ReactMethod
  fun updateVisible(name: String, progress: Int, fingerprint: String, promise: Promise) {
    try {
      val prefs = context.getSharedPreferences("visible-backup", android.content.Context.MODE_PRIVATE)
      if (prefs.getString("scope", null) != null) {
        prefs.edit().putString("fingerprint", fingerprint).apply()
        if (VisibleBackupService.running) {
          context.startService(Intent(context, VisibleBackupService::class.java)
            .setAction(VisibleBackupService.ACTION_UPDATE)
            .putExtra(VisibleBackupService.EXTRA_NAME, name)
            .putExtra(VisibleBackupService.EXTRA_PROGRESS, progress)
            .putExtra(VisibleBackupService.EXTRA_FINGERPRINT, fingerprint))
        }
      }
      promise.resolve(null)
    } catch (error: Exception) { promise.reject("BACKUP_VISIBLE_UPDATE", error) }
  }

  @ReactMethod
  fun stopVisible(preservePending: Boolean, promise: Promise) {
    try {
      if (!preservePending) context.getSharedPreferences("visible-backup", android.content.Context.MODE_PRIVATE).edit().clear().apply()
      context.stopService(Intent(context, VisibleBackupService::class.java))
      promise.resolve(null)
    } catch (error: Exception) { promise.reject("BACKUP_VISIBLE_STOP", error) }
  }

  @ReactMethod
  fun interruptedVisible(scope: String, promise: Promise) {
    val prefs = context.getSharedPreferences("visible-backup", android.content.Context.MODE_PRIVATE)
    val fingerprint = if (prefs.getString("scope", null) == scope) prefs.getString("fingerprint", null) else null
    promise.resolve(if (fingerprint == null) null else Arguments.createMap().apply {
      putString("fingerprint", fingerprint)
      putString("action", prefs.getString("action", "pause"))
    })
  }

  @ReactMethod
  fun clearInterruptedVisible(scope: String, promise: Promise) {
    val prefs = context.getSharedPreferences("visible-backup", android.content.Context.MODE_PRIVATE)
    if (!VisibleBackupService.running && prefs.getString("scope", null) == scope) prefs.edit().clear().apply()
    promise.resolve(null)
  }

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
  fun scan(after: String, mediaType: String, promise: Promise) {
    executor.execute {
      try {
        require(mediaType == "photo" || mediaType == "video") { "未知媒体集合" }
        val permission = if (Build.VERSION.SDK_INT >= 33) {
          if (mediaType == "video") Manifest.permission.READ_MEDIA_VIDEO else Manifest.permission.READ_MEDIA_IMAGES
        } else Manifest.permission.READ_EXTERNAL_STORAGE
        check(context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
          val label = if (mediaType == "video") "视频" else "照片"
          if (Build.VERSION.SDK_INT >= 34 && context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED)
            "目前只允许访问选定${label}；请在系统设置中改为允许全部媒体"
          else "请允许访问全部${label}后启用自动备份"
        }
        val collection = if (mediaType == "video") MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val identityColumns = if (Build.VERSION.SDK_INT >= 29)
          arrayOf("_id", "_display_name", "mime_type", "_size", "date_modified", MediaStore.MediaColumns.VOLUME_NAME)
        else arrayOf("_id", "_display_name", "mime_type", "_size", "date_modified")
        val projection = identityColumns + arrayOf("datetaken", "date_added")
        val args = android.os.Bundle().apply {
          val visibility = when {
            Build.VERSION.SDK_INT >= 30 -> " AND is_pending = 0 AND is_trashed = 0"
            Build.VERSION.SDK_INT >= 29 -> " AND is_pending = 0"
            else -> ""
          }
          putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "_id > ?$visibility")
          putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(after))
          putStringArray(android.content.ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf("_id"))
          putInt(android.content.ContentResolver.QUERY_ARG_SORT_DIRECTION, android.content.ContentResolver.QUERY_SORT_DIRECTION_ASCENDING)
          putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, 200)
        }
        val version = MediaStore.getVersion(context)
        val items = Arguments.createArray()
        var cursorId = after
        context.contentResolver.query(collection, projection, args, null)?.use { cursor ->
          val takenColumn = cursor.getColumnIndexOrThrow("datetaken")
          val addedColumn = cursor.getColumnIndexOrThrow("date_added")
          while (cursor.moveToNext() && items.size() < 200) {
            val id = cursor.getLong(0)
            cursorId = id.toString()
            val item = Arguments.createMap()
            item.putString("id", id.toString())
            item.putString("uri", ContentUris.withAppendedId(collection, id).toString())
            val volume = if (Build.VERSION.SDK_INT >= 29) cursor.getString(5) ?: "external" else "external"
            val collectionVersion = if (Build.VERSION.SDK_INT >= 29 && volume != "external")
              MediaStore.getVersion(context, volume) ?: version else version
            val oldFingerprint = "$version:$id:${cursor.getLong(3)}:${cursor.getLong(4)}"
            item.putString("fingerprint", "$mediaType:$volume:$collectionVersion:$id:${cursor.getLong(3)}:${cursor.getLong(4)}")
            if (mediaType == "photo") item.putString("legacyFingerprint", oldFingerprint)
            item.putString("name", cursor.getString(1) ?: if (mediaType == "video") "video.mp4" else "photo.jpg")
            item.putString("mime", cursor.getString(2) ?: "")
            item.putDouble("size", cursor.getLong(3).toDouble())
            // DATE_TAKEN is milliseconds; DATE_ADDED/DATE_MODIFIED are seconds.
            // Keep date metadata out of the fingerprint to preserve old history.
            item.putDouble("capturedAt", cursor.getLong(takenColumn).toDouble())
            item.putDouble("addedAt", cursor.getLong(addedColumn).toDouble() * 1000)
            item.putDouble("modifiedAt", cursor.getLong(4).toDouble() * 1000)
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
  fun stage(uri: String, size: Double, promise: Promise) {
    executor.execute {
      val file = File(File(context.filesDir, "upload-staging").apply { mkdirs() }, "backup-current")
      try {
        val parsed = android.net.Uri.parse(uri)
        require(parsed.scheme == "content" && parsed.authority == "media")
        require(size >= 0 && size.isFinite()) { "无法确定媒体文件大小" }
        val reserve = 32L * 1024 * 1024
        val available = StatFs(file.parentFile!!.absolutePath).availableBytes
        check(available > size.toLong() + reserve) { "手机暂存空间不足，请释放空间后重试" }
        context.contentResolver.openInputStream(parsed)?.use { input ->
          file.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            var copied = 0L
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              copied += read
              check(copied + reserve < available) { "手机暂存空间不足，请释放空间后重试" }
              output.write(buffer, 0, read)
            }
          }
        } ?: error("媒体已删除或无法读取")
        promise.resolve(file.absolutePath)
      } catch (error: Exception) { file.delete(); promise.reject("BACKUP_READ", error) }
    }
  }
}
