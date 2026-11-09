import { describe, expect, it } from 'vitest'
import type {
  AppData,
  Book,
  Note,
  ReadingSession,
} from '../../src/types'
import {
  applyOrSetOperation,
  canonicalJson,
  createDeviceSyncDocument,
  filterResurrectedChanges,
  getSyncPolicyDecision,
  mergeNoteChanges,
  mergeOrSets,
  mergeReadingProgressHistory,
  mergeReadingSessions,
  mergeSyncDocuments,
  orSetValues,
  sanitizeMetadataForSync,
  SyncQueue,
  SyncQueueError,
  validateDeviceSyncDocument,
  verifyDeviceSyncDocument,
  type NoteChange,
  type ReadingProgressHistory,
  type SyncChange,
  type SyncTombstone,
} from './index'

const timestamp = '2026-11-09T00:00:00.000Z'

const book: Book = {
  id: 'book-1',
  title: 'A Book',
  authors: ['Author'],
  format: 'epub',
  sha256: 'a'.repeat(64),
  size: 42,
  rootId: 'private-root',
  relativePath: 'private/path/book.epub',
  managed: true,
  available: true,
  cover: 'file:///private/cover.jpg',
  status: 'reading',
  favorite: false,
  tagIds: ['tag-1'],
  collectionIds: [],
  location: { progress: 0.5, updatedAt: timestamp },
  createdAt: timestamp,
  updatedAt: timestamp,
}

const appData: AppData = {
  schemaVersion: 1,
  deviceId: 'device-a',
  revision: 3,
  books: [book],
  notes: [],
  tags: [],
  collections: [],
  roots: [
    {
      id: 'private-root',
      displayName: 'Private',
      path: 'C:\\private',
      kind: 'filesystem',
      permission: 'granted',
      enabled: true,
      isDefault: true,
      readonly: false,
      scanState: 'idle',
    },
  ],
  sessions: [],
  annotations: [],
  settings: {
    username: 'reader',
    theme: 'system',
    density: 'comfortable',
    language: 'en',
    background: 'file:///private/background.jpg',
    dailyGoal: 30,
    idleMinutes: 5,
    reader: {
      fontFamily: 'serif',
      fontSize: 18,
      lineHeight: 1.5,
      paragraphSpacing: 1,
      margin: 24,
      width: 720,
      theme: 'paper',
      mode: 'scroll',
      encoding: 'utf-8',
      keepAwake: false,
      wheelThreshold: 20,
    },
    provider: {
      id: 'provider-private',
      type: 'webdav',
      name: 'Private',
      endpoint: 'https://example.invalid',
      username: 'user',
      prefix: 'Granite',
      credentialId: 'credential-private',
      accessKeyId: 'access-private',
    },
    syncPolicy: 'metadata',
    syncBookIds: [],
    syncCollectionIds: [],
    profile: 'default',
    sidebarExpanded: true,
    shortcuts: {},
    layout: {},
  },
  plugins: [],
  tombstones: [],
  syncHistory: [],
  conflicts: [],
  pluginData: {
    'example.plugin': { retainedUnknownField: { value: 7 } },
  },
}

function upsertChange(
  entityType: string,
  entityId: string,
  value: unknown,
  counter: number,
  deviceId: string,
): SyncChange {
  return {
    id: `${entityType}:${entityId}:${counter}`,
    entityType,
    entityId,
    operation: 'upsert',
    value,
    revision: { counter, deviceId },
  }
}

function note(id: string, body: string, device: string): Note {
  return {
    id,
    title: 'Shared note',
    body,
    folder: '',
    tagIds: [],
    createdAt: timestamp,
    updatedAt: `${timestamp}-${device}`,
  }
}

function noteChange(
  value: Note,
  counter: number,
  deviceId: string,
  baseChecksum = 'base',
): NoteChange {
  const change = upsertChange(
    'note',
    value.id,
    value,
    counter,
    deviceId,
  ) as SyncChange<Note>
  return {
    ...change,
    entityType: 'note',
    baseChecksum,
  }
}

