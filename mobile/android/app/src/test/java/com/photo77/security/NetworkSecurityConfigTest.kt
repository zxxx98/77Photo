package com.photo77.security

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkSecurityConfigTest {
  @Test
  fun manifestUsesTheDedicatedNetworkSecurityConfigInsteadOfAInlineGlobalFlag() {
    val manifest = File("app/src/main/AndroidManifest.xml").readText()

    assertTrue(manifest.contains("android:networkSecurityConfig=\"@xml/network_security_config\""))
    assertFalse(manifest.contains("android:usesCleartextTraffic=\"true\""))
    assertTrue(File("app/src/main/res/xml/network_security_config.xml").isFile)
  }
}
