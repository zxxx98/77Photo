package com.photo77.credentials

import android.content.Context
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.turbomodule.core.interfaces.TurboModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONObject
import com.photo77.upload.EncryptedUploadCredentialStore
import com.photo77.upload.UploadApi
import com.photo77.upload.UploadStoredCredentials
import com.photo77.upload.UploadURLPolicy

@ReactModule(name = NativeCredentialsModule.NAME)
class NativeCredentialsModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), TurboModule {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val preferences by lazy {
    reactApplicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
  }
  private val cipher = CredentialCipher()

  override fun getName(): String = NAME

  @ReactMethod
  fun get(serverId: String, promise: Promise) {
    execute(promise) {
      val safeServerId = validateServerId(serverId)
      val prefix = keyPrefix(safeServerId)
      val ciphertext = preferences.getString("$prefix.ciphertext", null)
      val iv = preferences.getString("$prefix.iv", null)
      val schemaVersion = preferences.getInt("$prefix.schema", -1)
      if (ciphertext == null && iv == null && schemaVersion == -1) {
        return@execute null
      }
      if (ciphertext == null || iv == null || schemaVersion == -1) {
        throw IllegalStateException("incomplete credential record")
      }
      val plaintext = cipher.decrypt(EncryptedPayload(schemaVersion, iv, ciphertext), safeServerId)
      credentialToMap(JSONObject(plaintext), safeServerId)
    }
  }

  @ReactMethod
  fun set(value: ReadableMap, promise: Promise) {
    execute(promise) {
      val serverId = validateServerId(requiredString(value, "serverId"))
      val credentials = JSONObject().apply {
        put("serverId", serverId)
        put("deviceId", requiredString(value, "deviceId"))
        put("accessToken", requiredString(value, "accessToken"))
        put("accessTokenExpiresAt", requiredString(value, "accessTokenExpiresAt"))
        put("refreshToken", requiredString(value, "refreshToken"))
        put("refreshTokenExpiresAt", requiredString(value, "refreshTokenExpiresAt"))
      }
      val encrypted = cipher.encrypt(credentials.toString(), serverId)
      val prefix = keyPrefix(serverId)
      val committed = preferences
        .edit()
        .putInt("$prefix.schema", encrypted.schemaVersion)
        .putString("$prefix.iv", encrypted.iv)
        .putString("$prefix.ciphertext", encrypted.ciphertext)
        .commit()
      if (!committed) {
        throw IllegalStateException("could not persist credentials")
      }
      null
    }
  }

  @ReactMethod
  fun clear(serverId: String, promise: Promise) {
    execute(promise) {
      val prefix = keyPrefix(validateServerId(serverId))
      val committed = preferences
        .edit()
        .remove("$prefix.schema")
        .remove("$prefix.iv")
        .remove("$prefix.ciphertext")
        .commit()
      if (!committed) {
        throw IllegalStateException("could not clear credentials")
      }
      null
    }
  }

  /** Uses the same native single-flight coordinator as background uploads. */
  @ReactMethod
  fun refresh(serverId: String, baseURL: String, attemptedAccessToken: String?, lanCIDRs: ReadableArray, promise: Promise) {
    execute(promise) {
      val safeServerId = validateServerId(serverId)
      val ranges = (0 until lanCIDRs.size()).map { index ->
        lanCIDRs.getString(index)?.trim()?.takeIf { it.isNotEmpty() }
          ?: throw IllegalArgumentException("lanCIDRs contains an invalid range")
      }.distinct().take(MAX_LAN_CIDRS)
      val normalizedBaseURL = UploadURLPolicy.requireAllowed(baseURL, ranges)
      val store = EncryptedUploadCredentialStore(reactApplicationContext)
      val current = readUploadCredentials(store, safeServerId) ?: return@execute null
      val refreshed = UploadApi(
        baseUrl = normalizedBaseURL,
        contentResolver = reactApplicationContext.contentResolver,
        credentials = store,
        allowedLANCIDRs = ranges,
      ).refresh(safeServerId, current.deviceId, attemptedAccessToken)
      if (!refreshed) return@execute null
      readUploadCredentials(store, safeServerId)?.toWritableMap()
    }
  }

  override fun invalidate() {
    executor.shutdownNow()
    super.invalidate()
  }

  private fun <T> execute(promise: Promise, operation: () -> T) {
    executor.execute {
      try {
        promise.resolve(operation())
      } catch (error: Throwable) {
        promise.reject("CREDENTIALS_ERROR", error)
      }
    }
  }

  private fun credentialToMap(json: JSONObject, expectedServerId: String): WritableMap {
    val actualServerId = json.optString("serverId")
    if (actualServerId != expectedServerId) {
      throw IllegalStateException("credential server mismatch")
    }
    return Arguments.createMap().apply {
      putString("serverId", actualServerId)
      putString("deviceId", jsonRequiredString(json, "deviceId"))
      putString("accessToken", jsonRequiredString(json, "accessToken"))
      putString("accessTokenExpiresAt", jsonRequiredString(json, "accessTokenExpiresAt"))
      putString("refreshToken", jsonRequiredString(json, "refreshToken"))
      putString("refreshTokenExpiresAt", jsonRequiredString(json, "refreshTokenExpiresAt"))
    }
  }

  private fun readUploadCredentials(store: EncryptedUploadCredentialStore, serverId: String): UploadStoredCredentials? {
    val prefix = keyPrefix(serverId)
    val ciphertext = preferences.getString("$prefix.ciphertext", null) ?: return null
    val iv = preferences.getString("$prefix.iv", null) ?: return null
    val schema = preferences.getInt("$prefix.schema", -1)
    if (schema < 0) return null
    val json = JSONObject(cipher.decrypt(EncryptedPayload(schema, iv, ciphertext), serverId))
    val deviceId = jsonRequiredString(json, "deviceId")
    return store.get(serverId, deviceId)
  }

  private fun UploadStoredCredentials.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("serverId", serverId)
    putString("deviceId", deviceId)
    putString("accessToken", accessToken)
    putString("accessTokenExpiresAt", accessTokenExpiresAt)
    putString("refreshToken", refreshToken)
    putString("refreshTokenExpiresAt", refreshTokenExpiresAt)
  }

  private fun requiredString(value: ReadableMap, key: String): String {
    val result = value.getString(key)
    if (result.isNullOrBlank()) {
      throw IllegalArgumentException("$key is required")
    }
    return result
  }

  private fun jsonRequiredString(value: JSONObject, key: String): String {
    val result = value.optString(key)
    if (result.isBlank()) {
      throw IllegalStateException("invalid credential record")
    }
    return result
  }

  private fun validateServerId(serverId: String): String {
    if (!SERVER_ID_PATTERN.matches(serverId)) {
      throw IllegalArgumentException("invalid server ID")
    }
    return serverId
  }

  private fun keyPrefix(serverId: String): String = "credential.v1.$serverId"

  companion object {
    const val NAME = "NativeCredentials"
    private const val PREFERENCES_NAME = "photo77.mobile.credentials"
    private val SERVER_ID_PATTERN = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
    private const val MAX_LAN_CIDRS = 128
  }
}

class NativeCredentialsPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == NativeCredentialsModule.NAME) NativeCredentialsModule(reactContext) else null
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      NativeCredentialsModule.NAME to
        ReactModuleInfo(
          NativeCredentialsModule.NAME,
          NativeCredentialsModule::class.java.name,
          false,
          false,
          false,
          true,
        ),
    )
  }
}
