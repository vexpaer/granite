# Granite core domain package

`packages/core/index.ts` is the browser-safe public surface for domain logic. It does not import
Node's loader APIs. The application supplies `src/types.ts` as the canonical shared type source.

The package exports:

- provider-neutral S3/WebDAV adapters backed by an injected native transport;
- per-device sync documents, checksum admission, tombstones, note conflict copies, session
  de-duplication, OR-Set tag state, revision-history progress, policies, and retry/cancel queues;
- Cordis-based plugin manifest validation and runtime lifecycle;
- Markdown wiki-link/backlink/rename helpers;
- date/session analytics and a monotonic, visibility-aware reading tracker.

## Sync security

`sanitizeMetadataForSync()` removes library roots, local paths, local cover/background paths,
provider settings, credential references, availability state, and per-device `cloudState`.
Application-only keys such as `granite.local-sync-state` must be removed by the application before
calling it. Unknown plugin namespaces are retained by `mergeSyncDocuments()`; incompatible values
produce a conflict record.

Per-device documents contain only changes and tombstones authored by that device. A document's
SHA-256 checksum covers all fields, and each change has an independent checksum. Tombstones are
terminal for the entity identity, so an older offline upsert cannot resurrect it.

## Plugin trust

`manifest.trust` is package metadata and grants no authority. A package is untrusted unless the
embedding app supplies a separate user trust decision as `{ trusted: true }`. Permission
confirmation is separate from code-trust confirmation. On every activation the manager intersects
the package's requested permissions with the currently granted `InstalledPlugin.permissions`, so a
revoked permission does not return when the plugin is re-enabled.

Trusted ESM plugins run through the controlled Cordis/Vue registration surface. Untrusted plugins
run in a Worker or an opaque-origin iframe. The iframe loads a Blob bootstrap through an external
classic `<script src="blob:...">` so it works under the Tauri CSP; plugin code has no same-origin
access to Tauri APIs and communicates only through permission-checked RPC. Readiness and sandbox
teardown are bounded, and one plugin's activation or cleanup failure is isolated in its runtime
record.

Use `verifyBundleIntegrity()` with the manifest's SRI value. Hex digests and a bare SHA-256 value
are not accepted as SRI.

## Application integration

The native transport adapter expects the app's existing `hostCall(op, args)` function:

```ts
import {
  createHostProviderTransport,
  createProvider,
  createSyncEngine,
} from './packages/core/index'

const transport = createHostProviderTransport((request) =>
  hostCall(request.op, request.args),
)
const provider = createProvider(profile, transport)
const engine = createSyncEngine({ provider, deviceId })
await engine.ensureProtocolDocument({ signal })
const bytes = await engine.downloadBook(book, { signal })
```

`createProvider()` binds one immutable profile to list/read/write/delete/stat/range,
capability, retry, cancellation, conditional-write, and SHA-256 checks. The adapter sends
`{op:'provider.request', args:{profile,method,key,body:number[],headers}}`. Provider-bound keys
already include `profile.prefix`, so the host-facing copy carries `prefix:''`; the public provider
profile and binding ID retain the configured prefix.

Installation should use `previewPluginPackage()`/`previewPluginSource()` and require the returned
`requiresUserReview` flow before storing the plugin. Runtime activation receives an external trust
grant and the current granted permissions:

```ts
const preview = await previewPluginPackage(bytes, {
  hostApiVersion: '1.0.0',
  hostPlatform: 'windows',
})
await activateInstalled(installedPlugin, hooks, {
  trusted: persistedUserTrustGrant,
  hostPlatform: 'windows',
  safeMode,
})
```

`initializeInstalledPlugins()` performs the same default-untrusted activation for enabled plugins.
`deactivateInstalled()` reverses UI, command, event, and sandbox resources. The reactive
`pluginUiRegistry` exposes `contributions`, `forSlot(slot)`, and `sandbox(pluginId)`.

## Platform evidence

Physical Android device verification is explicitly waived by the user on 2026-11-09. This waiver
does not remove the Android build, GitHub Actions/CI, or debug APK requirements, and it does not
claim that Android runtime behavior was observed. Android emulators and virtual devices remain
prohibited.

## Verification

```powershell
& node_modules/.bin/vitest.cmd run packages/core src/services/plugin-manager.test.ts
npm run build
```
