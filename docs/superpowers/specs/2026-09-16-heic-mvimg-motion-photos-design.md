# HEIC/HEIF and MVIMG Motion Photo Support

## Status

Design approved in conversation on 2026-09-16. Implementation has not started.

## Goal

Extend 77Photo so HEIC/HEIF images, Apple-style still-image plus MOV pairs,
Google-style MVIMG files, and ordinary MP4/WebM video all work through upload,
Android background upload, filesystem import and rescan, thumbnail generation,
gallery preview, dynamic playback, and original-file download.

Original media must remain byte-for-byte unchanged. Derived thumbnails and
motion-video files are rebuildable artifacts and must never be treated as the
canonical photo.

## Current Context

The server currently accepts JPEG, PNG, MP4, and WebM. The web uploader pairs a
JPEG/PNG with a same-basename `.MOV` and sends the MOV through the existing
`/api/v1/live-photos/{photoID}` endpoint. Live motion is stored under the
hidden `.77photo/live` directory, and the web viewer uses that endpoint for
playback.

The thumbnail worker decodes JPEG/PNG in Go and writes WebP variants. The
filesystem indexer and importer use `http.DetectContentType`, so they currently
reject HEIC/HEIF and MOV. The Android client uses a persistent Room-backed
single-file upload task and does not yet persist a companion motion file.

The Go build is intentionally CGO-free. The release image is Alpine-based and
currently contains no media command-line tools. The development environment
has FFmpeg 6.1 available, but the production image must declare and install its
runtime dependencies explicitly.

## Supported Media Semantics

### Still images

The server accepts these still formats when both the extension and detected
container agree:

| Extension | MIME type | Use |
| --- | --- | --- |
| `.jpg`, `.jpeg` | `image/jpeg` | JPEG still, including JPEG-based MVIMG |
| `.png` | `image/png` | PNG still and existing Live Photo base |
| `.heic` | `image/heic` | HEIC still or HEIC-based motion photo |
| `.heif` | `image/heif` | HEIF still or HEIF-based motion photo |

HEIC/HEIF recognition is based on ISO Base Media File Format `ftyp` brands,
including the HEIC/HEIF image brands used by current mobile exports. A filename
alone never makes an arbitrary file acceptable.

### Ordinary videos

MP4 and WebM remain first-class standalone videos. MOV is accepted as a motion
component of a logical dynamic photo; a standalone MOV upload remains rejected
by the ordinary photo-upload endpoint.

### Dynamic photos

The following forms are supported:

1. A supported still image plus a same-basename `.MOV`, for example
   `IMG_1234.HEIC` plus `IMG_1234.MOV`. Matching is case-insensitive and ignores
   only the final extension.
2. A JPEG or HEIC/HEIF file containing an embedded motion-video segment, such
   as a Google `MVIMG_*.JPG` file. The `MVIMG` prefix is only a hint; the bytes
   must contain an image and a video stream that can be validated.
3. A HEIC/HEIF container with a valid embedded video track, when present in the
   exported asset. The implementation must also continue supporting the
   separate-MOV form because both export forms exist in the field.

The dynamic state is derived from the existence of a validated motion artifact
for the photo. No video bytes are placed in the SQLite row.

## Architecture

### Media processing package

Add a focused `internal/media` package with three responsibilities:

- `Inspect`: validate extension/signature, return the canonical MIME type,
  identify still/video media, and locate an embedded motion segment.
- `RenderThumbnail`: render a still frame to the existing WebP cache format.
- `ExtractMotion`: validate and atomically write a motion-video artifact.

The package receives a small command-runner interface so unit tests can verify
arguments, timeouts, and cleanup without depending on a particular local
codec installation. Production uses direct process execution with no shell
interpolation.

FFmpeg/FFprobe are used for video probing, embedded-video validation, video
frame extraction, and WebP output. HEIC/HEIF still decoding uses the installed
libheif command-line tool (`heif-convert`); deployments may use an FFmpeg build
with HEIF support as an equivalent decoder when the media capability check
confirms it. The Go binary remains CGO-free.

