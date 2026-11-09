# Granite Page and Route Contract

## Shell Boundary

`src/App.vue` owns route rendering, global search, scroll-position restoration,
desktop and Android navigation shells, application appearance, and immersive
Reader hosting. Pages own their local selection and dialog state while reading and
mutating shared data through `useApp()`.

The desktop sidebar reads the saved `sidebarWidth` and `sidebarExpanded`
preferences. Width is bounded to 220–320 px; the narrow-window collapse is a
viewport adjustment and does not overwrite the saved preference. Global search
uses the saved `shortcuts.search` binding, displays that binding in the utility
bar, and retains `/` as an accessible fallback outside editable controls.

Core routes use stable names from the implementation contract. Plugin routes use
the namespace `plugin:<plugin-id>/<route-id>` and cannot collide with core routes.
A plugin page renders through `PluginSurface`; a missing, disabled, or unregistered
contribution shows an unavailable state with a back action.

Route changes save the previous `.app-scroll-area` scroll position by route key.
Search text clears when leaving Search. Shared search text, shelf filter, route,
and history are also retained by the app store for navigation restoration.

## Navigation by Platform

| Surface | Navigation |
| --- | --- |
| Windows | Four sidebar destinations: Home, Library, Notebook, Statistics |
| Windows account area | Avatar menu: Profile, Settings, Sync and Storage, Plugins, About and Diagnostics |
| Android portrait | Five always-visible bottom destinations: Home, Library, Notebook, Statistics, Me |
| Android landscape | Five-destination left rail |
| Reader | Full-surface mode with application navigation hidden |

The desktop sidebar deliberately excludes Settings and Sync. The Android `Me`
page exposes them.

## Route Table

| Route | Entry points | Purpose | Back behavior |
| --- | --- | --- | --- |
| `home` | Desktop sidebar, Android nav, brand | Reading workbench and real first-run state | Root destination |
| `bookshelf` with optional filter in `id` | Sidebar group, Android nav, Home links | Grid/list library, filters, bulk actions, collections | Root destination; selected filter remains |
| `book-detail` with book `id` | Library, Home, search, tags, statistics | Metadata, status, progress, annotations, notes, locate/relink | Returns to originating list or result |
| `notebook` with optional note `id` | Sidebar, Android nav, Home, Book Detail, Reader | Folders, note list, Markdown editor, preview, links, attachments | Returns to route/editor context; active dirty draft is saved before selection changes |
| `statistics` | Sidebar, Android nav, Home goal/trend links | Session-derived time, trends, calendar, goals, corrections | Root destination; range is retained while mounted |
| `me` | Android fifth tab | Profile and Android entry hub | Root destination |
| `settings` with optional category `id` | Avatar menu, Me, contextual Buttons | General, appearance, roots, reader, shortcuts, data/plugins | Returns to avatar/Me or prior page |
| `sync` | Avatar menu, Me, status icon, diagnostics | Provider controls, policy, history, conflicts | Returns to prior page |
| `plugins` | Avatar menu, Me, Settings | Install, review, permission, lifecycle, safe mode | Returns to prior page |
| `tags` | Settings/Me/Home tag management | Tag create, edit, color, merge, delete | Returns to tag management entry |
| `tag-results` with tag `id` | Home and Book Detail tags | Filtered books and notes for one tag | Returns to source |
| `search` with query in `id` | Global header, `/`, Ctrl/Cmd+K | Grouped books, notes, tags, plugin results | Returns with search context retained |
| `import` | Home, Library, global import action | Root selection, file choice, progress, duplicate/error results | Returns to previous page |
| `conflicts` | Sync, Search, Diagnostics | Inspect and resolve preserved local/remote versions | Returns to conflict source |
| `diagnostics` | Avatar menu, Me | Runtime facts, data counts, plugin/root errors, redacted export | Returns to prior page |
| `reader` with book `id` | Book Detail, Home, Library, Search | Immersive Reader host | Reader close ends session and restores the previous route |
| `plugin:<id>/<route>` | Plugin Center or a user-pinned plugin entry | Plugin-owned page surface | Returns to prior route; missing contribution is safe |

## Page Contracts

### Home

- Uses only real books, notes, annotations, sessions, goals, and tags.
- Offers folder setup when no writable root exists and import when the library is
  empty.
- Keeps the welcome hero fixed and renders Continue Reading, Recent Reading,
  Recent Notes, Statistics, Today's Goal, and Tags from `layout.homeOrder`.
- All six configurable modules are visible by default. `layout.homeHidden`
  controls visibility and `layout.homeCounts` bounds the recent-book, note, and
  tag lists.
- Continue Reading and recent-book actions open Book Detail or Reader according to
  the rendered control.
- Goal and trend values come from the shared analytics module.
- Header sync state remains idle until a successful sync history entry exists.

### Library

- Supports all, reading, unread, finished, favorite, collection, source, and tag
  filters without creating duplicate screen routes.
- Grid and list modes share selection and bulk actions.
- Grid columns adapt to viewport width; list and grid rows are windowed with
  overscan for long collections.
- Collection create, rename, and delete call `saveCollection` and
  `deleteCollection`; deleting a collection preserves books.
- Missing-file actions reveal a present file or run the hash-verified relink flow.

### Book Detail

- Shows actual format, availability, size, metadata, status, tags, collections,
  annotations, reading sessions, and related notes.
