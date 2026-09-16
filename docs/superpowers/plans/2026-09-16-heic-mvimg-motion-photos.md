# HEIC/HEIF and MVIMG Motion Photo Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add full HEIC/HEIF, MVIMG, paired-MOV, and FFmpeg-generated video-thumbnail support across the server, Web client, Android client, filesystem import/rescan, and deployment image.

**Architecture:** Add a dependency-free internal/media boundary for signatures, MVIMG segment discovery, external-tool execution, HEIC decoding, video probing, video-frame extraction, and derived-artifact writes. Photos keep their original file and metadata in the existing row; validated motion is stored as a rebuildable ID-keyed artifact. Upload and Android queue paths use one logical multipart operation for a still plus an optional MOV, while scanners use a two-pass same-basename association.

**Tech Stack:** Go 1.22, SQLite migrations, FFmpeg/FFprobe, libheif heif-convert, React/TypeScript/Vite, React Native 0.87, Kotlin/Room/OkHttp, Docker Alpine.

---

## Working Rules

- Work in a dedicated feature worktree before implementation. The current main worktree has user-owned edits in mobile/e2e/README.md and mobile/e2e/maestro/lan-http.yaml; do not reset, overwrite, or include those files in commits.
- Follow red-green-refactor for every behavior change: add one failing test, run the smallest test command and confirm the expected failure, implement the smallest behavior, rerun the test, then refactor only while green.
- Commit each task separately. A task commit must contain only its listed files.
- Never invoke FFmpeg, FFprobe, or heif-convert through a shell string. All production calls use exec.CommandContext with fixed argument slices and validated temporary paths.

## File Map

- Create internal/media/media.go, internal/media/media_test.go, and internal/media/runner.go for media types, signatures, MVIMG detection, external-tool abstraction, and atomic extraction/rendering.
- Modify internal/config/config.go and internal/config/config_test.go for media executable paths and limits.
- Modify cmd/77photo/main.go, internal/httpapi/server.go, and internal/httpapi/server_test.go for media injection and health capability reporting.
- Modify internal/photos/service.go, internal/photos/live.go, internal/photos/http.go, internal/photos/upload_test.go, internal/photos/live_test.go, and internal/photos/live_upload_test.go for MIME support, metadata, embedded extraction, logical upload, sidecar lifecycle, and playback.
- Modify internal/thumbnails/service.go and internal/thumbnails/service_test.go for image/video frame rendering through the media boundary.
- Modify internal/indexer/service.go, internal/indexer/service_test.go, internal/importer/service.go, internal/importer/service_test.go, and internal/photos/scan.go for shared detection and two-pass MOV association.
- Do not add a server migration: binary motion data stays outside SQLite in the derived artifact directory. The Android Room migration is listed in Task 8.
- Modify web/src/app/api.ts, web/src/app/api.test.ts, web/src/app/App.tsx, web/src/features/upload/uploadSelection.ts, web/src/features/upload/uploadSelection.test.ts, web/src/features/upload/UploadWorkspace.tsx, web/src/features/gallery/GalleryWorkspace.tsx, web/src/features/gallery/GalleryWorkspace.test.tsx, web/src/features/viewer/Viewer.tsx for HEIC selection, logical upload, status, and playback.
- Modify mobile/src/native/NativeUploadQueue.ts, mobile/src/features/upload/types.ts, mobile/src/features/upload/uploadService.ts, mobile/src/services/api/types.ts, mobile/src/services/api/client.ts, mobile/src/features/gallery/queries.ts, mobile/src/features/gallery/GalleryScreen.tsx, mobile/src/features/gallery/GalleryScreen.test.tsx, mobile/src/features/viewer/MediaViewerScreen.tsx, and mobile/src/features/viewer/MediaViewerScreen.test.tsx for client behavior; modify the listed Android picker, queue, Room, bridge, uploader, and test files for persisted companions.
- Create scripts/check-media-contract.sh.
- Modify docs/api/openapi.yaml, docs/DECISIONS.md, docs/operations/build.md, docs/operations/deployment.md, docs/operations/acceptance.md, README.md, Dockerfile, Dockerfile.release, and compose.yaml.

