package com.photo77

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Handler
import android.os.Looper
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

class BackupJobService : JobService(), HeadlessJsTaskEventListener {
  private var parameters: JobParameters? = null
  private var tasks: HeadlessJsTaskContext? = null
  private var taskId: Int? = null
  private var listener: ReactInstanceEventListener? = null
  private val handler = Handler(Looper.getMainLooper())
  private val startupTimeout = Runnable {
    val params = parameters
    cleanup()
    if (params != null) jobFinished(params, true)
  }
  private val host get() = (application as MainApplication).reactHost

  override fun onStartJob(params: JobParameters): Boolean {
    parameters = params
    val context = host.currentReactContext
    if (context != null) startTask(context) else {
      val pending = object : ReactInstanceEventListener {
        override fun onReactContextInitialized(context: ReactContext) {
          host.removeReactInstanceEventListener(this)
          listener = null
          if (parameters != null) startTask(context)
        }
      }
      listener = pending
      host.addReactInstanceEventListener(pending)
      handler.postDelayed(startupTimeout, 30000)
      host.start()
    }
    return true
  }

  private fun startTask(context: ReactContext) {
    handler.removeCallbacks(startupTimeout)
    try {
      tasks = HeadlessJsTaskContext.getInstance(context)
      tasks?.addTaskEventListener(this)
      taskId = tasks?.startTask(HeadlessJsTaskConfig("Photo77Backup", Arguments.createMap(), 240000, true))
    } catch (_: Exception) {
      val params = parameters
      cleanup()
      if (params != null) jobFinished(params, true)
    }
  }

  override fun onHeadlessJsTaskStart(taskId: Int) {}
  override fun onHeadlessJsTaskFinish(taskId: Int) {
    if (this.taskId != taskId) return
    val params = parameters
    cleanup()
    if (params != null) jobFinished(params, false)
  }

  private fun cleanup() {
    handler.removeCallbacks(startupTimeout)
    listener?.let { host.removeReactInstanceEventListener(it) }
    listener = null
    tasks?.removeTaskEventListener(this)
    tasks = null
    parameters = null
    taskId = null
  }

  override fun onStopJob(params: JobParameters): Boolean {
    // JS checks this event between files; an interrupted file is safe to retry
    // because the server detects duplicates by content.
    host.currentReactContext?.emitDeviceEvent("Photo77BackupStop", null)
    cleanup()
    return true
  }
}
