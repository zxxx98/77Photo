package com.photo77.network

import java.io.IOException
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response

/**
 * Keeps every native media request on the server boundary selected by the user.
 *
 * The initial URL is validated by the JS/native URL policy. Native transports do
 * not have access to the editable CIDR list, so redirects are constrained to
 * the exact normalized host and port of that already-validated URL. HTTPS may
 * not be downgraded to HTTP, and credentials in a Location header are rejected.
 */
class PolicyAwareRedirectInterceptor : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    var request = chain.request()
    var redirectCount = 0

    while (true) {
      val response = chain.proceed(request)
      if (!isRedirect(response.code)) return response

      val location = response.header("Location")
      if (location.isNullOrBlank()) return response
      if (redirectCount >= MAX_REDIRECTS) {
        response.close()
        throw IOException("redirect limit exceeded")
      }

      val nextURL = request.url.resolve(location)
      if (nextURL == null || !isAllowed(request.url, nextURL)) {
        response.close()
        throw IOException("redirect outside server boundary")
      }

      response.close()
      request = redirectedRequest(request, nextURL, response.code)
      redirectCount += 1
    }
  }

  companion object {
    private const val MAX_REDIRECTS = 5

    internal fun isAllowed(from: HttpUrl, to: HttpUrl): Boolean {
      if (from.host != to.host || from.port != to.port) return false
      if (from.scheme == "https" && to.scheme != "https") return false
      if (to.username.isNotEmpty() || to.password.isNotEmpty()) return false
      return to.scheme == "http" || to.scheme == "https"
    }

    private fun isRedirect(code: Int): Boolean = code == 301 || code == 302 || code == 303 || code == 307 || code == 308

    private fun redirectedRequest(request: Request, url: HttpUrl, responseCode: Int): Request {
      val builder = request.newBuilder().url(url)
      if (responseCode == 301 || responseCode == 302 || responseCode == 303) {
        if (request.method != "GET" && request.method != "HEAD") {
          builder.method("GET", null)
            .removeHeader("Content-Length")
            .removeHeader("Content-Type")
        }
      }
      return builder.build()
    }
  }
}

object PolicyAwareHttpClient {
  fun builder(): okhttp3.OkHttpClient.Builder = enforce(okhttp3.OkHttpClient.Builder())

  fun enforce(client: okhttp3.OkHttpClient): okhttp3.OkHttpClient.Builder = enforce(client.newBuilder())

  private fun enforce(builder: okhttp3.OkHttpClient.Builder): okhttp3.OkHttpClient.Builder = builder
    .followRedirects(false)
    .followSslRedirects(false)
    .addInterceptor(PolicyAwareRedirectInterceptor())

  fun create(): okhttp3.OkHttpClient = builder().build()
}
