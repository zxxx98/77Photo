package com.photo77.bridge

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.BaseReactPackage
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.NativeModule
import com.facebook.react.turbomodule.core.interfaces.TurboModule
import com.photo77.upload.db.UploadDatabase
import com.photo77.upload.db.UploadTaskEntity
import com.photo77.upload.db.UploadTaskState
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

@ReactModule(name = NativeUploadQueueModule.NAME)
class NativeUploadQueueModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), TurboModule {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val database by lazy { UploadDatabase.getInstance(reactApplicationContext) }

  override fun getName(): String = NAME

  @ReactMethod
  fun start(serverId: String, baseURL: String, deviceId: String, concurrency: Int, allowMobile: Boolean, lanCIDRs: ReadableArray, promise: Promise) {
    execute(promise) {
      val safeServerId = requireIdentifier(serverId, "serverId")
      val safeBaseURL = baseURL.trim().takeIf { it.isNotEmpty() && it.length <= 2_048 }
        ?: throw IllegalArgumentException("baseURL is invalid")
      val safeDeviceId = requireIdentifier(deviceId, "deviceId")
      val safeLANCIDRs = readLANCIDRs(lanCIDRs)
      val normalizedBaseURL = com.photo77.upload.UploadURLPolicy.requireAllowed(safeBaseURL, safeLANCIDRs)
      com.photo77.upload.UploadForegroundService.reserveStart(safeServerId)
      try {
        val intent = Intent(reactApplicationContext, com.photo77.upload.UploadForegroundService::class.java).apply {
          action = com.photo77.upload.UploadForegroundService.ACTION_START
          putExtra(com.photo77.upload.UploadForegroundService.EXTRA_SERVER_ID, safeServerId)
          putExtra(com.photo77.upload.UploadForegroundService.EXTRA_BASE_URL, normalizedBaseURL)
          putExtra(com.photo77.upload.UploadForegroundService.EXTRA_DEVICE_ID, safeDeviceId)
          putExtra(com.photo77.upload.UploadForegroundService.EXTRA_CONCURRENCY, concurrency.coerceIn(1, 4))
          putExtra(com.photo77.upload.UploadForegroundService.EXTRA_ALLOW_MOBILE, allowMobile)
          putStringArrayListExtra(com.photo77.upload.UploadForegroundService.EXTRA_LAN_CIDRS, ArrayList(safeLANCIDRs))
        }
        com.photo77.upload.UploadStartCoordinator(
          scheduleRecovery = {
            com.photo77.upload.UploadRecoveryWorker.schedule(
              context = reactApplicationContext,
              serverId = safeServerId,
              baseUrl = normalizedBaseURL,
              deviceId = safeDeviceId,
              concurrency = concurrency,
              allowMobile = allowMobile,
              lanCIDRs = safeLANCIDRs,
            )
          },
          startService = {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
              reactApplicationContext.startForegroundService(intent)
            } else {
              reactApplicationContext.startService(intent)
            }
          },
        ).run()
      } catch (error: Throwable) {
        com.photo77.upload.UploadForegroundService.releaseStartReservation(safeServerId)
        throw error
      }
      null
    }
  }

  @ReactMethod
  fun enqueue(serverId: String, deviceId: String, folderId: String, items: ReadableArray, promise: Promise) {
    execute(promise) {
      requireIdentifier(serverId, "serverId")
      requireIdentifier(deviceId, "deviceId")
      requireIdentifier(folderId, "folderId")
      if (items.size() == 0) throw IllegalArgumentException("items must not be empty")

      val now = System.currentTimeMillis()
      val batchId = UUID.randomUUID().toString()
      val tasks = (0 until items.size()).map { index ->
        val item = items.getMap(index) ?: throw IllegalArgumentException("item is invalid")
        UploadTaskEntity(
          id = UUID.randomUUID().toString(),
          batchId = batchId,
          contentUri = requiredString(item, "uri"),
          displayName = requiredString(item, "displayName"),
          mimeType = requiredString(item, "mimeType"),
          sizeBytes = optionalSize(item),
          serverId = serverId,
          userId = null,
          deviceId = deviceId,
          sessionId = null,
          folderId = folderId,
          state = UploadTaskState.QUEUED,
          sentBytes = 0,
          attempts = 0,
          lastErrorCode = null,
          lastErrorMessage = null,
          createdAtEpochMs = now,
          startedAtEpochMs = null,
          completedAtEpochMs = null,
          nextRetryAtEpochMs = null,
          leaseOwner = null,
          leaseUntilEpochMs = null,
        )
      }
      database.uploadTaskDao().insertAll(tasks)
      Arguments.createArray().also { result -> tasks.forEach { result.pushString(it.id) } }
    }
  }

  @ReactMethod
  fun snapshot(serverId: String, promise: Promise) {
    execute(promise) {
      val tasks = database.uploadTaskDao().findByServer(requireIdentifier(serverId, "serverId"))
      snapshotToMap(tasks)
    }
  }

  @ReactMethod
  fun pause(serverId: String, promise: Promise) {
    execute(promise) {
      val safeServerId = requireIdentifier(serverId, "serverId")
      val dao = database.uploadTaskDao()
      dao.pauseUploading(safeServerId)
      dao.pauseQueued(safeServerId)
      com.photo77.upload.UploadForegroundService.pauseActive(safeServerId)
      null
    }
  }

  @ReactMethod
  fun resume(serverId: String, promise: Promise) {
    execute(promise) {
      database.uploadTaskDao().resumePaused(requireIdentifier(serverId, "serverId"))
      null
    }
  }

  @ReactMethod
  fun retryFailed(serverId: String, promise: Promise) {
    execute(promise) {
      database.uploadTaskDao().retryFailed(requireIdentifier(serverId, "serverId"))
      null
    }
  }

  @ReactMethod
  fun cancel(taskIds: ReadableArray, promise: Promise) {
    execute(promise) {
      val ids = (0 until taskIds.size()).map { index ->
        taskIds.getString(index)?.takeIf { it.isNotBlank() }
          ?: throw IllegalArgumentException("task ID is invalid")
      }
      if (ids.isNotEmpty()) database.uploadTaskDao().cancel(ids, System.currentTimeMillis())
      null
    }
  }

  override fun invalidate() {
    executor.shutdownNow()
    super.invalidate()
  }

  private fun <T> execute(promise: Promise, operation: () -> T) {
    executor.execute {
      try {
        promise.resolve(operation())
      } catch (error: Throwable) {
        promise.reject("UPLOAD_QUEUE_ERROR", error)
      }
    }
  }

  private fun snapshotToMap(tasks: List<UploadTaskEntity>): WritableMap {
    val result = Arguments.createMap()
    val items = Arguments.createArray()
    tasks.forEach { items.pushMap(taskToMap(it)) }
    result.putArray("tasks", items)
    result.putInt("queued", tasks.count { it.state == UploadTaskState.QUEUED })
    result.putInt("uploading", tasks.count { it.state == UploadTaskState.UPLOADING })
    result.putInt("succeeded", tasks.count { it.state == UploadTaskState.SUCCEEDED })
    result.putInt("failed", tasks.count { it.state == UploadTaskState.FAILED })
    result.putDouble("sentBytes", tasks.sumOf { it.sentBytes }.toDouble())
    result.putDouble("totalBytes", tasks.mapNotNull { it.sizeBytes }.sum().toDouble())
    return result
  }

  private fun taskToMap(task: UploadTaskEntity): WritableMap = Arguments.createMap().apply {
    putString("id", task.id)
    putString("batchId", task.batchId)
    putString("contentUri", task.contentUri)
    putString("displayName", task.displayName)
    putString("mimeType", task.mimeType)
    putNullableDouble("size", task.sizeBytes)
    putString("serverId", task.serverId)
    putNullableString("userId", task.userId)
    putString("deviceId", task.deviceId)
    putNullableString("sessionId", task.sessionId)
    putString("folderId", task.folderId)
    putString("state", task.state)
    putDouble("sentBytes", task.sentBytes.toDouble())
    putInt("attempts", task.attempts)
    putNullableString("lastErrorCode", task.lastErrorCode)
    putNullableString("lastErrorMessage", task.lastErrorMessage)
    putDouble("createdAtEpochMs", task.createdAtEpochMs.toDouble())
    putNullableDouble("startedAtEpochMs", task.startedAtEpochMs)
    putNullableDouble("completedAtEpochMs", task.completedAtEpochMs)
    putNullableDouble("nextRetryAtEpochMs", task.nextRetryAtEpochMs)
    putNullableString("leaseOwner", task.leaseOwner)
    putNullableDouble("leaseUntilEpochMs", task.leaseUntilEpochMs)
  }

  private fun requiredString(map: ReadableMap, key: String): String =
    map.getString(key)?.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("$key is required")

  private fun optionalSize(map: ReadableMap): Long? {
    if (!map.hasKey("size") || map.isNull("size")) return null
    val value = map.getDouble("size")
    if (!value.isFinite() || value < 0 || value > Long.MAX_VALUE) throw IllegalArgumentException("size is invalid")
    return value.toLong()
  }

  private fun requireIdentifier(value: String, key: String): String =
    value.trim().takeIf { it.isNotEmpty() && it.length <= 128 } ?: throw IllegalArgumentException("$key is invalid")

  private fun readLANCIDRs(values: ReadableArray): List<String> =
    (0 until values.size()).map { index ->
      values.getString(index)?.trim()?.takeIf { it.isNotEmpty() }
        ?: throw IllegalArgumentException("lanCIDRs contains an invalid range")
    }.distinct().take(MAX_LAN_CIDRS)

  private fun WritableMap.putNullableString(key: String, value: String?) {
    if (value == null) putNull(key) else putString(key, value)
  }

  private fun WritableMap.putNullableDouble(key: String, value: Long?) {
    if (value == null) putNull(key) else putDouble(key, value.toDouble())
  }

  companion object {
    const val NAME = "NativeUploadQueue"
    private const val MAX_LAN_CIDRS = 128
  }
}

class NativeUploadQueuePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == NativeUploadQueueModule.NAME) NativeUploadQueueModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      NativeUploadQueueModule.NAME to ReactModuleInfo(
        NativeUploadQueueModule.NAME,
        NativeUploadQueueModule::class.java.name,
        false,
        false,
        false,
        true,
      ),
    )
  }
}
