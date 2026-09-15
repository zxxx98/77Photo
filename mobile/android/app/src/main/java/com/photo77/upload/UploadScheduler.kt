package com.photo77.upload

import com.photo77.upload.db.UploadTaskDao
import com.photo77.upload.db.UploadTaskEntity
import com.photo77.upload.db.UploadTaskState
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicBoolean

interface UploadTaskSource {
  fun recoverExpiredLeases(now: Long)

  fun acquireQueued(
    serverId: String,
    owner: String,
    limit: Int,
    now: Long,
    leaseUntil: Long,
  ): List<UploadTaskEntity>

  fun updateState(
    task: UploadTaskEntity,
    nextState: String,
    now: Long,
    errorCode: String?,
    errorMessage: String?,
    nextRetryAt: Long?,
  )

  /** State transitions from a leased upload must prove ownership at commit time. */
  fun updateStateOwned(
    task: UploadTaskEntity,
    owner: String,
    nextState: String,
    now: Long,
    errorCode: String?,
    errorMessage: String?,
    nextRetryAt: Long?,
  ) = updateState(task, nextState, now, errorCode, errorMessage, nextRetryAt)

  fun hasRunnable(serverId: String, now: Long): Boolean

  fun recordAttempt(task: UploadTaskEntity, owner: String, now: Long) = Unit

  fun updateProgress(task: UploadTaskEntity, owner: String, sentBytes: Long, now: Long) = Unit

  fun pauseForAuthentication(serverId: String, deviceId: String, now: Long) = Unit

  fun releaseLeases(owner: String) = Unit

  fun renewLeases(owner: String, now: Long, leaseUntil: Long) = Unit

  fun hasQueued(serverId: String): Boolean = false

  fun hasActiveLease(serverId: String, now: Long): Boolean = false
}

fun interface UploadTaskUploader {
  fun upload(task: UploadTaskEntity, onProgress: (sentBytes: Long, totalBytes: Long?) -> Unit): UploadResult
}

data class UploadResult(
  val statusCode: Int? = null,
  val errorCode: String? = null,
  val errorMessage: String? = null,
  val disposition: UploadDisposition? = null,
  val succeeded: Boolean = false,
) {
  companion object {
    fun success() = UploadResult(succeeded = true, statusCode = 200)

    fun retryable(code: String, message: String? = null, statusCode: Int? = null) = UploadResult(
      statusCode = statusCode,
      errorCode = code,
      errorMessage = message,
      disposition = UploadDisposition.RETRYABLE,
    )

    fun permanent(code: String, message: String? = null, statusCode: Int? = null) = UploadResult(
      statusCode = statusCode,
      errorCode = code,
      errorMessage = message,
      disposition = UploadDisposition.PERMANENT,
    )

    fun skipped(message: String? = null, statusCode: Int? = 409) = UploadResult(
      statusCode = statusCode,
      errorCode = "DUPLICATE_PHOTO",
      errorMessage = message,
      disposition = UploadDisposition.SKIPPED,
    )

    fun authRequired(message: String? = null) = UploadResult(
      statusCode = 401,
      errorCode = "AUTH_REQUIRED",
      errorMessage = message,
    )
  }
}

