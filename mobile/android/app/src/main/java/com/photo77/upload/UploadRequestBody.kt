package com.photo77.upload

import android.content.ContentResolver
import android.net.Uri
import java.io.IOException
import okhttp3.MediaType
import okhttp3.RequestBody
import okio.BufferedSink

/** Streams a selected content URI without buffering the media in the Java or JS heap. */
class UploadRequestBody(
  private val resolver: ContentResolver,
  private val uri: Uri,
  private val mediaType: MediaType?,
  private val length: Long?,
  private val onProgress: ((sentBytes: Long, totalBytes: Long?) -> Unit)? = null,
  private val progressIntervalMillis: Long = DEFAULT_PROGRESS_INTERVAL_MILLIS,
  private val nowMillis: () -> Long = { System.currentTimeMillis() },
) : RequestBody() {
  override fun contentType(): MediaType? = mediaType

  override fun contentLength(): Long = length?.takeIf { it >= 0L } ?: -1L

  override fun writeTo(sink: BufferedSink) {
    val input = resolver.openInputStream(uri)
      ?: throw IOException("media URI could not be opened")
    input.use { stream ->
      val buffer = ByteArray(BUFFER_SIZE)
      var sent = 0L
      var lastReportedAt: Long? = null
      while (true) {
        val read = stream.read(buffer)
        if (read < 0) break
        if (read == 0) continue
        sink.write(buffer, 0, read)
        sent += read
        val now = nowMillis()
        if (sent == contentLength() || lastReportedAt == null || now - lastReportedAt!! >= progressIntervalMillis) {
          onProgress?.invoke(sent, length)
          lastReportedAt = now
        }
      }
      onProgress?.invoke(sent, length)
    }
  }

  companion object {
    const val BUFFER_SIZE = 64 * 1024
    private const val DEFAULT_PROGRESS_INTERVAL_MILLIS = 250L
  }
}
