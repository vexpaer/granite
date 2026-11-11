# Granite Test Evidence

**Current policy, 2026-11-11 U3:** all future minimal checks/builds run in GitHub-hosted Actions only. Local commands and browser results below are historical v0.1.0 evidence; do not rerun them locally. GitHub-incompatible checks are waived without mandatory manual follow-up. See [ci.md](ci.md).

- **Observed:** 2026-11-10, Asia/Shanghai
- **Integrated source:** `e8070f13008edc0a3d40df846fc77d8d2e49f9ee`. The final local checks and Windows package below were produced from this source before its integration commit; subsequent documentation updates do not change the packaged application.
- **Host:** Windows 10 Home China build 26100, x64; PowerShell 7.
- **Toolchain:** Node.js 22.23.1, npm 10.9.8, Rust/Cargo `stable-x86_64-pc-windows-msvc`, Tauri CLI 2.12.x.
- **Caches:** project dependencies, Cargo, browser assets and build outputs are on `E:`. The local Rustup copy is now under `.cache/rustup`; historical Gradle runs used the pre-existing C-to-D junction, while subsequent Android builds use `.cache/gradle`. See the native build records for the exact environment of each run.

## Executed Results

| Check | Result | Scope and limits |
|---|---|---|
| `npm run check` | **PASS** | Typecheck, **21 files / 130 tests**, and production build passed at the pre-pause source freeze. No client source changed before the complete browser run below. |
| `npm test -- tests/synchronization.test.ts tests/object-transfer.test.ts` | **PASS** | 2 files / 17 tests, including logical WebDAV orchestration, 4 MiB resumable chunks, legacy-large-object compatibility and IndexedDB chunk-cache reuse. |
| Desktop `cargo check --locked --manifest-path src-tauri/Cargo.toml` | **PASS** | Current MSVC host build. |
| Desktop `cargo test --locked --manifest-path src-tauri/Cargo.toml` | **PASS** | **48 passed, 0 failed**, including ordinary safe relative attachments with omitted/null embedded bytes. |
| Android bridge `cargo check --locked --manifest-path native/android-bridge/Cargo.toml` | **PASS** | Host-side Rust bridge compile. |
| Android bridge `cargo test --locked --manifest-path native/android-bridge/Cargo.toml` | **PASS** | **3 passed, 0 failed**. This is not Android runtime evidence. |
| `npx playwright test tests/e2e/plugins.spec.ts --reporter=list` | **PASS** | **2/2** current targeted tests: real opaque iframe lifecycle, SRI rejection, permission review/revoke, storage namespace, no Tauri globals, disable/re-enable/uninstall. |
| `npx playwright test tests/e2e/pdf-annotations.spec.ts --reporter=list` | **PASS** | Targeted PDF browser flow passed: Highlight, Underline, Text and Ink; safe backup/hash/export; independent MuPDF/PyMuPDF 2.1 readback reported all four annotations readable and editable. |
| Current full Playwright set | **PASS** | **8/8 in 1.2 minutes** on 2026-11-10: four formats, notes and reload, empty/compact shell, four-format position/bookmark restoration and return to Home, navigation context, two isolated-plugin flows, and PDF write/backup/export with MuPDF readback. |
| Local Android Debug APK build | **PASS as local build evidence** | Not a GitHub Actions pass and not runtime evidence. |
| GitHub Actions Android run `42765264307` | **PASS** | Integrated source `e8070f1`; frontend checks, Debug APK, Android bridge tests, inspection and upload all passed. Downloaded artifact `13739732389` matches its checksum and Android Debug signature; see [Android CI record](android/ci.md). Earlier run `42644227600` remains historical evidence only. |
| Tagged signed Release run `42766136682` | **PASS** | Tag `v0.1.0`, same integrated source. Frontend checks, signed build, bridge JVM tests, APK inspection/upload and GitHub Release publication passed. Downloaded APK checksum, release signature, manifest, API levels and ARM64 ABI independently verified. |
| Windows / Android real device and live cloud | **USER MANUAL / NOT VERIFIED** | User U2 explicitly assigns all these checks to post-delivery manual testing. They do not block this delivery. No emulator, virtual device or live cloud provider was used. |

The full-check count reflects the integrated source and has grown beyond the
earlier 85-test snapshot as local-provider, registry, attachment, plugin and
resumable-transfer tests were added.

## Reproducible Commands

