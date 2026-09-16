package com.photo77.picker

import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NativePhotoPickerPersistenceTest {
  @Test
  fun rejectsAUriWhenItsReadGrantCannotBePersisted() {
    assertThrows(SecurityException::class.java) {
      PhotoPickerMetadata.from(
        uri = "content://media/photo-1",
        input = PhotoPickerMetadataInput(
          displayName = "photo.jpg",
          mimeType = "image/jpeg",
          sizeBytes = 12L,
          fallbackSizeBytes = null,
        ),
        persistReadGrant = { throw SecurityException("persistable grant unavailable") },
      )
    }
  }
}
