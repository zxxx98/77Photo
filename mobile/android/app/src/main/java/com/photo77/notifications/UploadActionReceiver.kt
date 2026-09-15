package com.photo77.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.photo77.upload.UploadForegroundService
import com.photo77.upload.UploadRecoveryWorker
import com.photo77.upload.UploadStartCoordinator
import com.photo77.upload.db.UploadDatabase
import java.util.concurrent.Executors

internal class UploadResumeCoordinator(
  private val resumePaused: () -> Unit,
  private val scheduleRecovery: () -> Unit,
  private val startService: () -> Unit,
) {
  fun run() {
    UploadStartCoordinator(
      scheduleRecovery = scheduleRecovery,
      startService = {
        resumePaused()
        startService()
      },
    ).run()
  }
}

class UploadActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val serverId = intent.getStringExtra(EXTRA_SERVER_ID)?.takeIf { it.isNotBlank() } ?: return
    val pending = goAsync()
    executor.execute {
      try {
        val dao = UploadDatabase.getInstance(context).uploadTaskDao()
        when (intent.action) {
          UploadNotificationFactory.ACTION_PAUSE -> {
            dao.pauseUploading(serverId)
            dao.pauseQueued(serverId)
            UploadForegroundService.pauseActive(serverId)
          }
          UploadNotificationFactory.ACTION_RESUME -> {
            val baseUrl = intent.getStringExtra(EXTRA_BASE_URL)?.takeIf { it.isNotBlank() }
            val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID)?.takeIf { it.isNotBlank() }
            val lanCIDRs = intent.getStringArrayListExtra(EXTRA_LAN_CIDRS).orEmpty()
            if (baseUrl != null && deviceId != null) {
              val concurrency = intent.getIntExtra(EXTRA_CONCURRENCY, 2)
              val allowMobile = intent.getBooleanExtra(EXTRA_ALLOW_MOBILE, false)
              UploadForegroundService.reserveStart(serverId)
              try {
                UploadResumeCoordinator(
                  resumePaused = { dao.resumePaused(serverId) },
                  startService = {
                    val serviceIntent = UploadForegroundService.startIntent(
                      context = context,
                      serverId = serverId,
                      baseUrl = baseUrl,
                      deviceId = deviceId,
                      concurrency = concurrency,
                      allowMobile = allowMobile,
                      lanCIDRs = lanCIDRs,
                    )
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(serviceIntent)
                    else context.startService(serviceIntent)
                  },
                  scheduleRecovery = {
                    UploadRecoveryWorker.schedule(
                      context = context,
                      serverId = serverId,
                      baseUrl = baseUrl,
                      deviceId = deviceId,
                      concurrency = concurrency,
                      allowMobile = allowMobile,
                      lanCIDRs = lanCIDRs,
                      initialDelayMillis = 10_000L,
                    )
                  },
                ).run()
              } catch (error: Throwable) {
                UploadForegroundService.releaseStartReservation(serverId)
                throw error
              }
            } else {
              dao.resumePaused(serverId)
            }
          }
        }
      } finally {
        pending.finish()
      }
    }
  }

  companion object {
    const val EXTRA_SERVER_ID = "server_id"
    const val EXTRA_BASE_URL = "base_url"
    const val EXTRA_DEVICE_ID = "device_id"
    const val EXTRA_CONCURRENCY = "concurrency"
    const val EXTRA_ALLOW_MOBILE = "allow_mobile"
    const val EXTRA_LAN_CIDRS = "lan_cidrs"
    private val executor = Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "photo77-upload-notification").apply { isDaemon = true }
    }
  }
}
