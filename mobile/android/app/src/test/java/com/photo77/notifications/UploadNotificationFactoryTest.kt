package com.photo77.notifications

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class UploadNotificationFactoryTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @Test
  fun usesStableChannelAndByteBasedProgress() {
    val notification = UploadNotificationFactory.progress(
      context,
      UploadNotificationState(
        serverId = "server-1",
        sentBytes = 40,
        totalBytes = 100,
        completed = 1,
        failed = 0,
        remaining = 2,
        paused = false,
      ),
    )

    assertEquals("77photo_uploads_v1", UploadNotificationFactory.CHANNEL_ID)
    assertEquals(100, notification.extras.getInt("android.progressMax"))
    assertEquals(40, notification.extras.getInt("android.progress"))
    assertFalse(notification.extras.getBoolean("android.progressIndeterminate"))
    assertTrue(notification.actions.isNotEmpty())
  }

  @Test
  fun fallsBackToIndeterminateProgressAndNeverIncludesPrivateText() {
    val notification = UploadNotificationFactory.progress(
      context,
      UploadNotificationState(
        serverId = "server-1",
        sentBytes = 0,
        totalBytes = null,
        completed = 0,
        failed = 0,
        remaining = 1,
        paused = false,
      ),
    )

    assertTrue(notification.extras.getBoolean("android.progressIndeterminate"))
    assertFalse(notification.extras.toString().contains("secret.jpg"))
    assertFalse(notification.extras.toString().contains("https://private.example"))
  }

  @Test
  fun completionNotificationSummarizesCounts() {
    val notification = UploadNotificationFactory.completion(context, succeeded = 3, skipped = 1, failed = 2)
    val text = notification.extras.getCharSequence("android.text").toString()
    assertTrue(text.contains("3"))
    assertTrue(text.contains("1"))
    assertTrue(text.contains("2"))
  }
}
