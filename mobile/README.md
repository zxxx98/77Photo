# 77Photo Android

React Native 0.87.1 + TypeScript Android client. The current milestone includes server connection, mobile Bearer login, secure session storage, photo timeline, real folder browsing, authenticated preview/video, on-demand original downloads, and a persistent manual upload queue. Uploads run while the app is active. Android may interrupt them after the app leaves the foreground; unfinished items are retried when the app is opened again. There is no automatic backup or resumable byte-range transfer.

## Requirements

- Node.js 22.13+
- JDK 17
- Android SDK 37, Build Tools 37 and NDK 27.1.12297006
- An ARM64 Android 12 (API 31) or newer device or emulator

The Android APK supports only `arm64-v8a`. Do not build or debug an x86/x86_64 Android target or emulator. The build host architecture is separate from the APK target: some Android SDK tools require an x86_64 host even when producing an ARM64 APK. A host-tool failure is not a reason to change the target ABI.

## Run

```bash
cd mobile
npm ci
npm start
```

In a second terminal:

```bash
cd mobile
ANDROID_HOME=/path/to/Android/Sdk npm run android
```

Build an ARM64 development APK with `cd mobile/android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a`; this variant uses Metro. Build a standalone ARM64 test APK with `./gradlew :app:assembleStaging -PreactNativeArchitectures=arm64-v8a`; this variant embeds JS and uses the standard debug signing key, so it is not a production release. The default target ABI is also `arm64-v8a`. All variants accept HTTP for private IP addresses (including emulator host `10.0.2.2`); public hosts require HTTPS. HTTP is unencrypted, so use it only on a trusted network. The server must already have an admin/user account and expose `/healthz` and `/api/v1/mobile/auth/*`.

## Checks

```bash
cd mobile
npm run typecheck
npm run lint
npm test -- --runInBand
```

The app ID is `com.photo77`, and the existing 77Photo launcher assets are copied from `assets/android/launcher/res`. A new release APK can update an old installation only with the original production signing key; the repository does not contain that key.
