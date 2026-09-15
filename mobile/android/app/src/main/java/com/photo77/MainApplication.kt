package com.photo77

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.photo77.credentials.NativeCredentialsPackage
import com.photo77.bridge.NativeUploadQueuePackage
import com.photo77.bridge.NativeDownloadPackage
import com.photo77.picker.NativePhotoPickerPackage
import com.photo77.network.PolicyAwareRedirectInterceptor
import com.facebook.react.modules.network.OkHttpClientProvider

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(NativeCredentialsPackage())
          add(NativeUploadQueuePackage())
          add(NativeDownloadPackage())
          add(NativePhotoPickerPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor(PolicyAwareRedirectInterceptor())
        .build()
    }
    loadReactNative(this)
  }
}
