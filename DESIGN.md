# Granite Design Brief

## Direction

Granite is a quiet digital study: a snow mountain at dawn, laundered sky, pale
paper, and restrained lavender light. The product should feel calm and precise
rather than corporate, game-like, or decorative. Reading content and current
task carry the visual emphasis.

The supplied `/assets/mountains.jpg` photograph is the shared atmosphere for the
desktop sidebar and the Home introduction. It should stay recognizable through a
lavender wash and must never reduce navigation contrast.

## Composition

### Windows

- A stable left sidebar, 220–320 px wide with a 256 px default, anchors the app.
  Users can save their preferred width and expanded state. It contracts below
  1100 px without changing destinations.
- The content canvas has a generous maximum width and uses cards only where they
  group a real reading task.
- Home opens with a restrained mountain hero, then prioritizes continue reading
  and recent activity over dashboard decoration.
- The utility bar contains search, a compact sync-state icon, and plugin header
  actions. It does not repeat the page title or show premature success copy.
- Lists and detail panels switch to stacked layouts before content becomes
  compressed.

### Android

- Portrait uses a fixed five-item bottom navigation with safe-area padding.
- Landscape uses a slim five-item left rail and returns width to content.
- Cards use the same tokens but avoid multi-column density that would make a
  phone look like a stretched desktop.
- Reader hides app navigation and uses the full viewport. Reader-owned panels
  remain responsible for their own responsive placement.

## Color and Material

Light mode uses warm off-white surfaces over a cool lavender-gray canvas. Dark
mode uses near-black aubergine surfaces with brighter lavender accents.

| Token | Light | Purpose |
| --- | --- | --- |
| `--canvas` | `#f6f4f7` | App background |
| `--surface` | warm translucent white | Cards and panels |
| `--text` | `#25212f` | Primary copy |
| `--text-secondary` | `#6f6878` | Supporting copy |
| `--accent` | `#8067ce` | Primary action |
| `--accent-strong` | `#6951b9` | Links and emphasis |
| `--accent-soft` | `#eee8fb` | Selected and informational surfaces |
| `--success` | `#4d9472` | Completed state |
| `--warning` | `#bd7d3d` | Attention state |
| `--danger` | `#b75461` | Destructive and failed state |

Surfaces use subtle borders, low shadows, and occasional blur. Glass effects
support hierarchy; they do not replace contrast. Saturated color marks actions,
selection, progress, and status.

## Typography

- UI text uses Segoe UI Variable Text, Segoe UI, PingFang SC, Microsoft YaHei UI,
  then the system UI fallback.
- Display and editorial headings use Cormorant Garamond, imported globally in
  `main.ts`, with STSong and Songti SC for Chinese fallback.
- Monospace metadata uses Cascadia Code, SF Mono, then Consolas.
- Body text is 14 px at standard desktop density and 13 px in compact layouts.
- Supporting UI copy is at least 12 px. Useful labels are not made tiny to fit
  more chrome.
- Uppercase English section eyebrows are not part of the design. Page hierarchy
  comes from Chinese headings, content grouping, and spacing.

## Shape, Spacing, and Motion

- Sidebar navigation uses subtle 7–8 px corners and compact rows.
- Main cards use 18–26 px corners with restrained layered shadows.
- Controls use 8–12 px corners and at least a 32 px small-control target; standard
  action targets are 38–40 px.
- Motion runs for 140–360 ms with a decelerating ease.
- Motion communicates route, dialog, toast, save, and state changes. It does not
  animate decorative data into existence.
- `prefers-reduced-motion` reduces animation and transition duration globally.

## Page Patterns

### Home

The first-run state is intentionally quiet: a concise invitation to add a folder
or import a book, without a fake cover or placeholder chart. The welcome hero is
fixed and always leads the page. Six modules—Continue Reading, Recent Reading,
Recent Notes, Statistics, Today's Goal, and Tags—are visible by default and can be
reordered, hidden, or restored from Appearance settings. Recent books, notes, and
tags also expose bounded display-count choices. With real data, the page uses
asymmetric emphasis: Continue Reading remains the main reading task while the
other modules support return and review.

### Library

Grid view is cover-forward. Each card keeps title, author, status, and actual
progress readable. List view swaps the cover for a compact information row.
Filters, collections, bulk actions, and view controls remain in a visible toolbar.
Long libraries render a windowed set of rows with overscan; the scrollbar still
represents the full collection.

### Book Detail

The detail page behaves like a book record rather than a marketing page. Metadata,
availability, reading action, collections, tags, annotations, notes, and file
recovery are grouped by task. Unavailable and read-only states change the
available actions.

### Notebook

Notebook uses a quiet three-part rhythm on wide layouts: folders and note list,
Markdown editor, and preview or context tools. Markdown preview is sanitized.
WikiLinks, backlinks, attachments, templates, save state, and note-level
conflicts are visible without taking over the writing surface.

### Statistics

Statistics favors consistent data over decorative dashboards. Time ranges share
one source of truth, charts show only observed sessions, the calendar uses a
readable heat scale, and goal rings reflect calculated progress. Charts may use
bars; actual progress uses the shared circular progress component.

### Settings, Plugins, and Diagnostics

Settings uses a stable category rail and a content panel. Plugin installation is a
decision surface: source, author, version, license, integrity, compatibility, and
permissions appear before the install action. Diagnostics reads like an
operational report, separates observed runtime data from user-authored data, and
makes export scope explicit.

Settings also exposes real work-profile actions. “Save current Profile” records the
current theme, layout, Home module arrangement, reader defaults, and versioned
enabled-plugin state. “Apply Profile” restores those settings from the database
and refreshes the draft; native provider configuration and credentials remain tied
to the current device. Appearance settings control the persisted sidebar width and
desktop expanded preference. Keyboard settings are reflected in the global search
hint and handler.

## Reeden-Informed Product Posture

The design studies Reeden's official documentation for library layouts,
application appearance, themes, and background treatment. The transferable ideas
are hierarchy and predictability: covers lead the library, navigation remains
stable, app theme and reading theme stay independent, and the reader is immersive.

Granite's own mountain-and-lavender identity, Cormorant display voice, plugin
acceptance flow, diagnostic language, and local-first data disclosures are
original to this project.

## Accessibility and Quality Bar

- Primary actions have visible focus and keyboard access.
- Icon controls include accessible names.
- Dialogs use `role="dialog"`, `aria-modal`, focus restoration, focus containment,
  Escape handling, and a shared topmost-overlay stack.
- The system Back event closes only the topmost layer before route navigation.
- Status copy accompanies status color.
- Secondary text remains at least 12 px.
- Long strings truncate with title or accessible context instead of forcing page
  overflow.
- Empty states describe the real next action.
- The app does not expose internal implementation names in user-facing copy.

## Platform Evidence

Physical Android-device verification is explicitly waived by the user on
2026-11-09. This document describes the implemented responsive design contract and
does not claim that runtime Android appearance was observed. Android CI and APK
artifact verification remain required. Emulator-based evidence is prohibited.
