package com.photo77.upload

import android.content.Context
import android.content.ContentResolver
import android.net.Uri
import com.photo77.credentials.CredentialCipher
import com.photo77.credentials.EncryptedPayload
import java.io.IOException
import java.io.InputStream
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import com.photo77.network.PolicyAwareHttpClient

data class UploadStoredCredentials(
  val serverId: String,
  val deviceId: String,
  val accessToken: String,
  val accessTokenExpiresAt: String,
  val refreshToken: String,
  val refreshTokenExpiresAt: String,
)

interface UploadCredentialStore {
  fun get(serverId: String, deviceId: String): UploadStoredCredentials?
  fun replace(credentials: UploadStoredCredentials)
}

interface UploadAuthRefresher {
  fun refresh(serverId: String, deviceId: String): Boolean
}

/** The native equivalent of the Keystore-backed credentials TurboModule store. */
class EncryptedUploadCredentialStore(
  context: Context,
  private val cipher: CredentialCipher = CredentialCipher(),
) : UploadCredentialStore {
  private val lock = Any()
  private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  override fun get(serverId: String, deviceId: String): UploadStoredCredentials? = synchronized(lock) {
    val prefix = keyPrefix(serverId)
    val ciphertext = preferences.getString("$prefix.ciphertext", null) ?: return@synchronized null
    val iv = preferences.getString("$prefix.iv", null) ?: return@synchronized null
    val schema = preferences.getInt("$prefix.schema", -1)
    if (schema < 0) return@synchronized null
    val json = JSONObject(cipher.decrypt(EncryptedPayload(schema, iv, ciphertext), serverId))
    val stored = json.toCredentials()
    stored.takeIf { it.serverId == serverId && it.deviceId == deviceId }
  }

  override fun replace(credentials: UploadStoredCredentials) = synchronized(lock) {
    val encrypted = cipher.encrypt(credentials.toJSON().toString(), credentials.serverId)
    val prefix = keyPrefix(credentials.serverId)
    check(
      preferences.edit()
        .putInt("$prefix.schema", encrypted.schemaVersion)
        .putString("$prefix.iv", encrypted.iv)
        .putString("$prefix.ciphertext", encrypted.ciphertext)
        .commit(),
    ) { "could not persist credentials" }
  }

  private fun keyPrefix(serverId: String): String {
    require(SERVER_ID_PATTERN.matches(serverId)) { "invalid server ID" }
    return "credential.v1.$serverId"
  }

  private fun JSONObject.toCredentials(): UploadStoredCredentials = UploadStoredCredentials(
    serverId = requiredString("serverId"),
    deviceId = requiredString("deviceId"),
    accessToken = requiredString("accessToken"),
    accessTokenExpiresAt = requiredString("accessTokenExpiresAt"),
    refreshToken = requiredString("refreshToken"),
    refreshTokenExpiresAt = requiredString("refreshTokenExpiresAt"),
  )

  private fun JSONObject.requiredString(key: String): String = optString(key).takeIf { it.isNotBlank() }
    ?: throw IllegalStateException("invalid credential record")

  private fun UploadStoredCredentials.toJSON(): JSONObject = JSONObject().apply {
    put("serverId", serverId)
    put("deviceId", deviceId)
    put("accessToken", accessToken)
    put("accessTokenExpiresAt", accessTokenExpiresAt)
    put("refreshToken", refreshToken)
    put("refreshTokenExpiresAt", refreshTokenExpiresAt)
  }

  companion object {
    private const val PREFERENCES_NAME = "photo77.mobile.credentials"
    private val SERVER_ID_PATTERN = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
  }
}