---

### Task 1: Add media format model and signature detection

**Files:**
- Create: internal/media/media.go
- Create: internal/media/media_test.go

- [ ] Step 1: Write the failing tests

Add TestInspectBytesRecognizesSupportedMedia for JPEG, PNG, HEIC, HEIF, MP4, and WebM. Use a test-only ftypBytes(brand string) helper. Add TestInspectBytesRejectsMismatchedExtensionAndSignature for a JPEG payload named .heic, unknown HEIF brands, and mismatched declared MIME.

The expected public shape is:

~~~go
type Kind string
const (
    KindStill Kind = "still"
    KindVideo Kind = "video"
)
type Inspection struct {
    MIME string
    Kind Kind
    Embedded bool
}
func InspectBytes(filename, declared string, head []byte) (Inspection, error)
~~~

- [ ] Step 2: Run the test and verify the correct red failure

Run go test ./internal/media -run 'TestInspectBytes' -count=1.

Expected: FAIL because the package and function do not exist.

- [ ] Step 3: Implement the minimal detector

Normalize image/jpg to image/jpeg. Require these extension/signature pairs:

~~~text
.jpg/.jpeg + JPEG signature -> image/jpeg
.png + PNG signature -> image/png
.heic + ISO-BMFF ftyp brand heic/heix/hevc/hevx -> image/heic
.heif + ISO-BMFF ftyp brand mif1/msf1 -> image/heif
.mp4 + video MP4 signature -> video/mp4
.webm + EBML signature -> video/webm
~~~

Reject unsupported declarations, extension mismatches, and invalid signatures with ErrUnsupported. Do not mark Embedded from a filename prefix.

- [ ] Step 4: Run green and commit

Run go test ./internal/media -run 'TestInspectBytes' -count=1; expected PASS.

~~~bash
git add internal/media/media.go internal/media/media_test.go
git commit -m "feat: recognize HEIC and HEIF media"
~~~

### Task 2: Add safe external tools and MVIMG extraction

**Files:**
- Create: internal/media/runner.go
- Modify: internal/media/media.go
- Modify: internal/media/media_test.go

- [ ] Step 1: Write failing runner tests

Add a fake runner test proving arguments are passed separately, context cancellation stops a command, and an output above MaxOutputBytes is deleted. Add an MVIMG fixture test containing a JPEG EOI marker followed by a bounded ISO-BMFF ftyp box; assert that the motion offset is returned only when FFProbe confirms a video stream.

Define the test seam:

~~~go
type Runner interface {
    Run(context.Context, string, ...string) ([]byte, error)
    RunToFile(context.Context, string, string, ...string) error
}
type Tools struct {
    FFmpeg string
    FFprobe string
    HeifConvert string
    Runner Runner
    Timeout time.Duration
    MaxOutputBytes int64
}
~~~

- [ ] Step 2: Run the test and verify red

Run go test ./internal/media -run 'Test(FindEmbeddedMotion|Tools)' -count=1.

Expected: FAIL because the runner and extraction methods are absent.

- [ ] Step 3: Implement direct, bounded process execution

Use exec.CommandContext(ctx, executable, args...). Never use sh -c. Implement these fixed command forms:

~~~text
ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of default=nw=1:nk=1 INPUT
ffmpeg -v error -nostdin -i INPUT -map 0:v:0 -c copy OUTPUT
ffmpeg -v error -nostdin -ss 0.5 -i INPUT -frames:v 1 -vf scale=min(1280,iw):-2 -f image2 OUTPUT
heif-convert INPUT OUTPUT
~~~

For JPEG MVIMG, locate the JPEG EOI and validate box bounds before copying the trailing video segment to a temporary input. Probe the temporary input, require a video stream, then atomically rename the extracted output. For HEIC/HEIF, probe the container directly and extract the first video stream when present. FindEmbeddedMotion must reject forged sizes and out-of-range slices.

