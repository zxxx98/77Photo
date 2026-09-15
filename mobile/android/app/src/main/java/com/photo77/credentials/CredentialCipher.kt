package com.photo77.credentials

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class EncryptedPayload(
  val schemaVersion: Int,
  val iv: String,
  val ciphertext: String,
)

interface KeyProvider {
  fun getOrCreate(): SecretKey
  fun delete()
}

internal class AndroidKeyStoreProvider : KeyProvider {
  override fun getOrCreate(): SecretKey {
    val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
    val existing = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
    if (existing != null) {
      return existing
    }

    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).apply {
      init(
        KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
          )
          .setKeySize(256)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setRandomizedEncryptionRequired(true)
          .build(),
      )
    }.generateKey()
  }

  override fun delete() {
    KeyStore.getInstance(ANDROID_KEY_STORE).apply {
      load(null)
      if (containsAlias(KEY_ALIAS)) {
        deleteEntry(KEY_ALIAS)
      }
    }
  }

  companion object {
    private const val ANDROID_KEY_STORE = "AndroidKeyStore"
    private const val KEY_ALIAS = CredentialCipher.KEY_ALIAS
  }
}

class CredentialCipher(
  private val keyProvider: KeyProvider = AndroidKeyStoreProvider(),
) {
  fun encrypt(plaintext: String, associatedData: String): EncryptedPayload {
    val iv = ByteArray(IV_LENGTH).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, keyProvider.getOrCreate(), GCMParameterSpec(TAG_LENGTH_BITS, iv))
    cipher.updateAAD(associatedData.toByteArray(StandardCharsets.UTF_8))
    val encrypted = cipher.doFinal(plaintext.toByteArray(StandardCharsets.UTF_8))
    return EncryptedPayload(
      schemaVersion = SCHEMA_VERSION,
      iv = Base64.getEncoder().encodeToString(iv),
      ciphertext = Base64.getEncoder().encodeToString(encrypted),
    )
  }

  fun decrypt(payload: EncryptedPayload, associatedData: String): String {
    require(payload.schemaVersion == SCHEMA_VERSION) { "unsupported credential schema" }
    val iv = Base64.getDecoder().decode(payload.iv)
    require(iv.size == IV_LENGTH) { "invalid credential IV" }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(
      Cipher.DECRYPT_MODE,
      keyProvider.getOrCreate(),
      GCMParameterSpec(TAG_LENGTH_BITS, iv),
    )
    cipher.updateAAD(associatedData.toByteArray(StandardCharsets.UTF_8))
    return String(
      cipher.doFinal(Base64.getDecoder().decode(payload.ciphertext)),
      StandardCharsets.UTF_8,
    )
  }

  companion object {
    const val KEY_ALIAS = "77photo.mobile.credentials.v1"
    const val SCHEMA_VERSION = 1
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_LENGTH = 12
    private const val TAG_LENGTH_BITS = 128
  }
}
