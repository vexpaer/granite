// @vitest-environment jsdom
import 'fake-indexeddb/auto';

import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useApp } from '../src/stores/app';
import type { Annotation, Book, LibraryRoot, Note, Tag } from '../src/types';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(async () => {
    throw new Error('Native invoke must not run in browser-preview tests.');
  }),
}));

type AppStore = ReturnType<typeof useApp>;

const previewDatabase = 'granite-local-preview';
const openStores: AppStore[] = [];

function timestamp(): string {
  return new Date().toISOString();
}

function makeTag(id: string, name: string): Tag {
  const at = timestamp();
  return {
    id,
    name,
    color: '#7657d6',
    pinned: false,
    createdAt: at,
    updatedAt: at,
  };
}

function makeBook(root: LibraryRoot, overrides: Partial<Book> = {}): Book {
  const at = timestamp();
  return {
    id: crypto.randomUUID(),
    title: 'Recoverable book',
    authors: ['Granite QA'],
    format: 'txt',
    sha256: 'a'.repeat(64),
    size: 0,
    rootId: root.id,
    relativePath: 'books/external.txt',
    managed: false,
    available: true,
    status: 'unread',
    favorite: false,
    tagIds: [],
    collectionIds: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function makeNote(overrides: Partial<Note> = {}): Note {
  const at = timestamp();
  return {
    id: crypto.randomUUID(),
    title: 'Linked note',
    body: '',
    folder: '',
    tagIds: [],
    attachments: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function makeAnnotation(bookId: string): Annotation {
  const at = timestamp();
  return {
    id: crypto.randomUUID(),
    bookId,
    type: 'highlight',
    text: 'Important passage',
    note: '',
    color: '#f2c94c',
    location: { format: 'txt', progress: 0.31, offset: 120 },
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

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
  await clearPreviewDatabase();
  openStores.length = 0;
});

afterEach(async () => {
  for (const app of openStores) stopStoreTimers(app);
  sessionStorage.clear();
  await clearPreviewDatabase();
  vi.unstubAllGlobals();
});

describe('Granite app persistence and destructive operations', () => {
  it('restores books, progress, notes, tags, and settings after a module restart', async () => {
    const app = await loadApp();
    const bytes = new TextEncoder().encode('persistent reading content');

    await app.importInputs([{ name: 'persistent.txt', bytes }]);
    const imported = app.books[0]!;
    expect(imported).toBeDefined();

    const tag = makeTag('tag-persisted', 'Persistent tag');
    await app.saveTag(tag);

    imported.tagIds = [tag.id];
    await app.saveBook(imported);
    await app.saveLocation(imported.id, {
      format: 'txt',
      progress: 0.42,
      offset: 211,
    });

    const note = app.newNote(imported.id, 'Saved quote', {
      format: 'txt',
      progress: 0.42,
      offset: 211,
    });
    note.title = 'Persistent note';
    note.body = '> Saved quote\n\nA note that must survive restart.';
    note.tagIds = [tag.id];
    await app.saveNote(note);

    app.settings.username = 'Restart Tester';
    await app.saveSettings();
    await app.persist();

    const expected = {
      bookId: imported.id,
      noteId: note.id,
      rootId: app.defaultRoot!.id,
      sha256: imported.sha256,
    };

    stopStoreTimers(app);
    vi.resetModules();

    const { useApp: getRestartedStore } = await import('../src/stores/app');
    const restarted = getRestartedStore();
    openStores.push(restarted);
    await restarted.init();

    expect(restarted.error).toBe('');
    expect(restarted.roots.map((root) => root.id)).toContain(expected.rootId);
    expect(restarted.books).toHaveLength(1);
    expect(restarted.books[0]).toMatchObject({
      id: expected.bookId,
      sha256: expected.sha256,
      tagIds: [tag.id],
      status: 'reading',
      location: { progress: 0.42, offset: 211 },
    });
    expect(restarted.notes).toHaveLength(1);
    expect(restarted.notes[0]).toMatchObject({
      id: expected.noteId,
      title: 'Persistent note',
      tagIds: [tag.id],
      bookId: expected.bookId,
    });
    expect(restarted.tags.some((candidate) => candidate.id === tag.id)).toBe(true);
    expect(restarted.settings.username).toBe('Restart Tester');
  });

  it('detects duplicate content by SHA-256 before creating another book', async () => {
    const app = await loadApp();
    const bytes = new TextEncoder().encode('byte-identical import');
    const expectedHash = createHash('sha256').update(bytes).digest('hex');

    await app.importInputs([{ name: 'first-copy.txt', bytes }]);
    await app.importInputs([{ name: 'renamed-copy.txt', bytes }]);

    expect(app.books).toHaveLength(1);
    expect(app.books[0]!.sha256).toBe(expectedHash);
    expect(app.importResults).toEqual([
      expect.objectContaining({
        filename: 'first-copy.txt',
        status: 'success',
        bookId: app.books[0]!.id,
      }),
      expect.objectContaining({
        filename: 'renamed-copy.txt',
        status: 'duplicate',
        bookId: app.books[0]!.id,
      }),
    ]);
  });

  it('unlinks a root without deleting its book file or creating a tombstone', async () => {
    const app = await loadApp();
    const bytes = new TextEncoder().encode('file owned outside Granite');
    await app.importInputs([{ name: 'external.txt', bytes }]);

    const book = app.books[0]!;
    const root = app.defaultRoot!;
    const rootSnapshot = { ...root };
    const relativePath = book.relativePath;

    await app.removeRoot(root.id);

    expect(app.roots).toHaveLength(0);
    expect(app.books).toHaveLength(1);
    expect(app.books[0]).toMatchObject({ id: book.id, available: false });
    expect(app.tombstones).toHaveLength(0);

    const { hostCall } = await import('../src/services/host');
    const storedBytes = await hostCall<number[]>('book.read', {
      root: rootSnapshot,
      relativePath,
    });
    expect(Array.from(storedBytes)).toEqual(Array.from(bytes));
  });

  it('creates a book tombstone for true delete while preserving an external source file', async () => {
    const app = await loadApp();
    const root = app.defaultRoot!;
    const sourceBytes = new TextEncoder().encode('external source must remain');
    const { hostCall } = await import('../src/services/host');
    const saved = await hostCall<{ relativePath: string; sha256: string; size: number }>(
      'book.import',
      {
        rootId: root.id,
        root: { ...root },
        filename: 'external-source.txt',
        bytes: Array.from(sourceBytes),
      },
    );
    const externalBook = makeBook(root, {
      title: 'External source',
      sha256: saved.sha256,
      size: saved.size,
      relativePath: saved.relativePath,
      managed: false,
    });
    await app.saveBook(externalBook);

    const annotation = makeAnnotation(externalBook.id);
    await app.saveAnnotation(annotation);
    await app.deleteBooks([externalBook.id]);

    expect(app.books).toHaveLength(0);
    expect(app.annotations).toHaveLength(0);
    expect(app.tombstones).toEqual([
      expect.objectContaining({
        entityType: 'book',
        entityId: externalBook.id,
        hash: saved.sha256,
        deviceId: app.deviceId,
      }),
    ]);

    const preserved = await hostCall<number[]>('book.read', {
      root,
      relativePath: saved.relativePath,
    });
    expect(Array.from(preserved)).toEqual(Array.from(sourceBytes));
  });

  it('merges and deletes shared tags without deleting associated books or notes', async () => {
    const app = await loadApp();
    const root = app.defaultRoot!;
    const source = makeTag('tag-source', 'Source');
    const target = makeTag('tag-target', 'Target');
    await app.saveTag(source);
    await app.saveTag(target);

    const book = makeBook(root, { title: 'Tagged book', tagIds: [source.id, target.id] });
    const note = makeNote({ title: 'Tagged note', tagIds: [source.id] });
    await app.saveBook(book);
    await app.saveNote(note);

    await app.mergeTags(source.id, target.id);

    expect(app.tags.map((tag) => tag.id)).toEqual([target.id]);
    expect(app.books.find((candidate) => candidate.id === book.id)?.tagIds).toEqual([
      target.id,
    ]);
    expect(app.notes.find((candidate) => candidate.id === note.id)?.tagIds).toEqual([
      target.id,
    ]);

    await app.deleteTag(target.id);

    expect(app.tags).toHaveLength(0);
    expect(app.books.find((candidate) => candidate.id === book.id)?.tagIds).toEqual([]);
    expect(app.notes.find((candidate) => candidate.id === note.id)?.tagIds).toEqual([]);
    expect(app.books).toHaveLength(1);
    expect(app.notes).toHaveLength(1);
  });

  it('updates WikiLink references, including aliases and escaped titles, when renaming a note', async () => {
    const app = await loadApp();
    const originalTitle = 'Draft? [v1]';
    const finalTitle = 'Final [v2]';
    const linked = makeNote({ title: originalTitle, body: 'Destination' });
    const referrer = makeNote({
      title: 'Referrer',
      body:
        `Read [[${originalTitle}]] and [[${originalTitle}|summary]]. ` +
        'Do not rewrite [[Draft? [v1] extended]].',
    });
    await app.saveNote(linked);
    await app.saveNote(referrer);

    const renamed = JSON.parse(
      JSON.stringify(app.notes.find((note) => note.id === linked.id)),
    ) as Note;
    renamed.title = finalTitle;
    await app.saveNote(renamed);

    const updatedReferrer = app.notes.find((note) => note.id === referrer.id)!;
    expect(updatedReferrer.body).toBe(
      `Read [[${finalTitle}]] and [[${finalTitle}|summary]]. ` +
        'Do not rewrite [[Draft? [v1] extended]].',
    );
    expect(app.notes.find((note) => note.id === linked.id)?.title).toBe(finalTitle);
  });
});