- [ ] Step 4: Add motion artifact atomicity tests

Use a fake runner to assert that a failed probe leaves no destination and that a successful extraction writes through a temporary path followed by a rename. Test timeout cancellation and output larger than MaxOutputBytes.

- [ ] Step 5: Run media tests and commit

Run go test ./internal/media -count=1; expected PASS.

~~~bash
git add internal/media/media.go internal/media/runner.go internal/media/media_test.go
git commit -m "feat: safely extract motion media with external tools"
~~~

### Task 3: Wire configuration, health, and container dependencies

**Files:**
- Modify: internal/config/config.go
- Modify: internal/config/config_test.go
- Modify: cmd/77photo/main.go
- Modify: internal/httpapi/server.go
- Modify: internal/httpapi/server_test.go
- Modify: Dockerfile
- Modify: Dockerfile.release
- Modify: compose.yaml

- [ ] Step 1: Write failing configuration and health tests

Test PHOTO_FFMPEG_PATH, PHOTO_FFPROBE_PATH, PHOTO_HEIF_CONVERT_PATH, and PHOTO_MEDIA_TIMEOUT. Test invalid timeout rejection. Extend the health response test to require a media capability with ok or unavailable, without exposing executable paths.

- [ ] Step 2: Run tests and verify red

Run go test ./internal/config ./internal/httpapi -run 'Test(Config|Health)' -count=1.

Expected: FAIL because configuration fields and the media health field do not exist.

- [ ] Step 3: Implement injection

Add executable path fields and a positive media timeout to config.Config. Construct one media.Tools instance in cmd/77photo/main.go; inject it into photos, thumbnails, indexer, and importer. Add media capability checks to health without making ordinary JPEG/PNG/MP4/WebM startup depend on HEIC support.

- [ ] Step 4: Install runtime packages

Install exactly ffmpeg and libheif-tools in both final Alpine Docker stages; the latter supplies heif-convert. Keep the Go build stage CGO_ENABLED=0. Set PHOTO_MEDIA_TIMEOUT in compose.yaml. Verify the resulting image with heif-convert --version.

- [ ] Step 5: Run checks and commit

Run:

~~~bash
go test ./internal/config ./internal/httpapi -count=1
go test ./... -count=1
docker build --target go-build -t 77photo-media-plan-check .
~~~

Expected: PASS and a CGO-free build.

~~~bash
git add internal/config internal/httpapi cmd/77photo/main.go Dockerfile Dockerfile.release compose.yaml
git commit -m "build: configure media processing tools"
~~~

### Task 4: Accept HEIC/HEIF and logical motion uploads

**Files:**
- Modify: internal/photos/service.go
- Modify: internal/photos/live.go
- Modify: internal/photos/http.go
- Create: internal/photos/live_upload_test.go
- Modify: internal/photos/upload_test.go
- Modify: internal/photos/live_test.go

- [ ] Step 1: Write failing server tests

Add tests named TestUploadAcceptsHEICAndHEIF, TestUploadExtractsEmbeddedMVIMGMotion, TestAttachLiveVideoAcceptsHEICStill, TestLogicalLiveUploadRemovesPartialFilesWhenMotionIsInvalid, and TestLiveVideoPathReturnsActualMotionMIME. Use fake media tools for unit tests and a real playable fixture in a media integration test.

Assert database MIME, original-byte hash, derived motion artifact, invalid-part cleanup, and actual playback content type.

- [ ] Step 2: Run tests and verify red

Run go test ./internal/photos -run '(HEIC|HEIF|MVIMG|LogicalLive|ActualMotion)' -count=1.

Expected: FAIL because HEIC MIME values, tool injection, and logical upload do not exist.

- [ ] Step 3: Extend upload and metadata

Replace the hard-coded MIME map in detectAndValidateMIME with the shared inspector. For HEIC/HEIF, decode to a bounded temporary PNG with the media tool and use image.DecodeConfig; use file mtime when Go EXIF cannot decode the source. Preserve the current JPEG/PNG EXIF path.

