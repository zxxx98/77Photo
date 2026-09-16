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
