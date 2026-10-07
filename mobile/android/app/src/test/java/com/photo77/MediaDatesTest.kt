package com.photo77

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaDatesTest {
  @Test fun exifWithoutOffsetUsesTheLocalCalendarTime() {
    assertEquals(Instant.parse("2026-10-04T16:15:00Z").toEpochMilli(),
      exifTimestamp("2026:10:05 00:15:00", null, ZoneId.of("Asia/Shanghai")))
  }

  @Test fun exifOffsetOverridesDeviceTimezone() {
    assertEquals(Instant.parse("2026-10-04T16:15:00Z").toEpochMilli(),
      exifTimestamp("2026:10:05 00:15:00", "+08:00", ZoneId.of("UTC")))
  }

  @Test fun invalidAndMissingExifDatesRemainUnknown() {
    assertNull(exifTimestamp(null, null))
    assertNull(exifTimestamp("0000:00:00 00:00:00", null))
    assertNull(exifTimestamp("2026:02:30 00:00:00", null))
    assertEquals(Instant.parse("2024-02-29T12:00:00Z").toEpochMilli(),
      exifTimestamp("2024:02:29 12:00:00", null, ZoneId.of("UTC")))
  }

  @Test fun videoDatesAcceptBasicAndIsoFormatsAndKeepSubseconds() {
    val expected = Instant.parse("2026-10-04T16:15:00.123Z").toEpochMilli()
    assertEquals(expected, videoTimestamp("20261004T161500.123Z"))
    assertEquals(expected, videoTimestamp("20261005T001500.123+0800"))
    assertEquals(expected, videoTimestamp("2026-10-04T16:15:00.123Z"))
    assertEquals(Instant.parse("2026-10-04T16:15:00Z").toEpochMilli(), videoTimestamp("20261004T161500Z"))
    assertNull(videoTimestamp("invalid"))
    assertNull(videoTimestamp(null))
  }
}