- Locate and relink are separate actions. Relink verifies SHA-256 and preserves the
  logical book ID and annotations.
- Root removal or missing media changes availability without creating a delete
  tombstone.

### Notebook

- Note selection awaits the previous dirty draft flush before changing identity.
  Incoming metadata refresh does not overwrite a dirty draft.
- Editor and sanitized preview are explicit modes.
- Folders, tags, templates, attachments, WikiLinks, and backlinks operate on real
  note fields.
- Save states distinguish idle, dirty, saving, saved, and error.

### Statistics

- Range totals, charts, calendar, goals, and recent sessions use
  `packages/core/analytics.ts`.
- Sessions are deduplicated by ID and split at local midnight before range
  filtering, preventing duplicate or whole-session cross-day counts.
- Manual correction validates ISO date/time order and effective duration against
  wall duration. The active session cannot be edited.
- A missing complete period displays only the observed range and real empty state.

### Sync and Storage

- Sync activity is derived from `syncStatus`, not the generic app busy flag.
- Provider setup supports WebDAV and S3-compatible profiles.
- Secret input is passed to `credential.set`; the secret is not stored in
  `AppSettings` or included in the diagnostics report.
- Policy controls distinguish full, metadata, selected, and on-demand behavior.
- Sync history, cancellation, and conflicts expose only observed state.

### Settings and Library Roots

- Saving a Profile records the current appearance, layout, Home module settings,
  reader defaults, and versioned enabled-plugin state through `saveProfile`.
- Applying a Profile uses `applyProfile`, then refreshes the Settings draft from
  the persisted app settings. The current device's native provider and credentials
  remain unchanged.
- Appearance settings expose real Home reorder/hide/count controls plus persisted
  sidebar width and expanded-state preferences.
- Every root shows permission, scan state, default status, read-only status, and a
  stable local display name.
- Reauthorize invokes a new native chooser while preserving the root identity;
  rescan is a distinct action.
- Migration selects a source and target, listens for
  `root.migrate-progress`, shows current/total and phase, supports cancellation,
  and reports completion only when the returned report is completed.
- Backup restore previews book, note, and duplicate counts before confirmation.
- Backup preview and destructive actions never fabricate completion.

### Plugins

- Local package and HTTPS source URL installation both lead to the same review
  dialog.
- Review includes source, author, version, license, integrity result, API/platform
  compatibility, and requested permissions.
- The user chooses whether to accept previewed permissions. Newly installed
  plugins remain disabled by default.
- Installed plugins can be enabled, disabled, rolled back when backup data exists,
  uninstalled while retaining plugin data, and individually permission-revoked.
- Safe Mode disables non-built-in plugin execution while preserving core pages.
- Named plugin pages use `plugin:<id>/<route>` and render through `PluginSurface`.

### Tags and Search

- Tags support create, rename, recolor, pin, merge, and delete.
- Deleting a tag removes only associations; merge moves associations to the target
  before deleting the source.
- Search groups results by entity type and preserves the query when a result is
  opened.
- Search state never implies a result exists before the local index returns one.

### Import

- Import is bound to the visible, selected default root before file choice.
- The native or browser picker accepts EPUB, PDF, TXT, and MOBI.
- Duplicate content is detected before writing another managed copy.
- Progress reflects completed file attempts; cancellation is checked between
  files and reported per item.

### Diagnostics

- Reads camelCase native runtime fields (`appVersion`, `tauriVersion`,
  `storageMode`, `platform`, `architecture`, `native`, `database`) and supports
  Android's `apiLevel` and `runtime` values.
- Lists actual bundled parsers and libraries, including JSZip, pdf-lib, and the
  MOBI parser.
- Redacted export excludes book/note text, roots and SAF URIs, provider secrets,
  credential IDs, and plugin bundles.

## Plugin Slots

The shell currently exposes:

| Slot | Host |
| --- | --- |
| `app.sidebar` | Desktop sidebar below core navigation |
| `app.header.actions` | Global utility bar |
| `app.dashboard` | Home |
| `library.toolbar` | Library action area |
| `settings.pages` | Settings content |

Slots default to empty and render only enabled, platform-compatible contributions.
Reader slots are coordinated with the Reader owner so plugin surfaces cannot
override system Back, core Reader gestures, or accessibility controls.

## Loading, Empty, and Error Rules

- A loading indicator requires an active asynchronous operation.
- An empty state appears only after successful loading established that no data
  exists.
- A permission failure names the inaccessible root and offers reauthorization,
  rescan, or unlink where valid.
- Save and import errors remain visible and actionable.
- Destructive actions state what is retained.
- Route back never deletes unsaved work; the page flushes or preserves its draft.

## Keyboard and System Back

- The user-selected search shortcut focuses global search; the utility bar shows
  the saved binding. `/` remains an accessible fallback outside editable controls.
- Alt+Left follows the route stack.
- Escape closes the topmost dialog or transient panel.
- Android emits `granite:back`. Registered dialogs consume it only when topmost;
  menu and Reader-owned panels have priority within their own overlays before the
  shell route fallback runs.

## Platform Evidence

Android physical-device verification is waived by the user on 2026-11-09. The
route and responsive contracts remain implementation requirements. Android CI and
APK build/artifact checks remain required, and emulator-based evidence is
prohibited. No document may claim Android runtime verification without separate
evidence.