```powershell
npm run check

$env:CARGO_HOME = 'E:\GITHUB\granite\.cache\cargo'
$env:CARGO_TARGET_DIR = 'E:\GITHUB\granite\target\host-msvc'
$env:RUSTUP_HOME = 'E:\GITHUB\granite\.cache\rustup'
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
cargo +stable-x86_64-pc-windows-msvc check --locked --manifest-path src-tauri/Cargo.toml
cargo +stable-x86_64-pc-windows-msvc test --locked --manifest-path src-tauri/Cargo.toml

$env:CARGO_TARGET_DIR = 'E:\GITHUB\granite\target\audit-android-bridge'
cargo check --locked --manifest-path native/android-bridge/Cargo.toml
cargo test --locked --manifest-path native/android-bridge/Cargo.toml

node scripts/create-fixtures.mjs
node scripts/prepare-qa.mjs
$env:PLAYWRIGHT_BROWSERS_PATH = 'E:\GITHUB\granite\.cache\ms-playwright'
npx playwright test tests/e2e/plugins.spec.ts --reporter=list
npx playwright test tests/e2e/pdf-annotations.spec.ts --reporter=list
npx playwright test --reporter=list
```

## Windows Evidence

The integrated source produced the final unsigned NSIS installer:

- `target/host-msvc/release/bundle/nsis/Granite_0.1.0_x64-setup.exe`
- Size: **8,042,759 bytes (8.04 MB)**
- SHA-256: `cfbd67a4fbaf48ceb629e04bce0a40774b52b658c4d72600e6400f3197ba22b1`
- Authenticode: **NotSigned**
- Delivery copy: `artifacts/release/Granite-0.1.0-windows-x64-setup.exe`
- Native executable: 19,580,416 bytes; SHA-256 `8af2d0422a5350f45099d368c02a9ba4e881e16cc68ec3a4dba3d82bf539b8fc`; product/file version 0.1.0.

A real current-user installation was observed earlier at
`C:\Users\vexpaer\AppData\Local\Granite\granite.exe`:

- Size: `19,272,192` bytes
- SHA-256: `44B63041661E8CF33EAB69B91DE92C678261AFED5EA90FF23DAE5153E2A61AC6`
- Screenshot: `artifacts/screenshots/installed-granite.png`

This proves an earlier Windows install/launch observation. It does not prove
that the later NSIS artifact was installed. Under U2 no further real-device
application run will be performed; the user will manually validate the delivered build.

## Android And PDF Artifacts

Final published Release APK:

- [Granite-v0.1.0-aarch64.apk](https://github.com/vexpaer/granite/releases/download/v0.1.0/Granite-v0.1.0-aarch64.apk)
- Size: `22,971,439` bytes
- SHA-256: `3ed49d4761613ca9b3b588798cf29f0f7dfcf80687dd5d43918de2940197499d`
- Package `app.granite.reader`, version `0.1.0`, min API 24, target API 37,
  `arm64-v8a`, not debuggable
- Verified APK v2 signature, `CN=Granite Release, O=Granite`, RSA-3072;
  certificate SHA-256 `e9fa2963910a71d0a48779be0616e7ba78100ee9ae76ab95447857691b0c9202`
- CI artifact ID `13740835212`; published asset digest matches the downloaded
  file and CI checksum
- Local delivery copy: `artifacts/release/Granite-v0.1.0-aarch64.apk`

The [published aggregate SHA256SUMS](https://github.com/vexpaer/granite/releases/download/v0.1.0/SHA256SUMS)
contains both final Windows and Android package names and hashes. The source
tag is `e8070f1`; later documentation commits record evidence only.

Historical local Debug APK (superseded by the integrated CI artifacts):

- `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- Package `app.granite.reader`, version `0.1.0`, min SDK 24, target/compile SDK 37
- Size: `179,033,980` bytes
- SHA-256: `8F02412E4C494A1CBC4954604AA8E67DA92A3AECF3601DB38792AECA8A889109`
- Android Debug V2 signature verified

The local APK is distinct from GitHub Actions artifact evidence and from
real-device runtime evidence.

Independent PDF evidence:

- `artifacts/verification/annotated-standard.pdf`
- `artifacts/verification/pdf-external.json`
- `artifacts/verification/pdf-external-render.png`

## Evidence Boundaries

- The sync tests use the actual synchronization/provider orchestration with an in-memory WebDAV object store and logical devices in one process. They do not contact WebDAV/S3, a credential store, another process, or another physical device.
- No live cloud credentials were supplied or requested after U2. Live provider authentication, TLS transport, failure recovery and another-device upload/download remain unobserved and are assigned to the user's manual checks.
- Browser screenshots and Playwright results are browser-preview evidence, never Windows or Android runtime evidence.
- All Windows/Android real-device and live-cloud checks are user-manual under U2; native compilation, Android CI/artifact and release checks remain active gates.
