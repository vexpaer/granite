# Granite Reader

This directory owns the native core for EPUB, PDF, TXT, and MOBI reading. The
reader does not require a plugin and does not use `epubjs`; EPUB packaging,
spine traversal, navigation, and resource resolution are implemented directly
with JSZip.

## Implemented formats and behavior

| Format | Implementation |
| --- | --- |
| EPUB | JSZip package/container/OPF parsing, manifest and spine navigation, EPUB3 NAV and EPUB2 NCX TOCs, direct image/font resource resolution, script-free HTML sanitization, and isolated per-chapter CSS. |
| PDF | PDF.js 5.7 continuous canvas, lazy page rendering, native text layer, PDF outline, text search, text selection, one- and two-pointer X/Y pan, anchored pinch zoom, 50% viewport overscroll with spring recovery, view-only 90-degree rotation, Fit Width, Fit Page, Actual Size, page input, and persisted page/X/Y/scale. |
| TXT | BOM handling, UTF-8-first decoding, GB18030/Big5/Shift-JIS/Windows-1252 fallback heuristics, manual encoding selection, chapter detection, continuous/paginated reflow, search, and stable text offsets. |
| MOBI | `@lingo-reader/mobi-parser` 0.4.6 browser API for metadata, spine, processed HTML, TOC, and parser-provided CSS/resources. Parser-supported PalmDOC/MOBI and KF8 content are accepted; malformed, DRM-protected, encrypted, or unsupported variants produce a visible error. |

EPUB, TXT, and MOBI share selection, copy/share, bookmarks, highlights,
underlines, text notes, Notebook creation, TOC search/back history, continuous
and paginated modes, and per-book appearance overrides. Reflow annotations use
chapter and stable text-offset locations. Invalid locations remain visible in
the database rather than being silently discarded.

PDF annotations are written as standard, editable PDF annotation dictionaries:
`Highlight`, `Underline`, `Text`, and `Ink`. Granite identifiers and an
appearance stream are included, while the low-level objects remain readable by
other PDF tools. The application serializes writes through `app.writeBook()`;
native code owns atomic replacement, backup/checksum verification, and the sync
queue. Database annotations remain available if a write fails and the toolbar
exposes retry.

## Explicit limitations

- EPUB DRM, scripted content, remote resources, and encrypted/obfuscated font
  variants are not implemented. Scripts, embedded objects, forms, audio/video,
  remote images, and unsafe CSS are removed during sanitization.
- PDF passwords/encryption, damaged xref streams, XFA-only forms, and malformed
  fonts are not repaired. A file that PDF.js cannot parse fails visibly.
- Scanned PDFs render normally, but text selection and search report that no
  extractable text layer is available. OCR is not part of Reader Core.
- MOBI/AZW-family DRM or proprietary compression variants are not decrypted.
  The supported surface is the content accepted by the installed MIT parser
  library.
- Text highlights on highly irregular markup can locate to the containing
  chapter and quote rather than an exact character fragment. They are never
  dropped automatically.
- Android touchscreen behavior is implemented but has no physical-device
  runtime observation in this task.

## Dependency decision

`epubjs` is currently unnecessary for Reader Core because the JSZip parser
covers the required package, spine, NAV/NCX, and resource behaviors. Required
reader dependencies are `pdfjs-dist`, `pdf-lib`, `jszip`, and
`@lingo-reader/mobi-parser`.

## Android verification status

Physical Android-device installation and runtime verification are **waived by
the user on 2026-11-09**. This waiver does not claim that Android runtime was
observed.

Android Debug/Release APK build, GitHub Actions, artifact verification, and code
validation remain required. Android emulators, simulators, and virtual devices
remain prohibited and must not be used as evidence in place of the waived
physical-device checks.

## Reader-owned tests

```powershell
npm test -- --run src/reader/formats.fixtures.test.ts src/reader/pdf-annotations.test.ts
```

The format test uses the original generated EPUB/PDF/TXT fixtures and an actual
public-domain MOBI sample from the MIT parser repository. The annotation test
round-trips all four required Granite PDF annotation types and verifies
replacement by Granite ID.
