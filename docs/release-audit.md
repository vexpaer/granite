# Granite release audit

**2026-11-11 U3:** future verification/builds are GitHub-only and minimal. GitHub-incompatible tests are waived, with no local or manual follow-up requirement. Results below retain the historical v0.1.0 evidence. Current process: [ci.md](ci.md).

Updated 2026-11-10 (Asia/Shanghai). The authoritative specification and user update U2 in [task-overrides.md](task-overrides.md) define this delivery.

## Current delivery gates

| Gate | Observed state |
| --- | --- |
| TypeScript, unit/integration tests, frontend build | Passed: `npm run check`, 21 files / 130 tests, production build. |
| Complete browser flow set | Passed: 8/8. Four formats render/search/bookmark; reading positions and bookmarks survive reload; notes persist; navigation context restores; isolated plugins install/run/revoke/uninstall; PDF annotations safely write and export. |
| Independent PDF inspection | Passed: MuPDF/PyMuPDF reads Highlight, Underline, Text and Ink as editable standard annotations. |
| Native Windows host | MSVC checks and 48 tests passed, including metadata-only external attachment preservation. |
| Android bridge | Kotlin 16 tests, `assembleDebug` and aarch64 Rust check passed. |
| Latest Windows installer | Final unsigned NSIS built: 8,042,759 bytes; version 0.1.0; SHA-256 `cfbd67a4fbaf48ceb629e04bce0a40774b52b658c4d72600e6400f3197ba22b1`. |
| Latest Android CI Debug APK | Passed run [42765264307](https://github.com/vexpaer/granite/actions/runs/42765264307), source `e8070f1`. Downloaded artifact `13739732389` matches its checksum; package and signature verified. |
| Signed APK and tagged release | Passed: [42766136682](https://github.com/vexpaer/granite/actions/runs/42766136682), tag `v0.1.0`, source `e8070f1`. Downloaded Release APK is 22,971,439 bytes; SHA-256 `3ed49d4761613ca9b3b588798cf29f0f7dfcf80687dd5d43918de2940197499d`; release signature, ARM64 ABI, package/version, API levels and manifest verified. |
| Published delivery | [v0.1.0](https://github.com/vexpaer/granite/releases/tag/v0.1.0) contains both platform packages and aggregate `SHA256SUMS`. Windows installer remains unsigned; Android uses the project release key. |
| Windows / Android real-device application checks | USER MANUAL / NOT VERIFIED — deferred by U2; not a delivery gate. |
| Live cloud authentication, upload/download and cross-device checks | USER MANUAL / NOT VERIFIED — deferred by U2; no credentials requested and no live service test performed. |

The revised first-release delivery gates are complete. User-manual items remain unverified and must never be relabeled as passed automated checks. The release tag retains the tested application source; follow-up documentation commits only record its evidence.

## Resolved implementation findings

- Native PDF uses a 64 KiB initial range and requests bounded ranges as needed. Other native file reads cross the bridge in at most 4 MiB messages.
- Windows position, size and maximized state use the native window-state plugin.
- Backups include a separate non-sensitive `provider-profile.json`; restoring it requires explicit review and fresh directory authorization or credentials. Existing active credentials are preserved.
- Newly added Notebook attachments use verified content-addressed files relative to the Markdown file. Standalone export and full backup include the actual attachment bytes.
- PDF writes verify the expected source SHA-256 before replacement, preserving externally modified originals on conflict.
- Reader reload routing, PDF location persistence and reactive-session analytics failures are fixed and covered by the browser restoration flow.

## Recorded limits

- EPUB, TXT and MOBI parsers still require complete decoded input buffers. Operations that require a complete file buffer are limited to 512 MiB; native PDF viewing can use ranges, while PDF annotation editing still requires a complete buffer. This is a documented memory limit, not a claim of unlimited-size parsing.
- A signed Android APK proves package/signature integrity and successful compilation, not actual device behavior.
- Logical-device WebDAV tests exercise the real synchronization orchestration with a test transport. They do not prove live cloud behavior.
- Real installation, window restoration, platform input/lifecycle and live cloud behavior remain on the user's post-delivery manual checklist under U2.

Commands and artifact identities are recorded in [test-evidence.md](test-evidence.md), [windows-build.md](windows-build.md) and [android/ci.md](android/ci.md).
