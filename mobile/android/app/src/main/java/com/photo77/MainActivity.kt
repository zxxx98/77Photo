package com.photo77

import android.net.Uri
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.photo77.picker.NativePhotoPickerModule
import com.photo77.picker.PhotoPickerHost
import com.photo77.picker.PhotoPickerResultDispatcher

class MainActivity : ReactActivity(), PhotoPickerHost {

  private val photoPickerLauncher: ActivityResultLauncher<PickVisualMediaRequest> =
      registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(NativePhotoPickerModule.MAX_SELECTION)) { uris: List<Uri> ->
        PhotoPickerResultDispatcher.dispatch(uris)
      }

  override fun launchPhotoPicker() {
    photoPickerLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "mobile"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
