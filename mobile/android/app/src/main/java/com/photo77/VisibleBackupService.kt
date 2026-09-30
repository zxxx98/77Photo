package com.photo77

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

// Started only from the user's visible backup action. Android 15+ limits
// dataSync foreground service time; onTimeout leaves the current file pending.
class VisibleBackupService : Service() {
  companion object {
    const val ACTION_START = "com.photo77.backup.START"
    const val ACTION_UPDATE = "com.photo77.backup.UPDATE"
    const val ACTION_PAUSE = "com.photo77.backup.PAUSE"
    const val ACTION_CANCEL = "com.photo77.backup.CANCEL"
    const val ACTION_STOP = "com.photo77.backup.STOP"
    const val EXTRA_SCOPE = "scope"
    const val EXTRA_LAUNCH_TOKEN = "launch_token"
    const val EXTRA_NAME = "name"
    const val EXTRA_PROGRESS = "progress"
    const val EXTRA_FINGERPRINT = "fingerprint"
    private const val CHANNEL_ID = "photo77_visible_backup"
    private const val NOTIFICATION_ID = 7719
    private const val PREFS = "visible-backup"
    private const val KEY_SCOPE = "scope"
    private const val KEY_FINGERPRINT = "fingerprint"
    private const val KEY_ACTION = "action"
    @Volatile var running = false
    @Volatile var runningToken: String? = null
  }

  private val preferences by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }
  private val notifications by lazy { getSystemService(NotificationManager::class.java) }
  private var name = "正在准备视频备份"
  private var progress = -1

  override fun onCreate() {
    super.onCreate()
    notifications.createNotificationChannel(NotificationChannel(CHANNEL_ID, "视频备份", NotificationManager.IMPORTANCE_LOW))
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        val scope = intent.getStringExtra(EXTRA_SCOPE) ?: return START_NOT_STICKY
        val launchToken = intent.getStringExtra(EXTRA_LAUNCH_TOKEN) ?: return START_NOT_STICKY
        preferences.edit().putString(KEY_SCOPE, scope).apply()
        name = "正在准备视频备份"
        progress = -1
        try { promote(); runningToken = launchToken }
        catch (_: Exception) { emit("pause"); stopSelf(); return START_NOT_STICKY }
      }
      ACTION_UPDATE -> {
        if (preferences.getString(KEY_SCOPE, null) == null) return START_NOT_STICKY
        name = intent.getStringExtra(EXTRA_NAME) ?: name
        progress = intent.getIntExtra(EXTRA_PROGRESS, -1)
        intent.getStringExtra(EXTRA_FINGERPRINT)?.let {
          preferences.edit().putString(KEY_FINGERPRINT, it).apply()
        }
        notifications.notify(NOTIFICATION_ID, notification())
      }
      ACTION_PAUSE -> {
        preferences.edit().putString(KEY_ACTION, "pause").commit()
        emit("pause")
        stopSelf()
      }
      ACTION_CANCEL -> {
        preferences.edit().putString(KEY_ACTION, "cancel").commit()
        emit("cancel")
        stopSelf()
      }
      ACTION_STOP -> {
        preferences.edit().clear().apply()
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  private fun promote() {
    val notification = notification()
    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(NOTIFICATION_ID, notification)
    running = true
  }

  private fun actionIntent(action: String, requestCode: Int): PendingIntent = PendingIntent.getService(
    this, requestCode, Intent(this, VisibleBackupService::class.java).setAction(action),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
  )

  private fun notification(): Notification {
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val builder = Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("77Photo 视频备份")
      .setContentText(if (progress >= 0) "$name · $progress%" else name)
      .setContentIntent(open)
      .setOngoing(true)
      .addAction(android.R.drawable.ic_media_pause, "暂停", actionIntent(ACTION_PAUSE, 1))
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "取消", actionIntent(ACTION_CANCEL, 2))
    if (progress in 0..99) builder.setProgress(100, progress, false)
    else if (progress < 0) builder.setProgress(0, 0, true)
    return builder.build()
  }

  private fun emit(action: String) {
    (application as MainApplication).reactHost.currentReactContext
      ?.emitDeviceEvent("Photo77VisibleBackupAction", action)
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    preferences.edit().putString(KEY_ACTION, "pause").commit()
    emit("pause")
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    runningToken = null
    super.onDestroy()
  }
}
