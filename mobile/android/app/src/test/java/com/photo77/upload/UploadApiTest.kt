package com.photo77.upload

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayInputStream
import java.io.InputStream
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadApiTest {
  @Test
  fun pairedMotionUsesOneLogicalRequestWithFileBeforeMotionAndCombinedProgress() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    var capturedPath: String? = null
    var capturedBody = ""
    val client = OkHttpClient.Builder()
      .addInterceptor(Interceptor { chain ->
        val request = chain.request()
        capturedPath = request.url.encodedPath
        val buffer = Buffer()
        request.body?.writeTo(buffer)
        capturedBody = buffer.readUtf8()
        Response.Builder()
          .request(request)
          .protocol(Protocol.HTTP_1_1)
          .code(201)
          .message("Created")
          .body("{}".toResponseBody("application/json".toMediaType()))
          .build()
      })
      .build()
    val progress = mutableListOf<Pair<Long, Long?>>()
    val api = UploadApi(
      baseUrl = "https://photos.example",
      contentResolver = context.contentResolver,
      credentials = FakeCredentials(),
      client = client,
      openStream = { uri ->
        when (uri.toString()) {
          "content://media/still" -> ByteArrayInputStream(ByteArray(4) { 's'.code.toByte() })
          "content://media/motion" -> ByteArrayInputStream(ByteArray(3) { 'm'.code.toByte() })
          else -> null
        }
      },
    )

    val result = api.upload(
      task = taskWithMotion(),
      onProgress = { sent, total -> progress += sent to total },
    )

    assertTrue(result.succeeded)
    assertEquals("/api/v1/photos/live-upload", capturedPath)
    assertTrue(capturedBody.indexOf("name=\"file\"") < capturedBody.indexOf("name=\"motion\""))
    assertEquals(7L, progress.last().first)
    assertEquals(7L, progress.last().second)
  }

  private fun taskWithMotion() = com.photo77.upload.db.UploadTaskEntity(
    id = "task-1",
    batchId = "batch-1",
    contentUri = "content://media/still",
    displayName = "photo.heic",
    mimeType = "image/heic",
    sizeBytes = 4L,
    motionUri = "content://media/motion",
    motionDisplayName = "photo.mov",
    motionMimeType = "video/quicktime",
    motionSizeBytes = 3L,
    serverId = "server-1",
    userId = null,
    deviceId = "device-1",
    sessionId = null,
    folderId = "folder-1",
    state = com.photo77.upload.db.UploadTaskState.QUEUED,
    sentBytes = 0L,
    attempts = 0,
    lastErrorCode = null,
    lastErrorMessage = null,
    createdAtEpochMs = 1L,
    startedAtEpochMs = null,
    completedAtEpochMs = null,
    nextRetryAtEpochMs = null,
    leaseOwner = null,
    leaseUntilEpochMs = null,
  )

  private class FakeCredentials : UploadCredentialStore {
    override fun get(serverId: String, deviceId: String) = UploadStoredCredentials(
      serverId = serverId,
      deviceId = deviceId,
      accessToken = "access-token",
      accessTokenExpiresAt = "2099-01-01T00:00:00Z",
      refreshToken = "refresh-token",
      refreshTokenExpiresAt = "2099-01-01T00:00:00Z",
    )

    override fun replace(credentials: UploadStoredCredentials) = Unit
  }
}
