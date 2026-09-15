package com.photo77.upload

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import com.photo77.notifications.UploadNotificationFactory
import com.photo77.notifications.UploadNotificationState
import com.photo77.upload.db.UploadDatabase
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Owns uploads after an explicit user start/resume action. */
class UploadForegroundService : Service() {
  private val monitor: ExecutorService = Executors.newSingleThreadExecutor()
  private var scheduler: UploadScheduler? = null
  private var currentServerId: String? = null

  override fun onCreate() {
    super.onCreate()
    UploadNotificationFactory.ensureChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action != ACTION_START) {
      stopSelfResult(startId)
      return START_NOT_STICKY
    }

    val serverId = intent.getStringExtra(EXTRA_SERVER_ID)?.takeIf { it.isNotBlank() }
    val baseUrl = intent.getStringExtra(EXTRA_BASE_URL)?.takeIf { it.isNotBlank() }
    val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID)?.takeIf { it.isNotBlank() }
    if (serverId == null || baseUrl == null || deviceId == null) {
      stopSelfResult(startId)
      return START_NOT_STICKY
    }

    val existingServerId = currentServerId
    // Promotion happens before opening the database or network connection.
    currentServerId = serverId
    startInForeground()
    if (scheduler != null && existingServerId == serverId) {
      scheduler?.setConcurrency(intent.getIntExtra(EXTRA_CONCURRENCY, DEFAULT_CONCURRENCY))
      return START_NOT_STICKY
    }

    scheduler?.stop()
    val allowMobile = intent.getBooleanExtra(EXTRA_ALLOW_MOBILE, false)
    val owner = "service-${UUID.randomUUID()}"
    val source = RoomUploadTaskSource(UploadDatabase.getInstance(applicationContext).uploadTaskDao())
    val api = UploadApi(
      baseUrl = baseUrl,
      contentResolver = contentResolver,
      credentials = EncryptedUploadCredentialStore(applicationContext),
    )
    val nextScheduler = UploadScheduler(
      source = source,
      uploader = api,
      authRefresher = api,
      networkAvailable = { hasAllowedNetwork(allowMobile) },
    )
    scheduler = nextScheduler
    val future = nextScheduler.start(
      serverId = serverId,
      owner = owner,
      concurrency = intent.getIntExtra(EXTRA_CONCURRENCY, DEFAULT_CONCURRENCY),
    )
    monitor.submit { watchProgress(serverId, baseUrl, deviceId, allowMobile, future, startId) }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    scheduler?.stop()
    scheduler = null
    monitor.shutdownNow()
    super.onDestroy()
  }

  override fun onTimeout(startId: Int) {
    // Android may time-limit data-sync foreground services. Leases return to queued.
    scheduler?.stop()
    stopSelf(startId)
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    onTimeout(startId)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun startInForeground() {
    val notification = UploadNotificationFactory.progress(
      this,
      UploadNotificationState(
        serverId = currentServerId ?: "unknown",
        sentBytes = 0,
        totalBytes = null,
        completed = 0,
        failed = 0,
        remaining = 0,
        paused = false,
      ),
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun watchProgress(
    serverId: String,
    baseUrl: String,
    deviceId: String,
    allowMobile: Boolean,
    future: java.util.concurrent.Future<*>,
    startId: Int,
  ) {
    val dao = UploadDatabase.getInstance(applicationContext).uploadTaskDao()
    while (!future.isDone && !Thread.currentThread().isInterrupted) {
      publishProgress(serverId, baseUrl, deviceId, allowMobile, dao.findByServer(serverId))
      try {
        Thread.sleep(1_000L)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    runCatching { future.get() }
    val tasks = dao.findByServer(serverId)
    val skipped = tasks.count { it.state == com.photo77.upload.db.UploadTaskState.SUCCEEDED && it.lastErrorCode == "DUPLICATE_PHOTO" }
    getSystemService(NotificationManager::class.java).notify(
      NOTIFICATION_ID,
      UploadNotificationFactory.completion(
        this,
        succeeded = tasks.count { it.state == com.photo77.upload.db.UploadTaskState.SUCCEEDED } - skipped,
        skipped = skipped,
        failed = tasks.count { it.state == com.photo77.upload.db.UploadTaskState.FAILED },
      ),
    )
    stopSelfResult(startId)
  }

  private fun publishProgress(
    serverId: String,
    baseUrl: String,
    deviceId: String,
    allowMobile: Boolean,
    tasks: List<com.photo77.upload.db.UploadTaskEntity>,
  ) {
    val totalBytes = tasks.takeIf { it.all { task -> task.sizeBytes != null } }?.sumOf { it.sizeBytes ?: 0L }
    val state = UploadNotificationState(
      serverId = serverId,
      sentBytes = tasks.sumOf { it.sentBytes },
      totalBytes = totalBytes,
      completed = tasks.count { it.state == com.photo77.upload.db.UploadTaskState.SUCCEEDED },
      failed = tasks.count { it.state == com.photo77.upload.db.UploadTaskState.FAILED },
      remaining = tasks.count { it.state == com.photo77.upload.db.UploadTaskState.QUEUED || it.state == com.photo77.upload.db.UploadTaskState.UPLOADING },
      paused = tasks.isNotEmpty() && tasks.none { it.state == com.photo77.upload.db.UploadTaskState.UPLOADING } && tasks.any { it.state == com.photo77.upload.db.UploadTaskState.PAUSED },
      baseUrl = baseUrl,
      deviceId = deviceId,
      allowMobile = allowMobile,
    )
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, UploadNotificationFactory.progress(this, state))
  }

  private fun hasAllowedNetwork(allowMobile: Boolean): Boolean {
    val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val network = manager.activeNetwork ?: return false
    val capabilities = manager.getNetworkCapabilities(network) ?: return false
    if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false
    return allowMobile || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
  }

  companion object {
    const val ACTION_START = "com.photo77.upload.START"
    const val EXTRA_SERVER_ID = "server_id"
    const val EXTRA_BASE_URL = "base_url"
    const val EXTRA_DEVICE_ID = "device_id"
    const val EXTRA_CONCURRENCY = "concurrency"
    const val EXTRA_ALLOW_MOBILE = "allow_mobile"
    const val CHANNEL_ID = "77photo_uploads_v1"
    const val NOTIFICATION_ID = 7701
    private const val DEFAULT_CONCURRENCY = 2

    fun startIntent(
      context: Context,
      serverId: String,
      baseUrl: String,
      deviceId: String,
      concurrency: Int = DEFAULT_CONCURRENCY,
      allowMobile: Boolean = false,
    ): Intent = Intent(context, UploadForegroundService::class.java).apply {
      action = ACTION_START
      putExtra(EXTRA_SERVER_ID, serverId)
      putExtra(EXTRA_BASE_URL, baseUrl)
      putExtra(EXTRA_DEVICE_ID, deviceId)
      putExtra(EXTRA_CONCURRENCY, concurrency.coerceIn(1, 4))
      putExtra(EXTRA_ALLOW_MOBILE, allowMobile)
    }
  }
}
