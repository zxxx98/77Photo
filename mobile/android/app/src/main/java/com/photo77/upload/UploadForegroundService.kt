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
import java.util.concurrent.atomic.AtomicBoolean

/** Owns uploads after an explicit user start/resume action. */
class UploadForegroundService : Service() {
  private val monitor: ExecutorService = Executors.newSingleThreadExecutor()
  private var scheduler: UploadScheduler? = null
  private var currentServerId: String? = null
  private val stopping = AtomicBoolean(false)

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
    val lanCIDRs = intent.getStringArrayListExtra(EXTRA_LAN_CIDRS).orEmpty()
    val normalizedBaseUrl = runCatching { UploadURLPolicy.requireAllowed(baseUrl, lanCIDRs) }.getOrNull()
    if (normalizedBaseUrl == null) {
      stopSelfResult(startId)
      return START_NOT_STICKY
    }

    val existingServerId = currentServerId
    // Promotion happens before opening the database or network connection.
    stopping.set(false)
    currentServerId = serverId
    synchronized(activeServices) {
      existingServerId?.let { if (activeServices[it] === this) activeServices.remove(it) }
      activeServices[serverId] = this
    }
    val allowMobile = intent.getBooleanExtra(EXTRA_ALLOW_MOBILE, false)
    val concurrency = intent.getIntExtra(EXTRA_CONCURRENCY, DEFAULT_CONCURRENCY)
    startInForeground(serverId, normalizedBaseUrl, deviceId, allowMobile, lanCIDRs, concurrency)
    if (scheduler != null && existingServerId == serverId) {
      scheduler?.setConcurrency(concurrency)
      return START_NOT_STICKY
    }

    scheduler?.stop()
    val owner = "service-${UUID.randomUUID()}"
    val source = RoomUploadTaskSource(UploadDatabase.getInstance(applicationContext).uploadTaskDao())
    val api = UploadApi(
      baseUrl = normalizedBaseUrl,
      contentResolver = contentResolver,
      credentials = EncryptedUploadCredentialStore(applicationContext),
      allowedLANCIDRs = lanCIDRs,
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
      concurrency = concurrency,
    )
    monitor.submit { watchProgress(serverId, normalizedBaseUrl, deviceId, allowMobile, lanCIDRs, future, startId) }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopping.set(true)
    scheduler?.stop()
    scheduler = null
    synchronized(activeServices) {
      currentServerId?.let { if (activeServices[it] === this) activeServices.remove(it) }
    }
    monitor.shutdownNow()
    super.onDestroy()
  }

  override fun onTimeout(startId: Int) {
    // Android may time-limit data-sync foreground services. Leases return to queued.
    stopping.set(true)
    scheduler?.stop()
    stopSelf(startId)
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    onTimeout(startId)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun startInForeground(
    serverId: String,
    baseUrl: String,
    deviceId: String,
    allowMobile: Boolean,
    lanCIDRs: List<String>,
    concurrency: Int,
  ) {
    val notification = UploadNotificationFactory.progress(
      this,
      UploadNotificationState(
        serverId = serverId,
        sentBytes = 0,
        totalBytes = null,
        completed = 0,
        failed = 0,
        remaining = 0,
        paused = false,
        baseUrl = baseUrl,
        deviceId = deviceId,
        concurrency = concurrency.coerceIn(1, 4),
        allowMobile = allowMobile,
        lanCIDRs = lanCIDRs,
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
    lanCIDRs: List<String>,
    future: java.util.concurrent.Future<*>,
    startId: Int,
  ) {
    val dao = UploadDatabase.getInstance(applicationContext).uploadTaskDao()
    while (!future.isDone && !Thread.currentThread().isInterrupted) {
      publishProgress(serverId, baseUrl, deviceId, allowMobile, lanCIDRs, dao.findByServer(serverId))
      try {
        Thread.sleep(1_000L)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    runCatching { future.get() }
    if (stopping.get() || Thread.currentThread().isInterrupted) return
    val tasks = dao.findByServer(serverId)
    if (tasks.any { it.state == com.photo77.upload.db.UploadTaskState.QUEUED || it.state == com.photo77.upload.db.UploadTaskState.UPLOADING }) {
      stopSelfResult(startId)
      return
    }
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
    lanCIDRs: List<String>,
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
      lanCIDRs = lanCIDRs,
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
    const val EXTRA_LAN_CIDRS = "lan_cidrs"
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
      lanCIDRs: Collection<String> = emptyList(),
    ): Intent = Intent(context, UploadForegroundService::class.java).apply {
      action = ACTION_START
      putExtra(EXTRA_SERVER_ID, serverId)
      putExtra(EXTRA_BASE_URL, baseUrl)
      putExtra(EXTRA_DEVICE_ID, deviceId)
      putExtra(EXTRA_CONCURRENCY, concurrency.coerceIn(1, 4))
      putExtra(EXTRA_ALLOW_MOBILE, allowMobile)
      putStringArrayListExtra(EXTRA_LAN_CIDRS, ArrayList(lanCIDRs.take(MAX_LAN_CIDRS)))
    }

    fun pauseActive(serverId: String): Boolean {
      val service = synchronized(activeServices) { activeServices[serverId] }
      if (service == null || service.currentServerId != serverId) return false
      service.stopping.set(true)
      service.scheduler?.stop()
      service.scheduler = null
      service.stopSelf()
      return true
    }

    private const val MAX_LAN_CIDRS = 128
    private val activeServices = mutableMapOf<String, UploadForegroundService>()
  }
}
