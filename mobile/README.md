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

## Multiple addresses for one server

Add up to eight addresses on the login screen or in **Settings → Server addresses**. Give each address a name, include its HTTP/HTTPS scheme and port, and use **Check** to verify an address saved while offline. Only verified addresses participate in automatic selection. Editing an address verifies it again. Use **Move up** to adjust fallback priority, **Use** to stay on one address, or **Automatically select** to restore failover.

For example, add `http://192.168.1.10:8080` at home and `http://100.90.1.10:8080` for an overlay network. HTTP is permitted for private IPs, IPv6 ULA/loopback and the overlay/CGNAT range `100.64.0.0/10`; it remains unencrypted at the application layer. Public IPs and DNS names require HTTPS. The app does not start or configure a VPN: enable your overlay network before connecting outside home.

Upgrade the server together with the app. Migration 009 stores an Ed25519 identity in the database, and `/api/v1/server/identity` signs fresh device challenges without receiving credentials. Ensure reverse proxies expose this route on every address. The client pins the identity at the original trusted address and checks alternatives before sharing a session. Back up the database to preserve identity; independent deployments copied from a database must not retain the same identity. Identity checking does not replace HTTPS or protect HTTP traffic against an active network intermediary. Older servers continue to work with one address, but cannot enable alternatives.

Automatic selection tries the last working address first and then verified addresses in list order, with a three-second timeout per probe. Successful probes are shared and cached for 30 seconds; failed rounds are cached for five seconds. Foreground/network changes and the reconnect button trigger a new check. Reads can retry once after a connection failure. Uploads and token refreshes are not automatically replayed when their response is lost; interrupted uploads remain available for manual retry. The upload queue keeps its original server/account scope, so switching IPs neither hides nor restarts it. All addresses being offline preserves the login session.

Manual device checks (ARM64 only): configure LAN and overlay addresses, switch Wi-Fi to cellular with the overlay enabled, disable the overlay to verify offline recovery, reject a different server, reconnect after token expiry, and interrupt an upload before switching addresses. Confirm media reloads, login survives offline periods, and pending uploads remain visible.

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

The workflow uses the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` to sign the APK. The result is stored as a GitHub Actions artifact for 30 days; the workflow does not publish a GitHub Release. The build always targets `arm64-v8a`, regardless of the build host architecture.
