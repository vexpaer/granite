# Granite release audit

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
| Latest Android CI Debug APK | Pending integrated-source push. Earlier run [42644227600](https://github.com/vexpaer/granite/actions/runs/42644227600) passed and its downloaded artifact was verified; it covers commit `4203e6d`, not the latest local changes. |
| Signed APK and tagged release | Pending the integrated candidate. Signing material stays outside Git; CI verifies the APK before publication. |
| Windows / Android real-device application checks | USER MANUAL / NOT VERIFIED — deferred by U2; not a delivery gate. |
| Live cloud authentication, upload/download and cross-device checks | USER MANUAL / NOT VERIFIED — deferred by U2; no credentials requested and no live service test performed. |

There is no current first-release completion claim until the remaining builds, artifact checks and publication finish. User-manual items must never be relabeled as passed automated checks.

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
