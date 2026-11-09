import type { Book, Tombstone } from '../../src/types'
import {
  createDeviceSyncDocument,
  mergeSyncDocuments,
  parseDeviceSyncDocument,
  sanitizeMetadataForSync,
  sha256Hex,
  SYNC_PROTOCOL_VERSION,
  type DeviceSyncDocument,
  type DeviceSyncDocumentInput,
  type MergedSyncDocuments,
  type SyncChange,
  type SyncDigest,
  type SyncRevision,
  type SyncSnapshot,
  type SyncTombstone,
} from './sync'
import type {
  ProviderRequestOptions,
  ProviderWriteResult,
  StorageProvider,
} from './provider'

export const SYNC_ROOT = 'sync'
export const SYNC_DEVICE_PREFIX = `${SYNC_ROOT}/devices/`
export const SYNC_PROTOCOL_KEY = `${SYNC_ROOT}/protocol-version.json`
export const SYNC_OBJECT_PREFIX = 'objects/sha256/'

export interface SyncEngineOptions {
  provider: StorageProvider
  deviceId: string
  digest?: SyncDigest
  now?: () => string
}

export interface PullSyncResult {
  documents: DeviceSyncDocument[]
  failures: Array<{ key: string; error: string }>
}

export interface ObjectOperationOptions extends ProviderRequestOptions {
  signal?: AbortSignal
}

function assertSha256(hash: string): string {
  const normalized = hash.toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new TypeError('book object hash must be a 64-character SHA-256 hex string')
  }
  return normalized
}

function assertOwnedTombstone(tombstone: SyncTombstone, deviceId: string): void {
  if (tombstone.deviceId !== deviceId) {
    throw new Error('a device may only publish tombstones created by itself')
  }
}

function changeId(entityType: string, entityId: string, revision: SyncRevision): string {
  return `${entityType}:${entityId}:${revision.counter}:${revision.deviceId}`
}

function snapshotChange(
  entityType: string,
  entityId: string,
  value: unknown,
  revision: SyncRevision,
): SyncChange {
  return {
    id: changeId(entityType, entityId, revision),
    entityType,
    entityId,
    operation: 'upsert',
    value,
    revision,
  }
}

export function mapSyncSnapshotToChanges(
  snapshot: SyncSnapshot,
  deviceId: string,
  revisionCounter: number,
): SyncChange[] {
  const revision = { counter: revisionCounter, deviceId }
  const changes: SyncChange[] = []

  for (const book of snapshot.books) {
    changes.push(snapshotChange('book', book.id, book, revision))
    if (book.location) {
      changes.push(
        snapshotChange(
          'reading-progress',
          book.id,
          {
            id: `progress:${book.id}:${revisionCounter}:${deviceId}`,
            bookId: book.id,
            location: book.location,
            revision,
            recordedAt: book.location.updatedAt ?? book.updatedAt,
          },
          revision,
        ),
      )
    }
  }
  for (const note of snapshot.notes) changes.push(snapshotChange('note', note.id, note, revision))
  for (const tag of snapshot.tags) changes.push(snapshotChange('tag', tag.id, tag, revision))
  for (const collection of snapshot.collections) {
    changes.push(snapshotChange('collection', collection.id, collection, revision))
  }
  for (const session of snapshot.sessions) {
    changes.push(snapshotChange('reading-session', session.id, session, revision))
  }
  for (const annotation of snapshot.annotations) {
    changes.push(snapshotChange('annotation', annotation.id, annotation, revision))
  }
  changes.push(snapshotChange('settings', 'app', snapshot.settings, revision))
  return changes
}

export class SyncEngine {
  readonly provider: StorageProvider
  readonly deviceId: string
  readonly digest: SyncDigest
  private readonly now: () => string

  constructor(options: SyncEngineOptions) {
    if (!options.deviceId) throw new TypeError('sync engine deviceId is required')
    this.provider = options.provider
    this.deviceId = options.deviceId
    this.digest = options.digest ?? sha256Hex
    this.now = options.now ?? (() => new Date().toISOString())
  }

  snapshot(data: Parameters<typeof sanitizeMetadataForSync>[0]): SyncSnapshot {
    return sanitizeMetadataForSync(data)
  }

  mapSnapshot(snapshot: SyncSnapshot, revision: number): SyncChange[] {
    return mapSyncSnapshotToChanges(snapshot, this.deviceId, revision)
  }

  async publish(
    input: Omit<DeviceSyncDocumentInput, 'deviceId'> & {
      signal?: AbortSignal
    },
  ): Promise<{ document: DeviceSyncDocument; write: ProviderWriteResult }> {
    const tombstones = input.tombstones ?? []
    for (const tombstone of tombstones) assertOwnedTombstone(tombstone, this.deviceId)

    const document = await createDeviceSyncDocument(
      {
        ...input,
        deviceId: this.deviceId,
        generatedAt: input.generatedAt ?? this.now(),
      },
      this.digest,
    )
    const key = `${SYNC_DEVICE_PREFIX}${encodeURIComponent(this.deviceId)}.json`
    const bytes = new TextEncoder().encode(JSON.stringify(document))
    const write = await this.provider.write(key, bytes, {
      contentType: 'application/json',
      digest: this.digest,
      signal: input.signal,
    })
    return { document, write }
  }

