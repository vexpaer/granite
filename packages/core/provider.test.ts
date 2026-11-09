import { describe, expect, it } from 'vitest'
import type { ProviderProfile } from '../../src/types'
import {
  createHostProviderTransport,
  createS3Provider,
  createWebDavProvider,
  ProviderError,
  sha256Hex,
  type NativeProviderTransport,
  type ProviderTransportRequest,
  type ProviderTransportResponse,
} from './index'

const webDavProfile: ProviderProfile = {
  id: 'webdav-main',
  type: 'webdav',
  name: 'WebDAV',
  endpoint: 'https://dav.example/base',
  username: 'reader',
  prefix: 'Granite',
  credentialId: 'credential-1',
}

const s3Profile: ProviderProfile = {
  id: 's3-main',
  type: 's3',
  name: 'S3',
  endpoint: 'https://s3.example',
  region: 'auto',
  bucket: 'books',
  prefix: 'Granite',
  credentialId: 'credential-2',
  accessKeyId: 'access-id',
}

class RecordingTransport implements NativeProviderTransport {
  readonly requests: ProviderTransportRequest[] = []

  constructor(
    private readonly responder: (
      request: ProviderTransportRequest,
    ) => ProviderTransportResponse | Promise<ProviderTransportResponse>,
  ) {}

  async request(request: ProviderTransportRequest): Promise<ProviderTransportResponse> {
    this.requests.push({
      ...request,
      headers: request.headers ? { ...request.headers } : undefined,
      body: request.body ? new Uint8Array(request.body) : undefined,
    })
    return this.responder(request)
  }
}

function response(
  status = 200,
  body: string | Uint8Array = '',
  headers: Record<string, string> = {},
): ProviderTransportResponse {
  return {
    status,
    headers,
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  }
}

describe('native provider transport', () => {
  it('uses the exact provider.request host shape', async () => {
    let captured: unknown
    const transport = createHostProviderTransport(async (request) => {
      captured = request
      return { status: 201, headers: { ETag: 'etag-1' }, body: [1, 2] }
    })

    const result = await transport.request({
      profile: webDavProfile,
      method: 'PUT',
      key: 'Granite/file.bin',
      body: Uint8Array.from([9, 8]),
      headers: { 'Content-Type': 'application/octet-stream' },
    })

    expect(captured).toEqual({
      op: 'provider.request',
      args: {
        profile: webDavProfile,
        method: 'PUT',
        key: 'Granite/file.bin',
        body: [9, 8],
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    })
    expect([...result.body!]).toEqual([1, 2])
  })

  it('rejects a cancelled host request without waiting for the transport', async () => {
    let announceStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    let finishHostCall: ((value: {
      status: number
      headers: Record<string, string>
      body: number[]
    }) => void) | undefined
    const transport = createHostProviderTransport(
      () =>
        new Promise((resolve) => {
          finishHostCall = resolve
          announceStarted?.()
        }),
    )
    const controller = new AbortController()
    const request = transport.request({
      profile: webDavProfile,
      method: 'GET',
      key: 'Granite/cancel.bin',
      signal: controller.signal,
    })

    await started
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })

    finishHostCall?.({ status: 200, headers: {}, body: [1] })
  })
})

describe('WebDAV provider', () => {
  it('creates every parent collection once before writing under the profile prefix', async () => {
    const transport = new RecordingTransport(() => response(201))
    const provider = createWebDavProvider(webDavProfile, transport, {
      digest: async () => 'a'.repeat(64),
    })

    await provider.write(
      'sync/devices/device-a.json',
      new TextEncoder().encode('{}'),
      { contentType: 'application/json', ifNoneMatch: '*' },
    )
    await provider.write(
      'sync/devices/device-b.json',
      new TextEncoder().encode('{}'),
      { contentType: 'application/json' },
    )

    expect(transport.requests.map((request) => [request.method, request.key])).toEqual([
      ['MKCOL', 'Granite'],
      ['MKCOL', 'Granite/sync'],
      ['MKCOL', 'Granite/sync/devices'],
      ['PUT', 'Granite/sync/devices/device-a.json'],
      ['PUT', 'Granite/sync/devices/device-b.json'],
    ])
    expect(transport.requests[3].headers).toMatchObject({
      'content-type': 'application/json',
      'if-none-match': '*',
      'x-granite-sha256': 'a'.repeat(64),
    })
    expect(Object.isFrozen(provider.profile)).toBe(true)
    expect(provider.binding()).toEqual({
      profileId: 'webdav-main',
      profileType: 'webdav',
      bindingId: 'webdav:webdav-main',
    })
  })

  it('treats an existing collection and a missing delete target as success', async () => {
    const transport = new RecordingTransport((request) => {
      if (request.method === 'MKCOL') return response(405)
      if (request.method === 'DELETE') return response(404)
      return response(201)
    })
    const provider = createWebDavProvider(webDavProfile, transport)

    await provider.write('a/b.txt', Uint8Array.from([1]))
    await expect(provider.remove('a/missing.txt')).resolves.toBeUndefined()
  })
})

describe('S3 provider', () => {
  it('uses one prefixed key and strips the prefix from list results', async () => {
    const xml =
      '<ListBucketResult>' +
      '<IsTruncated>false</IsTruncated>' +
      '<Contents><Key>Granite/sync/devices/device-a.json</Key><Size>12</Size>' +
      '<ETag>"etag-a"</ETag><LastModified>2026-11-09T00:00:00Z</LastModified></Contents>' +
      '</ListBucketResult>'
    const transport = new RecordingTransport(() => response(200, xml))
    const provider = createS3Provider(s3Profile, transport, {
      digest: async () => 'b'.repeat(64),
    })

    const listed = await provider.list('sync/devices')
    expect(listed).toEqual([
      {
        key: 'sync/devices/device-a.json',
        size: 12,
        etag: 'etag-a',
        lastModified: '2026-11-09T00:00:00Z',
      },
    ])
    expect(transport.requests[0].key).toBe(
      'Granite?list-type=2&prefix=Granite%2Fsync%2Fdevices',
    )

    await provider.write('objects/sha256/hash', Uint8Array.from([1, 2]))
    expect(transport.requests[1].key).toBe('Granite/objects/sha256/hash')
  })
})

describe('provider integrity and errors', () => {
  it('rejects a downloaded object whose checksum does not match', async () => {
    const bytes = new TextEncoder().encode('corrupt')
    const transport = new RecordingTransport(() => response(200, bytes))
    const provider = createWebDavProvider(webDavProfile, transport)

    await expect(
      provider.read('book.epub', { expectedSha256: '0'.repeat(64) }),
    ).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
      retryable: true,
    } satisfies Partial<ProviderError>)
  })

  it('can verify a good object and expose retryable HTTP failures', async () => {
    const bytes = new TextEncoder().encode('healthy')
    const checksum = await sha256Hex(bytes)
    const transport = new RecordingTransport((request) =>
      request.key.endsWith('missing') ? response(503) : response(200, bytes),
    )
    const provider = createWebDavProvider(webDavProfile, transport, {
      sleep: async () => undefined,
    })

    await expect(
      provider.read('healthy.epub', { expectedSha256: checksum }),
    ).resolves.toEqual(bytes)
    await expect(
      provider.read('missing', { retry: { maxAttempts: 2 } }),
    ).rejects.toMatchObject({
      status: 503,
      retryable: true,
    })
  })
})
