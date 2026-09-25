# Android APK identity

Preserved from the removed Android client. This directory contains launcher
resources only; it is not a buildable Android project.

- Display name: `77Photo` (`res/values/strings.xml` -> `app_name`).
- Application ID: `com.photo77` (previous `defaultConfig.applicationId`).
- Launcher icons: `ic_launcher` and `ic_launcher_round`. The adaptive icon XML,
  foreground vector and background color are preserved from the old "77" design.
  The old PNG density variants still contained the Android template icon; they
  have been replaced by matching "77" PNGs rendered from `legacy-icon.svg`
  and `legacy-icon-round.svg`.

When creating the new Android project, copy `res/` into the app's
`src/main/res/`, set the manifest application label to `@string/app_name`,
icon to `@mipmap/ic_launcher`, round icon to `@mipmap/ic_launcher_round`,
and set `applicationId` to `com.photo77`. Do not replace these resources as
part of the UI redesign.

Keeping the application ID alone does not make a new APK upgrade-compatible
with old installations: release signing continuity also requires the original
release signing key. The key and its passwords are not stored here; verify
their availability before shipping an update.