/** OkHttp transport for the server's one-file multipart upload contract. */
class UploadApi(
  private val baseUrl: String,
  private val contentResolver: ContentResolver,
  private val credentials: UploadCredentialStore,
  client: OkHttpClient = PolicyAwareHttpClient.create(),
  allowedLANCIDRs: Collection<String> = emptyList(),
  private val openStream: (Uri) -> InputStream? = { contentResolver.openInputStream(it) },
) : UploadTaskUploader, UploadAuthRefresher {
  private val client: OkHttpClient = PolicyAwareHttpClient.enforce(client).build()
  private val allowedBaseUrl = runCatching { UploadURLPolicy.requireAllowed(baseUrl, allowedLANCIDRs) }.getOrNull()

  override fun upload(task: com.photo77.upload.db.UploadTaskEntity, onProgress: (Long, Long?) -> Unit): UploadResult {
    if (allowedBaseUrl == null) return UploadResult.permanent("SERVER_URL_BLOCKED", "server URL is not allowed")
    val stored = credentials.get(task.serverId, task.deviceId)
      ?: return UploadResult.authRequired()
    val hasMotionFields = listOf(
      task.motionUri,
      task.motionDisplayName,
      task.motionMimeType,
      task.motionSizeBytes,
    ).any { it != null }
    if (hasMotionFields && (task.motionUri == null || task.motionDisplayName == null || task.motionMimeType == null)) {
      return UploadResult.permanent("INVALID_UPLOAD", "motion metadata is incomplete")
    }

    val motionSize = task.motionSizeBytes
    val totalMediaBytes = if (task.sizeBytes != null && motionSize != null) task.sizeBytes + motionSize else null
    val body = UploadRequestBody(
      resolver = contentResolver,
      uri = Uri.parse(task.contentUri),
      mediaType = task.mimeType.toMediaTypeOrNull(),
      length = task.sizeBytes,
      onProgress = { sent, _ -> onProgress(sent, totalMediaBytes ?: task.sizeBytes) },
      openStream = openStream,
    )
    val multipart = okhttp3.MultipartBody.Builder()
      .setType(okhttp3.MultipartBody.FORM)
      // The server parser requires these fields before the file part.
      .addFormDataPart("folder_id", task.folderId)
      .addFormDataPart("conflict", "rename")
      .addFormDataPart("file", task.displayName, body)
    if (task.motionUri != null && task.motionDisplayName != null && task.motionMimeType != null) {
      val primaryOffset = task.sizeBytes ?: 0L
      val motionBody = UploadRequestBody(
        resolver = contentResolver,
        uri = Uri.parse(task.motionUri),
        mediaType = task.motionMimeType.toMediaTypeOrNull(),
        length = motionSize,
        onProgress = { sent, _ -> onProgress(primaryOffset + sent, totalMediaBytes) },
        openStream = openStream,
      )
      multipart.addFormDataPart("motion", task.motionDisplayName, motionBody)
    }
    val target = if (task.motionUri != null) "/api/v1/photos/live-upload" else "/api/v1/photos/upload"
    val request = Request.Builder()
      .url(endpoint(target))
      .header("Authorization", "Bearer ${stored.accessToken}")
      .post(multipart.build())
      .build()

    return try {
      client.newCall(request).execute().use { response ->
        if (response.isSuccessful) {
          UploadResult.success()
        } else {
          response.toUploadResult()
        }
      }
    } catch (_: java.io.FileNotFoundException) {
      UploadResult.permanent("URI_ACCESS_DENIED", "selected media is no longer available")
    } catch (_: SecurityException) {
      UploadResult.permanent("URI_ACCESS_DENIED", "selected media permission is no longer available")
    } catch (error: IOException) {
      UploadResult.retryable("NETWORK_ERROR", error.message ?: "network request failed")
    } catch (error: IllegalArgumentException) {
      UploadResult.permanent("INVALID_UPLOAD", error.message ?: "upload request is invalid")
    }
  }

  override fun refresh(serverId: String, deviceId: String): Boolean {
    if (allowedBaseUrl == null) return false
    val current = credentials.get(serverId, deviceId) ?: return false
    val requestBody = JSONObject().put("refresh_token", current.refreshToken)
      .toString().toRequestBody(JSON_MEDIA_TYPE)
    val request = Request.Builder()
      .url(endpoint("/api/v1/mobile/auth/refresh"))
      .post(requestBody)
      .build()
    return try {
      client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) return false
        val json = JSONObject(response.body?.string().orEmpty())
        val deviceJSON = json.optJSONObject("device") ?: return false
        val responseDeviceId = deviceJSON.optString("id")
        if (responseDeviceId != deviceId) return false
        val next = UploadStoredCredentials(
          serverId = serverId,
          deviceId = responseDeviceId,
          accessToken = json.optString("access_token"),
          accessTokenExpiresAt = json.optString("access_token_expires_at"),
          refreshToken = json.optString("refresh_token"),
          refreshTokenExpiresAt = json.optString("refresh_token_expires_at"),
        )
        if (next.accessToken.isBlank() || next.refreshToken.isBlank() ||
          next.accessTokenExpiresAt.isBlank() || next.refreshTokenExpiresAt.isBlank()
        ) return false
        credentials.replace(next)
        true
      }
    } catch (_: Exception) {
      false
    }
  }

  private fun endpoint(path: String): String = "${checkNotNull(allowedBaseUrl)}/${path.trimStart('/')}"

  private fun okhttp3.Response.toUploadResult(): UploadResult {
    val status = code
    val payload = body?.string().orEmpty()
    val error = runCatching { JSONObject(payload).optJSONObject("error") }.getOrNull()
    val code = error?.optString("code")?.takeIf { it.isNotBlank() }
    val message = error?.optString("message")?.takeIf { it.isNotBlank() }
    return if (status == 401) {
      UploadResult.authRequired(message)
    } else {
      UploadResult(statusCode = status, errorCode = code, errorMessage = message)
    }
  }

  companion object {
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
  }
}
