# Granite Test Evidence

- **Observed:** 2026-11-09, Asia/Shanghai
- **Repository:** [https://github.com/vexpaer/granite](https://github.com/vexpaer/granite)
- **Workspace revision:** no Git `HEAD` existed when the suite ran; evidence applies to the observed workspace files, not a commit.
- **Runtime:** Node.js 22.23.1, npm 10.9.8
- **Test runtime:** Vitest 3.2.7, jsdom 27.4.0, fake-indexeddb 6.2.8
- **Environment:** jsdom for store/backup tests; Node.js environment for synchronization tests; `@tauri-apps/api/core.isTauri()` isolated from the synchronization suite through a `hostCall` stub; no native call or network access

## Commands And Results

### Focused suite — PASS

```powershell
npm test -- tests/app.test.ts tests/backup.test.ts
```

Observed result: **2 test files passed, 7 tests passed, 0 failed**.

### Synchronization risk suite — PASS

```powershell
npm test -- tests/synchronization.test.ts
```

Observed result: **1 test file passed, 7 tests passed, 0 failed**.

This run exercised the actual `synchronize()` orchestration, the actual Provider adapter factory, and a replacement `provider.request` host transport backed by one in-memory WebDAV object store. It did not contact WebDAV, S3, Tauri, a credential store, or another machine.

### Repository Vitest suite — PASS

```powershell
npm test
```

Latest observed result: **6 test files passed, 34 tests passed, 0 failed**.

The repository run included:

- `packages/core/provider.test.ts`: 6 tests passed.
- `packages/core/sync.test.ts`: 12 tests passed.
- `src/reader/pdf-annotations.test.ts`: 2 tests passed.
- `tests/backup.test.ts`: 1 test passed.
- `tests/app.test.ts`: 6 tests passed.
- `tests/synchronization.test.ts`: 7 tests passed.

### Typecheck — FAIL, outside this suite

```powershell
npm run typecheck
```

The latest run did not pass in the observed concurrent workspace. It reported an unresolved `src/views/ReaderView.vue`, three `ReaderPdfPage.vue` errors where `getViewport` is read from a page ref, and one `plugin-manager.ts` error where `.catch()` is called on a `void | Promise<void>` value. The earlier test-only synchronization import/type errors were corrected by deriving `SyncAccess` from the public `synchronize()` signature; the latest typecheck reported no error in `tests/synchronization.test.ts`, `tests/app.test.ts`, or `tests/backup.test.ts`. This failure is recorded as an integration/CI gap and is not converted into passing test evidence.

## Covered Data-Loss Risks

| Evidence ID | Test | Observed assertion | Requirement mapping | Limit |
|---|---|---|---|---|
| EV-STATE-01 | `tests/app.test.ts` — restores books, progress, notes, tags, and settings after a module restart | Imported a real browser-preview text book, saved progress, tag association, a book-linked note, and settings; flushed persistence; reset modules; created and initialized a new store singleton; verified the same IndexedDB-backed state and associations. | `P-05` local writes and restart; `READ-06` location persistence; `NOTE-03` saved-note durability; `ROOT-06` stable local records. | Browser IndexedDB and store-level location only. It does not observe native SQLite, Reader rendering/viewport, abrupt process death, Windows, or Android runtime. |
| EV-DEDUPE-01 | `tests/app.test.ts` — detects duplicate content by SHA-256 before creating another book | Imported byte-identical content under different filenames and verified one book record, one success, and one duplicate result pointing at the existing book. | `LIB-01` import baseline and `LIB-03` SHA identity. | Exact byte duplicates only. It does not decide changed metadata or different-edition behavior, native file dedupe, or UI wizard behavior. |
| EV-UNLINK-01 | `tests/app.test.ts` — unlinks a root without deleting its book file or creating a tombstone | Removed the default local root and verified the book record remained, became unavailable, no tombstone appeared, and the stored source bytes were still readable through the original root handle. | `ROOT-04` unavailability safety and `ROOT-08` unlink-only semantics. | Browser-preview root only. It does not observe Windows removable media, Android SAF revocation, cloud records, another device, or UI confirmation. |
| EV-DELETE-01 | `tests/app.test.ts` — creates a book tombstone for true delete while preserving an external source file | Deleted an externally managed book, verified its annotation was removed, a book tombstone included entity ID, Hash and device ID, and the underlying source bytes remained unchanged. | `LIB-08` delete scope safety and `SYNC-08` tombstone/external-original behavior. | No Provider was configured. It does not prove cloud object deletion, cloud-record cleanup, another device receiving the tombstone, or the UI's separate external-file confirmation. |
| EV-TAG-01 | `tests/app.test.ts` — merges and deletes shared tags without deleting associated books or notes | Merged a source tag into a target for both a book and note, verified associations deduplicated to the target, deleted the target, verified associations cleared, and verified both content objects remained. | `UI-17`, `LIB-04`, and `LIB-05` tag association safety. | Store-level CRUD only. It does not cover every tag-management UI path, plugin permission denial, import/export mapping, offline synchronization, or cross-device convergence. |
| EV-LINK-01 | `tests/app.test.ts` — updates WikiLink references, including aliases and escaped titles, when renaming a note | Renamed a note containing regex-significant characters, verified direct and aliased WikiLinks changed, and verified a longer lookalike link remained untouched. | `NOTE-04` rename/backlink integrity. | Does not cover external-file renames, case-insensitive or non-English link rules not stated by the current test, full backlink indexing, or sync conflicts. |
| EV-BACKUP-01 | `tests/backup.test.ts` — restores an older note as a conflict copy without overwriting a newer local edit | Exported a real ZIP containing `granite-backup.json`, `README.txt`, and the original book file; verified exported roots and Provider settings were absent; changed the local note; imported the backup; verified the newer local body survived, the backup body became a separate conflict copy, and both survived a store restart. | `SYNC-14` backup merge/conflict behavior and `NOTE-06` note conflict safety. | This is a backup-versus-local conflict in browser preview. It does not prove live multi-device sync, CRDT/block merge policy, conflict UI, all entity types, version migration, native save dialogs, or credentials storage. |
| EV-SYNC-01 | `tests/synchronization.test.ts` — syncs one book metadata record and file between logical devices through one profile | Used the actual synchronization and Provider orchestration against one in-memory WebDAV store. Logical Device A uploaded a book record and SHA-256-addressed file; logical Device B restored the metadata, downloaded the exact bytes, and assigned a device-local root/path. Every observed Provider request carried the same configured WebDAV profile. Uploaded device documents contained neither local root paths, relative paths, Provider configuration, endpoint, nor credential ID. | Partial `SYNC-02` same-profile use and `ROOT-06` device-local path behavior. | Logical devices sharing one process and in-memory store are not physical or cross-process devices. No real WebDAV/S3 server, native transport, credential manager, UI configuration, Windows/Android runtime, or final two-device Provider gate is proven. |
| EV-SYNC-02 | `tests/synchronization.test.ts` — repeats synchronization without rewriting the shared file object | After initial convergence, three repeated synchronizations ran with existing local state. The SHA-256 object-store key set and object PUT count did not grow, each device retained one book record, and the two expected device documents remained distinct. | Partial `SYNC-06` repeat/idempotency behavior. | The in-memory transport has no network delay, retry policy, lost response, process restart, conditional-write race, or hostile concurrent server; this does not establish full retryable/resumable/cancellable synchronization. |
| EV-SYNC-03 | `tests/synchronization.test.ts` — preserves both independently edited notes as a primary and a conflict copy | Two logical devices made different updates to one note. The later update remained primary, the other body became a linked conflict copy, and repeated synchronization did not duplicate the copy or conflict record. | Partial `NOTE-06` and `SYNC-07` note-conflict behavior. | Deterministic synthetic timestamps and one revision pattern are used. Does not prove block/CRDT merge, all offline clocks, conflict resolution UX, attachment conflicts, or physical-device operation. |
| EV-SYNC-04 | `tests/synchronization.test.ts` — prevents deleted books from resurrecting, removes an orphan hash object, and keeps a duplicate live hash object | A logical device deleted one unique book and one of two books sharing the same SHA-256 while a stale device edited those records. The tombstones won, both records stayed deleted, the unique orphan object was removed, and the shared hash object remained because a live book still referenced it. | Partial `SYNC-07` tombstones and `SYNC-08` cloud-object cleanup semantics. | Tombstones and revisions are test fixtures. Does not exercise the product Delete UI, external-original confirmation, a real Provider's delete failures/eventual consistency, another physical device, or interruption between tombstone publication and object deletion. |
| EV-SYNC-05 | `tests/synchronization.test.ts` — applies metadata, full, selected, and on-demand book-file policies | Through actual orchestration, `metadata` uploaded no book objects for two books; `full` and `on-demand` uploaded both available files; `selected` uploaded only the chosen book. A fresh on-demand logical device restored unavailable book records without automatically downloading their files. | Partial `SYNC-04` strategy behavior. | Uses one small deterministic fixture per policy. Does not prove policy switching, downloaded/cache-only transitions, insufficient space, damaged remote files, UI state, or real Provider behavior. |

## Harness Details

- Store and backup tests use the actual `useApp()` singleton and `hostCall` browser-preview paths; only the Tauri detection is mocked to ensure native code is not invoked.
- Synchronization tests replace only the native `provider.request` boundary. They call the actual `synchronize()` orchestration and `createProvider()` adapter against an in-memory WebDAV model that implements the exercised MKCOL, PUT, HEAD, GET, DELETE, and PROPFIND responses.
- Synchronization tests use the local key `Granite/` and logical Provider Profile metadata. The Provider endpoint uses the reserved `.invalid` domain, and no credential is sent because the transport is local.
- Two logical devices are represented by separate `AppData` objects, revisions, paths, and `SyncAccess` adapters. They are not emulated operating-system devices and no Windows or Android application lifecycle is exercised.
- `vi.resetModules()` is used to construct a fresh store singleton after writes. The fake IndexedDB database remains available for restart assertions.
- The database is cleared before and after each test.
- IndexedDB byte results are normalized with `Array.from` because their typed arrays cross jsdom/fake-indexeddb realms.
- Downloaded jsdom `Blob` data is read with `FileReader`; those `Blob` instances do not provide `.arrayBuffer()` in the configured environment.
- Tests import application modules by repository-relative specifiers and do not depend on absolute `E:/` paths or machine-specific directories.

## What This Evidence Does Not Prove

- No real-device Windows or Android runtime test was performed.
- Android physical verification remains `WAIVED` by the user on 2026-11-09; this document neither claims nor implies device observation.
- No GitHub Actions workflow result, APK artifact, signing result, or release asset was observed.
- No real S3-compatible or WebDAV Provider was configured.
- The synchronization suite uses in-memory logical devices. No physical, cross-process, or real cross-device transfer was observed.
- No native credential system, Windows Credential Manager, Android Keystore, credential decryption, TLS, or secret-redaction behavior was observed.
- No real cloud deletion, Provider authentication failure, offline/reconnect, retry, rate limit, conditional write, ETag conflict, cancellation, resumability, corruption detection, Android SAF, or lifecycle behavior was observed.
- No sync UI, policy-switch workflow, conflict-resolution screen, progress/error presentation, or real-device credential setup was observed.
- A passing browser-preview test does not close broader acceptance rows whose remaining bullets require native integration, visual review, Provider behavior, or device evidence.
