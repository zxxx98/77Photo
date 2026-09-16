package com.photo77.upload

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.photo77.upload.db.UploadDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

internal enum class RecoveryLeaseDecision {
  RUN,
  YIELD_SUCCESS,
  RETRY,
}

/** Restarts queued work after a process kill, reboot, or connectivity interruption. */
class UploadRecoveryWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
  override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
    val serverId = inputData.getString(KEY_SERVER_ID)?.takeIf { it.isNotBlank() }
    val baseUrl = inputData.getString(KEY_BASE_URL)?.takeIf { it.isNotBlank() }
    val deviceId = inputData.getString(KEY_DEVICE_ID)?.takeIf { it.isNotBlank() }
    if (serverId == null || baseUrl == null || deviceId == null) return@withContext Result.failure()
    if (reservationDecision(UploadForegroundService.isStartReserved(serverId)) == RecoveryLeaseDecision.RETRY) {
      return@withContext Result.retry()
    }
    val lanCIDRs = inputData.getStringArray(KEY_LAN_CIDRS)?.toList().orEmpty()
    val normalizedBaseUrl = runCatching { UploadURLPolicy.requireAllowed(baseUrl, lanCIDRs) }.getOrNull()
      ?: return@withContext Result.failure()

    val dao = UploadDatabase.getInstance(applicationContext).uploadTaskDao()
    releaseCompletedTaskUriGrants(
      dao.findByServer(serverId),
      ContentResolverUriGrantReleaser(applicationContext.contentResolver),
    )
    val source = RoomUploadTaskSource(dao)
    if (leaseDecision(source.hasActiveLease(serverId, System.currentTimeMillis())) == RecoveryLeaseDecision.YIELD_SUCCESS) {
      return@withContext Result.success()
    }
    val api = UploadApi(
      baseUrl = normalizedBaseUrl,
      contentResolver = applicationContext.contentResolver,
      credentials = EncryptedUploadCredentialStore(applicationContext),
      allowedLANCIDRs = lanCIDRs,
    )
    val allowMobile = inputData.getBoolean(KEY_ALLOW_MOBILE, false)
    val scheduler = UploadScheduler(
      source,
      api,
      authRefresher = api,
      networkAvailable = { hasAllowedNetwork(allowMobile) },
      onTaskTerminal = { task ->
        releaseTaskUriGrants(task, ContentResolverUriGrantReleaser(applicationContext.contentResolver))
      },
    )
    val future = scheduler.start(
      serverId = serverId,
      owner = "worker-${id}",
      concurrency = inputData.getInt(KEY_CONCURRENCY, 2),
    )
    try {
      future.get()
      if (source.hasQueued(serverId) || source.hasActiveLease(serverId, System.currentTimeMillis())) Result.retry() else Result.success()
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      Result.retry()
    } catch (_: Exception) {
      Result.retry()
    } finally {
      scheduler.stop()
    }
  }

  companion object {
    const val KEY_SERVER_ID = "server_id"
    const val KEY_BASE_URL = "base_url"
    const val KEY_DEVICE_ID = "device_id"
    const val KEY_CONCURRENCY = "concurrency"
    const val KEY_ALLOW_MOBILE = "allow_mobile"
    const val KEY_LAN_CIDRS = "lan_cidrs"

    internal fun leaseDecision(hasActiveLease: Boolean): RecoveryLeaseDecision =
      if (hasActiveLease) RecoveryLeaseDecision.YIELD_SUCCESS else RecoveryLeaseDecision.RUN

    internal fun reservationDecision(isReserved: Boolean): RecoveryLeaseDecision =
      if (isReserved) RecoveryLeaseDecision.RETRY else RecoveryLeaseDecision.RUN

    fun schedule(
      context: Context,
      serverId: String,
      baseUrl: String,
      deviceId: String,
      concurrency: Int = 2,
      allowMobile: Boolean = false,
      lanCIDRs: Collection<String> = emptyList(),
      initialDelayMillis: Long = 0L,
    ) {
      val input = Data.Builder()
        .putString(KEY_SERVER_ID, serverId)
        .putString(KEY_BASE_URL, baseUrl)
        .putString(KEY_DEVICE_ID, deviceId)
        .putInt(KEY_CONCURRENCY, concurrency.coerceIn(1, 4))
        .putBoolean(KEY_ALLOW_MOBILE, allowMobile)
        .putStringArray(KEY_LAN_CIDRS, lanCIDRs.take(MAX_LAN_CIDRS).toTypedArray())
        .build()
      val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()
      val requestBuilder = OneTimeWorkRequestBuilder<UploadRecoveryWorker>()
        .setInputData(input)
        .setConstraints(constraints)
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      if (initialDelayMillis > 0L) {
        requestBuilder.setInitialDelay(initialDelayMillis, TimeUnit.MILLISECONDS)
      }
      val request = requestBuilder.build()
      WorkManager.getInstance(context).enqueueUniqueWork(
        "77photo-upload-$serverId",
        ExistingWorkPolicy.KEEP,
        request,
      )
    }

    private const val MAX_LAN_CIDRS = 128
  }

  private fun hasAllowedNetwork(allowMobile: Boolean): Boolean {
    val manager = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val network = manager.activeNetwork ?: return false
    val capabilities = manager.getNetworkCapabilities(network) ?: return false
    if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false
    return allowMobile || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
  }
}
