# Android bridge contract

The webview still has one application command: `host_call(request)`.
`tauri-plugin-android-bridge` is an internal native adapter and exposes no
separate web permission. The Rust host decides which calls cross into Android.

## Roots and files

`root.default` is implemented in the Android plugin and returns this stable,
canonical app-private root:

```json
{
  "id": "deterministic UUID",
  "displayName": "Granite Library",
  "path": "<context.filesDir>/Granite Library",
  "kind": "filesystem",
  "permission": "granted",
  "enabled": true,
  "isDefault": true,
  "readonly": false,
  "scanState": "idle",
  "lastValidatedAt": "RFC 3339"
}
```

The Rust host can perform filesystem operations on this exact app-private
directory. The Android plugin uses the same directory for the default
Notebook. Filesystem input from the webview is constrained to this exact root;
arbitrary app-private paths are rejected by the plugin.

`root.pick` launches `ACTION_OPEN_DOCUMENT_TREE`, requests read/write,
persistable, and prefix grants, and immediately calls
`takePersistableUriPermission`. A selected root has:

- `kind: "saf"`
- `path: "content://..."`
- permission `granted` or `readonly`

SAF operations use `ContentResolver` and `DocumentFile`. Paths are always
relative to the selected tree. Traversal, absolute paths, NULs, unsupported
extensions, and escaping canonical paths are rejected.

The Rust host routes SAF scan/validate/import/read/write/locate through the
Android plugin. Book writes use a verified backup, temporary write, replacement,
and final hash check. Imports use a unique filename and verify the destination
hash before returning. Migration never deletes source files; `root.migrateCancel`
sets the cooperative cancellation flag.

`file.pickBooks` uses `ACTION_OPEN_DOCUMENT` with multiple selection and
returns `{name, bytes: number[]}[]`.

## Notebook

The authoritative AppData state and SQLite database remain in Rust/private
storage. `state.load` and `state.save` call these native-only plugin methods:

```rust
app.android_bridge().sync_notebook(&state).await
app.android_bridge().mirror_notebook(&state).await
```

The mirror uses the writable default root or selected SAF root, writes under
`Notebook/`, stores Markdown YAML front matter and stable Granite note IDs, and
maintains `.granite/notebook-index.json`. Reads verify UTF-8 and bounds. These
operations are not exposed as web `host_call` operations.

## Credentials

The Android implementation stores only AES-GCM ciphertext plus a random IV in
private preferences. The 256-bit AES key is generated and retained by
`AndroidKeyStore`. The webview may call `credential.set` and
`credential.delete`, but not `credential.get` or a resolve operation.

Rust obtains a secret only through:

```rust
app.android_bridge()
  .resolve_credential(credential_id)
  .await
```

The returned Rust wrapper zeroizes the value after provider use.

## Lifecycle and Back

Native Tauri events:

| Event | Payload |
| --- | --- |
| `granite://android-back` | `{sequence, pressedAtMs, elapsedRealtimeMs}` |
| `granite://android-lifecycle` | `{sequence, state, occurredAtMs, elapsedRealtimeMs}` |
| `granite://android-share-available` | `{count}` |

`granite://android-back` is emitted only while interception is enabled. The
frontend enables it with:

```ts
hostCall('lifecycle.back', { enabled: true })
```

It should enable interception only when the current route, Reader, modal, or
navigation history can consume Back. Handle the event with the application's
single `back()` operation so app history and Android system Back stay aligned.
Disable interception when Back should use Android's normal dispatcher.

Other lifecycle calls:

```ts
hostCall('lifecycle.keepAwake', { enabled: true })
hostCall('lifecycle.immersive', { enabled: true })
```

Keep-awake uses `FLAG_KEEP_SCREEN_ON`. Immersive mode uses AndroidX window
insets with transient system bars. Both preferences survive Activity
recreation and are reapplied on resume. The manifest opts into the platform
Back callback path.

The `.state` value is exactly `"foreground"` or `"background"`. Timing includes
both wall time and `SystemClock.elapsedRealtime()` so reading sessions can avoid
background JS timers and wall-clock jumps.

## Share import

Manifest filters accept `ACTION_SEND` and `ACTION_SEND_MULTIPLE` for EPUB, PDF,
TXT, and MOBI. The plugin immediately copies provider bytes into a durable
private inbox and records size and SHA-256. A cold-start or single-task
`onNewIntent` signal emits `granite://android-share-available`.

Share import is two-phase:

1. `share.consume` returns `{id, name, bytes: number[]}[]` and changes no inbox
   state.
2. After the importer finishes, call `share.ack` with only IDs whose result is
   successful or a detected duplicate:

```ts
hostCall('share.ack', { ids: acknowledgedIds })
```

Failed, cancelled, and unattempted entries stay available for retry. IDs, not
filenames, identify records because filenames can repeat. `share.ack` rewrites
the index before deleting its private cache files.

## APK export

`book.export` and `backup.export` use `ACTION_CREATE_DOCUMENT`. One save dialog
may be active at a time. The selected URI is written and read back with size
and SHA-256 verification.

## Explicit non-goals

- SQLite is never opened on an SAF document.
- Share filenames are not used as state identity.
- Web code cannot resolve credentials.
- No emulator, simulator, or virtual Android target is used.
