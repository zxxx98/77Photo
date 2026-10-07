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

## Photo management

In **Photos**, use **搜索与筛选** to combine a filename query, media type, folder and capture-date range with the existing favorites filter. Dates use `YYYY-MM-DD`; the end date includes the entire day in the device's local timezone. Clearing filters leaves the favorites toggle independent. An empty library and a search without matches have separate messages.

Long-press a thumbnail, or tap **选择**, to enter selection mode. The timeline can select the currently loaded photos for a day; folder browsing also supports selection. Use **移动** to choose a writable directory belonging to the same photo owner, or **删除** to move selected media into trash. Moving supports automatic renaming on a filename conflict. Selection can include more than 500 items; delete/restore/purge requests are chunked to the server limit. Moves run sequentially using the existing single-photo endpoint. Read-only selections disable management actions; mixed writable/read-only selections may partially fail and retain the failed items. Android Back exits selection mode first.

In the viewer, **管理照片 · 移动 / 删除** offers the same operations for one item when its folder is writable. In **Folders**, use **新建文件夹** to create a root directory or a child of the current writable directory; it becomes available for browsing and upload selection.

Open **回收站** from **Photos** to view your own deleted media, expiry times and previews. Select items to restore to their original directories or another writable directory of the same owner, optionally renaming conflicts. **永久删除** and **清空我的回收站** require confirmation. Clearing includes eligible items not yet loaded, using a fixed cutoff for the whole operation. Pending file operations can be retried. This view does not expose an administrator's all-user trash scope.

Partial failures retain the failed selection and show per-item reasons. Lost write responses are never automatically replayed; refresh to reconcile the server result before retrying. Trash does not grant shared-folder writers access to another owner's deleted library. Photo deletion uses the server batch-delete endpoint so Live Photo companions follow the server's trash lifecycle.

ARM64 device acceptance: combine filters and load multiple pages; long-press/select a day; move and delete single/multiple images, videos and Live Photos; create root/nested folders and upload into them; browse read/write shares; restore after a target disappears or a name conflicts; permanently delete and clear unpaged trash; interrupt a write and reconcile by refreshing. Verify Android Back, keyboard and bottom-sheet layout on a small screen. See the [mobile priority plan](../docs/superpowers/plans/2026-09-30-mobile-feature-priorities.md) for implementation and verification status.

## Map, people, details and manual upload cancellation

From **Photos**, open **地图相册** to browse geotagged media. Drag or pinch the map, expand a cluster, browse the current area or a co-located place, and choose a year. Area photo lists paginate. Map availability, tile layers and attribution come from the server; failed tiles can be retried. Tile requests carry no account credentials, while media thumbnails use the authenticated media API.

**人物相册** is available to administrators, matching the Web API permissions, when face recognition is enabled. Browse paginated people and person photos, then use **人物命名** to name or clear a name. Photos with multiple faces belonging to the person appear once. Revision conflicts keep the input and ask you to refresh before retrying.

In the viewer, open **照片详情** for size, dimensions, capture time, folder and available camera metadata. Valid GPS coordinates show a mini map when the server enables maps; jump to the full map or open the position in Amap using WGS84. Missing metadata is omitted, and absent or invalid coordinates show a clear message.

In the manual upload queue, **取消** stops waiting or active work and retains staged files for **重试**. **移除** persists removal before deleting those files. Retry/removal wait until the old transfer settles, and late progress or success cannot revive a cancelled item. If the server already received the upload, refresh the library to reconcile it; retries use existing server deduplication. Cancellation persists across relaunch. Leaving the page by unmounting it or changing accounts aborts the old transfer; switching tabs preserves the mounted queue's normal behavior.

ARM64 device acceptance: drag/pinch and transition back to one finger; expand clusters and co-located places; filter years and paginate; inspect locations across the date line; interrupt tile loading and retry. Verify ordinary users cannot enter people administration, disabled recognition and empty lists have messages, person pagination and naming conflicts work, and Android Back returns to the correct context. Inspect absent and zero GPS coordinates, disabled maps, mini-map/full-map jumps and Amap with/without an installed app. Cancel waiting and active image/video/Live Photo uploads, exercise late responses, retry/remove, relaunch and change accounts; verify automatic backup still works independently.

## Manual upload and date folders

**Backup** opens **手动上传** by default. **自动备份** has its own tab and scrollable settings, so its options no longer consume the upload queue's space. The manual directory selector, archive option, selection button, status summary and queue share one scrollable page; on small screens, scroll to reach all tasks. Switching these tabs preserves uploads and automatic backup scheduling. The folder selector uses a separate full-height view with Android Back support.

