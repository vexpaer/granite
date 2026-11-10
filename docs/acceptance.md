# Granite first-release acceptance

Updated 2026-11-10 (Asia/Shanghai). Authority: [Granite 规格书](../granite%20规格书/Granite%20规格书.md), including its current user correction, and [U2](task-overrides.md).

The user will perform all real-device and real-cloud checks after delivery. They are not current release gates and must be recorded as **USER MANUAL / NOT VERIFIED**, never as passed. Android emulators and virtual devices remain prohibited. Functional implementation, local automated tests, native compilation, CI builds, signing and artifact verification remain required.

| Criterion | State and evidence |
| --- | --- |
| Core implementation and frontend checks | `npm run check` passed: 130 tests in 21 files, typecheck and production build. Covers library identity/unlink/deletion safety, backup recovery, tags, notebook assets, providers, sync, plugin boundaries, geometry and formats. |
| Main browser workflows | 8/8 passed, including four-format import/read/search, saved positions and bookmarks after reload, notes, navigation state, sandboxed plugin lifecycle and PDF standard annotation export. |
| Windows native host | 48 tests and MSVC checks passed, including metadata-only external attachment preservation. Android aarch64 compilation also passed. |
| Android native bridge | Kotlin 16/16 tests, Debug assembly and Android aarch64 Rust compilation passed. |
| Windows deliverable | Final unsigned NSIS installer built: 8,042,759 bytes, SHA-256 `cfbd67a4fbaf48ceb629e04bce0a40774b52b658c4d72600e6400f3197ba22b1`. Product/file version is 0.1.0. No installation/runtime claim is made. |
| Android CI deliverable | Earlier Debug CI [42644227600](https://github.com/vexpaer/granite/actions/runs/42644227600) passed; integrated Debug and signed release artifacts are pending. |
| Data safety, startup and reading | Known faults must be fixed before publication. See [release audit](release-audit.md) for resolved findings and remaining build gates. |
| Windows and Android actual-device application behavior | USER MANUAL / NOT VERIFIED under U2. Includes installation, reading, restart, window/input/lifecycle behavior and platform directory access. |
| Real S3/WebDAV and another-device synchronization | USER MANUAL / NOT VERIFIED under U2. Local test transports do not substitute for this user check. |

The first release is complete for this revised scope once final native/CI builds, artifact inspection and GitHub publication are recorded. The user's manual checklist is specification section 10-A.6. Test commands and the distinction between old artifacts and the final candidate are in [test-evidence.md](test-evidence.md).
