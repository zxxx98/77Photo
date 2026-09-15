package com.photo77.upload

import org.junit.Assert.assertEquals
import org.junit.Test

class UploadRetryPolicyTest {
  private val policy = UploadRetryPolicy(random = { 0.5 })

  @Test
  fun classifiesServerAndMediaErrors() {
    assertEquals(UploadDisposition.PERMANENT, policy.classify(413, "UPLOAD_TOO_LARGE"))
    assertEquals(UploadDisposition.SKIPPED, policy.classify(409, "DUPLICATE_PHOTO"))
    assertEquals(UploadDisposition.RETRYABLE, policy.classify(429, "RATE_LIMITED"))
    assertEquals(UploadDisposition.RETRYABLE, policy.classify(503, "INTERNAL_ERROR"))
    assertEquals(UploadDisposition.PERMANENT, policy.classify(415, "UNSUPPORTED_MEDIA_TYPE"))
  }

  @Test
  fun retryDelayUsesFullJitterAndCapsAtFifteenMinutes() {
    assertEquals(500L, policy.delayMillis(attempt = 1))
    assertEquals(1000L, policy.delayMillis(attempt = 2))
    assertEquals(15 * 60 * 1000L, policy.delayMillis(attempt = 20))
  }
}