describe('safe per-device sync documents', () => {
  it('strips local roots, paths, provider credentials, and background paths', () => {
    const snapshot = sanitizeMetadataForSync(appData)
    expect(snapshot.books[0]).not.toHaveProperty('rootId')
    expect(snapshot.books[0]).not.toHaveProperty('relativePath')
    expect(snapshot.books[0]).not.toHaveProperty('cover')
    expect(snapshot.settings).not.toHaveProperty('provider')
    expect(snapshot.settings).not.toHaveProperty('background')
    expect(snapshot.pluginData['example.plugin']).toEqual({
      retainedUnknownField: { value: 7 },
    })
  })

  it('seals and verifies a synchronized document', async () => {
    const change = upsertChange('book', book.id, safeBookFixture(), 4, 'device-a')
    const document = await createDeviceSyncDocument({
      deviceId: 'device-a',
      revision: 4,
      generatedAt: timestamp,
      changes: [change],
      pluginData: { 'example.plugin': { retained: true } },
    })

    expect(document.protocolVersion).toBe(1)
    expect(await verifyDeviceSyncDocument(document)).toBe(true)
    expect(
      await verifyDeviceSyncDocument({
        ...document,
        revision: 5,
      }),
    ).toBe(false)
  })

  it('rejects owner changes in the wrong per-device document', async () => {
    await expect(
      createDeviceSyncDocument({
        deviceId: 'device-a',
        revision: 1,
        changes: [upsertChange('tag', 'tag-1', { id: 'tag-1' }, 1, 'device-b')],
      }),
    ).rejects.toThrow('own changes')
  })

  it('rejects malformed changes even when the document itself is shaped correctly', () => {
    const errors = validateDeviceSyncDocument({
      protocolVersion: 1,
      deviceId: 'device-a',
      revision: 1,
      generatedAt: timestamp,
      changes: [
        {
          id: 'change-1',
          entityType: 'note',
          entityId: 'note-1',
          operation: 'upsert',
          revision: { counter: -1, deviceId: 'device-b' },
          checksum: 'digest',
        },
      ],
      tombstones: [],
      pluginData: {},
      checksum: 'digest',
    })

    expect(errors).toEqual(
      expect.arrayContaining([
        'changes.0.revision is invalid',
        'changes.0.revision belongs to another device',
      ]),
    )
  })
})

describe('conflict and history merges', () => {
  it('treats tombstones as terminal even when an offline change has a larger counter', () => {
    const tombstone: SyncTombstone = {
      id: 'book:book-1',
      entityType: 'book',
      entityId: 'book-1',
      at: timestamp,
      deviceId: 'device-a',
      revision: 2,
      revisionStamp: { counter: 2, deviceId: 'device-a' },
    }
    const stale = upsertChange('book', 'book-1', { id: 'book-1' }, 999, 'device-b')
    expect(filterResurrectedChanges([stale], [tombstone])).toEqual([])
  })

  it('creates conflict copies for concurrent note heads instead of LWW', () => {
    const local = note('note-1', 'local body', 'a')
    const remote = note('note-1', 'remote body', 'b')
    const result = mergeNoteChanges(
      [
        noteChange(local, 5, 'device-a'),
        noteChange(remote, 5, 'device-b'),
      ],
      { preferredDeviceId: 'device-a' },
    )

    expect(result.notes).toHaveLength(2)
    expect(result.notes.some((entry) => entry.body === 'local body')).toBe(true)
    expect(
      result.notes.some(
        (entry) => entry.body === 'remote body' && entry.conflictOf === 'note-1',
      ),
    ).toBe(true)
    expect(result.conflicts).toHaveLength(1)
  })

  it('de-duplicates sessions by ID', () => {
    const sessions: ReadingSession[] = [
      {
        id: 'session-1',
        deviceId: 'a',
        bookId: 'book-1',
        startedAt: timestamp,
        endedAt: timestamp,
        activeMs: 10,
      },
      {
        id: 'session-1',
        deviceId: 'a',
        bookId: 'book-1',
        startedAt: timestamp,
        endedAt: timestamp,
        activeMs: 20,
      },
    ]
    expect(mergeReadingSessions(sessions)).toHaveLength(1)
    expect(mergeReadingSessions(sessions)[0].activeMs).toBe(20)
  })

  it('merges tag relations as an OR-Set', () => {
    let left = applyOrSetOperation({}, {
      element: 'tag-1',
      operation: 'add',
      operationId: 'device-a:1',
    })
    left = applyOrSetOperation(left, {
      element: 'tag-1',
      operation: 'remove',
      operationId: 'device-a:1',
    })
    expect(orSetValues(left)).toEqual([])
    const right = applyOrSetOperation({}, {
      element: 'tag-1',
      operation: 'add',
      operationId: 'device-b:1',
    })
    const merged = mergeOrSets(left, right)
    expect(orSetValues(merged)).toEqual(['tag-1'])
  })

  it('orders progress by logical revision while retaining revision history', () => {
    const olderRevision: ReadingProgressHistory = {
      bookId: 'book-1',
      current: {
        id: 'p1',
        bookId: 'book-1',
        location: { progress: 0.4, updatedAt: '2026-11-10T00:00:00Z' },
        revision: { counter: 3, deviceId: 'device-a' },
        recordedAt: '2026-11-10T00:00:00Z',
      },
      history: [],
    }
    const newerRevision: ReadingProgressHistory = {
      bookId: 'book-1',
      current: {
        id: 'p2',
        bookId: 'book-1',
        location: { progress: 0.6, updatedAt: '2026-11-08T00:00:00Z' },
        revision: { counter: 7, deviceId: 'device-b' },
        recordedAt: '2026-11-08T00:00:00Z',
      },
      history: [],
    }

    const merged = mergeReadingProgressHistory(olderRevision, newerRevision)
    expect(merged[0].current.location.progress).toBe(0.6)
    expect(merged[0].history).toHaveLength(2)
  })

  it('retains unknown plugin namespaces and both conflicting values', async () => {
    const first = await createDeviceSyncDocument({
      deviceId: 'device-a',
      revision: 1,
      generatedAt: timestamp,
      pluginData: {
        known: { value: 'local' },
        untouched: { nested: true },
      },
    })
    const second = await createDeviceSyncDocument({
      deviceId: 'device-b',
      revision: 1,
      generatedAt: timestamp,
      pluginData: {
        known: { value: 'remote' },
        futurePlugin: { schema: 9 },
      },
    })
    const merged = mergeSyncDocuments(first, second)
    expect(merged.pluginData.untouched).toEqual({ nested: true })
    expect(merged.pluginData.futurePlugin).toEqual({ schema: 9 })
    expect(merged.conflicts.some((conflict) => conflict.type === 'plugin-data')).toBe(true)
  })

  it('retains prototype-like plugin namespaces without mutating prototypes', async () => {
    const malicious = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"safe":true}}',
    ) as Record<string, unknown>
    const document = await createDeviceSyncDocument({
      deviceId: 'device-a',
      revision: 1,
      generatedAt: timestamp,
      pluginData: malicious,
    })
    const merged = mergeSyncDocuments(document)

    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(Object.prototype.hasOwnProperty.call(merged.pluginData, '__proto__')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(merged.pluginData, 'constructor')).toBe(true)
  })
})

