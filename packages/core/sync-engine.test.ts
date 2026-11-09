import { describe, expect, it } from 'vitest'
import type { ProviderProfile } from '../../src/types'
import {
  createSyncEngine,
  ProviderError,
  sha256Hex,
  type ProviderCapabilities,
  type ProviderObject,
  type ProviderRangeOptions,
  type ProviderReadOptions,
  type ProviderRequestOptions,
  type ProviderStat,
  type ProviderWriteOptions,
  type ProviderWriteResult,
  type StorageProvider,
  type SyncRevision,
  type SyncSnapshot,
} from './index'

class MemoryProvider implements StorageProvider {
  readonly profile: Readonly<ProviderProfile> = Object.freeze({
    id: 'memory',
    type: 'webdav',
    name: 'Memory',
    endpoint: 'https://memory.invalid',
    prefix: 'Granite',
    credentialId: 'memory-credential',
  })
  readonly bindingId = 'webdav:memory'
  readonly objects = new Map<string, Uint8Array>()

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      conditionalWrite: true,
      rangeRead: true,
      serverChecksums: true,
      move: true,
      versioning: false,
      multipartUpload: false,
      etag: true,
    }
  }

  async list(prefix = ''): Promise<ProviderObject[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => ({ key, size: bytes.byteLength }))
      .sort((left, right) => left.key.localeCompare(right.key))
  }

  async stat(key: string): Promise<ProviderStat | undefined> {
    const bytes = this.objects.get(key)
    return bytes ? { key, size: bytes.byteLength } : undefined
  }

  async read(key: string, options: ProviderReadOptions = {}): Promise<Uint8Array> {
    const bytes = this.objects.get(key)
    if (!bytes) throw new ProviderError('not found', { status: 404 })
    if (
      options.expectedSha256 &&
      (await (options.digest ?? sha256Hex)(bytes)) !== options.expectedSha256
    ) {
      throw new ProviderError('checksum mismatch', {
        code: 'CHECKSUM_MISMATCH',
        retryable: true,
      })
    }
    return new Uint8Array(bytes)
  }

  async readRange(key: string, options: ProviderRangeOptions): Promise<Uint8Array> {
    const bytes = await this.read(key, options)
    return bytes.slice(options.start, options.end === undefined ? undefined : options.end + 1)
  }

  async write(
    key: string,
    bytes: Uint8Array,
    options: ProviderWriteOptions = {},
  ): Promise<ProviderWriteResult> {
    if (options.ifNoneMatch === '*' && this.objects.has(key)) {
      throw new ProviderError('precondition failed', { status: 412 })
    }
    this.objects.set(key, new Uint8Array(bytes))
    return {
      checksum: await (options.digest ?? sha256Hex)(bytes),
      status: 201,
    }
  }

  async remove(key: string, _options: ProviderRequestOptions = {}): Promise<void> {
    this.objects.delete(key)
  }
}

const snapshot: SyncSnapshot = {
  books: [
    {
      id: 'book-1',
      title: 'Book',
      authors: ['Author'],
      format: 'epub',
      sha256: 'a'.repeat(64),
      size: 100,
      status: 'reading',
      favorite: false,
      tagIds: ['tag-1'],
      collectionIds: [],
      location: {
        progress: 0.25,
        updatedAt: '2026-11-09T00:00:00.000Z',
      },
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
    },
  ],
  notes: [],
  tags: [],
  collections: [],
  sessions: [],
  annotations: [],
  settings: {
    username: 'reader',
    theme: 'system',
    density: 'comfortable',
    language: 'en',
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
    syncPolicy: 'metadata',
    syncBookIds: [],
    syncCollectionIds: [],
    profile: 'default',
    sidebarExpanded: true,
    shortcuts: {},
    layout: {},
  },
  pluginData: { 'future.plugin': { schema: 2 } },
}

describe('SyncEngine transport and snapshot helpers', () => {
  it('validates protocol documents and tolerates a concurrent create winner', async () => {
    const provider = new MemoryProvider()
    const engine = createSyncEngine({ provider, deviceId: 'device-a' })
    await engine.ensureProtocolDocument()
    expect(provider.objects.has('sync/protocol-version.json')).toBe(true)

    provider.objects.set(
      'sync/protocol-version.json',
      new TextEncoder().encode(JSON.stringify({ protocolVersion: 2 })),
    )
    await expect(engine.ensureProtocolDocument()).rejects.toThrow(
      'remote sync protocol 2 is incompatible with 1',
    )

    provider.objects.delete('sync/protocol-version.json')
    const originalWrite = provider.write.bind(provider)
    let raced = false
    provider.write = async (key, bytes, options) => {
      if (key === 'sync/protocol-version.json' && !raced) {
        raced = true
        provider.objects.set(
          key,
          new TextEncoder().encode(JSON.stringify({ protocolVersion: 1 })),
        )
        throw new ProviderError('precondition failed', { status: 412 })
      }
      return originalWrite(key, bytes, options)
    }
    await expect(engine.ensureProtocolDocument()).resolves.toBeUndefined()
  })

  it('publishes a per-device snapshot and rejects a document at another device path', async () => {
    const provider = new MemoryProvider()
    const engine = createSyncEngine({
      provider,
      deviceId: 'device-a',
      now: () => '2026-11-09T00:00:00.000Z',
    })
    const revision: SyncRevision = { counter: 3, deviceId: 'device-a' }
    const mapped = engine.mapSnapshot(snapshot, revision.counter)

    expect(mapped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'reading-progress',
          entityId: 'book-1',
          revision,
        }),
        expect.objectContaining({
          entityType: 'settings',
          entityId: 'app',
        }),
      ]),
    )

    await engine.publishSnapshot(snapshot, { revision: revision.counter })
    const pulled = await engine.pull()
    expect(pulled.failures).toEqual([])
    expect(pulled.documents[0]).toMatchObject({
      deviceId: 'device-a',
      pluginData: { 'future.plugin': { schema: 2 } },
    })

    const validDocument = pulled.documents[0]!
    provider.objects.set(
      'sync/devices/device-b.json',
      new TextEncoder().encode(JSON.stringify(validDocument)),
    )
    expect((await engine.pull()).failures).toEqual([
      expect.objectContaining({
        key: 'sync/devices/device-b.json',
        error: 'device document path does not match its deviceId',
      }),
    ])
  })

  it('checks book-object checksums on upload and download', async () => {
    const provider = new MemoryProvider()
    const engine = createSyncEngine({ provider, deviceId: 'device-a' })
    const bytes = new TextEncoder().encode('book bytes')
    const hash = await sha256Hex(bytes)

    await engine.uploadBookObject(hash, bytes)
    await expect(engine.downloadBookObject(hash)).resolves.toEqual(bytes)
    await expect(
      engine.uploadBookObject('0'.repeat(64), bytes),
    ).rejects.toThrow('checksum')

    await engine.deleteBookObject(hash)
    expect(provider.objects.has(`objects/sha256/${hash}`)).toBe(false)
  })
})
