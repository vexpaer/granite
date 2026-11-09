# Granite Product Brief

Granite is a free, open-source, local-first ebook reader and personal library for
Windows and Android. It is designed for readers who want their books, notes,
reading history, and extensions to remain useful without an account, a
subscription, or a developer-operated service.

The first release supports EPUB, PDF, TXT, and MOBI. Granite uses Tauri 2, a Rust
native host, Vue 3 and TypeScript for the interface, and Cordis for plugins. The
core experience remains available offline.

## Product Principles

- Local work completes first. Reading, annotations, notes, progress, and library
  edits do not depend on connectivity.
- Users control file locations. Windows and Android can each use one or more
  independent library roots, and root removal only unlinks the root.
- The interface reports observed state. It does not seed sample books, invent a
  reading session, manufacture trends, or display success before a task succeeds.
- Plugins are optional. A missing, disabled, failed, or untrusted plugin cannot
  break core navigation or local reading.
- Export is a product feature. Backups include authored data while excluding
  device paths and provider secrets.
- Desktop and Android share route IDs, domain models, and task flows while using
  navigation suited to each input model.

## Information Architecture

Windows uses four primary destinations in the left sidebar:

1. Home
2. Library
3. Notebook
4. Statistics

The bottom-left avatar menu contains the user profile, Settings, Sync and
Storage, Plugins, and About and Diagnostics. Settings and Sync are not primary
sidebar destinations.

Android portrait uses five fixed destinations: Home, Library, Notebook,
Statistics, and Me. Android landscape moves the same five destinations into a
left navigation rail. Reader is the exception: it occupies the full available
surface and hides application navigation until the reader closes.

## Core User Tasks

### Start and return to reading

Home is a reading workbench. It surfaces only data that exists: continue reading,
recent books, recent notes, a reading goal based on real sessions, tags, and
recent use of library tools. A new profile shows concise import and folder setup
actions instead of a fictional dashboard.

The welcome hero is fixed. Continue Reading, Recent Reading, Recent Notes,
Statistics, Today's Goal, and Tags are six user-configurable Home modules. They
are all visible by default; users can reorder, hide, restore them, and set the
number of recent books, notes, or tags shown.

Work Profiles save the current application theme, layout, Home module settings,
reader defaults, and versioned enabled-plugin state. Applying a saved Profile
restores that snapshot while preserving the current device's sync provider and
native credential. Preset Profiles provide the same layout and reader-width
starting points without changing native provider configuration.

### Manage a library

Library provides grid and list views, search, status and source filters,
collections, tags, sorting, bulk selection, and long-list windowing. Book Detail
shows metadata, status, progress, collections, tags, annotations, and related
notes. A missing file can be revealed, reauthorized, or hash-verified and
relinked without replacing the book identity or annotations.

### Write connected notes

Notebook is an independent Markdown space. It supports folders, tags, templates,
attachments, preview, WikiLinks, backlinks, book quotes, and ReaderLocation links.
Edits are saved per note with explicit save state. Switching notes flushes the
previous dirty draft before changing selection, preventing a delayed save from
moving to the wrong note.

### Understand reading activity

Statistics derives every total, trend, calendar cell, streak, and goal from
reading sessions. Shared analytics code deduplicates session IDs and divides a
session across local calendar days, including sessions that cross midnight.
Users can correct a completed session's start, end, and effective duration.
Statistics do not fill missing periods with invented values.

### Configure storage and sync

Settings exposes multiple local roots with rename, default, read-only, enable,
rescan, reauthorize, remove-link, and migration controls. Migration reports
native copy and verification progress, supports cancellation, and updates book
roots only after verification completes. Source files are retained.

Appearance settings persist the desktop sidebar width and expanded preference.
Narrow windows may collapse the sidebar without changing the saved preference.
The global search shortcut is user-selected and the utility bar displays the saved
binding. The first release uses a complete Simplified Chinese interface and does
not present an inactive English-language switch.

