package com.photo77.upload

import org.junit.Assert.assertEquals
import org.junit.Test

class UploadStartCoordinatorTest {
  @Test
  fun schedulesRecoveryBeforeStartingTheForegroundService() {
    val events = mutableListOf<String>()

    UploadStartCoordinator(
      scheduleRecovery = { events += "schedule" },
      startService = { events += "service" },
    ).run()

    assertEquals(listOf("schedule", "service"), events)
  }
}
