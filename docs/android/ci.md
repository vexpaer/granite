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
9. Android SDK, build-tools, NDK, and CMake installation
10. `tauri android init` only when `src-tauri/gen/android/app/build.gradle.kts`
   is absent
11. `chmod +x src-tauri/gen/android/gradlew`
12. `npx tauri android build --debug --apk --target aarch64 --ci`
13. APK signature, checksum, badging, and merged-manifest inspection
14. Debug APK artifact upload

For `v*` tags, the Release job repeats the checks and build, configures signing
from repository secrets, verifies the APK with `apksigner`, and creates or
updates the GitHub Release assets.

The workflow does not start an emulator, install onto a device, run Android UI
tests, or build an AAB.

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

The workspace-local test toolchain is under:

```text
E:\GITHUB\granite\.cache\android-toolchain\
  jdk17\
  android-sdk\
```

It contains JDK 17, API 37.0, build-tools 37.0.0, NDK 29.0.13846066, CMake
3.22.1, and platform-tools 37.0.1. `.cache` is ignored by Git.

PowerShell setup for a local build:

```powershell
$tool = 'E:\GITHUB\granite\.cache\android-toolchain'
$env:JAVA_HOME = Join-Path $tool 'jdk17'
$env:ANDROID_HOME = Join-Path $tool 'android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:NDK_HOME = Join-Path $env:ANDROID_HOME 'ndk\29.0.13846066'
$env:CARGO_HOME = 'E:\GITHUB\granite\.cache\cargo'
$env:CARGO_TARGET_DIR = 'E:\GITHUB\granite\target'
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

npm ci
npx tauri android build --debug --apk --target aarch64 --ci
bash scripts/android-verify-apk.sh debug
```

`bash` can be supplied by Git for Windows. Do not install the APK merely
because a device happens to be attached. Physical verification is currently
waived, and any future installation requires an identified target serial.

## Outputs and evidence

The build writes APKs below:

```text
src-tauri/gen/android/app/build/outputs/apk/
```

The inspection script writes these files below `artifacts/android/<mode>/`:

- `SHA256SUMS`
- `apk-inspection.txt`
- per-APK merged manifest dumps

CI uploads the Debug APK and inspection files. A successful job is not runtime
evidence and does not close any waived Android device gate.