- [ ] Step 4: Implement logical upload and sidecar lifecycle

Add a service operation accepting a still file and optional motion MOV. Validate the still first, validate motion with FFProbe, store both with temporary files, insert one photo row, and atomically commit the motion artifact. On explicit motion failure, remove every temporary and partial artifact.

Store the new artifact at .77photo/live/<photo-id>.motion; keep the old .mov location as a read fallback. Remove current and legacy motion artifacts on photo deletion and rebuild embedded motion after a source checksum change. Extend AttachLiveVideo to accept JPEG, PNG, HEIC, and HEIF still MIME values.

- [ ] Step 5: Add the HTTP endpoint

Add POST /api/v1/photos/live-upload. Parse scalar fields before parts, require exactly one still file, allow at most one motion part, and return the created Photo as 201. Keep the existing single-file upload and /api/v1/live-photos/{id} endpoint unchanged for compatibility.

- [ ] Step 6: Run tests and commit

Run go test ./internal/photos ./internal/httpapi -count=1; expected PASS.

~~~bash
git add internal/photos
git commit -m "feat: ingest HEIC and embedded motion photos"
~~~

### Task 5: Generate thumbnails for HEIC and video

**Files:**
- Modify: internal/thumbnails/service.go
- Modify: internal/thumbnails/service_test.go
- Modify: internal/photos/http.go

- [ ] Step 1: Write failing thumbnail tests

Add tests that HEIC, HEIF, MP4, and WebM photos are accepted by Ensure and produce WebP variants. Add a fake-tool assertion for -ss 0.5, one video stream, and bounded scaling. Add a failure test confirming no partial WebP remains.

- [ ] Step 2: Run tests and verify red

Run go test ./internal/thumbnails -count=1.

Expected: FAIL because the worker currently only accepts JPEG/PNG.

- [ ] Step 3: Implement media-backed rendering

Inject a renderer with:

~~~go
type MediaRenderer interface {
    DecodeStill(context.Context, string, string) (image.Image, error)
    ExtractVideoFrame(context.Context, string) (image.Image, error)
}
~~~

Keep Go decoding for JPEG/PNG. Use heif-convert or verified FFmpeg HEIF decoding for HEIC/HEIF, then apply orientation and the existing WebP writer. Use FFmpeg for MP4, WebM, MOV, and motion artifacts. Extract around 0.5 seconds and fall back to the first decodable frame.

- [ ] Step 4: Extend HTTP preview

Route HEIC/HEIF through the thumbnail service and preserve 202 pending behavior. Keep standalone video preview serving the original video. Return 415 only when the source cannot be rendered.

- [ ] Step 5: Run tests and commit

Run go test ./internal/thumbnails ./internal/photos -count=1; expected PASS.

~~~bash
git add internal/thumbnails internal/photos/http.go
git commit -m "feat: generate WebP thumbnails for HEIC and video"
~~~

### Task 6: Implement rescan/import pairing

**Files:**
- Modify: internal/indexer/service.go
- Modify: internal/indexer/service_test.go
- Modify: internal/importer/service.go
- Modify: internal/importer/service_test.go
- Modify: internal/photos/scan.go
- Modify: internal/photos/service.go

- [ ] Step 1: Write failing ingestion tests

Cover HEIC plus MOV, HEIF plus MOV, MVIMG JPG, standalone MP4/WebM, orphan MOV, changed MVIMG source, and deleted companion MOV. Assert one gallery row per pair, a valid motion artifact, correct MIME, stale-artifact removal, and unchanged relative import paths.

- [ ] Step 2: Run tests and verify red

Run go test ./internal/indexer ./internal/importer ./internal/photos -run '(HEIC|HEIF|MVIMG|Motion|MOV|Import)' -count=1.

Expected: FAIL because scanners reject HEIC/MOV and index only one file at a time.

- [ ] Step 3: Refactor rescan into two passes

