package com.photo77.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class UploadURLPolicyTest {
  @Test
  fun allowsHttpsAndNormalizesTrailingSlash() {
    assertEquals(
      "https://photos.example/library",
      UploadURLPolicy.requireAllowed(" HTTPS://photos.example/library/// ", emptyList()),
    )
  }

  @Test
  fun allowsHttpOnlyWhenTheIpMatchesAnEnabledRange() {
    assertEquals(
      "http://192.168.1.9:8080",
      UploadURLPolicy.requireAllowed("http://192.168.1.9:8080", listOf("192.168.0.0/16")),
    )
    assertThrows(IllegalArgumentException::class.java) {
      UploadURLPolicy.requireAllowed("http://192.168.1.9:8080", emptyList())
    }
  }

  @Test
  fun rejectsHttpHostnamesPublicIpsAndCredentialBearingUrls() {
    listOf(
      "http://photos.example",
      "http://8.8.8.8",
      "https://user:password@photos.example",
      "https://photos.example/path?token=secret",
      "ftp://photos.example",
    ).forEach { raw ->
      assertThrows(IllegalArgumentException::class.java) {
        UploadURLPolicy.requireAllowed(raw, listOf("192.168.0.0/16"))
      }
    }
  }
}
