# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Native modules and Android components are looked up by name from the React Native
# bridge, the manifest, Room, and WorkManager. Keep their public entry points when
# R8 is enabled; credentials and upload payloads are never kept in generated logs.
-keep class com.photo77.bridge.** { *; }
-keep class com.photo77.credentials.** { *; }
-keep class com.photo77.notifications.** { *; }
-keep class com.photo77.picker.** { *; }
-keep class com.photo77.upload.** { *; }
-keep class * extends androidx.room.RoomDatabase { *; }
-keep class * extends androidx.work.Worker { *; }
-keep class * extends androidx.work.CoroutineWorker { *; }
