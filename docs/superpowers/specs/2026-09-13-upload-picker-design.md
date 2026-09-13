# Upload picker entry point

## Problem

The header `Upload` action only changes the route to `#/upload`. The actual
file input is inside the upload workspace, so clicking the prominent header
action does not open a file picker and does not create an upload request.

## Design

`AppShell` owns a visually hidden multi-file input and keeps it mounted while
the authenticated shell is visible. The header action changes the route and
calls that input's `click()` in the same user event, so the browser can open
the native picker. A selection is stored with a monotonically increasing ID
and passed to `UploadWorkspace`; the workspace appends each file as a queued
item, then acknowledges that ID so revisiting the page cannot enqueue the
same files again. The existing upload workspace input remains available for
drag/drop-area selection, and both paths use the same queued item shape.

Selecting files queues them and starts the upload automatically once a
destination folder is available. The existing `Start upload` button remains
available for manually retrying queued, failed, or cancelled items and
preserves the current progress, cancellation, retry, and destination-folder
behavior.

## Validation

Add a focused unit test for the header action helper to verify it navigates and
opens the picker in one event. Add focused unit tests for converting selected
files into queued upload items and requesting automatic upload. Run the full
Vitest suite, TypeScript typecheck, and production build; manually verify both
file inputs start uploading after selection and that retry still sends the
existing request.
