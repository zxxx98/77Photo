package com.photo77.notifications

import org.junit.Assert.assertEquals
import org.junit.Test

class UploadResumeCoordinatorTest {
  @Test
  fun resumeStartsTheForegroundServiceBeforeSchedulingFallbackRecovery() {
    val events = mutableListOf<String>()

    UploadResumeCoordinator(
      resumePaused = { events += "resume" },
      startService = { events += "service" },
      scheduleRecovery = { events += "schedule" },
    ).run()

    assertEquals(listOf("schedule", "resume", "service"), events)
  }
}
