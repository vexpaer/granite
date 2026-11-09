// @vitest-environment jsdom
import 'fake-indexeddb/auto';

import { webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useApp } from '../src/stores/app';
import type { AppData, Note, Tag } from '../src/types';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(async () => {
    throw new Error('Native invoke must not run in browser-preview tests.');
  }),
}));

type AppStore = ReturnType<typeof useApp>;

const previewDatabase = 'granite-local-preview';
const openStores: AppStore[] = [];
let capturedBlob: Blob | undefined;

function timestamp(): string {
  return new Date().toISOString();
}

function makeTag(): Tag {
  const at = timestamp();
  return {
    id: 'tag-backup',
    name: 'Backup',
    color: '#7657d6',
    pinned: true,
    createdAt: at,
    updatedAt: at,
  };
}

function makeNote(bookId: string, tagId: string): Note {
  const at = timestamp();
  return {
    id: 'note-backup-conflict',
    title: 'Conflict note',
    body: 'Version saved in the backup',
    folder: 'Research',
    tagIds: [tagId],
    bookId,
    attachments: [],
    createdAt: at,
    updatedAt: at,
  };
}

async function clearPreviewDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(previewDatabase, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('kv')) {
        request.result.createObjectStore('kv');
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('kv')) {
        database.close();
        resolve();
        return;
      }

      const transaction = database.transaction('kv', 'readwrite');
      transaction.objectStore('kv').clear();
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    };
  });
}

async function loadApp(): Promise<AppStore> {
  const { useApp: getStore } = await import('../src/stores/app');
  const app = getStore();
  openStores.push(app);
  await app.init();
  expect(app.error).toBe('');
  return app;
}

function stopStoreTimers(app: AppStore): void {
  if (app.sessionInterval) clearInterval(app.sessionInterval);
  if (app.toastTimer) clearTimeout(app.toastTimer);
}

function backupFile(bytes: Uint8Array): File {
  const copy = bytes.slice();
  return {
    name: 'granite-backup.zip',
    arrayBuffer: async () =>
      copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
  } as File;
}

function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error('Expected an ArrayBuffer from the downloaded backup.'));
        return;
      }
      resolve(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(blob);
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
  capturedBlob = undefined;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:granite-test-download';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await clearPreviewDatabase();
  openStores.length = 0;
});

afterEach(async () => {
  for (const app of openStores) stopStoreTimers(app);
  sessionStorage.clear();
  await clearPreviewDatabase();
  vi.unstubAllGlobals();
});

describe('Granite backup recovery', () => {
  it('restores an older note as a conflict copy without overwriting a newer local edit', async () => {
    const app = await loadApp();
    const bytes = new TextEncoder().encode('book content carried by the backup');
    await app.importInputs([{ name: 'backup-book.txt', bytes }]);
    const book = app.books[0]!;

    const tag = makeTag();
    await app.saveTag(tag);
    book.tagIds = [tag.id];
    await app.saveBook(book);

    const note = makeNote(book.id, tag.id);
    await app.saveNote(note);
    await app.exportBackup();

    expect(app.error).toBe('');
    expect(capturedBlob).toBeDefined();
    const exportedBytes = await readBlob(capturedBlob!);
    const exportedZip = await JSZip.loadAsync(exportedBytes);
    expect(exportedZip.file(`books/${book.id}.txt`)).toBeTruthy();
    expect(exportedZip.file('README.txt')).toBeTruthy();

    const manifestEntry = exportedZip.file('granite-backup.json');
    expect(manifestEntry).toBeTruthy();
    const manifest = JSON.parse(await manifestEntry!.async('string')) as AppData;
    expect(manifest.roots).toEqual([]);
    expect(manifest.settings).not.toHaveProperty('provider');
    expect(manifest.books.find((candidate) => candidate.id === book.id)).toMatchObject({
      sha256: book.sha256,
      relativePath: `books/${book.id}.txt`,
    });
    expect(manifest.notes.find((candidate) => candidate.id === note.id)?.body).toBe(
      'Version saved in the backup',
    );

    const localNote = app.notes.find((candidate) => candidate.id === note.id)!;
    localNote.body = 'Newer local edit that must survive restore';
    await app.saveNote(localNote);

    await app.importBackup(backupFile(exportedBytes));

    expect(app.error).toBe('');
    const original = app.notes.find((candidate) => candidate.id === note.id)!;
    expect(original.body).toBe('Newer local edit that must survive restore');
    const conflict = app.notes.find(
      (candidate) =>
        candidate.id !== note.id && candidate.conflictOf === note.id,
    );
    expect(conflict).toMatchObject({
      body: 'Version saved in the backup',
      title: 'Conflict note（恢复副本）',
      conflictOf: note.id,
      bookId: book.id,
      tagIds: [tag.id],
    });

    stopStoreTimers(app);
    vi.resetModules();

    const { useApp: getRestartedStore } = await import('../src/stores/app');
    const restarted = getRestartedStore();
    openStores.push(restarted);
    await restarted.init();

    expect(
      restarted.notes.find((candidate) => candidate.id === note.id)?.body,
    ).toBe('Newer local edit that must survive restore');
    expect(
      restarted.notes.find((candidate) => candidate.conflictOf === note.id)?.body,
    ).toBe('Version saved in the backup');
  });
});