### Derived motion storage

Keep one hidden artifact per photo at a deterministic path under
`.77photo/live`, keyed by photo ID. The artifact is written to a temporary file,
validated, synced, and atomically renamed. Its container is not normalized:
an extracted MP4 remains MP4 and a paired QuickTime file remains QuickTime.

`LiveVideoPath` reads the artifact header before serving it and returns the
matching content type. The existing `.mov` artifact path is read as a backward
compatibility fallback and migrated/replaced when the photo is next updated.

When a source checksum changes during rescan, any old motion artifact is
removed before a new embedded segment is extracted. Deleting a photo removes
both the original and its derived motion artifact. Renaming or moving a photo
does not change the artifact because it is keyed by the immutable photo ID.

### Thumbnails

Extend the thumbnail worker to accept still images and videos:

- JPEG/PNG: retain the current Go decoder path.
- HEIC/HEIF: decode to a bounded intermediate image with libheif or a verified
  FFmpeg HEIF decoder, then apply orientation and encode the cached WebP.
- MP4/WebM/MOV: use FFmpeg to select a frame around 0.5 seconds, falling back
  to the first decodable frame for shorter media, then encode WebP.
- MVIMG: use the still image portion for the poster and its extracted motion
  artifact for playback.

The existing cache key remains tied to the photo source revision. Tool output
is written through the same atomic cache-file pattern already used by the
thumbnail service.

## Upload and Ingestion Flows

### Web upload

Extend the file picker and selection pairing helper to recognize `.heic` and
`.heif` as still files. Existing same-basename MOV pairing remains unchanged.
The normal upload endpoint accepts HEIC/HEIF and automatically extracts an
embedded motion segment after the source has been safely stored and indexed.

Add a logical dynamic-photo multipart operation for a still plus an optional
companion MOV. It uploads the still and motion component under one logical
operation, so a retry cannot create a second photo after the first half already
succeeded. The existing single-file upload and existing attach endpoint remain
available for compatibility.

If an embedded motion segment is malformed or absent, a valid still is still
stored as an ordinary photo. If a user explicitly supplies a companion MOV and
that MOV fails validation, the logical operation fails and must remove all
temporary/partial artifacts before returning the error.

### Android upload

The Android picker continues to accept image and video selections, including
HEIC/HEIF providers. The JavaScript selection layer groups a supported still
and same-basename MOV into one logical item. The native queue persists optional
motion URI, display name, MIME, and size fields on the same Room task.

The Android upload API sends one multipart logical-photo request when a task
has a companion motion URI. The task's retry, pause/resume state, cancellation,
and byte progress represent both parts. Persisted URI grants remain in force
until the logical task completes or is canceled.

MVIMG and HEIC/HEIF files containing their own motion are single-file tasks;
the server performs the embedded extraction after receiving the source.

### Filesystem rescan and import

Replace the current MIME-only checks with the shared media inspector.

The rescan uses a two-stage association pass:

1. Index valid still images and standalone MP4/WebM videos. For an embedded
   motion container, extract its motion artifact while indexing the still.
2. Associate same-basename MOV files with indexed compatible stills. A matching
   MOV is stored as the photo's motion artifact and is not indexed as a second
   gallery item. Unmatched MOV files remain skipped rather than appearing as
   standalone videos.

The importer moves HEIC/HEIF and ordinary supported media. It moves a matching
MOV together with its still so the subsequent rescan can associate the pair;
unmatched MOV files are skipped. Existing folder structure and conflict rules
remain unchanged.

## API and Client Behavior

- Extend `Photo.mime_type` API enums with `image/heic` and `image/heif`.
- Keep `is_live_photo` as a derived client property populated by the existing
  live-photo status query.
- Keep `/api/v1/live-photos/status` and `/api/v1/live-photos/{id}` for dynamic
  state and playback. The playback response advertises the actual video MIME.
- Add the logical dynamic-photo upload contract to OpenAPI, including its
  still `file` part and optional `motion` part.
