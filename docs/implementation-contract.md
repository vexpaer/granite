# Granite integration contract

All agents edit the shared workspace directly; do not revert other work. Main owns root tooling, src/types.ts, src/stores/app.ts, src/services/host.ts, integration and tests. UI agent owns App.vue, components (except Reader*), views (except ReaderView), styles. Reader agent owns ReaderView.vue, Reader* components, src/reader/**. Native agent owns src-tauri/** excluding gen/android (Android agent owns it). Domain agent owns packages/core/**. Android agent owns .github/**, scripts/android*, docs/android*, src-tauri/gen/android/**.

## UI store
`useApp()` from `src/stores/app` returns one reactive singleton. Fields: ready, busy, error, toast, books:Book[], notes:Note[], tags:Tag[], collections:Collection[], roots:LibraryRoot[], sessions:ReadingSession[], annotations:Annotation[], settings:AppSettings, route:{name,id?}, history, search, shelfFilter, readerBookId, importResults, syncStatus, syncHistory, conflicts, plugins. Methods: init(), navigate(name,id?), back(), notify(text), importFiles(files?:FileList|File[]), openReader(bookId,location?), saveBook(book), deleteBooks(ids), saveNote(note), newNote(bookId?,quote?,location?), deleteNote(id), saveTag(tag), deleteTag(id), mergeTags(source,target), saveSettings(), addRoot(), updateRoot(root), removeRoot(id), rescanRoot(id), migrateRoot(from,to), sync(), cancelSync(), exportBackup(), importBackup(file), readBook(book):Promise<Uint8Array>, writeBook(book,bytes), saveLocation(bookId,location), saveAnnotation(annotation), deleteAnnotation(id), beginSession(bookId), endSession(), exportBook(book), exportNote(note), installPlugin(file), setPluginEnabled(id,enabled). Mutations followed by `persist()`; errors shown via store error/toast. UI may call persist(). Notes auto-save with explicit status. No invented sample data in default app.

Routes: home, bookshelf, book-detail (id), notebook (optional note id), statistics, me, settings, sync, plugins, tags, tag-results (id), search, import, conflicts, diagnostics, reader (id). ReaderView props `book:Book`, emits `close`; Reader imports useApp for bytes, annotations, notes, sessions. Reader must always exit cleanly.

## Native bridge
One Tauri command `host_call`, argument `{request:{op:string,args:object}}`, returns JSON result or errors. Ops:
- state.load => object|null; state.save {state} => true. Private SQLite, versioned, backup on migrations.
- root.pick => LibraryRoot|null via native chooser (Android SAF tree); root.scan {root} => array `{name,relativePath,size,format}`; root.validate {root}=> updated root. root.migrate {from,to}=> report; never delete originals.
- book.import {rootId,root,filename,bytes:number[]} => `{relativePath,sha256,size}` (safe unique file, verifies hash); book.read {root,relativePath}=>number[]; book.write {root,relativePath,bytes:number[]}=>{sha256,size} (backup, atomic verify); book.export {filename,bytes}=>bool; book.locate {root,relativePath}=>bool.
- file.pickBooks => array `{name,bytes:number[]}` using native picker.
- credential.set {id,secret} => true; credential.delete {id} => true. Never expose credential.get to web UI/plugins.
- provider.request {profile,method,key,body?:number[],headers?:object} => `{status,headers,body:number[]}`. Native resolves profile credentialId, signs S3 or WebDAV Basic, TLS. Credentials never persisted in AppSettings.
- backup.export {filename,bytes:number[]} => bool using native save dialog; diagnostics => redacted platform/runtime info.

## Domain packages
packages/core exports index.ts including types where practical (main src/types.ts canonical UI types), pure merge/sync contracts, Provider implementations with injected native HTTP transport, plugin runtime Cordis, manifest validation/permission/lifecycle, Markdown links and analytics. No Vue dependency. Agent can create own test files with vitest. Integration uses public exports only. Do not install dependencies or change root package: tell main what you need.

## Security and data
Library roots/device paths never in sync export. Credentials stay native. Removing roots only unlinks. Explicit delete creates tombstone, queues cloud object delete; external source not deleted. All actual acceptance gates must reflect observed evidence, never mark Android verified without physical device. No Android emulator.
