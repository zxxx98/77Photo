package com.photo77.upload

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.FileNotFoundException
import okhttp3.MediaType.Companion.toMediaType
import okio.Buffer
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UploadRequestBodyTest {
  @Test
  fun unavailableContentUriIsReportedAsPermanentMediaAccessFailure() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val body = UploadRequestBody(
      resolver = context.contentResolver,
      uri = Uri.parse("content://media/missing"),
      mediaType = "image/jpeg".toMediaType(),
      length = null,
      openStream = { null },
    )

    assertThrows(FileNotFoundException::class.java) { body.writeTo(Buffer()) }
  }
}
