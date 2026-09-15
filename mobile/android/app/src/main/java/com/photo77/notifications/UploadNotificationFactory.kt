package com.photo77.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

data class UploadNotificationState(
  val serverId: String,
  val sentBytes: Long,
  val totalBytes: Long?,
  val completed: Int,
  val failed: Int,
  val remaining: Int,
  val paused: Boolean,
  val baseUrl: String? = null,
  val deviceId: String? = null,
  val concurrency: Int = 2,
  val allowMobile: Boolean = false,
  val lanCIDRs: List<String> = emptyList(),
)

object UploadNotificationFactory {
  const val CHANNEL_ID = "77photo_uploads_v1"

  fun ensureChannel(context: Context) {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "77Photo uploads", NotificationManager.IMPORTANCE_LOW),
    )
  }

  fun progress(context: Context, state: UploadNotificationState): Notification {
    ensureChannel(context)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle(if (state.paused) "Uploads paused" else "Uploading photos")
      .setContentText(summary(state))
      .setOngoing(!state.paused)
      .setOnlyAlertOnce(true)
      .setAutoCancel(false)

    val total = state.totalBytes?.takeIf { it > 0L }
    if (total == null) {
      builder.setProgress(0, 0, true)
    } else if (total <= Int.MAX_VALUE && state.sentBytes <= Int.MAX_VALUE) {
      builder.setProgress(total.toInt(), state.sentBytes.coerceIn(0L, total).toInt(), false)
    } else {
      val percent = ((state.sentBytes.coerceIn(0L, total) * 100.0) / total).toInt()
      builder.setProgress(100, percent.coerceIn(0, 100), false)
    }

    val action = if (state.paused) ACTION_RESUME else ACTION_PAUSE
    builder.addAction(
      0,
      if (state.paused) "Resume" else "Pause",
      actionPendingIntent(context, action, state),
    )
    return builder.build()
  }

  fun completion(context: Context, succeeded: Int, skipped: Int, failed: Int): Notification {
    ensureChannel(context)
    return NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .setContentTitle("77Photo upload complete")
      .setContentText("$succeeded succeeded · $skipped skipped · $failed failed")
      .setAutoCancel(true)
      .setOngoing(false)
      .build()
  }

  private fun summary(state: UploadNotificationState): String =
    "${state.completed} complete · ${state.failed} failed · ${state.remaining} remaining"

  private fun actionPendingIntent(context: Context, action: String, state: UploadNotificationState): PendingIntent {
    val intent = Intent(context, UploadActionReceiver::class.java).apply {
      this.action = action
      putExtra(UploadActionReceiver.EXTRA_SERVER_ID, state.serverId)
      state.baseUrl?.let { putExtra(UploadActionReceiver.EXTRA_BASE_URL, it) }
      state.deviceId?.let { putExtra(UploadActionReceiver.EXTRA_DEVICE_ID, it) }
      putExtra(UploadActionReceiver.EXTRA_CONCURRENCY, state.concurrency)
      putExtra(UploadActionReceiver.EXTRA_ALLOW_MOBILE, state.allowMobile)
      putStringArrayListExtra(UploadActionReceiver.EXTRA_LAN_CIDRS, ArrayList(state.lanCIDRs.take(128)))
    }
    val requestCode = (state.serverId.hashCode() * 31 + action.hashCode()) and 0x7fffffff
    return PendingIntent.getBroadcast(
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  const val ACTION_PAUSE = "com.photo77.upload.PAUSE"
  const val ACTION_RESUME = "com.photo77.upload.RESUME"
}
