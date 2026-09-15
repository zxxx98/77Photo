package com.photo77.network

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyAwareRedirectInterceptorTest {
  @Test
  fun keepsRedirectsOnTheSameHostAndPort() {
    val from = "http://192.168.1.8:8080/photos/1/preview".toHttpUrl()

    assertTrue(PolicyAwareRedirectInterceptor.isAllowed(from, "http://192.168.1.8:8080/photos/1/next".toHttpUrl()))
    assertFalse(PolicyAwareRedirectInterceptor.isAllowed(from, "http://192.168.1.9:8080/photos/1/next".toHttpUrl()))
    assertFalse(PolicyAwareRedirectInterceptor.isAllowed(from, "http://192.168.1.8:8081/photos/1/next".toHttpUrl()))
  }

  @Test
  fun rejectsCredentialInjectionAndHttpsDowngrade() {
    val https = "https://photos.example/photos/1".toHttpUrl()

    assertFalse(PolicyAwareRedirectInterceptor.isAllowed(https, "http://photos.example/photos/1".toHttpUrl()))
    assertFalse(PolicyAwareRedirectInterceptor.isAllowed(https, "https://user:secret@photos.example/photos/1".toHttpUrl()))
    assertTrue(PolicyAwareRedirectInterceptor.isAllowed("http://photos.example:8080".toHttpUrl(), "https://photos.example:8080".toHttpUrl()))
  }
}