Collect regular files with relative path, folder, normalized directory/base key, and shared inspection result. First index valid stills and standalone MP4/WebM; extract embedded motion while indexing a still. Then associate one validated MOV with each matching still. Associated MOV paths are marked seen but never indexed as a second photo. A missing companion removes the old artifact.

- [ ] Step 4: Refactor importer pairing

Collect the source tree before constructing moves. Accept HEIC/HEIF, embedded-motion images, MP4, and WebM. Include MOV only if a supported still with the same normalized directory/base exists. Move the pair together and leave unmatched MOV skipped.

- [ ] Step 5: Run tests and commit

Run go test ./internal/indexer ./internal/importer ./internal/photos -count=1; expected PASS.

~~~bash
git add internal/indexer internal/importer internal/photos/scan.go internal/photos/service.go
git commit -m "feat: scan and import motion photo pairs"
~~~

### Task 7: Add Web HEIC selection and logical upload

**Files:**
- Modify: web/src/features/upload/uploadSelection.ts
- Modify: web/src/features/upload/uploadSelection.test.ts
- Modify: web/src/features/upload/UploadWorkspace.tsx
- Modify: web/src/app/App.tsx
- Modify: web/src/app/api.ts
- Modify: web/src/app/api.test.ts

- [ ] Step 1: Write failing Web tests

Test HEIC plus MOV, HEIF plus MOV, case-insensitive matching, unmatched MOV, and single-file MVIMG. Add an API test asserting multipart order folder_id, conflict, file, motion, and progress completion after both parts.

- [ ] Step 2: Run tests and verify red

Run cd web && npm test -- --run src/features/upload/uploadSelection.test.ts src/app/api.test.ts.

Expected: FAIL because HEIC/HEIF are not still candidates and no logical upload client method exists.

- [ ] Step 3: Implement selection and API support

Add .heic and .heif to isSupportedStill. Add uploadLivePhoto(file, motion, folderId, onProgress, signal) targeting /api/v1/photos/live-upload. Update the workspace to call it for paired items. Add image/heic,image/heif to both file-input accept strings.

- [ ] Step 4: Run Web checks and commit

Run:

~~~bash
cd web
npm test -- --run src/features/upload/uploadSelection.test.ts src/app/api.test.ts
npm run typecheck
~~~

Expected: PASS.

~~~bash
git add web/src
git commit -m "feat: upload HEIC motion photo pairs from Web"
~~~

### Task 8: Persist and upload Android motion companions

**Files:**
- Modify: mobile/src/native/NativeUploadQueue.ts
- Modify: mobile/src/features/upload/types.ts
- Modify: mobile/src/features/upload/uploadService.ts
- Modify: mobile/android/app/src/main/java/com/photo77/upload/db/UploadTaskEntity.kt
- Modify: mobile/android/app/src/main/java/com/photo77/upload/db/UploadTaskDao.kt
- Modify: mobile/android/app/src/main/java/com/photo77/upload/db/UploadDatabase.kt
- Create: mobile/android/app/src/main/java/com/photo77/upload/db/Migration2.kt
- Modify: mobile/android/app/src/main/java/com/photo77/bridge/NativeUploadQueueModule.kt
- Modify: mobile/android/app/src/main/java/com/photo77/upload/UploadApi.kt
- Modify: mobile/android/app/src/test/java/com/photo77/upload/UploadApiTest.kt
- Modify: mobile/android/app/src/test/java/com/photo77/upload/UploadSchedulerTest.kt
- Modify: mobile/android/app/src/test/java/com/photo77/upload/UploadRequestBodyTest.kt
- Modify: mobile/android/app/src/test/java/com/photo77/upload/db/UploadTaskDaoTest.kt
- Modify: mobile/android/app/src/test/java/com/photo77/picker/NativePhotoPickerModuleTest.kt
- Modify: mobile/android/app/src/test/java/com/photo77/picker/NativePhotoPickerPersistenceTest.kt

- [ ] Step 1: Write failing pairing, migration, and multipart tests

