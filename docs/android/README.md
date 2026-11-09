# Android implementation

Granite uses Tauri 2 with the system Android WebView. The Android-only native
adapter lives in `native/android-bridge`; the generated host project lives in
`src-tauri/gen/android`.

The workflow in `.github/workflows/android.yml` runs JavaScript checks and a
Debug APK build for pull requests and branch pushes. A `v*` tag builds, signs,
inspects, checksums, and publishes a Release APK. It never starts an emulator
or builds an AAB.

Related documents:

- [CI and local toolchain](ci.md)
- [Native bridge contract](bridge-contract.md)
- [APK signing and secrets](signing.md)
- [Physical-device acceptance runbook](physical-device-acceptance.md)

The physical-device acceptance gate is **WAIVED by the user on 2026-11-09**.
That waiver is not evidence that a device test passed. CI, APK generation,
manifest inspection, checksums, and release-signature verification remain
required.
