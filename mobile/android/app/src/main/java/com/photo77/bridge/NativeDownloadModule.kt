package com.photo77.bridge

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Queues an authenticated original download without putting the bearer token in its URL. */
@ReactModule(name = NativeDownloadModule.NAME)
class NativeDownloadModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), TurboModule {
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
      val manager = reactApplicationContext.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
        ?: throw IllegalStateException("download manager is unavailable")
      val request = DownloadManager.Request(Uri.parse(safeURL))
        .setTitle("77Photo")
        .setDescription("Original photo download")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setMimeType("application/octet-stream")
        .addRequestHeader("Authorization", safeAuthorization)
        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeFileName)
      manager.enqueue(request).toDouble()
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
