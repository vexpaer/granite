# Granite first-release acceptance

Updated 2026-11-11 (Asia/Shanghai). Authority: [Granite 规格书](../granite%20规格书/Granite%20规格书.md) and current user correction [U3](task-overrides.md).

All future installation, builds and minimal tests run only in GitHub-hosted Actions, as described in [ci.md](ci.md). Tests GitHub cannot perform are **WAIVED / NOT VERIFIED**, with no local/manual follow-up requirement. No browser/device/live-cloud matrix is required. Historical local and browser results below remain evidence of v0.1.0 only, not future execution requirements. Emulators remain prohibited; known data-safety, startup or core-reading faults still block publication.

## Historical v0.1.0 delivery evidence

| Criterion | State and evidence |
| --- | --- |
| Core implementation and frontend checks | `npm run check` passed: 130 tests in 21 files, typecheck and production build. Covers library identity/unlink/deletion safety, backup recovery, tags, notebook assets, providers, sync, plugin boundaries, geometry and formats. |
| Main browser workflows | 8/8 passed, including four-format import/read/search, saved positions and bookmarks after reload, notes, navigation state, sandboxed plugin lifecycle and PDF standard annotation export. |
| Windows native host | 48 tests and MSVC checks passed, including metadata-only external attachment preservation. Android aarch64 compilation also passed. |
| Android native bridge | Kotlin 16/16 tests, Debug assembly and Android aarch64 Rust compilation passed. |
| Windows deliverable | Final unsigned NSIS installer built: 8,042,759 bytes, SHA-256 `cfbd67a4fbaf48ceb629e04bce0a40774b52b658c4d72600e6400f3197ba22b1`. Product/file version is 0.1.0. No installation/runtime claim is made. |
| Android CI deliverable | Integrated Debug CI [42765264307](https://github.com/vexpaer/granite/actions/runs/42765264307) and signed Release CI [42766136682](https://github.com/vexpaer/granite/actions/runs/42766136682) passed for source `e8070f1`. Downloaded Debug and Release APKs match their checksums; package, ARM64 ABI, manifest and signatures verified. |
| GitHub publication | [v0.1.0](https://github.com/vexpaer/granite/releases/tag/v0.1.0) published with the Windows installer, signed Android APK and aggregate `SHA256SUMS`. Release APK: 22,971,439 bytes, SHA-256 `3ed49d4761613ca9b3b588798cf29f0f7dfcf80687dd5d43918de2940197499d`. |
| Data safety, startup and reading | Known faults must be fixed before publication. See [release audit](release-audit.md) for resolved findings and remaining build gates. |
| Windows and Android actual-device application behavior | WAIVED / NOT VERIFIED under U3; no required manual follow-up. Includes installation, reading, restart, window/input/lifecycle behavior and platform directory access. |
| Real S3/WebDAV and another-device synchronization | WAIVED / NOT VERIFIED under U3; no required manual follow-up. Local test transports do not prove live cloud behavior. |

The first release was delivered with the recorded automated/native/CI checks, artifact inspection and GitHub publication. U3 removes the old required manual checklist; it remains historical reference only. Test commands and the distinction between historical and final artifacts are in [test-evidence.md](test-evidence.md). Delivery does not claim the waived checks passed.

## Implementation and evidence index

This index maps the specification's first-release areas to the shipped sources and relevant automated evidence. A test covers its assertions, not every platform behavior in the linked area. All native application interactions and live-service checks remain user-manual under U2.

| Specification area | Implementation | Automated evidence |
| --- | --- | --- |
| 10-A.1 shell, navigation and shared components | `src/App.vue`, `src/components/`, `src/services/view-state.ts`; [page contracts](pages.md) | `tests/e2e/navigation-state.spec.ts`, `tests/e2e/product.spec.ts` |
| 10-A.2.1 Home | `src/views/HomeView.vue`, `src/components/homeLayout.ts` | `tests/app.test.ts`, `tests/e2e/product.spec.ts` |
| 10-A.2.2–3 library and details | `LibraryView.vue`, `BookDetailView.vue`, `src/stores/app.ts` | `tests/app.test.ts`, `src/stores/app.test.ts`, `tests/e2e/navigation-state.spec.ts` |
| 3-A multiple roots, safe unlink and migration | `SettingsView.vue`, `src/services/host.ts`, `src-tauri/src/filesystem.rs`, Android bridge | `tests/app.test.ts`, native Rust tests, Kotlin book-safety tests |
| 10-A.2.4 / Reader A–F, H; 6-A input | `ReaderView.vue`, `src/reader/`, `Reader*` components | Four-format fixtures, native-range and PDF-geometry tests; `tests/e2e/formats.spec.ts`, `restore.spec.ts` |
| PDF standard annotations and direct writeback | `src/reader/pdf-annotations.ts`, `src-tauri/src/filesystem.rs`, Android bridge | PDF annotation unit tests, `tests/e2e/pdf-annotations.spec.ts`, MuPDF readback, Rust/Kotlin write-precondition tests |
| 10-A.2.5 / 8 Notebook | `NotebookView.vue`, `packages/core/markdown.ts`, `src/services/notebook-files.ts`, native mirrors | `markdown.test.ts`, `tests/notebook-files.test.ts`, `tests/backup.test.ts`, product browser flow, native attachment tests |
| 10-A.2.6 / 9 statistics | `StatisticsView.vue`, `packages/core/analytics.ts`, session tracking in store/Reader | `packages/core/analytics.test.ts`, reading/restore browser flows |
| 10-A.2.7 global search | `SearchView.vue`, store search API and plugin search service | `tests/app.test.ts`, `tests/e2e/navigation-state.spec.ts` |
| 10-A.2.8 import wizard | `ImportView.vue`, `src/services/metadata.ts`, native/Android import paths | App deduplication/safety tests, four-format browser import flow; native sharing remains user-manual |
| 10-A.2.9 settings, profiles and portable backup | `SettingsView.vue`, `src/services/provider-backup.ts`, store backup APIs | `tests/app.test.ts`, `backup.test.ts`, `provider-backup.test.ts` |
| 10-A.2.10 / 10–11 providers and synchronization | `SyncView.vue`, `packages/core/provider.ts`, `sync-engine.ts`, `src/services/synchronization.ts`, `object-transfer.ts` | Provider/local-provider/sync-engine tests, `tests/synchronization.test.ts`, `object-transfer.test.ts`; live cloud remains unverified |
| 10-A.2.11 / 4, 13 plugins | `PluginsView.vue`, `packages/core/plugins.ts`, `src/services/plugin-manager.ts`, `plugin-registry.ts` | Core/manager/registry tests, `tests/e2e/plugins.spec.ts` under the packaged CSP |
| 10-A.2.12 shared tags | `TagsView.vue`, `TagResultsView.vue`, store tag APIs | App merge/delete/association tests; notebook-file tests |
| 10-A.2.13 profile and diagnostics | `MeView.vue`, `DiagnosticsView.vue`, `AppAvatarMenu.vue`, `src/services/platform.ts` | Typecheck and native runtime-info compilation; menus exercised by browser navigation; native interaction remains user-manual |
| 10-A.2.14 conflicts and recovery | `ConflictsView.vue`, sync merge and backup restore paths | Core sync tests, `tests/backup.test.ts`, `synchronization.test.ts`, native file-safety tests |
| 12 private SQLite and credentials | `src-tauri/src/database.rs`, `credentials.rs`, Android Keystore bridge | Rust database/migration and compile checks; live credential use remains user-manual |
| 14 Windows/Android deliverables | `.github/workflows/android.yml`, `scripts/desktop.mjs`, `scripts/android.mjs` | Windows build record, CI runs and downloaded artifact/signature/checksum inspection |

The earlier detailed criterion IDs referenced by the architecture notes are retained in the [historical ledger](https://github.com/vexpaer/granite/blob/4203e6d2e4886d58edd1ca192c626b7758d37894/docs/acceptance.md). Its old test counts and device/cloud gate states are historical and superseded by this record and U2.