describe('sync policy and queue', () => {
  it('implements all four policies without converting missing files into deletes', () => {
    expect(
      getSyncPolicyDecision({ policy: 'full', object: 'book-file', bookId: 'book-1' })
        .syncBookFile,
    ).toBe(true)
    expect(
      getSyncPolicyDecision({ policy: 'metadata', object: 'book-file', bookId: 'book-1' })
        .syncBookFile,
    ).toBe(false)
    expect(
      getSyncPolicyDecision({
        policy: 'selected',
        object: 'book-file',
        bookId: 'book-2',
        collectionIds: ['collection-1'],
        selectedCollectionIds: ['collection-1'],
      }).syncBookFile,
    ).toBe(true)
    expect(
      getSyncPolicyDecision({
        policy: 'on-demand',
        object: 'book-file',
        bookId: 'book-1',
      }).syncBookFile,
    ).toBe(false)
    expect(
      getSyncPolicyDecision({
        policy: 'on-demand',
        object: 'delete',
        bookId: 'book-1',
      }).deleteRemoteObject,
    ).toBe(true)
    expect(
      getSyncPolicyDecision({
        policy: 'metadata',
        object: 'plugin-data',
      }).syncMetadata,
    ).toBe(true)
  })

  it('checks payload integrity, retries with backoff, and resumes', async () => {
    let nowMs = Date.parse(timestamp)
    let attempts = 0
    const queue = new SyncQueue({
      digest: async (value) => `digest:${canonicalJson(value)}`,
      now: () => new Date(nowMs).toISOString(),
      createId: () => 'queue-1',
      baseRetryDelayMs: 100,
    })
    await queue.enqueue({
      kind: 'document',
      operation: 'put',
      key: 'sync/devices/a.json',
      payload: { revision: 1 },
    })

    const first = await queue.runNext(async () => {
      attempts += 1
      throw new SyncQueueError('temporary offline', { retryable: true })
    })
    expect(first?.status).toBe('pending')
    expect(attempts).toBe(1)

    nowMs += 200
    const second = await queue.runNext(async () => {
      attempts += 1
      return 'ok'
    })
    expect(second?.status).toBe('succeeded')
    expect(attempts).toBe(2)
  })

  it('cancels an in-flight operation through its AbortSignal', async () => {
    const queue = new SyncQueue({
      digest: async (value) => `digest:${canonicalJson(value)}`,
      now: () => timestamp,
      createId: () => 'queue-cancel',
    })
    await queue.enqueue({
      kind: 'object',
      operation: 'put',
      key: 'objects/sha256/value',
      payload: [1, 2, 3],
    })

    const running = queue.runNext(
      (_item, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true },
          )
        }),
    )
    await Promise.resolve()
    queue.cancel('queue-cancel', 'user cancelled')
    expect((await running)?.status).toBe('cancelled')
  })
})

function safeBookFixture() {
  return sanitizeMetadataForSync(appData).books[0]
}
