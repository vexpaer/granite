# Android physical-device acceptance runbook

## Current status

**WAIVED by the user on 2026-11-09.** Physical Android installation and runtime
verification are not a blocker for this task and no device evidence is
requested. This waiver does not mean the checks passed.

Android CI, Debug APK generation/artifact upload, tagged signed Release APK
generation, signature inspection, and checksums remain required. No emulator,
simulator, virtual device, or Android UI automation may substitute for the
waived physical run.

As of this document:

- No physical-device result is claimed.
- No attached `adb` target was present at the last read-only inspection.
- No package was installed on any device.
- CI and local APK evidence are recorded separately in `ci.md`.

## Safety rule for any later run

Do not use `adb` without an explicit `-s <serial>` once a device is attached.
First identify the target with:

```powershell
adb devices -l
```

Match the model and serial to the user-confirmed physical target. Do not infer
the target from whichever device happens to be listed first. If it is not
explicitly identified, stop before installing. Never use an emulator or AVD.

Read-only confirmation:

```powershell
adb -s <serial> shell getprop ro.product.manufacturer
adb -s <serial> shell getprop ro.product.model
adb -s <serial> shell getprop ro.build.version.sdk
adb -s <serial> shell getprop ro.kernel.qemu
```

`ro.kernel.qemu=1` indicates an emulator and must not be accepted as the
physical target.

Only after target identification:

```powershell
adb -s <serial> install -r <verified-debug-apk>
```

## Acceptance checklist for a future authorized run

Use disposable test books and backup any test-only state. Record the APK SHA-256,
device serial (private evidence), model, Android API level, and run timestamp.

### Startup and app-private default

- Launch with no library root saved.
- Home initializes without a chooser.
- Settings shows `Granite Library` with kind `FILESYSTEM`.
- The displayed path ends in the application private `files/Granite Library`
  directory returned by `root.default`.
- Import an EPUB/PDF/TXT/MOBI into the default root and read it.
- Force-stop and relaunch; the root, books, progress, notes, and settings remain.
- Confirm `granite.sqlite3`, WAL files, plugin caches, and credentials are not in
  the SAF tree.

### SAF tree selection and persistence

- Add a folder through system `ACTION_OPEN_DOCUMENT_TREE`.
- Confirm the returned root has `kind=saf` and a `content://` URI.
- Import a supported book, confirm unique naming, read it, modify/write it, and
  compare the reported SHA-256 with the final file.
- Force-stop and relaunch; persistent access is still valid.
- Repeat after reboot.
- Revoke or remove the tree/provider grant and relaunch.
- The root becomes unavailable/denied; books are retained and no deletion
  tombstone is emitted.
- Reauthorize and rescan without losing book identity.
- Attempt `..`, absolute paths, unsupported formats, and an escaping root path;
  each must fail.

### Multiple roots and migration

- Configure two roots and confirm their device-local paths remain distinct.
- Migrate a disposable library from filesystem to SAF and SAF to filesystem.
- Verify copied bytes by SHA-256.
- Confirm existing destination files are skipped or reported without
  overwrite and source files are preserved.
- Run migration again with cancellation and confirm the report says cancelled
  and any completed copies remain valid.

### Notebook

- Create nested-folder notes with WikiLinks and Markdown body text.
- Save, force-stop, and relaunch.
- Open `Notebook/` in the selected root and inspect Markdown, YAML front matter,
  stable note IDs, and `.granite/notebook-index.json`.
- Edit a Markdown file with another app, relaunch, and verify read-back.
- Delete an externally managed file and verify the safety policy remains
  recoverable.
- Rename a note and verify duplicate-name handling and backlinks.
- Confirm the default filesystem root and SAF root both use the same Notebook
  layout.

### Credential vault

- Set and resolve a disposable provider credential through native provider use.
- Confirm plaintext never appears in AppData, SAF files, preferences XML, logs,
  diagnostics, or UI/plugin responses.
- Confirm web `host_call` rejects `credential.get` and credential resolution.
- Delete the credential and confirm provider use fails closed.
- Back up/restore test data and confirm credential ciphertext is not included
  in portable AppData backup.

### Share import

- Share one EPUB/PDF/TXT/MOBI with Granite from a file manager and another app.
- Confirm `ACTION_SEND`, cold start, and single-task delivery.
- Share multiple files and confirm `ACTION_SEND_MULTIPLE`.
- On `granite://android-share-available`, call `share.consume`.
- Interrupt before acknowledgement, relaunch, and confirm every unconsumed
  record can be read again with the same ID.
- Make one import fail and one succeed; call `share.ack` only for the success or
  duplicate ID.
- Relaunch and confirm the failed ID remains retryable.
- Share two books with the same display filename and confirm IDs keep them
  distinct.
- Tamper with a private inbox cache file and confirm hash verification rejects
  it without clearing unrelated records.

### Lifecycle, Back, immersive mode, and keep-awake

- Subscribe to `granite://android-lifecycle`; background/resume yields ordered
  `background` and `foreground` records.
- Confirm monotonic elapsed times advance correctly across wall-clock changes
  and process suspension.
- Enter nested app routes/modals/Reader and verify system Back follows the
  documented order: modal/sheet, transient state, immersive Reader, then history.
- Confirm the frontend enables `lifecycle.back` only when a destination can
  consume it and disables it at the root.
- On API 33+, confirm predictive/edge Back uses the same path and does not
  duplicate a navigation action.
- Toggle immersive mode in Reader and while reading a PDF canvas; app controls
  hide, transient system bars remain reachable, and leaving Reader restores app
  navigation and insets.
- With keep-awake enabled, verify the display remains on; disable it and verify
  normal timeout behavior.
- Exercise rotation, split-screen/window-size changes, process recreation, and
  screen lock. Route, reader anchor, filters, drafts, and notes must survive.

### Export and lifecycle interruption

- Export a book and backup through `ACTION_CREATE_DOCUMENT`.
- Confirm cancel returns false without changing data.
- Kill or interrupt during write and confirm the source remains valid.
- Verify exported bytes and the exposed checksum.
- Confirm an import that reaches success or duplicate is acknowledged, while a
  cancelled or failed import remains retryable.

## Evidence record

| Gate | Status |
| --- | --- |
| Debug CI and APK artifact | Pending successful pushed run |
| Tagged signed Release APK | Pending a version tag and configured secrets |
| Physical install/startup | **WAIVED 2026-11-09; not run** |
| SAF persistence/revocation | **WAIVED 2026-11-09; not run** |
| Share single/multiple | **WAIVED 2026-11-09; not run** |
| Lifecycle, immersive, keep-awake, Back | **WAIVED 2026-11-09; not run** |
| Keystore provider use | **WAIVED 2026-11-09; not run** |

Update this table only from observed evidence. CI logs do not close waived
runtime rows, and an emulator result is never acceptable evidence.
