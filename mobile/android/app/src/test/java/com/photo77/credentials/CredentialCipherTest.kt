package com.photo77.credentials

import java.util.Base64
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class CredentialCipherTest {
  private val key = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
  private val provider = object : KeyProvider {
    override fun getOrCreate(): SecretKey = key
    override fun delete() = Unit
  }

  @Test
  fun encryptsAndDecryptsWithAuthenticatedServerBinding() {
    val cipher = CredentialCipher(provider)
    val encrypted = cipher.encrypt("secret-token", "server-1")

    assertEquals(CredentialCipher.SCHEMA_VERSION, encrypted.schemaVersion)
    assertNotEquals("secret-token", encrypted.ciphertext)
    assertEquals("secret-token", cipher.decrypt(encrypted, "server-1"))
    assertThrows(Exception::class.java) { cipher.decrypt(encrypted, "server-2") }
  }

  @Test
  fun encryptedPayloadContainsRandomIv() {
    val cipher = CredentialCipher(provider)
    val first = cipher.encrypt("same", "server-1")
    val second = cipher.encrypt("same", "server-1")

    assertNotEquals(first.iv, second.iv)
    assertEquals(12, Base64.getDecoder().decode(first.iv).size)
  }
}