Select a writable server root and choose photos or videos with the system picker. **手动上传 → 按年月日归档** defaults to on for the current account view and uploads to `root/YYYY/MM/DD/`, creating or reusing directories. Turn it off before selecting files to upload directly into the selected folder. This option is independent of automatic backup's archive setting and applies only to newly selected files; older queue items retain their original destination. Queue cards show each file's planned folder path.

Capture time comes from photo EXIF or video metadata, falling back to the source provider's capture time, time added to the library and modification time. Offset-less EXIF uses the device's local timezone; explicit offsets are respected. Missing or invalid dates use `root/日期未知/`. Cloud/document picker selections remain uploadable even when metadata is unavailable. The staging copy's creation time is never used as the photo date, and manual selection does not require access to the full photo library. Live Photo still/MOV pairs use the still's date and stay together.

Each task persists its root and calendar path when enqueued, then persists the actual date folder before starting the upload. Retries and relaunch keep that destination even if the selected root, archive option or device timezone changes. Directory creation conflicts reuse the existing folder; lost creation responses wait for a manual retry and listing, and permission/deletion errors fail that task without falling back to the root. If a resolved destination is deleted, select the file again to create a new task. Cancelling while dates are being resolved prevents byte transfer and keeps staged files for retry.

ARM64 device checks: use a small screen and increased font size, scroll through a long queue, open folder selection and switch between manual and automatic tabs during transfer. Upload photos from different days/months/years, EXIF with and without offsets, videos, Live Photo pairs, cloud documents and files without dates. Toggle archive/root for later selections, cancel during folder creation, retry a lost creation/upload response, relaunch with queued work, and check revoked write access and deleted folders.

## Automatic photo backup

In **Backup → 自动备份**, select a writable server folder as the backup root, enable **自动备份照片**, and grant access to all photos. Android 14+ selected-photo access is insufficient for automatic backup; manual uploads remain available without full library access. Automatic backup includes all existing and newly added photos visible in Android MediaStore, including images with embedded motion. **备份视频** separately opts in to MP4/WebM backup; separate MOV companions still use manual upload.

**按年月日归档** defaults to on for new configurations. Photos and enabled videos are uploaded into `root/YYYY/MM/DD/`, for example `手机备份/2026/10/05/`. Dates use Android MediaStore's capture time and the device's local timezone, falling back to the time added to the library, then modification time. If all timestamps are missing or invalid, files go into `root/日期未知/`. Existing directories are reused; missing directories are created automatically, including under writable shared roots. Concurrent directory creation is reconciled by listing the existing directory. A lost creation response is checked on a later scan without immediately replaying the write. Directory permission or deletion errors pause backup rather than sending files to the root.

Existing configurations keep uploading directly into their selected folder until this option is enabled. Disable both photo and video backup before changing the root or archive option, then re-enable. Each root and archive mode keeps its own completion history; switching modes scans and uploads into the newly selected layout while preserving existing server files. Manual uploads use the independent archive option in **手动上传**.

**仅 Wi-Fi** defaults to on. Turn it off to allow cellular uploads. The destination is saved independently of the manual upload selection; to change it, disable backup, select a new folder, and re-enable. Backup is upload-only and never deletes device or server photos. The status card shows confirmed photo count, last completed scan, and errors.

Android schedules a persisted job approximately every 15 minutes when a network is available; Wi-Fi settings are checked before each file. Opening the app and network changes also trigger checks. Each run has a time budget and saves its scan position for the next run. Doze, battery restrictions and manufacturer policies can delay jobs. Force-stopping the app prevents background work until it is opened again. Use a standalone staging/release APK for background checks; debug builds require Metro.

Successful uploads and server-confirmed duplicates are recorded per server identity, account, backup root and archive mode. Address failover preserves this history. Interrupted uploads retry as whole files, with server content deduplication handling lost responses. Unreadable or unsupported photos are retried on subsequent scans without blocking other photos. Permission, authentication and target-folder errors appear in the status card. Disabling backup cancels an active backup upload; signing out also disables scheduled backup. Backup uses the existing secure session store and server identity checks, and keeps at most one staged backup file.

ARM64 device verification: enable backup with photos from different days/months/years, check `YYYY/MM/DD` creation and reuse, capture-time fallbacks, local dates near midnight, a writable shared root, concurrent creation and lost creation responses. Disable both backups, change archive mode and switch back to check independent history and preserved files. Add a photo while the app is closed, reboot, and verify eventual upload without opening the app. Check Wi-Fi/cellular transitions, revoked/limited photo permission, an expired access token, an unavailable/deleted root or date directory, interrupted uploads, disabling during directory creation/transfer, and signing into another account. Reopen after force-stop and confirm scheduling resumes. Native background scheduling and battery-policy behavior require a device check.

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