Add a pairing test for supported still plus MOV and unmatched MOV. Add Room migration tests for nullable motion_uri, motion_display_name, motion_mime_type, and motion_size_bytes. Add an OkHttp test asserting one logical request with file before motion.

- [ ] Step 2: Run tests and verify red

Run:

~~~bash
cd mobile
npm test -- --runInBand src/features/upload
cd android
./gradlew testDebugUnitTest --tests '*UploadTask*' --tests '*Migration*' --tests '*UploadApi*'
~~~

Expected: FAIL because queue items and Room version 2 have no companion fields.

- [ ] Step 3: Extend picked-media and Room models

Use a non-recursive companion type:

~~~ts
type MotionMedia = Pick<PickedMedia, 'uri' | 'displayName' | 'mimeType' | 'size'>;
type PickedMedia = {
  uri: string;
  displayName: string;
  mimeType: string;
  size: number | null;
  motion?: MotionMedia;
};
~~~

Pair jpg/jpeg/png/heic/heif with .mov by normalized basename. Add four nullable Room columns and migrate from version 1 to version 2. Populate them from the optional motion map in the native bridge.

- [ ] Step 4: Implement one-request upload and combined progress

When motion fields exist, UploadApi posts to /api/v1/photos/live-upload with scalar fields first, then file, then motion. Keep the existing auth refresh and retry classification. Report primary progress as sent, motion progress as primarySize plus sent, and total media bytes as primarySize plus motionSize.

- [ ] Step 5: Run Android tests and commit

Run:

~~~bash
cd mobile
npm test -- --runInBand src/features/upload
npm run typecheck
cd android
./gradlew testDebugUnitTest --tests '*UploadTask*' --tests '*Migration*' --tests '*UploadApi*'
~~~

Expected: PASS.

~~~bash
git add mobile/src mobile/android/app/src/main/java/com/photo77/bridge/NativeUploadQueueModule.kt mobile/android/app/src/main/java/com/photo77/upload mobile/android/app/src/test
git commit -m "feat: upload Android motion photos atomically"
~~~

### Task 9: Add Web and Android LIVE playback

**Files:**
- Modify: web/src/features/gallery/GalleryWorkspace.tsx
- Modify: web/src/features/viewer/Viewer.tsx
- Modify: mobile/src/services/api/types.ts
- Modify: mobile/src/services/api/client.ts
- Modify: mobile/src/features/gallery/queries.ts
- Modify: mobile/src/features/gallery/GalleryScreen.tsx
- Modify: mobile/src/features/viewer/MediaViewerScreen.tsx
- Modify: web/src/features/gallery/GalleryWorkspace.test.tsx
- Modify: mobile/src/features/gallery/GalleryScreen.test.tsx
- Create: mobile/src/features/viewer/MediaViewerScreen.test.tsx

- [ ] Step 1: Write failing viewer tests

Test that a HEIC photo returned by live status gets a LIVE marker, uses the preview URL as poster, and uses the live-photo URL for playback. Test that standalone HEIC is rendered as an authenticated image and video/quicktime uses download fallback unless marked LIVE.

- [ ] Step 2: Run tests and verify red

Run:

~~~bash
cd web
npm test -- --run src/features/gallery src/features/viewer
cd ../mobile
npm test -- --runInBand src/features/gallery src/features/viewer
~~~

Expected: FAIL because Android does not merge live status and its viewer recognizes only MP4/WebM.

- [ ] Step 3: Implement status and playback

Add is_live_photo?: boolean to Web and mobile photo types. Extend mobile listPhotos to query /api/v1/live-photos/status for at most 100 IDs. Add livePhotoURL(photoId); pass existing Bearer headers to react-native-video. Render HEIC/HEIF with server WebP preview and LIVE items with authenticated video plus the preview poster.

- [ ] Step 4: Run tests and commit

Run:

~~~bash
cd web
npm test -- --run src/features/gallery src/features/viewer
npm run typecheck
cd ../mobile
npm test -- --runInBand src/features/gallery src/features/viewer
npm run typecheck
~~~

Expected: PASS.

