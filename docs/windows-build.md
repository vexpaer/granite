# Granite Windows build record

Status: **final v0.1.0 build and published artifact record**

The final installer below is published in [Granite v0.1.0](https://github.com/vexpaer/granite/releases/tag/v0.1.0) as `Granite-0.1.0-windows-x64-setup.exe`. Its uploaded SHA-256 matches the local build. The release tag is `e8070f1`; later documentation updates record the evidence without changing application code.

This record covers the first-release Windows host owned by `src-tauri/**` and the
Windows packaging path. Android build and device evidence are recorded separately.

## Environment

Observed on 2026-11-10 (Asia/Shanghai):

- Host: Windows 10 Home China, build 26100, x64
- Rust toolchain: `stable-x86_64-pc-windows-msvc`
- Rust: `rustc 1.99.1 (58cf8f9c3 2026-10-13)`
- Cargo: `cargo 1.99.1 (5f94df478 2026-08-27)`
- Visual Studio Build Tools: 2022 `17.14.36310.24`, with
  `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`
- Node.js: `v22.23.1`
- npm: `10.9.8`
- Tauri CLI: `2.12.4`
- NSIS: `3.13`

Use PowerShell 7 and select MSVC explicitly:

```powershell
$env:CARGO_HOME = 'E:\GITHUB\granite\.cache\cargo'
$env:CARGO_TARGET_DIR = 'E:\GITHUB\granite\target\host-msvc'
$env:RUSTUP_HOME = 'E:/GITHUB/granite/.cache/rustup'
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
```

Rust dependencies and build outputs are stored on E:. The pre-existing
`C:\Users\vexpaer\.rustup` junction points to
`D:\Links\Users_vexpaer_.rustup`; it was left unchanged. The required
`stable-x86_64-pc-windows-msvc` toolchain, including its Android targets, was
copied to the E workspace cache. `rustup run` reported rustc 1.99.1 with its
sysroot below `E:\GITHUB\granite\.cache\rustup`.

The pre-existing NSIS 3.13 cache at
`C:\Users\vexpaer\AppData\Local\tauri\NSIS` was left unchanged and copied to
`E:\GITHUB\granite\target\host-msvc\.tauri\NSIS`. The final build used Tauri's
`bundle.useLocalToolsDir` option. No dependency or tool was newly installed.

## Verification

Run from the repository root:

```powershell
cargo +stable-x86_64-pc-windows-msvc test --locked --manifest-path src-tauri/Cargo.toml
cargo +stable-x86_64-pc-windows-msvc check --locked --manifest-path src-tauri/Cargo.toml
```

Observed results:

- Native MSVC tests: **48 passed, 0 failed, 0 ignored**
- `cargo check`: passed
- `cargo check --features custom-protocol`: passed
- Final MSVC release build and NSIS packaging: passed
- Android Rust target check:
  `cargo check --target aarch64-linux-android` passed with the repository-local
  Android SDK/NDK cache
- `book.stat` and `book.readRange`: compile-verified; Android SAF requests route
  through the Kotlin bridge and filesystem roots stay in Rust
- `book.trash`: compile-verified and covered by unit tests, including refusal to
  move an externally managed book
- `plugin.fetch`: compile-verified, including HTTPS/redirect validation and the
  20 MiB archive limit; no live remote plugin archive fetch was performed
- LocalFilesystem provider: compile-verified with tests for prefix isolation,
  recursive LIST, GET/HEAD byte ranges, conditional writes and deletes,
  checksum validation, and atomic replacement
- Windows window state: `tauri-plugin-window-state 2.5.0` is registered only
  for Windows with size, position, and maximized state enabled. The plugin's
  close-time save and startup restore paths are type-checked; no final-app runtime
  restart was performed because interactive window launch is prohibited.
- `book.write`: the command requires the SHA-256 of the loaded target. Native
  code checks it before creating a backup and again before atomic replacement.
  An external change returns `Conflict`, removes the pending temporary
  replacement, preserves the external bytes, and retains any completed
  pre-write backup in private app data.

The native suite covers SQLite state round trips and migration backups, path
traversal rejection, atomic book writes with checksum verification, recoverable
trash behavior, root migration cancellation, Notebook conflict handling, S3
signing, secure plugin URLs, and byte-array validation.

The Notebook mirror materializes declared attachments below the Markdown file's
actual parent directory using
`attachments/sha256/<sha256>/<safe-name>`. It verifies Base64 Data URL shape,
path and name boundaries, decoded SHA-256 content, and reparse-point safety.
An existing content-addressed file with different bytes is preserved and
reported as a conflict. Removing or moving a Note does not delete existing
attachment files. A metadata-only attachment with omitted or null `data` keeps
its ordinary relative path and existing external file unchanged. The strict
content-addressed path and Base64 validation run only when attachment data is
present.

Build the Windows installer:

```powershell
npm run desktop:build -- --config '{"bundle":{"useLocalToolsDir":true}}'
```

Tauri invokes the configured frontend build before packaging the MSVC release
executable.

## Artifacts

Final validation artifacts from the frozen source state:

```text
E:\GITHUB\granite\target\host-msvc\release\granite.exe
```

- Size: 19,580,416 bytes (18.673 MiB)
- Built: 2026-11-10 13:52:46 +08:00
- SHA-256: `8AF2D0422A5350F45099D368C02A9BA4E881E16CC68EC3A4DBA3D82BF539B8FC`
- Signing status: `NotSigned`

```text
E:\GITHUB\granite\target\host-msvc\release\bundle\nsis\Granite_0.1.0_x64-setup.exe
```

- Size: 8,042,759 bytes (7.67 MiB)
- Built: 2026-11-10 13:52:46 +08:00
- SHA-256: `CFBD67A4FBAF48CEB629E04BCE0A40774B52B658C4D72600E6400F3197BA22B1`
- Signing status: `NotSigned`

Check an artifact with:

```powershell
Get-Item -LiteralPath $installer | Select-Object FullName, Length, LastWriteTime
Get-FileHash -LiteralPath $installer -Algorithm SHA256
Get-AuthenticodeSignature -LiteralPath $installer
```

Unsigned installers are expected in local validation builds and are recorded as
unsigned. If Windows code signing is configured for a release, use protected
keys or CI secrets; signing material must never be committed.

## Existing Windows run evidence

Before the final rebuild, a real current-user installation existed at:

```text
C:\Users\vexpaer\AppData\Local\Granite
```

Observed install metadata:

- HKCU uninstall entry: `Granite`, version `0.1.0`
- Installed executable: 19,272,192 bytes
- Installed executable SHA-256:
  `44B63041661E8CF33EAB69B91DE92C678261AFED5EA90FF23DAE5153E2A61AC6`
- Screenshot:
  `artifacts/screenshots/installed-granite.png`, captured 2026-11-09
  20:44:08 +08:00

The main integration session also observed the real Windows application and a
native folder picker. There is no separate log file for the final artifact or
that picker action. These observations do not prove that the final rebuilt
installer was installed.

## Release limits

- Under specification U2, real Windows/Android installation, startup, touch,
  picker, restart, and live WebDAV/S3/cross-device checks are waived for the
  user's later manual testing. They are recorded as **WAIVED**, not PASS, and do
  not block artifact delivery.
- The final rebuilt installer was not executed or installed in this native-agent
  pass. No UI, device, native CDP, or live-provider test was run.
- Publication is recorded above; no signing material is committed and no
  Android runtime verification is claimed. The Windows artifact is unsigned.
- Frontend build warnings about bundle size and static/dynamic imports are not
  native build failures. They remain visible for the owning frontend workstream.