/** Coordinates leased Room jobs and keeps the number of active file streams bounded. */
class UploadScheduler(
  private val source: UploadTaskSource,
  private val uploader: UploadTaskUploader,
  private val retryPolicy: UploadRetryPolicy = UploadRetryPolicy(),
  private val sleepMillis: Long = DEFAULT_SLEEP_MILLIS,
  private val clock: () -> Long = { System.currentTimeMillis() },
  private val authRefresher: UploadAuthRefresher? = null,
  private val networkAvailable: () -> Boolean = { true },
  private val onInitialLeaseDecision: () -> Unit = {},
) {
  private val coordinator: ExecutorService = Executors.newSingleThreadExecutor(daemonThreadFactory("photo77-upload-coordinator"))
  private val workers: ExecutorService = Executors.newCachedThreadPool(daemonThreadFactory("photo77-upload-worker"))
  private val stopped = AtomicBoolean(false)
  private val stateLock = Any()
  private var configuredConcurrency = DEFAULT_CONCURRENCY
  private var degraded = false
  private var transientFailureStreak = 0
  private var successStreak = 0
  private var activeRun: Future<*>? = null
  private var runOwner: String? = null

  fun start(serverId: String, owner: String, concurrency: Int): Future<*> {
    synchronized(stateLock) {
      check(!stopped.get()) { "scheduler is stopped" }
      configuredConcurrency = concurrency.coerceIn(MIN_CONCURRENCY, MAX_CONCURRENCY)
      val existing = activeRun
      if (existing != null && !existing.isDone) return existing
      runOwner = owner
      val run = coordinator.submit { runLoop(serverId, owner) }
      activeRun = run
      return run
    }
  }

  fun setConcurrency(concurrency: Int) {
    synchronized(stateLock) {
      configuredConcurrency = concurrency.coerceIn(MIN_CONCURRENCY, MAX_CONCURRENCY)
    }
  }

  fun stop() {
    if (!stopped.compareAndSet(false, true)) return
    coordinator.shutdownNow()
    workers.shutdownNow()
    runOwner?.let(source::releaseLeases)
  }

  private fun runLoop(serverId: String, owner: String) {
    val active = LinkedHashMap<Future<*>, UploadTaskEntity>()
    var initialLeaseDecisionReported = false
    fun reportInitialLeaseDecision() {
      if (!initialLeaseDecisionReported) {
        initialLeaseDecisionReported = true
        onInitialLeaseDecision()
      }
    }
    try {
      source.recoverExpiredLeases(clock())
      while (!stopped.get() && !Thread.currentThread().isInterrupted) {
        reapFinished(active)
        val now = clock()
        source.renewLeases(owner, now, now + LEASE_MILLIS)
        val runnable = source.hasRunnable(serverId, now)
        if (active.isEmpty() && !runnable) {
          reportInitialLeaseDecision()
          return
        }
        if (active.isEmpty() && source.hasActiveLease(serverId, now)) {
          reportInitialLeaseDecision()
          return
        }

        if (networkAvailable()) {
          val available = effectiveConcurrency() - active.size
          if (available > 0) {
            val tasks = source.acquireQueued(
              serverId = serverId,
              owner = owner,
              limit = available,
              now = now,
              leaseUntil = now + LEASE_MILLIS,
            )
            tasks.forEach { task ->
              active[workers.submit { process(task, owner) }] = task
            }
          }
        }
        reportInitialLeaseDecision()

        if (active.isEmpty() && !source.hasRunnable(serverId, clock())) return
        if (active.isEmpty() && !networkAvailable()) return
        if (sleepMillis > 0) Thread.sleep(sleepMillis)
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    } finally {
      reportInitialLeaseDecision()
      source.releaseLeases(owner)
      active.keys.forEach { it.cancel(true) }
    }
  }

  private fun reapFinished(active: MutableMap<Future<*>, UploadTaskEntity>) {
    val finished = active.keys.filter { it.isDone }
    finished.forEach(active::remove)
  }

  private fun process(task: UploadTaskEntity, owner: String) {
    var authRetried = false
    var attempt = task.attempts
    while (!stopped.get()) {
      attempt += 1
      source.recordAttempt(task, owner, clock())
      val result = try {
        uploader.upload(task) { sentBytes, _ ->
          source.updateProgress(task, owner, sentBytes, clock())
        }
      } catch (error: IOException) {
        UploadResult.retryable("NETWORK_ERROR", error.message)
      } catch (error: Exception) {
        UploadResult.retryable("UPLOAD_FAILED", error.message)
      }

      // Service destruction, timeout, or an explicit pause must not turn a canceled
      // transfer into a successful task after its lease has been released.
      if (stopped.get()) return

      if (result.statusCode == 401 || result.errorCode == "AUTH_REQUIRED") {
        if (!authRetried && authRefresher?.refresh(task.serverId, task.deviceId) == true) {
          authRetried = true
          continue
        }
        source.pauseForAuthentication(task.serverId, task.deviceId, clock())
        source.updateStateOwned(
          task = task,
          owner = owner,
          nextState = UploadTaskState.PAUSED,
          now = clock(),
          errorCode = "AUTH_REQUIRED",
          errorMessage = result.errorMessage,
          nextRetryAt = null,
        )
        return
      }

      when {
        result.succeeded -> {
          source.updateStateOwned(task, owner, UploadTaskState.SUCCEEDED, clock(), null, null, null)
          recordSuccess()
          return
        }
        disposition(result) == UploadDisposition.SKIPPED -> {
          source.updateStateOwned(
            task,
            owner,
            UploadTaskState.SUCCEEDED,
            clock(),
            "DUPLICATE_PHOTO",
            result.errorMessage,
            null,
          )
          return
        }
        disposition(result) == UploadDisposition.RETRYABLE -> {
          recordTransientFailure(result)
          val now = clock()
          source.updateStateOwned(
            task,
            owner,
            UploadTaskState.QUEUED,
            now,
            result.errorCode ?: "UPLOAD_RETRYABLE",
            result.errorMessage,
            now + retryPolicy.delayMillis(attempt),
          )
          return
        }
        else -> {
          source.updateStateOwned(
            task,
            owner,
            UploadTaskState.FAILED,
            clock(),
            result.errorCode ?: "UPLOAD_FAILED",
            result.errorMessage,
            null,
          )
          return
        }
      }
    }
  }

  private fun disposition(result: UploadResult): UploadDisposition =
    result.disposition ?: retryPolicy.classify(result.statusCode, result.errorCode)

  private fun effectiveConcurrency(): Int = synchronized(stateLock) {
    if (degraded) MIN_CONCURRENCY else configuredConcurrency
  }

  private fun recordTransientFailure(result: UploadResult) {
    if (result.statusCode == 429 || result.statusCode != null && result.statusCode in 500..599) {
      synchronized(stateLock) {
        transientFailureStreak += 1
        successStreak = 0
        if (transientFailureStreak >= ADAPTATION_THRESHOLD) degraded = true
      }
    }
  }

  private fun recordSuccess() {
    synchronized(stateLock) {
      transientFailureStreak = 0
      successStreak += 1
      if (degraded && successStreak >= ADAPTATION_THRESHOLD) {
        degraded = false
        successStreak = 0
      }
    }
  }

  companion object {
    private const val DEFAULT_CONCURRENCY = 2
    private const val MIN_CONCURRENCY = 1
    private const val MAX_CONCURRENCY = 4
    private const val ADAPTATION_THRESHOLD = 3
    internal const val LEASE_MILLIS = 60_000L
    private const val DEFAULT_SLEEP_MILLIS = 250L

    private fun daemonThreadFactory(name: String): ThreadFactory = ThreadFactory { runnable ->
      Thread(runnable, name).apply { isDaemon = true }
    }
  }
}

/** Production Room adapter; the scheduler itself remains straightforward to unit-test. */
class RoomUploadTaskSource(private val dao: UploadTaskDao) : UploadTaskSource {
  override fun recoverExpiredLeases(now: Long) {
    dao.recoverExpiredLeases(now)
  }

  override fun acquireQueued(serverId: String, owner: String, limit: Int, now: Long, leaseUntil: Long): List<UploadTaskEntity> =
    dao.acquireQueued(serverId, owner, limit, now, leaseUntil)

  override fun updateState(
    task: UploadTaskEntity,
    nextState: String,
    now: Long,
    errorCode: String?,
    errorMessage: String?,
    nextRetryAt: Long?,
  ) {
    dao.updateStateWithRetry(task.id, task.state, nextState, now, errorCode, errorMessage, nextRetryAt)
  }

  override fun updateStateOwned(
    task: UploadTaskEntity,
    owner: String,
    nextState: String,
    now: Long,
    errorCode: String?,
    errorMessage: String?,
    nextRetryAt: Long?,
  ) {
    dao.updateStateWithRetryOwned(task.id, owner, nextState, now, errorCode, errorMessage, nextRetryAt)
  }

  override fun hasRunnable(serverId: String, now: Long): Boolean = dao.hasRunnable(serverId, now)

  override fun recordAttempt(task: UploadTaskEntity, owner: String, now: Long) {
    dao.recordAttempt(task.id, owner)
  }

  override fun updateProgress(task: UploadTaskEntity, owner: String, sentBytes: Long, now: Long) {
    dao.updateProgress(task.id, owner, sentBytes, now + UploadScheduler.LEASE_MILLIS)
  }

  override fun renewLeases(owner: String, now: Long, leaseUntil: Long) {
    dao.renewLeases(owner, leaseUntil)
  }

  override fun pauseForAuthentication(serverId: String, deviceId: String, now: Long) {
    dao.pauseForAuthentication(serverId, deviceId)
  }

  override fun releaseLeases(owner: String) {
    dao.releaseLeases(owner)
  }

  override fun hasQueued(serverId: String): Boolean = dao.hasQueued(serverId)

  override fun hasActiveLease(serverId: String, now: Long): Boolean = dao.hasActiveLease(serverId, now)
}
