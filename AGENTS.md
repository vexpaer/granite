# Granite engineering

Use PowerShell 7 (`pwsh`) on Windows. Follow `granite 规格书/Granite 规格书.md`; confirmed requirements take priority. All spawned subagents must use `group/ds` as requested. Install project dependencies and caches here on E:. Do not use Android emulators or virtual devices. Real-device and GitHub Actions results must be recorded separately from unit/browser tests. Never publish a release with open data safety, startup or core reading failures. Never commit credentials, signing material, personal books, local library paths or test artifacts containing them.

Shared model: src/types.ts. Native bridge and ownership: docs/implementation-contract.md. Traceability: docs/acceptance.md. Run npm run check and cargo test/check before integration. Preserve external library originals; root unlink is never remote delete. No fake UI data or success states.

User update U2 (2026-11-10): all Windows/Android real-device application verification and all live cloud/cross-device service tests are deferred to the user after delivery. Do not run them or request cloud credentials. They are not current delivery/release gates; record them as user-manual/not-verified, never passed. Automated local tests, native builds, GitHub Actions builds, signing and artifact checks remain required. See docs/task-overrides.md and the updated authoritative specification.
