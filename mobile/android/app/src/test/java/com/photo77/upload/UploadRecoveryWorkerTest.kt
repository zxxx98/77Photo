package com.photo77.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadRecoveryWorkerTest {
  @Test
  fun activeForegroundOwnerMakesRecoveryWorkerYieldSuccessfully() {
    assertEquals(RecoveryLeaseDecision.YIELD_SUCCESS, UploadRecoveryWorker.leaseDecision(true))
    assertEquals(RecoveryLeaseDecision.RUN, UploadRecoveryWorker.leaseDecision(false))
  }

  @Test
  fun foregroundStartReservationMakesRecoveryRetriesUntilServiceOwnsTheRun() {
    UploadForegroundService.reserveStart("server-reserved")
    try {
      assertTrue(UploadForegroundService.isStartReserved("server-reserved"))
      assertEquals(RecoveryLeaseDecision.RETRY, UploadRecoveryWorker.reservationDecision(true))
    } finally {
      UploadForegroundService.releaseStartReservation("server-reserved")
    }
    assertFalse(UploadForegroundService.isStartReserved("server-reserved"))
  }
}
