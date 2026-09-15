package com.photo77.upload

/** Persists recovery work before handing control to the foreground service. */
internal class UploadStartCoordinator(
  private val scheduleRecovery: () -> Unit,
  private val startService: () -> Unit,
) {
  fun run() {
    scheduleRecovery()
    startService()
  }
}
