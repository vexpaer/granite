# Android CI and local toolchain

## Workflow behavior

`.github/workflows/android.yml` uses `ubuntu-24.04`.

For pull requests and non-tag branch pushes, the Debug job runs:

1. `npm ci`
2. `npm run typecheck`
3. `node scripts/create-fixtures.mjs`
4. `node packages/core/examples/basic-plugin/build.mjs`
5. `npm test`
6. `npm run build`
7. Rust setup with all four Android targets
8. Java 17 setup
9. Android SDK, build-tools, NDK, and CMake installation; the setup action
   installs only `platform-tools`, avoiding its obsolete default `tools`
   package before the explicit `sdkmanager` installation
10. `tauri android init` only when `src-tauri/gen/android/app/build.gradle.kts`
   is absent
11. `chmod +x src-tauri/gen/android/gradlew`
12. `npx tauri android build --debug --apk --target aarch64 --ci`
13. Android bridge JVM tests, including SAF provider and path rules,
    content-addressed Notebook attachments, bounded PDF range validation,
    managed book layout, and write-precondition checks; this runs after the
    Tauri build so ignored generated `tauri.settings.gradle` inputs exist
14. APK signature, checksum, badging, and merged-manifest inspection
15. Debug APK artifact upload

The Release job also supports an explicit `workflow_dispatch` candidate build.
Both paths repeat the checks, configure signing from the same four repository
secrets, build a release APK, and verify it with `apksigner`. A manual run
uploads `Granite-<package.json version>-candidate-aarch64.apk`, `SHA256SUMS`,
the APK inspection, and manifest dumps as a workflow artifact; it never creates
a GitHub Release. A `v*` tag push uploads the same inspection bundle and then
creates a GitHub Release with the tag-derived APK name.

The workflow does not start an emulator, install onto a device, run Android UI
tests, connect to a live provider, or build an AAB. Real-device installation,
touch, directory persistence, restart, and live WebDAV/S3/cross-device checks
are deferred to the user's later manual runs and are not pass evidence.

## Pinned Android toolchain

The generated project and CI use Tauri CLI 2.12.x values:

| Component | Version/package |
| --- | --- |
| Java | Temurin 17 |
| Compile SDK | `platforms;android-37.0` |
| Target SDK | 37 |
| Min SDK | 24 |
| Build tools | `build-tools;37.0.0` |
| NDK | `ndk;29.0.13846066` |
| CMake | `cmake;3.22.1` |

The Google SDK repository does not currently expose a package named
`platforms;android-37`; `platforms;android-37.0` is the downloadable API 37
package. The workflow therefore sets `ANDROID_COMPILE_SDK=37.0` and passes
that exact repository package to `sdkmanager`. This was checked against the
current SDK repository on 2026-11-09, which also listed
`build-tools;37.0.0` and `ndk;29.0.13846066`. The generated Gradle template
pins `compileSdk` and `targetSdk` to integer API 37; the environment variable
does not change Gradle's values.

The committed Gradle launcher may have mode `100644` after being generated on
Windows. CI repairs only its working-tree mode with `chmod +x`; repository
history can also set the executable bit when convenient.

## Local toolchain

The workspace-local test toolchain and caches are under:

```text
E:\GITHUB\granite\.cache\
  android-toolchain\
    jdk17\
    android-sdk\
  cargo\
  gradle\
```

It contains JDK 17, API 37.0, build-tools 37.0.0, NDK 29.0.13846066, CMake
3.22.1, and platform-tools 37.0.1. Cargo and Gradle use the workspace-local
cache paths below. `.cache` is ignored by Git.

PowerShell setup for a local build:

```powershell
$tool = 'E:\GITHUB\granite\.cache\android-toolchain'
$env:JAVA_HOME = Join-Path $tool 'jdk17'
$env:ANDROID_HOME = Join-Path $tool 'android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:NDK_HOME = Join-Path $env:ANDROID_HOME 'ndk\29.0.13846066'
$env:CARGO_HOME = 'E:\GITHUB\granite\.cache\cargo'
$env:CARGO_TARGET_DIR = 'E:\GITHUB\granite\target'
$env:GRADLE_USER_HOME = 'E:\GITHUB\granite\.cache\gradle'
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

npm ci
npx tauri android build --debug --apk --target aarch64 --ci
bash scripts/android-verify-apk.sh debug
```

`bash` can be supplied by Git for Windows. Real-device and live-provider checks
are deferred to the user. They are waived for this delivery, not treated as
passing checks, and do not block automated CI packaging or the first-version
artifacts.

## Outputs and evidence

The build writes APKs below:

```text
src-tauri/gen/android/app/build/outputs/apk/
```

The inspection script writes these files below `artifacts/android/<mode>/`:

- `SHA256SUMS`
- `apk-inspection.txt`
- per-APK merged manifest dumps

CI uploads the Debug APK and inspection files. A successful job proves only the
automated build and inspection path. It is not runtime evidence and does not
turn any waived device or live-cloud check into a pass.

## Verified Debug artifact

On 2026-11-09, GitHub Actions run
[`42644227600`](https://github.com/vexpaer/granite/actions/runs/42644227600)
completed successfully for commit
`4203e6d2e4886d58edd1ca192c626b7758d37894`. Debug job `129253027867`
completed every step, including `Build Debug APK`, `Inspect and checksum Debug
APK`, and `Upload Debug APK`. The artifact was downloaded to the ignored local
directory `.cache/ci/4203e6d`.

Artifact `granite-android-debug-4203e6d2e4886d58edd1ca192c626b7758d37894`
(ID `13686952069`) was checked independently with the workspace JDK 17 and
Android SDK/build-tools 37.0.0:

- APK:
  `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- APK size: `183994068` bytes
- APK SHA-256:
  `e59bde3eb5087d8daabc58fda37528706b9d4fc0106b780bfeca56989ea0c6c7`
- The APK hash exactly matches the artifact's `SHA256SUMS`
- `aapt2 dump xmltree` and `apkanalyzer manifest print` both report package
  `app.granite.reader`, min SDK 24, and target SDK 37; the manifest is marked
  debuggable
- `apksigner verify --verbose --print-certs` reports `Verifies`, APK Signature
  Scheme v2 enabled, and one Android Debug RSA-2048 signer with certificate
  SHA-256
  `82fc4843caf2262f0e8e8a5fe315230fa2dbabf41c1f66344c55ca6bcc39038b`

No APK was installed or run on a physical device. This records the successful
GitHub Actions compilation and artifact integrity checks only.
