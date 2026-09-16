package com.photo77.picker

import android.net.Uri
import com.photo77.upload.UriGrantReleaser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NativePhotoPickerModuleTest {
  @Test
  fun activityResultDispatcherDeliversSelectionsToTheNativeModule() {
    var received: List<Uri>? = null
    PhotoPickerResultDispatcher.register { received = it }

    PhotoPickerResultDispatcher.dispatch(listOf(Uri.parse("content://media/photo-1")))

    assertEquals(listOf(Uri.parse("content://media/photo-1")), received)
  }

  @Test
  fun metadataUsesProviderValuesAndPersistsReadGrant() {
    var persisted = false
    val result = PhotoPickerMetadata.from(
      uri = "content://media/photo-1",
      input = PhotoPickerMetadataInput(
        displayName = "holiday.jpg",
        mimeType = "image/jpeg",
        sizeBytes = 2048L,
        fallbackSizeBytes = null,
      ),
      persistReadGrant = { persisted = true },
    )

    assertEquals("content://media/photo-1", result.uri)
    assertEquals("holiday.jpg", result.displayName)
    assertEquals("image/jpeg", result.mimeType)
    assertEquals(2048L, result.sizeBytes)
    assertTrue(persisted)
  }

  @Test
  fun metadataFallsBackWhenDisplayNameAndSizeColumnsAreMissing() {
    val result = PhotoPickerMetadata.from(
      uri = "content://media/holiday.png",
      input = PhotoPickerMetadataInput(
        displayName = null,
        mimeType = "image/png",
        sizeBytes = null,
        fallbackSizeBytes = 4096L,
      ),
      persistReadGrant = {},
    )

    assertEquals("holiday.png", result.displayName)
    assertEquals(4096L, result.sizeBytes)
  }

  @Test
  fun unknownSizeRemainsNullAndMimeFilterRejectsNonVisualContent() {
    val result = PhotoPickerMetadata.from(
      uri = "content://media/unknown",
      input = PhotoPickerMetadataInput(
        displayName = "unknown",
        mimeType = "image/jpeg",
        sizeBytes = null,
        fallbackSizeBytes = null,
      ),
      persistReadGrant = {},
    )
    assertNull(result.sizeBytes)
    assertTrue(isSupportedVisualMimeType("image/jpeg"))
    assertTrue(isSupportedVisualMimeType("video/mp4"))
    assertTrue(!isSupportedVisualMimeType("application/pdf"))
  }

  @Test
  fun acceptsHeicAndHeifProviderMimeTypes() {
    listOf("image/heic", "image/heif").forEach { mimeType ->
      val result = PhotoPickerMetadata.from(
        uri = "content://media/photo-1",
        input = PhotoPickerMetadataInput("photo", mimeType, 12L, null),
        persistReadGrant = {},
      )
      assertEquals(mimeType, result.mimeType)
    }
  }

  @Test
  fun dropsOrphanAndDuplicateMotionFilesAndReleasesTheirGrants() {
    val still = metadata("IMG_0001.HEIC", "image/heic")
    val paired = metadata("IMG_0001.MOV", "video/quicktime")
    val duplicate = metadata("img_0001.mov", "video/quicktime")
    val orphan = metadata("orphan.MOV", "video/quicktime")
    val released = mutableListOf<String>()

    val result = dropOrphanMotion(
      listOf(orphan, paired, still, duplicate),
      UriGrantReleaser { released += it.toString() },
    )

    assertEquals(listOf("IMG_0001.MOV", "IMG_0001.HEIC"), result.map { it.displayName })
    assertEquals(listOf("content://media/orphan.MOV", "content://media/img_0001.mov"), released)
  }

  private fun metadata(name: String, mimeType: String) = PickedMediaMetadata(
    uri = "content://media/$name",
    displayName = name,
    mimeType = mimeType,
    sizeBytes = 12L,
  )
}
