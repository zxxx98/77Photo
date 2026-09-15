package com.photo77.bridge

import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.turbomodule.core.interfaces.TurboModule
import com.photo77.upload.UploadURLPolicy
import com.photo77.network.PolicyAwareHttpClient
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import okhttp3.OkHttpClient
import okhttp3.Request

internal fun requireMediaStoreUpdate(updatedRows: Int) {
  if (updatedRows <= 0) throw java.io.IOException("download destination could not be published")
}

/** Queues an authenticated original download without putting the bearer token in its URL. */
@ReactModule(name = NativeDownloadModule.NAME)
class NativeDownloadModule(
  reactContext: ReactApplicationContext,
  client: OkHttpClient = PolicyAwareHttpClient.create(),
) : ReactContextBaseJavaModule(reactContext), TurboModule {
  private val client: OkHttpClient = PolicyAwareHttpClient.enforce(client).build()
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()

  override fun getName(): String = NAME

  @com.facebook.react.bridge.ReactMethod
  fun download(url: String, fileName: String, authorization: String, lanCIDRs: ReadableArray, promise: Promise) {
    execute(promise) {
      val ranges = (0 until lanCIDRs.size()).map { index ->
        lanCIDRs.getString(index)?.trim()?.takeIf { it.isNotEmpty() }
          ?: throw IllegalArgumentException("lanCIDRs contains an invalid range")
      }
      val safeURL = UploadURLPolicy.requireAllowed(url, ranges)
      val safeAuthorization = authorization.trim().takeIf { value ->
        value.startsWith("Bearer ") && value.length > "Bearer ".length &&
          !value.contains('\r') && !value.contains('\n')
      } ?: throw IllegalArgumentException("authorization is invalid")
      val safeFileName = sanitizeFileName(fileName)
      val request = Request.Builder()
        .url(safeURL)
        .header("Authorization", safeAuthorization)
        .get()
        .build()
      val resolver = reactApplicationContext.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, safeFileName)
        put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/77Photo")
          put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
      }
      val destination = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("download destination is unavailable")
      var completed = false
      try {
        client.newCall(request).execute().use { response ->
          if (!response.isSuccessful) throw java.io.IOException("download failed with HTTP ${response.code}")
          val body = response.body ?: throw java.io.IOException("download response is empty")
          val output = resolver.openOutputStream(destination)
            ?: throw java.io.IOException("download destination cannot be opened")
          body.byteStream().use { input -> output.use { input.copyTo(it) } }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val published = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
          requireMediaStoreUpdate(resolver.update(destination, published, null, null))
        }
        completed = true
        destination.toString()
      } finally {
        if (!completed) resolver.delete(destination, null, null)
      }
    }
  }

  override fun invalidate() {
    executor.shutdownNow()
    super.invalidate()
  }

  private fun sanitizeFileName(fileName: String): String {
    val sanitized = fileName.trim()
      .replace(Regex("[^A-Za-z0-9._ -]"), "_")
      .trim('.', ' ')
      .take(180)
    return sanitized.ifBlank { "photo-77-original" }
  }

  private fun <T> execute(promise: Promise, operation: () -> T) {
    executor.execute {
      try {
        promise.resolve(operation())
      } catch (error: Throwable) {
        promise.reject("DOWNLOAD_ERROR", error)
      }
    }
  }

  companion object {
    const val NAME = "NativeDownload"
  }
}

class NativeDownloadPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == NativeDownloadModule.NAME) NativeDownloadModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      NativeDownloadModule.NAME to ReactModuleInfo(
        NativeDownloadModule.NAME,
        NativeDownloadModule::class.java.name,
        false,
        false,
        false,
        true,
      ),
    )
  }
}