Sync supports one S3-compatible or WebDAV provider profile at a time. The profile
controls both metadata and book files. Provider secrets are written through
`credential.set` to the native credential store and never included in normal app
settings, diagnostics, or backups. Initial idle state says that sync is waiting
or unconfigured; it does not claim a successful run.

### Extend the product safely

Plugins can be installed from a local package or an explicit HTTPS source URL.
Before installation, Granite stages the package and shows its source, author,
version, license, integrity result, API compatibility, platform support, and
requested permissions. Installation requires explicit confirmation and leaves
new plugins disabled by default.

Untrusted plugin UI defaults to a Worker or iframe boundary with permission-checked
RPC. Safe Mode keeps core screens available while third-party plugins remain off.
Installed plugins can be enabled, disabled, rolled back, uninstalled while
preserving their data, and stripped of individual permissions.

## Global Flows

- Global search groups books, notes, tags, and searchable plugin results.
- Import uses the selected default writable root, reports duplicates and errors,
  exposes actual progress, and allows cancellation between files.
- Sync conflicts preserve both versions until the user chooses a resolution.
- Diagnostics builds a local, redacted report that excludes book and note text,
  paths, SAF URIs, credentials, credential IDs, and plugin bundles.
- Android system Back first closes the topmost dialog or panel, then follows the
  route stack. Reader-owned panels consume Back before the shell exits Reader.

## State Contract

`src/stores/app.ts` is the authoritative UI state boundary. Pages call its public
methods and do not write persistence formats or invoke domain workflows through
ad hoc copies. Reader receives a `book` prop and emits `close`; the shell restores
the previous route. Components never seed demo records or synthesize missing
metrics.

## Empty, Loading, and Failure States

Every data surface has a real state for no data, loading, permission failure,
unavailable files, missing filters, and validation errors where applicable.
Primary actions lead to creating or recovering the missing thing. Busy indicators
appear only while the corresponding operation is running. A green success state
requires persisted data or a completed domain result.

## Accessibility

- All icon-only controls have an accessible name and title where useful.
- Navigation exposes current-page state and visible keyboard focus.
- Dialogs trap focus, close with Escape, and register in a topmost-overlay stack.
- Android system Back is consumed by the topmost dialog before route fallback.
- Controls use native buttons, inputs, selects, and progress elements.
- Status is never communicated by color alone.
- Text and controls support 12 px minimum secondary copy, increased contrast, and
  reduced-motion preferences.
- The compact shell avoids horizontal page scrolling.

## Platform Scope and Evidence

- Windows desktop is a first-release target.
- Android is a first-release target.
- Android physical-device installation and runtime verification are **explicitly
  waived by the user on 2026-11-09**. This is a scope decision, not a passed test.
- Android build, GitHub Actions, Debug APK artifact, Release APK workflow, manifest
  inspection, checksums, and signature verification remain required.
- Android emulators, simulators, and virtual devices are prohibited and cannot
  substitute for the waived physical-device evidence.
- Do not describe Android runtime behavior as observed without evidence.
- Linux and a web reader are outside the first-release scope.

## Product Reference

The specification names Reeden as the primary product-pattern reference. Granite
adapts the information hierarchy and interaction patterns documented by the
official Reeden product and documentation, while using original Granite branding,
visual assets, components, and copy:

- [Reeden product](https://reeden.app/cn)
- [Bookshelf layout](https://docs.reeden.app/bookshelf_layout)
- [Application appearance](https://docs.reeden.app/app_appearance)
- [Application theme](https://docs.reeden.app/app_theme)
- [Theme and background](https://docs.reeden.app/theme_background)

Patterns used in this implementation are: a task-first home, cover-forward
library, visible reader progress, persistent global controls, compact navigation
on phones, spacious navigation on desktop, and clear separation between app and
reading themes. Granite does not copy Reeden assets, proprietary icons, copy, or
screenshots.
