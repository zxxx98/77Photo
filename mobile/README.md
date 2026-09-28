# 77Photo Android

React Native 0.87.1 + TypeScript Android client. The current milestone includes server connection, mobile Bearer login, secure session storage, photo timeline, real folder browsing, authenticated preview/video, on-demand original downloads, a persistent manual upload queue, and opt-in automatic photo backup. Manual uploads run while the app is active. Android may interrupt them after the app leaves the foreground; unfinished items are retried when the app is opened again. Automatic photo backup uses Android background jobs; byte-range transfer resumption is not supported.

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

## Multiple addresses for one server

Add up to eight addresses on the login screen or in **Settings → Server addresses**. Give each address a name, include its HTTP/HTTPS scheme and port, and use **Check** to verify an address saved while offline. Only verified addresses participate in automatic selection. Editing an address verifies it again. Use **Move up** to adjust fallback priority, **Use** to stay on one address, or **Automatically select** to restore failover.

For example, add `http://192.168.1.10:8080` at home and `http://100.90.1.10:8080` for an overlay network. HTTP is permitted for private IPs, IPv6 ULA/loopback and the overlay/CGNAT range `100.64.0.0/10`; it remains unencrypted at the application layer. Public IPs and DNS names require HTTPS. The app does not start or configure a VPN: enable your overlay network before connecting outside home.

Upgrade the server together with the app. Migration 009 stores an Ed25519 identity in the database, and `/api/v1/server/identity` signs fresh device challenges without receiving credentials. Ensure reverse proxies expose this route on every address. The client pins the identity at the original trusted address and checks alternatives before sharing a session. Back up the database to preserve identity; independent deployments copied from a database must not retain the same identity. Identity checking does not replace HTTPS or protect HTTP traffic against an active network intermediary. Older servers continue to work with one address, but cannot enable alternatives.

Automatic selection tries the last working address first and then verified addresses in list order, with an eight-second timeout per probe. Successful probes are shared and cached for 30 seconds; failed rounds are cached for five seconds. Foreground/network changes and the reconnect button trigger a new check. Reads can retry once after a connection failure. Uploads and token refreshes are not automatically replayed when their response is lost; interrupted uploads remain available for manual retry. The upload queue keeps its original server/account scope, so switching IPs neither hides nor restarts it. All addresses being offline preserves the login session. An older server can still be used at the address entered on the login screen; alternatives stay pending until the server supports identity checks.

Manual device checks (ARM64 only): configure LAN and overlay addresses, switch Wi-Fi to cellular with the overlay enabled, disable the overlay to verify offline recovery, reject a different server, reconnect after token expiry, and interrupt an upload before switching addresses. Confirm media reloads, login survives offline periods, and pending uploads remain visible.

## Automatic photo backup

In **Backup**, select a writable server folder, enable **自动备份照片**, and grant access to all photos. Android 14+ selected-photo access is insufficient for automatic backup; manual uploads remain available without full library access. Automatic backup includes all existing and newly added photos visible in Android MediaStore, including images with embedded motion. Standalone videos and separate MOV companions still use manual upload.

**仅 Wi-Fi** defaults to on. Turn it off to allow cellular uploads. The destination is saved independently of the manual upload selection; to change it, disable backup, select a new folder, and re-enable. Backup is upload-only and never deletes device or server photos. The status card shows confirmed photo count, last completed scan, and errors.

Android schedules a persisted job approximately every 15 minutes when a network is available; Wi-Fi settings are checked before each file. Opening the app and network changes also trigger checks. Each run has a time budget and saves its scan position for the next run. Doze, battery restrictions and manufacturer policies can delay jobs. Force-stopping the app prevents background work until it is opened again. Use a standalone staging/release APK for background checks; debug builds require Metro.

Successful uploads and server-confirmed duplicates are recorded per server identity, account and destination. Address failover preserves this history. Interrupted uploads retry as whole files, with server content deduplication handling lost responses. Unreadable or unsupported photos are retried on subsequent scans without blocking other photos. Permission, authentication and target-folder errors appear in the status card. Disabling backup cancels an active backup upload; signing out also disables scheduled backup. Backup uses the existing secure session store and server identity checks, and keeps at most one staged backup file.

ARM64 device verification: enable backup with existing photos, add a photo while the app is closed, reboot, and verify eventual upload without opening the app. Check Wi-Fi/cellular transitions, revoked/limited photo permission, an expired access token, an unavailable/deleted destination, interrupted uploads, disabling during transfer, and signing into another account. Reopen after force-stop and confirm scheduling resumes. Native background scheduling and battery-policy behavior require a device check.

## Checks

```bash
cd mobile
npm run typecheck
npm run lint
npm test -- --runInBand
```

The app ID is `com.photo77`, and the existing 77Photo launcher assets are copied from `assets/android/launcher/res`. A new release APK can update an old installation only with the original production signing key; the repository does not contain that key.

## Release APK

The [Android release workflow](../.github/workflows/android-release.yml) builds a signed ARM64 release APK after a push to `main` changes the `version` in `mobile/package.json`. It compares the version before and after the push, so edits to other package fields alone do not start a build. To bump the app version, run `npm version patch --no-git-tag-version` in `mobile/` (or update both `package.json` and `package-lock.json`) and commit the change. Gradle reads this version for `versionName` and derives an increasing `versionCode` from `MAJOR.MINOR.PATCH`.

The workflow uses the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` to sign the APK. The build always targets `arm64-v8a`, regardless of the build host architecture.

The APK is published as a GitHub Release tagged `android-MAJOR.MINOR.PATCH`, for example `android-0.4.2`. These tags are separate from the `vMAJOR.MINOR.PATCH` tags that the server release workflow uses. The release asset is named `77photo-android-MAJOR.MINOR.PATCH-arm64-release.apk`. Re-running the workflow for a version that already has a release replaces that release's APK instead of failing. Releases before `android-0.0.9` used the older `android-vMAJOR.MINOR.PATCH` tagging and remain on GitHub.
