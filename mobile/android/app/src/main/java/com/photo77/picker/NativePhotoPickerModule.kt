package com.photo77.picker

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.turbomodule.core.interfaces.TurboModule
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Implemented by the activity that owns the Activity Result registration. */
interface PhotoPickerHost {
  fun launchPhotoPicker()
}

/** Keeps the result callback with the React module while the activity is recreated. */
internal object PhotoPickerResultDispatcher {
  private var handler: ((List<Uri>) -> Unit)? = null

  @Synchronized
  fun register(handler: (List<Uri>) -> Unit) {
    this.handler = handler
  }

  @Synchronized
  fun clear() {
    handler = null
  }

  @Synchronized
  fun dispatch(uris: List<Uri>) {
    val callback = handler
    handler = null
    callback?.invoke(uris)
  }
}

data class PhotoPickerMetadataInput(
  val displayName: String?,
  val mimeType: String?,
  val sizeBytes: Long?,
  val fallbackSizeBytes: Long?,
)

data class PickedMediaMetadata(
  val uri: String,
  val displayName: String,
  val mimeType: String,
  val sizeBytes: Long?,
)

object PhotoPickerMetadata {
  fun from(uri: String, input: PhotoPickerMetadataInput, persistReadGrant: () -> Unit): PickedMediaMetadata {
    val parsed = Uri.parse(uri)
    val fallbackName = parsed.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "picked-media"
    val displayName = input.displayName?.trim()?.takeIf { it.isNotEmpty() } ?: fallbackName
    val mimeType = input.mimeType?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
      ?: throw IllegalArgumentException("mime type is missing")
    if (!isSupportedVisualMimeType(mimeType)) throw IllegalArgumentException("media type is not supported")
    persistReadGrant()
    val size = (input.sizeBytes ?: input.fallbackSizeBytes)?.takeIf { it >= 0L }
    return PickedMediaMetadata(uri, displayName, mimeType, size)
  }
}

fun isSupportedVisualMimeType(mimeType: String): Boolean =
  mimeType.lowercase().startsWith("image/") || mimeType.lowercase().startsWith("video/")

internal class PhotoPickerContentReader(private val resolver: ContentResolver) {
  fun read(uri: Uri): PickedMediaMetadata {
    val descriptor = resolver.openAssetFileDescriptor(uri, "r")
      ?: throw IllegalArgumentException("selected media cannot be opened")
    val fallbackSize = descriptor.use { it.length.takeIf { length -> length >= 0L } }
    resolver.openInputStream(uri)?.use { } ?: throw IllegalArgumentException("selected media cannot be reopened")

    var displayName: String? = null
    var size: Long? = null
    var queriedMime: String? = null
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE, "mime_type"), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (nameIndex >= 0 && !cursor.isNull(nameIndex)) displayName = cursor.getString(nameIndex)
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
        val mimeIndex = cursor.getColumnIndex("mime_type")
        if (mimeIndex >= 0 && !cursor.isNull(mimeIndex)) queriedMime = cursor.getString(mimeIndex)
      }
    }
    val mimeType = resolver.getType(uri) ?: queriedMime
      ?: throw IllegalArgumentException("media type is missing")
    return PhotoPickerMetadata.from(uri.toString(), PhotoPickerMetadataInput(displayName, mimeType, size, fallbackSize)) {
      resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
  }
}

@ReactModule(name = NativePhotoPickerModule.NAME)
class NativePhotoPickerModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), TurboModule {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private var pending: Promise? = null

  override fun getName(): String = NAME

  @ReactMethod
  fun pick(promise: Promise) {
    synchronized(this) {
      if (pending != null) {
        promise.reject("PICKER_BUSY", "a media picker is already open")
        return
      }
      pending = promise
    }
    val host = reactApplicationContext.currentActivity as? PhotoPickerHost
    if (host == null) {
      synchronized(this) { pending = null }
      promise.reject("PICKER_UNAVAILABLE", "Android Photo Picker is unavailable")
      return
    }
    PhotoPickerResultDispatcher.register(::handleSelection)
    try {
      host.launchPhotoPicker()
    } catch (error: Throwable) {
      PhotoPickerResultDispatcher.clear()
      synchronized(this) { pending = null }
      promise.reject("PICKER_UNAVAILABLE", error)
    }
  }

  private fun handleSelection(uris: List<Uri>) {
    val promise = synchronized(this) {
      val result = pending
      pending = null
      result
    } ?: return
    executor.execute {
      try {
        val reader = PhotoPickerContentReader(reactApplicationContext.contentResolver)
        val result = Arguments.createArray()
        uris.map { reader.read(it) }.forEach { result.pushMap(it.toWritableMap()) }
        promise.resolve(result)
      } catch (error: Throwable) {
        promise.reject("PICKER_METADATA_UNREADABLE", "selected media metadata could not be read", error)
      }
    }
  }

  override fun invalidate() {
    PhotoPickerResultDispatcher.clear()
    synchronized(this) { pending = null }
    executor.shutdownNow()
    super.invalidate()
  }

  private fun PickedMediaMetadata.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("uri", uri)
    putString("displayName", displayName)
    putString("mimeType", mimeType)
    if (sizeBytes == null) putNull("size") else putDouble("size", sizeBytes.toDouble())
  }

  companion object {
    const val NAME = "NativePhotoPicker"
    const val MAX_SELECTION = 100
  }
}

class NativePhotoPickerPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == NativePhotoPickerModule.NAME) NativePhotoPickerModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      NativePhotoPickerModule.NAME to ReactModuleInfo(
        NativePhotoPickerModule.NAME,
        NativePhotoPickerModule::class.java.name,
        false,
        false,
        false,
        true,
      ),
    )
  }
}
