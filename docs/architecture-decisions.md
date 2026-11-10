# Granite Architecture Decisions

- **Baseline:** 2026-11-09
- **Authoritative source:** [`granite 规格书/Granite 规格书.md`](../granite%20规格书/Granite%20规格书.md)
- **Repository:** [https://github.com/vexpaer/granite](https://github.com/vexpaer/granite)

**U2 — User correction, 2026-11-10:** all Windows/Android real-device application checks and live-cloud/cross-device checks are assigned to the user after delivery. They are not current release prerequisites and must remain labeled user-manual/not-verified. Functional implementation, automated tests, native/CI builds, signing and artifact checks still apply. U2 supersedes the older evidence-gate statements below; historical source line numbers and acceptance IDs refer to the original specification snapshot.

**U1 — User correction, 2026-11-09:** physical Android-device installation and runtime verification was waived for this implementation. Android CI Debug/Release APK build and artifact/release verification remain required. Android emulator, simulator, and virtual-device testing remain prohibited.

This document separates product decisions that are explicitly approved from implementation ideas that the specification merely recommends. It is intentionally stricter than a normal design note: a plausible implementation detail is not recorded as approved unless the source says so.

Status terms used below:

- **Confirmed:** explicitly marked **[确定]**, explicitly listed under “已确认”, or stated as a user-confirmed visual direction.
- **Binding constraint:** normative “must/不得/不能” behavior that limits implementation even when the source did not label the paragraph **[确定]**. This is an acceptance constraint, not proof that every implementation mechanism is approved.
- **Proposal:** marked **[建议]**; an implementation may select it within the user's autonomous development scope.
- **Pending:** marked **[待定]** or absent from the specification.

## Confirmed And Binding Architecture

### AD-001 — Product And Platform Boundary

**Status: Confirmed**

Granite is the formal project name. The first release targets Windows desktop and Android only. Linux and a web reader are outside first-release support, test, and publication scope. Local reading must work without an account, subscription, Granite cloud, or mandatory self-hosted service. The main project is AGPL-3.0, while every plugin declares its own license and distribution compatibility is reviewed.

Consequences:

- Windows and Android share domain models, business logic, plugin SDK, and core experience, while platform navigation and native capabilities remain platform-specific.
- Local-first behavior covers reading, library edits, progress, annotations, and notes. Synchronization is a recovery/convergence layer, not a prerequisite for local use.
- Open data export is a product architecture requirement, not a post-release utility.

Source: `L5, L11-18, L22, L1039, L1099-1101`.

Acceptance: `P-01` through `P-08`, `ARC-04`.

### AD-002 — Cross-Platform Runtime And Layer Boundaries

**Status: Confirmed for Tauri 2, Rust Host, Vue 3, TypeScript, and Cordis**

The confirmed runtime stack is:

```text
Platform Host: Tauri 2 + Rust
UI Shell: Vue 3 + TypeScript
Plugin runtime: Cordis
Platform WebViews: WebView2 on Windows, Android System WebView on Android
```

The specification defines these layers:

1. Platform Host for files, SQLite or another local data store, HTTP, credentials, notifications, native pickers, and Android lifecycle.
2. Domain Core for stable book, library, annotation, progress, reader-location, search, import, and export contracts.
3. UI Shell for pages, reader UI, settings, plugin slots, layout, and themes.
4. Cordis runtime for context, services, dependency injection, events, lifecycle, and scopes.
5. Plugin SDK and loader for manifests, permissions, dependencies, installation, activation, removal, compatibility, and UI contributions.
6. Storage Provider abstraction for S3-compatible, WebDAV, and local filesystem, with future cloud connectors as plugins.
7. Sync Engine for the offline queue, device/sync documents, incremental exchange, merging, conflicts, and tombstones.
8. Official and third-party plugins.

Binding dependency direction:

- UI accesses data only through Domain or Host APIs.
- Plugins access services through Context.
- Sync depends on the Provider contract rather than a specific cloud service.
- Rust does not depend on Vue components.
- Plugins do not import another plugin's private implementation.
- Public APIs, event schemas, models, manifests, and synchronization contracts have one authoritative, versioned definition.

The product must not require Electron, a resident Node.js runtime, Redis, PostgreSQL, or Docker. Large books are streamed and loaded on demand; plugin loading is lazy; scroll/location events are throttled; indexing and sync are cancellable.

Source: `L13, L22-47, L1086`.

Acceptance: `ARC-01` through `ARC-04`, `P-06`, `SYNC-13`.

### AD-003 — Native Platform Boundary

**Status: Confirmed for the platform capabilities; specific minimum OS versions remain pending**

Windows owns native folder selection, drag/drop, file selection, keyboard shortcuts, window-state persistence, Credential Manager access, mouse, and touchpad integration.

Android owns Storage Access Framework access, persistent tree grants, system share import, Keystore, touch, system Back, lifecycle and process recreation, and background restrictions. Android must not assume Node.js, arbitrary POSIX paths, or unlimited background execution.

The shared `LibraryRootService`/`FileHandle` abstraction is the boundary for platform file access. Plugins receive authorized book handles or restricted storage APIs, never unconstrained root-directory access.

Source: `L41-47, L68-73`.

Acceptance: `WIN-01` through `WIN-09`, `AND-01` through `AND-17` with A-gate physical-runtime rows marked `WAIVED` by U1, and `ROOT-01` through `ROOT-11`.

### AD-004 — Local Library Root Model

**Status: Confirmed**

Both Windows and Android expose **Settings → Library → Local Library Folder** throughout the product lifetime. Users can choose an existing directory, view it, change it, and reauthorize it. Each device may configure multiple independent roots, and all roots aggregate into one Library.

The logical model separates:

- A device-local root record with stable `libraryRootId`, path or SAF URI, display name, permission state, scan state, default-import marker, optional read-only marker.
- A device-independent book identity using stable `bookId`, SHA-256 content hash, and a local relative reference.
- A cloud Provider Profile, which is independent of local-root configuration.

Paths and SAF URIs are device-local and must never overwrite another device's configuration. Root removal means unlink, not deletion. Root unavailability must not create deletion tombstones. Moving between roots requires explicit copy/move and validation. Temporary unavailability and confirmed deletion are separate states.

Active transactional data, including SQLite if SQLite is chosen, must remain in reliable app-private storage on Android and cannot be opened directly on an SAF document URI. A migration must validate the destination before deleting a source, and failed migration retains the source.

Source: `L49-81`.

Acceptance: `ROOT-01` through `ROOT-11`; Android physical-runtime evidence for `AND-04` is waived by U1, while `AND-07` retains its implementation gate.

### AD-005 — Core Independence From Plugins And Cloud

**Status: Confirmed**

Core routes and required capabilities remain accessible without plugins. A missing, disabled, crashing, or not-installed plugin must not break Library, Reader, Notebook, Statistics, Settings, annotations, navigation, or other plugins. Cloud failure must not block local reading or roll back a committed local write.

Reader features explicitly required without plugins include TOC, search, bookmarks, annotation handling, appearance, progress persistence, immersion, and standard input handling. Plugins may extend behavior but cannot block system Back, accessibility, PDF zoom, page turn, text selection, or other protected core actions.

Source: `L15-18, L128-130, L155, L490-496, L754, L773, L887-893`.

Acceptance: `ARC-04`, `PLUG-09`, `PLUG-11`, `READ-18`.

### AD-006 — Plugin Platform

**Status: Confirmed for Cordis, install sources, full-page extension, permissions, and isolation controls; loader/SDK mechanics include unresolved choices**

Cordis is the plugin architecture base and supplies Context, Service, Events, Dependency Injection, Reversible Effects, Lifecycle, and Scoped Context. Cordis is explicitly not a security sandbox.

The loader discovers plugins through Rust/Tauri file interfaces, parses and validates manifests, checks dependency cycles, permission/API/platform compatibility, reads prebuilt ESM bundles, and activates through Cordis. Stopping a plugin must reverse all registrations.

The manifest minimum is:

```text
id, name, version, apiVersion, main,
dependencies, optionalDependencies, permissions, contributes,
platforms, schemaVersion, author, license, repository, integrity
```

Confirmed install sources are the official catalog, third-party registry/Git/release/URL, and local packages. Installation shows source, author, version, integrity/signature state, API compatibility, license, and permissions before confirmation.

Confirmed permission categories are at least:

```text
reader.observe, reader.control,
library.read, library.write,
bookfile.read, bookfile.write,
annotation.read, annotation.write,
network.request (target restricted),
storage.namespace, sync.namespace,
ui.register, notification, credential.use
```

Trusted or explicitly authorized plugins may render full Vue extension pages. Untrusted code defaults to Worker/iframe or an equivalent controlled runtime and calls permission-checked Host APIs over RPC. Neither mode may bypass Tauri capabilities, Host permissions, or file boundaries. Plaintext credentials are never exposed to plugins. Disable/uninstall preserves plugin data by default.

Official and third-party plugins use the same public SDK and are allowed to provide services to other plugins without directly accessing another plugin's private database.

Source: `L91-117, L1097`.

Acceptance: `PLUG-01` through `PLUG-11`.

### AD-007 — UI Shell, Navigation, And Design System

**Status: Confirmed**

Windows uses four primary routes in this order:

1. `home`
2. `library`, with fixed All, Reading, Unread, Read, Favorites children
3. `notebook`
4. `statistics`

Settings, sync, account/profile, plugin center, and diagnostics use the bottom-left avatar menu rather than primary navigation.

Android phone portrait uses five fixed bottom destinations:

1. Home
2. Library
3. Notebook
4. Statistics
5. Me

Android landscape uses a five-destination left Navigation Rail. Tablet/large layouts use a rail or expandable Navigation Drawer according to available window size. Layout decisions use window size classes, not device model or orientation alone. Rotation, split screen, and resizing preserve routes, per-destination back stacks, scroll, filters, search, selected items, and unsaved edits.

Core routes have stable IDs. Plugin routes use `plugin:<plugin-id>/<route-id>` and cannot occupy Core route IDs. Plugin destinations do not automatically displace Core navigation.

Reeden is the primary product and visual reference. Material Design 3 and M3 Expressive are explicitly not the design-system basis. Granite uses its own semantic tokens and controlled extension points for themes, layout, slots, and components. Minimalism means information restraint while preserving readable metadata, status, recovery, permission, and accessibility information.

Source: `L119-171, L469-528, L895-956, L517, L524, L899-900`.

Acceptance: `UI-01` through `UI-22`, `AND-02`, `AND-09`, `WIN-05`; the physical-runtime portions of `AND-02` and `AND-09` are waived by U1.

### AD-008 — Reader Core And PDF Write-Back

**Status: Confirmed**

EPUB, PDF, TXT, and MOBI are Core formats in the first release. AZW3 and CBZ/CBR are extension formats, not first-release Core requirements.

Reader behavior has one navigation/input contract and a format-neutral `ReaderLocation`, with format-specific fields such as EPUB CFI or PDF page/coordinate. Locations, viewport, zoom, annotations, per-book settings, and search state must survive reopening, platform lifecycle changes, and synchronization.

PDF uses a continuously ordered, vertically arranged two-dimensional canvas with free X/Y pan, continuous center-anchored pinch zoom, Fit Width initial zoom, capped overscroll and rebound, lazy page rendering, and system Back priority. It must not use left/right page-swipe semantics as its default Android PDF canvas model.

PDF annotations are directly written into the PDF as standard comments after user save. The supported minimum is highlight, underline, text comment, and ink. The write must preserve editability when practical rather than flattening by default, create a recoverable backup, validate the output, update content Hash and sync queue, and recover from interruption, low disk space, read-only files, and synchronization conflicts.

Source: `L726-833, L839-893, L1092-1093`.

Acceptance: `READ-01` through `READ-19`.

### AD-009 — Notebook Data Model

**Status: Confirmed for Markdown/open files and required behavior; conflict algorithm remains open**

Notebook uses an Obsidian-style open file structure. Ordinary Markdown files are the source of truth; folders, WikiLinks, backlinks, tags, templates, attachments, book links, quoted text, and `ReaderLocation` are supported. A proprietary block database is not the mandatory editing model.

SQLite or another index may store rebuildable search/backlink/reference metadata, but it must not replace the Markdown files as the portable source of truth. Attachments use portable relative paths. Notes work without an open book, offline editing works, and whole-note last-writer-wins is prohibited.

Source: `L972-976`.

Acceptance: `NOTE-01` through `NOTE-06`.

### AD-010 — Tags, Events, Reading Time, And Statistics

**Status: Confirmations and binding contracts**

- Tags are Core data, not plugin-owned data. `tagId` is stable across renaming, relations are many-to-many across books and notes, and merging/removing tags preserves books/notes. Tags and relations synchronize as metadata.
- Events use `domain.action`, typed/versioned payloads, entity IDs, and plugin-lifecycle ownership. Large book binaries do not travel in event payloads. High-frequency runtime events are not persisted wholesale.
- Reading Tracker records `sessionId`, `deviceId`, `bookId`, start/end times, effective duration, start/end location, and pause reason.
- Opening a book does not automatically count as reading. Background, lock screen, and excessive inactivity pause timing. Android uses monotonic time plus lifecycle events.
- Analytics derives summaries from raw sessions and deduplicates cross-device sessions by unique ID.

Source: `L732-746, L958-982`.

Acceptance: `LIB-04` through `LIB-07`, `ARC-05`, `STAT-01` through `STAT-05`.

### AD-011 — Storage Providers And Cloud Binding

**Status: Confirmed**

First-release Provider types are:

- S3-compatible: configurable endpoint, region, bucket, authentication, and path.
- WebDAV: custom address and application password.
- Local Filesystem: local library roots selectable on Windows and Android.

Google Drive and OneDrive are not first-release requirements. They are future Provider plugins using official APIs. The absence of an official account or Granite application server remains confirmed.

Book files and synchronization metadata must use one user-selected Cloud Provider Profile, endpoint, account, and credentials. The UI and APIs must make mixed-provider configurations impossible. Provider contracts expose list, read, write, delete, metadata, conditional write, range read, capability detection, retry, cancellation, and classified errors. The Sync Engine cannot bypass the abstraction.

Provider contracts must detect ETag, lock, and MOVE capability differences and degrade explicitly. Custom application-level E2EE and recovery keys are not required.

Source: `L984-996, L984, L1094-1096`.

Acceptance: `SYNC-01` through `SYNC-14`.

### AD-012 — Local-First Synchronization Obligations

**Status: Binding behavior; transport document design is not yet approved**

The following behavior is fixed even though the collaboration protocol is proposal-only:

- Commit local SQLite/file state first, then enqueue remote work.
- A remote failure does not roll back local commits.
- Sync is idempotent, retryable, cancellable, offline-recoverable, resumable, chunked, hash-validated, and safe when remote content is damaged.
- Supported strategies are full files, metadata only, selected collections/books, and metadata-first/on-demand download. Switching strategies cannot erase cloud objects or turn “not downloaded” into “deleted”.
- Reading progress, tags, bookmarks, annotations, sessions, settings, and notes require entity-specific convergence. Wall-clock time alone is not trusted for identity or deletion.
- A managed book deletion removes its cloud object/record and propagates a tombstone. A user-managed external original requires separate confirmation before physical deletion.
- Removing a local root is unlink-only. Temporary root/permission loss is not deletion.
- Unknown plugin data is retained.
- Multiple devices never directly share a SQLite database file.

Source: `L998-1023, L1094, L1100`.

Acceptance: `SYNC-03` through `SYNC-10`.

### AD-013 — Persistence, Credentials, And Portability

**Status: Confirmed for security boundaries and portability; choosing SQLite as the sole store is not confirmed**

The specification says local structured metadata is stored in SQLite, but the architectural selection is introduced as **[建议]**. Treat SQLite as the current proposed implementation while preserving these confirmed/binding rules:

- No active database on an arbitrary SAF Document URI.
- No direct SQLite-file synchronization between devices.
- Databases and plugin schemas are versioned; failed migrations retain a recoverable backup.
- Plugins cannot execute arbitrary SQL.
- High-frequency reading-location writes are throttled.
- S3 secrets, WebDAV passwords, and OAuth tokens are not placed in ordinary JSON or logs.
- Windows uses Credential Manager; Android uses Keystore.
- Network transport uses TLS and diagnostics redact secrets/private content.
- Complete export includes original books, metadata, library structure, reading locations, annotations, notes, sessions, plugin data, Profiles, and layouts.
- Credentials are excluded from default export.

Source: `L24, L628, L1025-1031, L1039`.

Acceptance: `SYNC-11` through `SYNC-14`.

### AD-014 — Android Physical-Verification Override

**Status: Confirmed user correction dated 2026-11-09; supersedes the specification's physical Android acceptance instruction**

Android physical-device installation, launch, runtime, and physical visual verification are not release blockers for this implementation. No Android device evidence is requested. An emulator, simulator, or virtual device remains prohibited and cannot be used to fill the waived gate.

The following remain active:

- GitHub Actions basic checks and unit tests.
- Debug APK build and artifact upload.
- Tagged signed Release APK build and GitHub Releases publication, subject to repository secrets and workflow implementation.
- APK download, checksum, metadata, and signature inspection.
- Underlying Android implementation and automated contract/integration checks that do not require a device.

Repository: [https://github.com/vexpaer/granite](https://github.com/vexpaer/granite).

Acceptance: `AND-01` through `AND-17`, `CI-01` through `CI-03`, and the Android-specific portions of `FINAL-*` are interpreted through U1.

## Not First-Release Architecture Requirements

These are excluded from the Core release gate:

- Linux client and web reader.
- Google Drive and OneDrive connectors.
- Built-in AZW3 or CBZ/CBR readers.
- Knowledge graph inside the mandatory Notebook core; it is an optional UI plugin.
- Core OPDS, Calibre, or KOReader integration; all three are optional plugins.
- Google Play publication and AAB generation.
- Mandatory application-level E2EE or custom recovery-key infrastructure.

Source: `L5, L593, L728, L994, L1037, L1054, L1092, L1096-1098`.

## Implementation Choices

The specification proposes these mechanisms without fixing every implementation detail. The user's autonomous development instruction authorizes routine architecture choices. The implementation uses private SQLite, a versioned Granite SDK around Cordis, per-device sync documents, note conflict copies, PDF.js with standard PDF annotation writing, and isolated iframe/Worker plugins. These choices do not require another approval step; only a change to a confirmed product requirement needs a new user decision.

| ID | Proposal | Why it is not yet a decision | Source |
|---|---|---|---|
| OD-01 | Use SQLite for local structured data. | Architecture text labels it **[建议]**. The synchronization and SAF sections constrain SQLite if used but do not prove it is the only approved store. | L24, L72, L1027 |
| OD-02 | Wrap Cordis in a stable Granite Plugin SDK. | The wrapper and stable public API are marked **[建议]**; Cordis itself is the confirmed base. | L95 |
| OD-03 | Suggested Context service surface: reader, library, annotations, events, storage, sync, UI, commands, settings, scheduler, notifications, permissions, logger. | The service list is explicitly “建议服务”; names/signatures are not approved contracts. | L99-111 |
| OD-04 | Per-device synchronization documents plus `Granite/sync/...` remote layout. | The section is marked **[建议]**. The required behavior in AD-012 can be implemented another way. | L998-1015 |
| OD-05 | Specific note merge implementation: Yjs CRDT, block-level merge, or conflict copies. | The specification requires safe conflict handling but presents candidate mechanisms; no algorithm is selected. | L976, L1019 |
| OD-06 | Use Foliate.js for EPUB and evaluate PDFium or MuPDF for PDF. | Engine choices are marked **[建议]** and require license, size, Android, selection, and annotation review. | L728 |
| OD-07 | Suggested module tree under `apps/`, `packages/`, `plugins/`, and `src-tauri/`. | Module boundaries are marked **[建议]**. The tree also places Notebook, reading-time, and analytics under `plugins/`, while first-release navigation treats them as Core user capabilities; packaging requires an explicit decision. | L1063-1086 |
| OD-08 | Exact sandbox/plugin trust mechanism among Worker, iframe, or equivalent controlled runtime. | The specification requires a controlled environment for untrusted plugins but permits multiple mechanisms. Trust classification, CSP, RPC, and signature policy need design. | L117 |
| OD-09 | Official and third-party catalog/registry protocols and signing/trust policy. | Install sources are confirmed, but catalog APIs, persistence, update channels, signature roots, and revocation behavior are not specified. | L117, L1035 |
| OD-10 | Exact provider conditional-write, ETag, locking, and MOVE strategy for each compatible service. | The specification requires capability detection and degradation but does not choose a uniform algorithm. | L996 |
| OD-11 | Brand display-font family and exact visual token values. | Direction is confirmed; the specific serif/display family and token values are left to design implementation. | L404, L940-944 |
| OD-12 | Performance targets. | The specification requires recording installer size, startup, idle memory, large-book peak memory, sync network, and battery cost; it says targets will be based on measured baselines rather than providing thresholds. | L47 |

## Pending Decisions And Unspecified Boundaries

| ID | Pending question | Current evidence | Source |
|---|---|---|---|
| OPEN-01 | Must PDF support specialized stylus pressure, tilt, palm rejection, and pen eraser behavior on S Pen/Surface Pen or similar devices? | The only explicit “仍待确认” item. Standard touch/mouse ink and annotation must still work. | L833, L1105 |
| OPEN-02 | What are the minimum supported Windows and Android OS/API versions? | The platform names are confirmed; no minimum versions or support policy are given. | L5, L22 |
| OPEN-03 | What Windows package format, installer, signing, update mechanism, and distribution channels are required? | Windows installation is required for acceptance, but package/signing details are absent. | L1058 |
| OPEN-04 | What is the exact first-release plugin API/manifest/sync-protocol version numbering and deprecation window? | Versioning is required, but initial numbers and compatibility duration are absent. | L113, L1015, L1086 |
| OPEN-05 | What user-facing product boundary should Notebook, reading time, and analytics use even if internally packaged as official plugins? | Core pages and first-release gate require these capabilities without exposing mandatory plugin installation; the suggested module tree puts them under `plugins/`. | L15, L155, L540-668, L1077-1079 |
| OPEN-06 | What data transfer/recovery behavior is required if the user changes the local structured database engine or migrates a profile created by an older schema? | Versions/backups are required, but migration compatibility duration and format are unspecified. | L628, L1029 |
| OPEN-07 | What performance thresholds fail release? | Baseline measurements are required; thresholds are not. | L47 |
| OPEN-08 | Which exact physical Windows host and supported OS versions are sufficient for practical first-release coverage? | Real Windows verification remains mandatory. Android physical-device coverage is waived by U1, so device/OS selection is no longer an Android release prerequisite while CI APK gates remain active. | L670-682, L1056-1061; U1 |

## Implementation Notes That Must Not Change Product Decisions

- A build system may organize code differently from the proposed module tree, but it must preserve the confirmed layer/dependency boundaries and stable public contracts.
- A plugin may implement optional behavior, but Core cannot require plugin installation for the first-release page and reader gates.
- A Provider may use different conditional-write primitives internally, but the user-facing one-Provider Profile rule remains fixed.
- A note editor may use CRDT or conflict copies internally, but ordinary Markdown must remain the portable source of truth and whole-note silent last-writer-wins is prohibited.
- An EPUB/PDF engine may differ from the suggested engines only after satisfying the confirmed format, licensing, Android, selection, annotation, memory, and direct-write-back gates.
- UI work may refine visual values, but the confirmed route order, responsive navigation, avatar/settings placement, Reeden reference, no-MD3 basis, accessibility, and real-runtime visual evidence cannot be silently changed.

Any change to a confirmed decision should record the owner, date, replacement decision, migration/compatibility impact, affected acceptance IDs, and test evidence.