- Web HEIC/HEIF preview continues to use the server's WebP preview URL. The
  web viewer plays the derived motion artifact for LIVE photos.
- Android gallery queries live status, renders HEIC/HEIF through the server
  preview URL, and plays a LIVE artifact with the existing authenticated video
  player. Unsupported video codecs retain the current download fallback.
- Original download always returns the original uploaded or imported bytes,
  with the original filename.

## Security, Resource Limits, and Failure Handling

- Never construct media commands through a shell. Pass fixed argument arrays
  and validated temporary paths.
- Apply the configured upload-size limit before invoking a decoder or extractor.
- Bound FFmpeg/heif-convert wall-clock time, output dimensions, output bytes,
  and the number of concurrent media processes. Tool contexts must be
  cancelable when an HTTP request is canceled.
- Store temporary media only below the managed storage/cache roots and remove
  it on every error path.
- Validate extracted video streams with FFprobe before exposing an artifact;
  reject empty, audio-only, malformed, or over-limit results.
- A missing tool or unsupported codec must produce a clear service error or a
  thumbnail-pending/unavailable response. It must never expose a half-written
  artifact or create a visible index row for invalid media.
- The startup/health documentation must report whether the required media
  tools are present. Existing JPEG/PNG/MP4/WebM behavior must remain usable if
  an optional HEIC decoder is unavailable, while HEIC/HEIF ingestion reports a
  specific unsupported-capability error.

## Testing Strategy

### Go

- Unit-test canonical MIME detection for JPEG, PNG, HEIC and HEIF brands,
  extension mismatches, invalid signatures, and ordinary MP4/WebM.
- Test MVIMG extraction with a small valid image-plus-video fixture and verify
  that the extracted artifact contains a playable video stream.
- Test paired HEIC/HEIF plus MOV ingestion, replacement, source-change
  invalidation, deletion cleanup, and unmatched MOV skipping.
- Test thumbnail generation for HEIC/HEIF, MP4, WebM, MOV, MVIMG, tool failure,
  cancellation, output limits, and atomic cleanup.
- Extend upload, rescan, importer, HTTP, and API contract tests to cover the
  new MIME values and logical upload operation.

### Web

- Extend selection tests for HEIC/HEIF plus same-basename MOV pairing,
  case-insensitive matching, unmatched MOV behavior, and MVIMG single-file
  uploads.
- Test the API client multipart shape and progress handling for logical
  dynamic-photo uploads.
- Test HEIC LIVE state rendering and viewer playback URL selection.

### Android

- Test picker metadata acceptance for `image/heic` and `image/heif`.
- Test filename pairing before queue insertion.
- Test Room migration and persistence of optional motion fields.
- Test multipart ordering, both parts' progress, retry behavior, and an
  authenticated playback request for a LIVE item.
- Build the Android debug APK and run the existing unit/type/lint checks.

### Deployment acceptance

The Docker image must contain working `ffmpeg`, `ffprobe`, and the selected
HEIC decoder. An acceptance fixture must verify: HEIC thumbnail, HEIF
thumbnail, MVIMG poster and playback, JPEG/HEIC plus MOV pairing, MP4/WebM
video thumbnails, rescan/import association, and original-byte preservation.

## Documentation and Configuration Changes

- Replace the V1 media-format decision that rejects HEIC/HEIF and document the
  new MIME and dynamic-photo semantics.
- Update OpenAPI media enums, logical upload request, thumbnail responses, and
  live playback responses.
- Add media-tool installation and capability-check instructions to build and
  deployment documentation.
- Document that FFmpeg and an HEIC decoder are runtime dependencies for the
  new formats, while original media remains unmodified.

## Out of Scope

- Video transcoding or codec normalization.
- Re-encoding or metadata rewriting of original media.
- iOS-native picker implementation; the current mobile project provides an
  Android client, while server-side HEIC/HEIF support is platform-neutral.
- Repairing malformed vendor containers beyond extracting a validated video
  stream when the shared media inspector can safely identify one.