  async publishSnapshot(
    snapshot: SyncSnapshot,
    input: {
      revision: number
      tombstones?: SyncTombstone[]
      metadata?: Record<string, unknown>
      signal?: AbortSignal
    },
  ): Promise<{ document: DeviceSyncDocument; write: ProviderWriteResult }> {
    return this.publish({
      revision: input.revision,
      changes: this.mapSnapshot(snapshot, input.revision),
      tombstones: input.tombstones,
      metadata: input.metadata,
      pluginData: snapshot.pluginData,
      signal: input.signal,
    })
  }

  async ensureProtocolDocument(options: ObjectOperationOptions = {}): Promise<void> {
    const existing = await this.provider.stat(SYNC_PROTOCOL_KEY, options)
    if (existing) return
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        minimumReaderVersion: '1.0.0',
      }),
    )
    await this.provider.write(SYNC_PROTOCOL_KEY, bytes, {
      contentType: 'application/json',
      digest: this.digest,
      signal: options.signal,
      ifNoneMatch: '*',
    })
  }

  async pull(options: ObjectOperationOptions = {}): Promise<PullSyncResult> {
    const entries = await this.provider.list(SYNC_DEVICE_PREFIX, options)
    const documents: DeviceSyncDocument[] = []
    const failures: Array<{ key: string; error: string }> = []

    for (const entry of entries) {
      if (!entry.key.endsWith('.json')) continue
      try {
        const bytes = await this.provider.read(entry.key, {
          signal: options.signal,
          headers: options.headers,
          retry: options.retry,
        })
        const text = new TextDecoder().decode(bytes)
        const document = await parseDeviceSyncDocument(text, this.digest)
        if (
          `${SYNC_DEVICE_PREFIX}${encodeURIComponent(document.deviceId)}.json` !==
          entry.key
        ) {
          throw new Error('device document path does not match its deviceId')
        }
        documents.push(document)
      } catch (error) {
        failures.push({
          key: entry.key,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      documents: documents.sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
      failures,
    }
  }

  merge(documents: readonly DeviceSyncDocument[]): MergedSyncDocuments {
    return mergeSyncDocuments(...documents)
  }

  async uploadBookObject(
    hash: string,
    bytes: Uint8Array,
    options: ObjectOperationOptions = {},
  ): Promise<ProviderWriteResult> {
    const expected = assertSha256(hash)
    const actual = await this.digest(bytes)
    if (actual.toLowerCase() !== expected) {
      throw new Error('book object checksum does not match its declared SHA-256')
    }
    return this.provider.write(`${SYNC_OBJECT_PREFIX}${expected}`, bytes, {
      contentType: 'application/octet-stream',
      digest: this.digest,
      signal: options.signal,
      headers: options.headers,
      retry: options.retry,
      ifNoneMatch: '*',
    })
  }

  async downloadBookObject(
    hash: string,
    options: ObjectOperationOptions = {},
  ): Promise<Uint8Array> {
    const expected = assertSha256(hash)
    return this.provider.read(`${SYNC_OBJECT_PREFIX}${expected}`, {
      expectedSha256: expected,
      digest: this.digest,
      signal: options.signal,
      headers: options.headers,
      retry: options.retry,
    })
  }

  async downloadBook(
    book: Pick<Book, 'sha256'>,
    options: ObjectOperationOptions = {},
  ): Promise<Uint8Array> {
    return this.downloadBookObject(book.sha256, options)
  }

  async deleteBookObject(
    hash: string,
    options: ObjectOperationOptions = {},
  ): Promise<void> {
    await this.provider.remove(`${SYNC_OBJECT_PREFIX}${assertSha256(hash)}`, options)
  }

  buildTombstone(input: {
    entityType: string
    entityId: string
    revision: number
    deviceId?: string
    hash?: string
    at?: string
  }): SyncTombstone {
    return {
      id: `${input.entityType}:${input.entityId}:${input.revision}:${input.deviceId ?? this.deviceId}`,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.hash ? { hash: input.hash } : {}),
      at: input.at ?? this.now(),
      deviceId: input.deviceId ?? this.deviceId,
      revision: input.revision,
      revisionStamp: {
        counter: input.revision,
        deviceId: input.deviceId ?? this.deviceId,
      },
    }
  }

  buildBookDeletionTombstones(input: {
    book: Pick<Book, 'id' | 'sha256'>
    annotationIds?: readonly string[]
    revision: number
    at?: string
  }): SyncTombstone[] {
    const tombstones = [
      this.buildTombstone({
        entityType: 'book',
        entityId: input.book.id,
        hash: input.book.sha256,
        revision: input.revision,
        at: input.at,
      }),
    ]
    for (const annotationId of input.annotationIds ?? []) {
      tombstones.push(
        this.buildTombstone({
          entityType: 'annotation',
          entityId: annotationId,
          revision: input.revision,
          at: input.at,
        }),
      )
    }
    return tombstones
  }
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  return new SyncEngine(options)
}
