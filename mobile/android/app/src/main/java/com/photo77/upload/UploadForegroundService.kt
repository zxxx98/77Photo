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
  private val progressMonitor: ExecutorService = Executors.newSingleThreadExecutor()
  private val lifecycleLock = Any()
  @Volatile
  private var scheduler: UploadScheduler? = null
  @Volatile
  private var activeFuture: java.util.concurrent.Future<*>? = null
  private var currentServerId: String? = null
  private var currentBaseUrl: String? = null
  private var currentDeviceId: String? = null
  private var currentAllowMobile = false
  private var currentLanCIDRs: List<String> = emptyList()
  private var currentConcurrency = DEFAULT_CONCURRENCY
  @Volatile
  private var recoveryNeeded = false
  private val stopping = AtomicBoolean(false)
  private var generation = 0L
  @Volatile
  private var latestStartId = 0

  private data class StartRequest(
    val generation: Long,
    val serverId: String,
    val baseUrl: String,
    val deviceId: String,
    val allowMobile: Boolean,
    val lanCIDRs: List<String>,
    val concurrency: Int,
  )

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

    val allowMobile = intent.getBooleanExtra(EXTRA_ALLOW_MOBILE, false)
    val concurrency = intent.getIntExtra(EXTRA_CONCURRENCY, DEFAULT_CONCURRENCY).coerceIn(1, 4)
    var existingServerId: String? = null
    var reusableScheduler: UploadScheduler? = null
    var schedulerToStop: UploadScheduler? = null
    var request: StartRequest? = null
    synchronized(lifecycleLock) {
      existingServerId = currentServerId
      reusableScheduler = scheduler?.takeIf {
        activeFuture?.isDone == false &&
        currentServerId == serverId && currentBaseUrl == normalizedBaseUrl && currentDeviceId == deviceId &&
          currentAllowMobile == allowMobile && currentLanCIDRs == lanCIDRs
      }
      schedulerToStop = if (reusableScheduler == null) scheduler else null
      if (schedulerToStop != null) {
        scheduler = null
        activeFuture = null
      }
      stopping.set(false)
      latestStartId = startId
      currentServerId = serverId
      currentBaseUrl = normalizedBaseUrl
      currentDeviceId = deviceId
      currentAllowMobile = allowMobile
      currentLanCIDRs = lanCIDRs
      currentConcurrency = concurrency
      recoveryNeeded = false
      if (reusableScheduler == null) {
        generation += 1
        request = StartRequest(generation, serverId, normalizedBaseUrl, deviceId, allowMobile, lanCIDRs, concurrency)
      }
    }
    synchronized(activeServices) {
      existingServerId?.let { if (activeServices[it] === this) activeServices.remove(it) }
      activeServices[serverId] = this
    }
    startInForeground(serverId, normalizedBaseUrl, deviceId, allowMobile, lanCIDRs, concurrency)
    reusableScheduler?.let {
      it.setConcurrency(concurrency)
      return START_NOT_STICKY
    }
    val leaseRelease = schedulerToStop?.stop()
    val initializationRequest = checkNotNull(request)
    monitor.submit {
      try {
        runCatching { leaseRelease?.get() }
        initializeScheduler(initializationRequest)
      } catch (_: Throwable) {
        handleInitializationFailure(initializationRequest)
      }
    }
    return START_NOT_STICKY
  }

  /** Runs all Room access and scheduler construction away from the service main thread. */
  private fun initializeScheduler(request: StartRequest) {
    if (!isCurrent(request)) {
      releaseObsoleteReservation(request)
      return
    }
    val owner = "service-${UUID.randomUUID()}"
    val dao = UploadDatabase.getInstance(applicationContext).uploadTaskDao()
    releaseCompletedTaskUriGrants(
      dao.findByServer(request.serverId),
      ContentResolverUriGrantReleaser(contentResolver),
      dao::hasRetainableUri,
    )
    val source = RoomUploadTaskSource(dao)
    val api = UploadApi(
      baseUrl = request.baseUrl,
      contentResolver = contentResolver,
      credentials = EncryptedUploadCredentialStore(applicationContext),
      allowedLANCIDRs = request.lanCIDRs,
    )
    val nextScheduler = UploadScheduler(
      source = source,
      uploader = api,
      authRefresher = api,
      networkAvailable = { hasAllowedNetwork(request.allowMobile) },
      onTaskTerminal = { task ->
        releaseTaskUriGrantsIfUnused(task, dao::hasRetainableUri, ContentResolverUriGrantReleaser(contentResolver))
      },
      onInitialLeaseDecision = { releaseStartReservation(request.serverId) },
    )
    val future = synchronized(lifecycleLock) {
      if (!isCurrentLocked(request)) null else {
        scheduler = nextScheduler
        nextScheduler.start(serverId = request.serverId, owner = owner, concurrency = request.concurrency)
          .also { activeFuture = it }
      }
    }
    if (future == null) {
      nextScheduler.stop()
      releaseObsoleteReservation(request)
      return
    }
    progressMonitor.submit { watchProgress(request, future) }
  }

  private fun handleInitializationFailure(request: StartRequest) {
    val stopId = synchronized(lifecycleLock) {
      if (!isCurrentLocked(request)) null else {
        generation += 1
        recoveryNeeded = true
        latestStartId
      }
    }
    if (stopId == null) {
      releaseObsoleteReservation(request)
      return
    }
    releaseStartReservation(request.serverId)
    stopSelfResult(stopId)
  }

  private fun isCurrent(request: StartRequest): Boolean = synchronized(lifecycleLock) { isCurrentLocked(request) }

  private fun isCurrentLocked(request: StartRequest): Boolean =
    !stopping.get() && generation == request.generation

  private fun releaseObsoleteReservation(request: StartRequest) {
    val retainedByNewStart = synchronized(lifecycleLock) {
      !stopping.get() && currentServerId == request.serverId && generation != request.generation
    }
    if (!retainedByNewStart) releaseStartReservation(request.serverId)
  }

  private fun pauseAndStop() {
    val schedulerToStop = synchronized(lifecycleLock) {
      stopping.set(true)
      generation += 1
      scheduler.also {
        scheduler = null
        activeFuture = null
      }
    }
    schedulerToStop?.stop()
    stopSelf()
  }

  override fun onDestroy() {
    val schedulerToStop = synchronized(lifecycleLock) {
      stopping.set(true)
      generation += 1
      scheduler.also {
        scheduler = null
        activeFuture = null
      }
    }
    if (schedulerToStop != null) recoveryNeeded = true
    currentServerId?.let(::releaseStartReservation)
    schedulerToStop?.stop()
    scheduleRecoveryIfNeeded()
    synchronized(activeServices) {
      currentServerId?.let { if (activeServices[it] === this) activeServices.remove(it) }
    }
    monitor.shutdownNow()
    progressMonitor.shutdownNow()
    super.onDestroy()
  }

  override fun onTimeout(startId: Int) {
    // Android may time-limit data-sync foreground services. Leases return to queued.
    val schedulerToStop = synchronized(lifecycleLock) {
      stopping.set(true)
      generation += 1
      scheduler.also {
        scheduler = null
        activeFuture = null
      }
    }
    recoveryNeeded = true
    schedulerToStop?.stop()
    scheduleRecoveryIfNeeded()
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

  private fun watchProgress(request: StartRequest, future: java.util.concurrent.Future<*>) {
    val dao = UploadDatabase.getInstance(applicationContext).uploadTaskDao()
    while (!future.isDone && !Thread.currentThread().isInterrupted && isCurrent(request)) {
      publishProgress(
        request.serverId,
        request.baseUrl,
        request.deviceId,
        request.allowMobile,
        request.lanCIDRs,
        dao.findByServer(request.serverId),
      )
      try {
        Thread.sleep(1_000L)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    runCatching { future.get() }
    if (!isCurrent(request) || Thread.currentThread().isInterrupted) return
    val tasks = dao.findByServer(request.serverId)
    val needsRecovery = tasks.any {
      it.state == com.photo77.upload.db.UploadTaskState.QUEUED ||
        it.state == com.photo77.upload.db.UploadTaskState.UPLOADING
    }
    val stopId = synchronized(lifecycleLock) {
      if (!isCurrentLocked(request)) null else {
        scheduler = null
        activeFuture = null
        if (needsRecovery) recoveryNeeded = true
        latestStartId
      }
    } ?: return
    if (needsRecovery) {
      stopSelfResult(stopId)
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
    stopSelfResult(stopId)
  }

  private fun scheduleRecoveryIfNeeded() {
    if (!recoveryNeeded) return
    val serverId = currentServerId ?: return
    val baseUrl = currentBaseUrl ?: return
    val deviceId = currentDeviceId ?: return
    UploadRecoveryWorker.schedule(
      context = applicationContext,
      serverId = serverId,
      baseUrl = baseUrl,
      deviceId = deviceId,
      concurrency = currentConcurrency,
      allowMobile = currentAllowMobile,
      lanCIDRs = currentLanCIDRs,
    )
    recoveryNeeded = false
  }

  private fun publishProgress(
    serverId: String,
    baseUrl: String,
    deviceId: String,
    allowMobile: Boolean,
    lanCIDRs: List<String>,
    tasks: List<com.photo77.upload.db.UploadTaskEntity>,
  ) {
    val totalBytes = tasks.takeIf { it.all { task -> task.sizeBytes != null && (task.motionUri == null || task.motionSizeBytes != null) } }
      ?.sumOf { (it.sizeBytes ?: 0L) + (it.motionSizeBytes ?: 0L) }
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
      service.pauseAndStop()
      return true
    }

    fun reserveStart(serverId: String) {
      synchronized(startReservations) { startReservations.add(serverId) }
    }

    fun releaseStartReservation(serverId: String) {
      synchronized(startReservations) { startReservations.remove(serverId) }
    }

    internal fun isStartReserved(serverId: String): Boolean =
      synchronized(startReservations) { serverId in startReservations }

    private const val MAX_LAN_CIDRS = 128
    private val activeServices = mutableMapOf<String, UploadForegroundService>()
    private val startReservations = mutableSetOf<String>()
  }
}
