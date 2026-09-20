package com.photo77.branding

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class BrandingResourcesTest {
  @Test
  fun `application name and adaptive icons use 77Photo branding`() {
    val strings = File("src/main/res/values/strings.xml").readText()
    val manifest = File("src/main/AndroidManifest.xml").readText()
    val icon = File("src/main/res/mipmap-anydpi-v26/ic_launcher.xml").readText()
    val roundIcon = File("src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml").readText()
    val foreground = File("src/main/res/drawable/ic_launcher_foreground.xml").readText()

    assertTrue(strings.contains("<string name=\"app_name\">77Photo</string>"))
    assertTrue(manifest.contains("android:icon=\"@mipmap/ic_launcher\""))
    assertTrue(manifest.contains("android:roundIcon=\"@mipmap/ic_launcher_round\""))
    assertTrue(icon.contains("@drawable/ic_launcher_foreground"))
    assertTrue(roundIcon.contains("@drawable/ic_launcher_foreground"))
    assertTrue(foreground.contains("#FAF9F7"))
    assertTrue(foreground.contains("#A8C5B8"))
  }
}
