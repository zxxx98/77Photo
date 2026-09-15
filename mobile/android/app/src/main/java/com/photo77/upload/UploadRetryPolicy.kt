package com.photo77.upload

import kotlin.math.max

enum class UploadDisposition {
  RETRYABLE,
  PERMANENT,
  SKIPPED,
}

/** Decides which upload failures can be retried without interpreting server prose. */
class UploadRetryPolicy(
  private val random: () -> Double = { kotlin.random.Random.nextDouble() },
) {
  fun classify(statusCode: Int?, errorCode: String?): UploadDisposition {
    return when {
      errorCode == "DUPLICATE_PHOTO" -> UploadDisposition.SKIPPED
      errorCode == "UPLOAD_TOO_LARGE" || errorCode == "UNSUPPORTED_MEDIA_TYPE" -> UploadDisposition.PERMANENT
      statusCode == 413 || statusCode == 415 -> UploadDisposition.PERMANENT
      statusCode == 429 || statusCode != null && statusCode in 500..599 -> UploadDisposition.RETRYABLE
      statusCode != null && statusCode in 400..499 -> UploadDisposition.PERMANENT
      else -> UploadDisposition.RETRYABLE
    }
  }

  /** Full jitter over an exponential delay, capped at fifteen minutes. */
  fun delayMillis(attempt: Int): Long {
    var upperBound = BASE_DELAY_MILLIS
    repeat(max(0, attempt - 1)) {
      if (upperBound >= MAX_DELAY_MILLIS) return MAX_DELAY_MILLIS
      upperBound = (upperBound * 2).coerceAtMost(MAX_DELAY_MILLIS)
    }
    if (upperBound >= MAX_DELAY_MILLIS) return MAX_DELAY_MILLIS
    val factor = random().coerceIn(0.0, 1.0)
    return (upperBound.toDouble() * factor).toLong().coerceIn(0L, MAX_DELAY_MILLIS)
  }

  companion object {
    private const val BASE_DELAY_MILLIS = 1_000L
    const val MAX_DELAY_MILLIS = 15 * 60 * 1_000L
  }
}
