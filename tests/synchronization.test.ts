// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  AppData,
  AppSettings,
  Book,
  LibraryRoot,
  Note,
  ProviderProfile,
  Tombstone,
} from '../src/types';

const hostHarness = vi.hoisted(() => ({
  call: undefined as
    | ((op: string, args: Record<string, unknown>) => Promise<unknown>)
    | undefined,
}));

vi.mock('../src/services/host', () => ({
  hostCall: (op: string, args: Record<string, unknown>) => {
    if (!hostHarness.call) throw new Error('Test provider host has not been installed.');
    return hostHarness.call(op, args);
  },
  sha256: async (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex'),
}));

import { synchronize } from '../src/services/synchronization';

type SyncAccess = Parameters<typeof synchronize>[1];

const fixedTime = '2026-11-09T12:00:00.000Z';
const laterTime = '2026-11-09T12:05:00.000Z';
const prefix = 'Granite';

const sharedProfile: ProviderProfile = {
  id: 'shared-webdav-profile',
  type: 'webdav',
  name: 'Shared QA WebDAV',
  endpoint: 'https://dav.example.invalid/private-root',
  username: 'qa-reader',
  prefix,
  credentialId: 'native-credential-secret-reference',
};

interface RecordedRequest {
  method: string;
  key: string;
  profile: ProviderProfile;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class InMemoryWebDav {
  readonly objects = new Map<string, Uint8Array>();
  readonly requests: RecordedRequest[] = [];
  readonly putKeys: string[] = [];
  readonly deleteKeys: string[] = [];

  async handle(op: string, args: Record<string, unknown>): Promise<unknown> {
    expect(op).toBe('provider.request');
    const method = String(args.method);
    const key = String(args.key);
    const profile = args.profile as ProviderProfile;
    this.requests.push({ method, key, profile });

    if (method === 'MKCOL') {
      return { status: 201, headers: {} };
    }

    if (method === 'PUT') {
      const bytes = Uint8Array.from((args.body as number[] | undefined) ?? []);
      this.objects.set(key, bytes);
      this.putKeys.push(key);
      const requestHeaders = (args.headers as Record<string, string> | undefined) ?? {};
      const checksum = requestHeaders['x-granite-sha256'];
      return {
        status: 201,
        headers: {
          etag: `"${hash(bytes).slice(0, 12)}"`,
          ...(checksum ? { 'x-granite-sha256': checksum } : {}),
        },
      };
    }

    if (method === 'HEAD') {
      const bytes = this.objects.get(key);
      if (!bytes) return { status: 404, headers: {} };
      return {
        status: 200,
        headers: {
          'content-length': String(bytes.byteLength),
          etag: `"${hash(bytes).slice(0, 12)}"`,
          'last-modified': fixedTime,
        },
      };
    }

    if (method === 'GET') {
      const bytes = this.objects.get(key);
      if (!bytes) return { status: 404, headers: {} };
      return {
        status: 200,
        headers: {
          'content-length': String(bytes.byteLength),
          etag: `"${hash(bytes).slice(0, 12)}"`,
        },
        body: Array.from(bytes),
      };
    }

    if (method === 'DELETE') {
      if (!this.objects.delete(key)) return { status: 404, headers: {} };
      this.deleteKeys.push(key);
      return { status: 204, headers: {} };
    }

    if (method === 'PROPFIND') {
      const directory = `${key.replace(/\/+$/, '')}/`;
      const entries = [...this.objects.entries()]
        .filter(([objectKey]) => {
          if (!objectKey.startsWith(directory)) return false;
          const remainder = objectKey.slice(directory.length);
          return Boolean(remainder) && !remainder.includes('/');
        })
        .map(([objectKey, bytes]) => {
          const href = `/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
          return (
            '<d:response>' +
            `<d:href>${xmlEscape(href)}</d:href>` +
            '<d:propstat><d:prop>' +
            `<d:getcontentlength>${bytes.byteLength}</d:getcontentlength>` +
            `<d:getetag>"${hash(bytes).slice(0, 12)}"</d:getetag>` +
            `<d:getlastmodified>${fixedTime}</d:getlastmodified>` +
            '</d:prop></d:propstat>' +
            '</d:response>'
          );
        })
        .join('');
      return {
        status: 207,
        headers: { 'content-type': 'application/xml' },
        body: Array.from(
          new TextEncoder().encode(
            `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${entries}</d:multistatus>`,
          ),
        ),
      };
    }

    throw new Error(`Unexpected WebDAV method ${method} for ${key}`);
  }

  install(): void {
    hostHarness.call = (op, args) => this.handle(op, args);
  }

  storageKey(logicalKey: string): string {
    return `${prefix}/${logicalKey}`;
  }

  object(logicalKey: string): Uint8Array | undefined {
    const bytes = this.objects.get(this.storageKey(logicalKey));
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  json(logicalKey: string): unknown {
    const bytes = this.object(logicalKey);
    if (!bytes) throw new Error(`Missing test object ${logicalKey}`);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  keysUnder(logicalPrefix: string): string[] {
    const storagePrefix = this.storageKey(logicalPrefix);
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(storagePrefix))
      .sort();
  }
}

function root(id: string, path: string): LibraryRoot {
  return {
    id,
    displayName: id,
    path,
    kind: 'filesystem',
    permission: 'granted',
    enabled: true,
    isDefault: true,
    readonly: false,
    scanState: 'idle',
    lastValidatedAt: fixedTime,
  };
}

function settings(
  policy: AppSettings['syncPolicy'],
  overrides: Partial<AppSettings> = {},
): AppSettings {
  return {
    username: 'Sync Reader',
    theme: 'light',
    density: 'comfortable',
    language: 'zh-CN',
    dailyGoal: 30,
    idleMinutes: 5,
    reader: {
      fontFamily: 'serif',
      fontSize: 20,
      lineHeight: 1.9,
      paragraphSpacing: 16,
      margin: 32,
      width: 760,
      theme: 'paper',
      mode: 'scroll',
      encoding: 'auto',
      keepAwake: false,
      wheelThreshold: 100,
    },
    syncPolicy: policy,
    syncBookIds: [],
    syncCollectionIds: [],
    profile: 'Minimal',
    sidebarExpanded: true,
    shortcuts: {},
    layout: {},
    provider: { ...sharedProfile },
    background: 'device-local-background.jpg',
    ...overrides,
  };
}

function appData(
  deviceId: string,
  localRoot: LibraryRoot,
  policy: AppSettings['syncPolicy'],
  overrides: Partial<AppData> = {},
): AppData {
  return {
    schemaVersion: 1,
    deviceId,
    revision: 2,
    books: [],
    notes: [],
    tags: [],
    collections: [],
    roots: [localRoot],
    sessions: [],
    annotations: [],
    settings: settings(policy),
    plugins: [],
    tombstones: [],
    syncHistory: [],
    conflicts: [],
    pluginData: {},
    ...overrides,
  };
}

function book(
  id: string,
  bytes: Uint8Array,
  localRoot: LibraryRoot,
  overrides: Partial<Book> = {},
): Book {
  return {
    id,
    title: `Book ${id}`,
    authors: ['Sync QA'],
    format: 'txt',
    sha256: hash(bytes),
    size: bytes.byteLength,
    rootId: localRoot.id,
    relativePath: `private/${localRoot.id}/${id}.txt`,
    managed: true,
    available: true,
    status: 'reading',
    favorite: false,
    tagIds: [],
    collectionIds: [],
    location: { format: 'txt', progress: 0.37, offset: 42 },
    createdAt: fixedTime,
    updatedAt: fixedTime,
    cloudState: 'local',
    ...overrides,
  };
}

function note(id: string, body: string, updatedAt = fixedTime): Note {
  return {
    id,
    title: `Note ${id}`,
    body,
    folder: 'Research',
    tagIds: [],
    attachments: [],
    createdAt: fixedTime,
    updatedAt,
  };
}

function tombstone(
  entityId: string,
  contentHash: string,
  deviceId: string,
  revision: number,
): Tombstone {
  return {
    id: `tombstone-${entityId}`,
    entityType: 'book',
    entityId,
    hash: contentHash,
    at: laterTime,
    deviceId,
    revision,
  };
}

function accessFor(
  deviceId: string,
  localRoot: LibraryRoot,
  files: Map<string, Uint8Array>,
  downloads: Array<{ bookId: string; bytes: Uint8Array }>,
): SyncAccess {
  return {
    async read(target) {
      const bytes = files.get(target.sha256);
      if (!bytes) throw new Error(`Missing local bytes for ${target.id}`);
      return new Uint8Array(bytes);
    },
    async download(target, bytes) {
      downloads.push({ bookId: target.id, bytes: new Uint8Array(bytes) });
      return {
        ...target,
        rootId: localRoot.id,
        relativePath: `private/${deviceId}/downloads/${target.id}.${target.format}`,
        managed: true,
        available: true,
        cloudState: 'synced',
      };
    },
    progress() {},
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('app synchronization orchestration', () => {
  it('syncs one book metadata record and file between logical devices through one profile', async () => {
    const server = new InMemoryWebDav();
    server.install();
    const bytes = new TextEncoder().encode('shared book payload');
    const rootA = root('root-a', 'C:\\Users\\alice\\Private Library');
    const rootB = root('root-b', '/storage/emulated/0/Private Library');
    const sourceBook = book('book-shared', bytes, rootA);
    const deviceA = appData('device-a', rootA, 'full', { books: [sourceBook] });
    const deviceB = appData('device-b', rootB, 'full');
    const readsA: string[] = [];
    const downloadsB: Array<{ bookId: string; bytes: Uint8Array }> = [];
    const accessA = accessFor('device-a', rootA, new Map([[sourceBook.sha256, bytes]]), []);
    accessA.read = async (target) => {
      readsA.push(target.id);
      return new Uint8Array(bytes);
    };
    const accessB = accessFor('device-b', rootB, new Map(), downloadsB);

    const syncedA = await synchronize(deviceA, accessA, signal());
    const syncedB = await synchronize(deviceB, accessB, signal());

    expect(syncedB.books).toHaveLength(1);
    expect(syncedB.books[0]).toMatchObject({
      id: sourceBook.id,
      title: sourceBook.title,
      sha256: sourceBook.sha256,
      rootId: rootB.id,
      relativePath: `private/device-b/downloads/${sourceBook.id}.txt`,
      available: true,
      cloudState: 'synced',
    });
    expect(downloadsB).toHaveLength(1);
    expect(Array.from(downloadsB[0]!.bytes)).toEqual(Array.from(bytes));
    expect(Array.from(server.object(`objects/sha256/${sourceBook.sha256}`)!)).toEqual(
      Array.from(bytes),
    );
    expect(readsA).toEqual([sourceBook.id]);
    expect(new Set(server.requests.map((request) => request.profile.id))).toEqual(
      new Set([sharedProfile.id]),
    );
    expect(new Set(server.requests.map((request) => request.profile.type))).toEqual(
      new Set(['webdav']),
    );

    const documentA = server.json('sync/devices/device-a.json');
    const documentB = server.json('sync/devices/device-b.json');
    const serializedDocuments = JSON.stringify([documentA, documentB]);
    expect(serializedDocuments).not.toContain(rootA.path);
    expect(serializedDocuments).not.toContain(rootB.path);
    expect(serializedDocuments).not.toContain(sharedProfile.endpoint);
    expect(serializedDocuments).not.toContain(sharedProfile.credentialId);
    expect(serializedDocuments).not.toMatch(/"rootId"|"relativePath"|"provider"/);

    const objectPutsBefore = server.putKeys.filter((key) =>
      key.startsWith(server.storageKey('objects/sha256/')),
    ).length;
    const repeats = await Promise.all([
      synchronize(syncedA, accessA, signal()),
      synchronize(syncedB, accessB, signal()),
      synchronize(syncedB, accessB, signal()),
    ]);
    const objectPutsAfter = server.putKeys.filter((key) =>
      key.startsWith(server.storageKey('objects/sha256/')),
    ).length;

    expect(objectPutsAfter).toBe(objectPutsBefore);
    expect(repeats.every((state) => state.books.filter((item) => item.id === sourceBook.id).length === 1)).toBe(true);
    expect(server.keysUnder('sync/devices/')).toEqual([
      server.storageKey('sync/devices/device-a.json'),
      server.storageKey('sync/devices/device-b.json'),
    ]);
  });

  it('preserves both independently edited notes as a primary and a conflict copy', async () => {
    const server = new InMemoryWebDav();
    server.install();
    const rootA = root('root-a', '/device-a/library');
    const rootB = root('root-b', '/device-b/library');
    const deviceA = appData('device-a', rootA, 'metadata', {
      notes: [note('note-shared', 'Version from device A')],
    });
    const deviceB = appData('device-b', rootB, 'metadata', {
      notes: [note('note-shared', 'Version from device B', laterTime)],
    });
    const downloads: Array<{ bookId: string; bytes: Uint8Array }> = [];

    await synchronize(
      deviceA,
      accessFor('device-a', rootA, new Map(), downloads),
      signal(),
    );
    const syncedB = await synchronize(
      deviceB,
      accessFor('device-b', rootB, new Map(), downloads),
      signal(),
    );

    expect(syncedB.notes).toHaveLength(2);
    expect(syncedB.notes.map((item) => item.body).sort()).toEqual([
      'Version from device A',
      'Version from device B',
    ]);
    expect(syncedB.notes.find((item) => item.id === 'note-shared')?.body).toBe(
      'Version from device B',
    );
    expect(syncedB.notes.find((item) => item.conflictOf === 'note-shared')).toMatchObject({
      body: 'Version from device A',
      conflictOf: 'note-shared',
    });
    expect(syncedB.conflicts.filter((item) => item.type === 'note-conflict')).toHaveLength(1);

    const repeated = await synchronize(
      syncedB,
      accessFor('device-b', rootB, new Map(), downloads),
      signal(),
    );
    expect(repeated.notes.filter((item) => item.conflictOf === 'note-shared')).toHaveLength(1);
    expect(repeated.conflicts.filter((item) => item.type === 'note-conflict')).toHaveLength(1);
  });

  it('prevents deleted books from resurrecting, removes an orphan hash object, and keeps a duplicate live hash object', async () => {
    const server = new InMemoryWebDav();
    server.install();
    const rootA = root('root-a', '/device-a/library');
    const rootB = root('root-b', '/device-b/library');
    const soloBytes = new TextEncoder().encode('solo content');
    const sharedBytes = new TextEncoder().encode('shared duplicate content');
    const files = new Map([
      [hash(soloBytes), soloBytes],
      [hash(sharedBytes), sharedBytes],
    ]);
    const soloBook = book('book-solo', soloBytes, rootA);
    const sharedDeleted = book('book-shared-delete', sharedBytes, rootA, {
      title: 'Shared content, deleted alias',
    });
    const sharedLive = book('book-shared-live', sharedBytes, rootA, {
      title: 'Shared content, live alias',
    });
    const deviceA = appData('device-a', rootA, 'full', {
      books: [soloBook, sharedDeleted, sharedLive],
    });
    const deviceB = appData('device-b', rootB, 'full');
    const downloadsA: Array<{ bookId: string; bytes: Uint8Array }> = [];
    const downloadsB: Array<{ bookId: string; bytes: Uint8Array }> = [];
    const accessA = accessFor('device-a', rootA, files, downloadsA);
    const accessB = accessFor('device-b', rootB, new Map(), downloadsB);

    const syncedA = await synchronize(deviceA, accessA, signal());
    const syncedB = await synchronize(deviceB, accessB, signal());
    expect(downloadsB.map((item) => item.bookId).sort()).toEqual([
      'book-shared-delete',
      'book-shared-live',
      'book-solo',
    ]);

    const deletionState = structuredClone(syncedA);
    deletionState.revision += 1;
    deletionState.books = deletionState.books.filter(
      (item) => item.id !== soloBook.id && item.id !== sharedDeleted.id,
    );
    deletionState.tombstones.push(
      tombstone(soloBook.id, soloBook.sha256, deletionState.deviceId, deletionState.revision),
      tombstone(
        sharedDeleted.id,
        sharedDeleted.sha256,
        deletionState.deviceId,
        deletionState.revision,
      ),
    );

    const staleDeviceB = structuredClone(syncedB);
    staleDeviceB.revision += 1;
    staleDeviceB.books = staleDeviceB.books.map((item) =>
      item.id === soloBook.id || item.id === sharedDeleted.id
        ? { ...item, title: `${item.title} stale edit`, updatedAt: laterTime }
        : item,
    );

    const afterDeleteA = await synchronize(deletionState, accessA, signal());
    expect(server.object(`objects/sha256/${soloBook.sha256}`)).toBeUndefined();
    expect(server.object(`objects/sha256/${sharedLive.sha256}`)).toBeDefined();

    const afterDeleteB = await synchronize(staleDeviceB, accessB, signal());
    expect(afterDeleteB.books.map((item) => item.id)).toEqual([sharedLive.id]);
    expect(afterDeleteA.books.map((item) => item.id)).toEqual([sharedLive.id]);
    expect(afterDeleteB.tombstones.map((item) => item.entityId).sort()).toEqual([
      sharedDeleted.id,
      soloBook.id,
    ]);

    const afterStaleRemote = await synchronize(afterDeleteA, accessA, signal());
    expect(afterStaleRemote.books.map((item) => item.id)).toEqual([sharedLive.id]);
    expect(server.object(`objects/sha256/${soloBook.sha256}`)).toBeUndefined();
    expect(server.object(`objects/sha256/${sharedLive.sha256}`)).toBeDefined();
  });

  it.each([
    ['metadata', 0],
    ['full', 2],
    ['selected', 1],
    ['on-demand', 2],
  ] as const)(
    'applies the %s book-file policy during orchestration',
    async (policy, expectedObjects) => {
      const server = new InMemoryWebDav();
      server.install();
      const rootA = root('root-a', `/device-a/${policy}`);
      const rootB = root('root-b', `/device-b/${policy}`);
      const bytesA = new TextEncoder().encode(`${policy} book A`);
      const bytesB = new TextEncoder().encode(`${policy} book B`);
      const selectedBook = book('book-a', bytesA, rootA);
      const otherBook = book('book-b', bytesB, rootA);
      const files = new Map([
        [selectedBook.sha256, bytesA],
        [otherBook.sha256, bytesB],
      ]);
      const policySettings =
        policy === 'selected'
          ? settings(policy, { syncBookIds: [selectedBook.id] })
          : settings(policy);
      const deviceA = appData('device-a', rootA, policy, {
        books: [selectedBook, otherBook],
        settings: policySettings,
      });
      const downloadsA: Array<{ bookId: string; bytes: Uint8Array }> = [];

      const syncedA = await synchronize(
        deviceA,
        accessFor('device-a', rootA, files, downloadsA),
        signal(),
      );

      expect(server.keysUnder('objects/sha256/')).toHaveLength(expectedObjects);
      expect(syncedA.books).toHaveLength(2);

      if (policy === 'on-demand') {
        const deviceB = appData('device-b', rootB, 'on-demand');
        const downloadsB: Array<{ bookId: string; bytes: Uint8Array }> = [];
        const syncedB = await synchronize(
          deviceB,
          accessFor('device-b', rootB, new Map(), downloadsB),
          signal(),
        );
        expect(syncedB.books).toHaveLength(2);
        expect(syncedB.books.every((item) => item.available === false)).toBe(true);
        expect(downloadsB).toHaveLength(0);
      }
    },
  );
});
