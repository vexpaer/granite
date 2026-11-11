# Android implementation

**Current U3 policy (2026-11-11):** build/test/sign/publish only in GitHub Actions, with simple automated checks. Device/live-cloud tests are waived with no required manual follow-up. Local toolchain and deferred runbook text linked below are historical. See [ci.md](../ci.md).

Granite uses Tauri 2 with the system Android WebView. The Android-only native
adapter lives in `native/android-bridge`; the generated host project lives in
`src-tauri/gen/android`.

The workflow in `.github/workflows/android.yml` runs JavaScript checks and a
Debug APK build for pull requests and branch pushes. A manual dispatch builds
and uploads a verified signed candidate APK. A `v*` tag builds, signs,
inspects, checksums, and publishes a Release APK. It never starts an emulator
or builds an AAB.

Related documents:

- [CI and local toolchain](ci.md)
- [Native bridge contract](bridge-contract.md)
- [APK signing and secrets](signing.md)
- [Deferred device and live-provider acceptance runbook](physical-device-acceptance.md)

Android install/runtime checks and real WebDAV, S3, and cross-device cloud
checks are **WAIVED for this delivery**. The user will run those manual checks
later. The waiver is not evidence that the checks passed and does not block the
first Windows/Android artifact delivery. CI, APK generation, manifest
inspection, checksums, and release-signature verification remain required.