~~~bash
git add web/src mobile/src
git commit -m "feat: play HEIC motion photos in Web and Android"
~~~

### Task 10: Update API, decisions, and deployment documentation

**Files:**
- Create: scripts/check-media-contract.sh
- Modify: docs/api/openapi.yaml
- Modify: docs/DECISIONS.md
- Modify: docs/operations/build.md
- Modify: docs/operations/deployment.md
- Modify: docs/operations/acceptance.md
- Modify: README.md

- [ ] Step 1: Write the contract check

Create scripts/check-media-contract.sh with this content:

~~~sh
#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
files="docs/api/openapi.yaml docs/DECISIONS.md docs/operations/build.md docs/operations/deployment.md docs/operations/acceptance.md README.md"
for needle in image/heic image/heif /api/v1/photos/live-upload ffmpeg ffprobe heif-convert MVIMG; do
    if ! (cd "$root" && rg -q --fixed-strings "$needle" $files); then
        echo "missing media contract entry: $needle" >&2
        exit 1
    fi
done
~~~

Make it executable and add one shell test invocation to the acceptance documentation.

- [ ] Step 2: Run the check and verify red

Run bash scripts/check-media-contract.sh.

Expected: FAIL because the new MIME/path/tool entries are absent or incomplete.

- [ ] Step 3: Update OpenAPI and decisions

Add the new MIME enum values, logical multipart fields, live playback content types, and thumbnail pending behavior. Replace the V1 HEIC/HEIF rejection decision. Document that MVIMG is inspected by bytes, MOV is a companion, and originals are never rewritten.

- [ ] Step 4: Document capability checks and commit

Document installation and these verification commands:

~~~bash
ffmpeg -version
ffprobe -version
heif-convert --version
curl -fsS http://127.0.0.1:8080/healthz
~~~

Run git diff --check, then commit:

~~~bash
git add scripts/check-media-contract.sh docs/api/openapi.yaml docs/DECISIONS.md docs/operations README.md
git commit -m "docs: document expanded motion photo formats"
~~~

### Task 11: Run complete verification and media acceptance

**Files:**
- Verification-only task; no new source files are expected. If a check fails, modify only the exact implementation or test file named in Tasks 1-10.
- Do not modify mobile/e2e/README.md or mobile/e2e/maestro/lan-http.yaml.

- [ ] Step 1: Run Go verification

Run go test ./... -count=1; expected PASS.

- [ ] Step 2: Run Web verification

Run:

~~~bash
cd web
npm test -- --run
npm run typecheck
npm run lint
npm run build
~~~

Expected: PASS and a production bundle.

- [ ] Step 3: Run Android verification

Run:

~~~bash
cd mobile
npm test -- --runInBand
npm run typecheck
npm run lint
ANDROID_HOME=/home/ubuntu/Android/Sdk npm run android:assemble
~~~

Expected: PASS and a debug APK.

- [ ] Step 4: Verify the final container

Run:

~~~bash
docker build -t 77photo-media-acceptance .
docker run --rm 77photo-media-acceptance ffmpeg -version
docker run --rm 77photo-media-acceptance ffprobe -version
docker run --rm 77photo-media-acceptance heif-convert --version
~~~

Expected: all commands exit successfully and the Go binary remains CGO-free.

- [ ] Step 5: Run fixture acceptance

Verify through upload and rescan:

~~~text
HEIC -> image/heic, WebP preview, original hash unchanged
HEIF -> image/heif, WebP preview, original hash unchanged
MVIMG JPG -> one row, WebP poster, LIVE playback
HEIC + MOV -> one row, LIVE playback
HEIF + MOV -> one row, LIVE playback
MP4/WebM -> standalone row and WebP video thumbnail
orphan MOV -> no gallery row
changed/deleted source -> stale motion artifact removed
~~~

- [ ] Step 6: Inspect diff before claiming completion

Run git status --short, git diff main...HEAD --stat, and git diff --check main...HEAD. Confirm feature commits are isolated from the two pre-existing mobile E2E edits.
