package com.photo77

import android.app.Activity
import android.content.Intent
import android.content.ClipData
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

class PhotoPickerModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), ActivityEventListener {
  private val executor = Executors.newSingleThreadExecutor()
  private var pending: Promise? = null
  private val requestCode = 7717

  init { context.addActivityEventListener(this) }
  override fun getName() = "Photo77Picker"

  @ReactMethod
  fun identityChallenge(promise: Promise) {
    val bytes = ByteArray(32)
    java.security.SecureRandom().nextBytes(bytes)
    promise.resolve(bytes.joinToString("") { "%02x".format(it.toInt() and 255) })
  }

  @ReactMethod
  fun shareMedia(url: String, bearer: String, mime: String, name: String, promise: Promise) {
    executor.execute {
      var connection: HttpURLConnection? = null
      try {
        val server = URL(url)
        if (server.protocol != "https" && server.protocol != "http") throw IllegalArgumentException("无效媒体地址")
        val directory = File(context.cacheDir, "shared-media").apply { mkdirs() }
        // Keep only short lived copies. The shared URI grants access to this one file.
        directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 60 * 60 * 1000L }?.forEach { it.delete() }
        val safeName = name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[^A-Za-z0-9._-]"), "_").take(120).ifBlank { "media" }
        val file = File(directory, "${UUID.randomUUID()}-$safeName")
        try {
          connection = server.openConnection() as HttpURLConnection
          connection.instanceFollowRedirects = false
          connection.connectTimeout = 20000
          connection.readTimeout = 30000
          connection.setRequestProperty("Authorization", bearer)
          connection.setRequestProperty("Accept", "*/*")
          if (connection.responseCode !in 200..299) throw IllegalStateException("获取原文件失败：HTTP ${connection.responseCode}")
          connection.inputStream.use { input -> file.outputStream().use { output -> input.copyTo(output) } }
          if (file.length() == 0L) throw IllegalStateException("原文件为空")
          val uri = FileProvider.getUriForFile(context, "${context.packageName}.share", file)
          val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime.ifBlank { "application/octet-stream" }
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newUri(context.contentResolver, "77Photo media", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          val activity = context.currentActivity ?: throw IllegalStateException("无法打开分享面板")
          activity.runOnUiThread {
            try { activity.startActivity(Intent.createChooser(intent, "分享媒体")); promise.resolve(null) }
            catch (error: Exception) { promise.reject("SHARE_FAILED", error) }
          }
        } catch (error: Exception) { file.delete(); throw error }
      } catch (error: Exception) { promise.reject("SHARE_FAILED", error) }
      finally { connection?.disconnect() }
    }
  }

  @ReactMethod
  fun pick(promise: Promise) {
    if (pending != null) { promise.reject("PICKER_BUSY", "选择器已经打开"); return }
    val activity = context.currentActivity ?: run { promise.reject("NO_ACTIVITY", "无法打开照片选择器"); return }
    try {
      val intent = if (Build.VERSION.SDK_INT >= 33) {
        Intent(MediaStore.ACTION_PICK_IMAGES).apply {
          putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, minOf(MediaStore.getPickImagesMaxLimit(), 50))
        }
      } else {
        // On Android 12 the system/backported Photo Picker handles ACTION_GET_CONTENT
        // when available; the document picker remains a usable fallback.
        Intent(Intent.ACTION_GET_CONTENT).apply {
          type = "*/*"
          putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*"))
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
          addCategory(Intent.CATEGORY_OPENABLE)
        }
      }
      pending = promise
      activity.startActivityForResult(intent, requestCode)
    } catch (error: Exception) { pending = null; promise.reject("PICKER_FAILED", error) }
  }

  override fun onNewIntent(intent: Intent) {}
  override fun onActivityResult(activity: Activity, code: Int, result: Int, data: Intent?) {
    if (code != requestCode) return
    val promise = pending ?: return
    pending = null
    if (result != Activity.RESULT_OK || data == null) { promise.resolve(Arguments.createArray()); return }
    val uris = mutableListOf<Uri>()
    data.data?.let { uris.add(it) }
    data.clipData?.let { clip -> for (i in 0 until clip.itemCount) {
      val uri = clip.getItemAt(i).uri
      if (!uris.contains(uri)) uris.add(uri)
    } }
    executor.execute {
      val created = mutableListOf<File>()
      try {
        val output = Arguments.createArray()
        val directory = File(context.filesDir, "upload-staging").apply { mkdirs() }
        for (uri in uris) {
          var name = "media"
          context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor: Cursor ->
            if (cursor.moveToFirst()) name = cursor.getString(0) ?: name
          }
          name = name.substringAfterLast('/').substringAfterLast('\\').take(255)
          val reportedMime = context.contentResolver.getType(uri)
          val mime = when (name.substringAfterLast('.', "").lowercase()) {
            "mov" -> "video/quicktime"
            "heic" -> "image/heic"
            "heif" -> "image/heif"
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "mp4" -> "video/mp4"
            else -> reportedMime ?: "application/octet-stream"
          }
          val file = File(directory, UUID.randomUUID().toString())
          created.add(file)
          try {
            context.contentResolver.openInputStream(uri)?.use { input -> file.outputStream().use { input.copyTo(it) } }
              ?: throw IllegalStateException("无法读取所选媒体")
            val item = Arguments.createMap()
            item.putString("path", file.absolutePath)
            item.putString("name", name)
            item.putString("mime", mime)
            item.putDouble("size", file.length().toDouble())
            if (mime.startsWith("video/")) {
              try {
                val retriever = MediaMetadataRetriever()
                retriever.setDataSource(file.absolutePath)
                val frame = retriever.getFrameAtTime(0)
                if (frame != null) {
                  val thumbnail = File(directory, UUID.randomUUID().toString() + ".jpg")
                  created.add(thumbnail)
                  thumbnail.outputStream().use { stream -> frame.compress(Bitmap.CompressFormat.JPEG, 80, stream) }
                  item.putString("thumbnailPath", thumbnail.absolutePath)
                  frame.recycle()
                }
                retriever.release()
              } catch (_: Exception) { /* The media remains uploadable when thumbnail extraction fails. */ }
            }
            output.pushMap(item)
          } catch (error: Exception) { file.delete(); throw error }
        }
        promise.resolve(output)
      } catch (error: Exception) {
        created.forEach { it.delete() }
        promise.reject("COPY_FAILED", error)
      }
    }
  }

  @ReactMethod
  fun deleteFile(path: String, promise: Promise) {
    val directory = File(context.filesDir, "upload-staging").canonicalFile
    val file = File(path).canonicalFile
    if (file.parentFile != directory) { promise.reject("INVALID_PATH", "无效文件路径"); return }
    promise.resolve(!file.exists() || file.delete())
  }
}
