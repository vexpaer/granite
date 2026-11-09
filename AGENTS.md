# Granite engineering

Use PowerShell 7 (`pwsh`) on Windows. Follow `granite 规格书/Granite 规格书.md`; confirmed requirements take priority. All spawned subagents must use `group/ds` as requested. Install project dependencies and caches here on E:. Do not use Android emulators or virtual devices. Real-device and GitHub Actions results must be recorded separately from unit/browser tests. Never publish a release with open data safety, startup or core reading failures. Never commit credentials, signing material, personal books, local library paths or test artifacts containing them.

Shared model: src/types.ts. Native bridge and ownership: docs/implementation-contract.md. Traceability: docs/acceptance.md. Run npm run check and cargo test/check before integration. Preserve external library originals; root unlink is never remote delete. No fake UI data or success states.
