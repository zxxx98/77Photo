package com.photo77.bridge

import java.io.IOException
import org.junit.Assert.assertThrows
import org.junit.Test

class NativeDownloadPublicationTest {
  @Test
  fun rejectsAStoreUpdateThatDidNotPublishTheDownload() {
    assertThrows(IOException::class.java) {
      requireMediaStoreUpdate(0)
    }
  }
}
