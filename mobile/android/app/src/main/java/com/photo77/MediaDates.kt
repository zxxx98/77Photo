package com.photo77

import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.ResolverStyle
import java.time.temporal.ChronoField
import java.util.Locale

private val exifDateFormat = DateTimeFormatter.ofPattern("uuuu:MM:dd HH:mm:ss", Locale.US)
  .withResolverStyle(ResolverStyle.STRICT)
private val videoDateFormat = DateTimeFormatterBuilder()
  .appendPattern("uuuuMMdd'T'HHmmss")
  .appendFraction(ChronoField.NANO_OF_SECOND, 0, 9, true)
  .appendOffset("+HHmm", "Z")
  .toFormatter(Locale.US).withResolverStyle(ResolverStyle.STRICT)

// EXIF often has no offset. Interpret that wall-clock time in the device's
// timezone, rather than treating it as UTC and shifting the calendar date.
internal fun exifTimestamp(value: String?, offset: String?, zone: ZoneId = ZoneId.systemDefault()): Long? {
  if (value.isNullOrBlank()) return null
  return runCatching {
    val date = LocalDateTime.parse(value.trim(), exifDateFormat)
    val parsedOffset = offset?.let { runCatching { ZoneOffset.of(it.trim()) }.getOrNull() }
    (if (parsedOffset != null) date.toInstant(parsedOffset) else date.atZone(zone).toInstant())
      .toEpochMilli().takeIf { it > 0 }
  }.getOrNull()
}

internal fun videoTimestamp(value: String?): Long? {
  if (value.isNullOrBlank()) return null
  return runCatching { Instant.parse(value.trim()).toEpochMilli() }
    .recoverCatching { OffsetDateTime.parse(value.trim(), videoDateFormat).toInstant().toEpochMilli() }
    .getOrNull()?.takeIf { it > 0 }
}
