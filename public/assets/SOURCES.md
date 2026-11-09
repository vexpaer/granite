# Bundled asset provenance

- `mountains.jpg`: mountain photograph sourced from Unsplash, https://images.unsplash.com/photo-1464822759023-fed622ff2c3b . Downloaded 2026-11-09; Unsplash license https://unsplash.com/license . Served locally for offline use; no remote image requests at runtime.
- Display font: Cormorant Garamond, distributed by `@fontsource/cormorant-garamond`, SIL Open Font License 1.1. Font resources are bundled locally by Vite.
- Application icons: Lucide, ISC license, from `lucide-vue-next`.
- Offline PDF resources: PDF.js CMaps, standard fonts, WASM and their license files are copied unchanged from the locked `pdfjs-dist` package by `scripts/sync-reader-assets.mjs`. They are bundled under `/pdfjs` at build time.
- The image in the specification is user-provided design reference; application UI is implemented independently.
