package com.photo77.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.photo77.upload.UploadForegroundService
import com.photo77.upload.db.UploadDatabase
import java.util.concurrent.Executors

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
          }
          UploadNotificationFactory.ACTION_RESUME -> {
            dao.resumePaused(serverId)
            val baseUrl = intent.getStringExtra(EXTRA_BASE_URL)?.takeIf { it.isNotBlank() }
            val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID)?.takeIf { it.isNotBlank() }
            if (baseUrl != null && deviceId != null) {
              val serviceIntent = UploadForegroundService.startIntent(
                context = context,
                serverId = serverId,
                baseUrl = baseUrl,
                deviceId = deviceId,
                concurrency = intent.getIntExtra(EXTRA_CONCURRENCY, 2),
                allowMobile = intent.getBooleanExtra(EXTRA_ALLOW_MOBILE, false),
              )
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(serviceIntent)
              else context.startService(serviceIntent)
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
    private val executor = Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "photo77-upload-notification").apply { isDaemon = true }
    }
  }
}
