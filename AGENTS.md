# Android target architecture

- The Android client in `mobile/` supports only ARM64 (`arm64-v8a`). Do not build, run, test, or debug an x86 or x86_64 Android target or emulator.
- Keep Android build and test commands on the `arm64-v8a` target. A build host's CPU architecture is separate from the APK target ABI; switching the target to x86_64 does not fix host SDK tool failures.
- If the available host cannot run Android SDK tools for an ARM64 APK, report that native build verification is unavailable there. Continue with checks that do not require changing the target ABI.
