import type { ProviderProfile } from '../../src/types'
import { sha256Hex, type SyncDigest } from './sync'

export type ProviderHeaders = Record<string, string>

export interface ProviderTransportRequest {
  profile: Readonly<ProviderProfile>
  method: string
  key: string
  body?: Uint8Array
  headers?: ProviderHeaders
  signal?: AbortSignal
}

export interface ProviderTransportResponse {
  status: number
  headers: ProviderHeaders
  body?: Uint8Array | number[]
}

export interface NativeProviderTransport {
  request(request: ProviderTransportRequest): Promise<ProviderTransportResponse>
}

export interface NativeProviderHostRequest {
  op: 'provider.request'
  args: {
    profile: ProviderProfile
    method: string
    key: string
    body?: number[]
    headers?: ProviderHeaders
  }
}

export interface NativeProviderHostResponse {
  status: number
  headers: ProviderHeaders
  body?: number[]
}

export type NativeProviderHostCall = (
  request: NativeProviderHostRequest,
) => Promise<NativeProviderHostResponse>

export interface ProviderRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  retryableStatuses?: readonly number[]
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export interface ProviderRequestOptions {
  signal?: AbortSignal
  headers?: ProviderHeaders
  retry?: ProviderRetryOptions
}

export interface ProviderReadOptions extends ProviderRequestOptions {
  expectedSha256?: string
  digest?: SyncDigest
}

export interface ProviderRangeOptions extends ProviderReadOptions {
  start: number
  end?: number
}

export interface ProviderWriteOptions extends ProviderRequestOptions {
  contentType?: string
  ifMatch?: string
  ifNoneMatch?: string
  digest?: SyncDigest
}

export interface ProviderWriteResult {
  checksum: string
  status: number
  etag?: string
}

export interface ProviderObject {
  key: string
  size?: number
  etag?: string
  lastModified?: string
}

export interface ProviderStat extends ProviderObject {}

export interface ProviderCapabilities {
  conditionalWrite: boolean
  rangeRead: boolean
  serverChecksums: boolean
  move: boolean
  versioning: boolean
  multipartUpload: boolean
  etag: boolean
}

export interface StorageProvider {
  readonly profile: Readonly<ProviderProfile>
  readonly bindingId: string
  capabilities(options?: ProviderRequestOptions): Promise<ProviderCapabilities>
  list(prefix?: string, options?: ProviderRequestOptions): Promise<ProviderObject[]>
  stat(key: string, options?: ProviderRequestOptions): Promise<ProviderStat | undefined>
  read(key: string, options?: ProviderReadOptions): Promise<Uint8Array>
  readRange(key: string, options: ProviderRangeOptions): Promise<Uint8Array>
  write(key: string, bytes: Uint8Array, options?: ProviderWriteOptions): Promise<ProviderWriteResult>
  remove(key: string, options?: ProviderRequestOptions): Promise<void>
  move?(
    sourceKey: string,
    destinationKey: string,
    options?: ProviderRequestOptions,
  ): Promise<void>
}

export interface ProviderEngineBinding {
  profileId: string
  profileType: ProviderProfile['type']
  bindingId: string
}

export class ProviderError extends Error {
  readonly code: string
  readonly status?: number
  readonly retryable: boolean

  constructor(
    message: string,
    options: {
      code?: string
      status?: number
      retryable?: boolean
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderError'
    this.code = options.code ?? 'PROVIDER_ERROR'
    this.status = options.status
    this.retryable = options.retryable ?? false
  }
}

export class ProviderBindingError extends ProviderError {
  constructor(message: string) {
    super(message, { code: 'PROVIDER_BINDING_MISMATCH', retryable: false })
    this.name = 'ProviderBindingError'
  }
}

function normalizeHeaders(headers: ProviderHeaders | undefined): ProviderHeaders {
  const normalized: ProviderHeaders = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = value
  }
  return normalized
}

function responseHeader(headers: ProviderHeaders, name: string): string | undefined {
  return headers[name.toLowerCase()]
}

function toBytes(body: Uint8Array | number[] | undefined): Uint8Array {
  if (!body) return new Uint8Array()
  return body instanceof Uint8Array ? new Uint8Array(body) : Uint8Array.from(body)
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('request aborted'))
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      reject(signal?.reason ?? new Error('request aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('request aborted')
}

function providerProfileCopy(profile: ProviderProfile): Readonly<ProviderProfile> {
  if (!profile.id) throw new ProviderError('provider profile id is required')
  if (profile.type !== 'webdav' && profile.type !== 's3') {
    throw new ProviderError(`unsupported provider type: ${String(profile.type)}`)
  }
  if (!profile.endpoint) throw new ProviderError('provider endpoint is required')
  if (!profile.credentialId) throw new ProviderError('provider credentialId is required')
  return Object.freeze({ ...profile })
}

function encodeLogicalKey(key: string): string {
  return key
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function xmlTagValues(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${escaped}>`,
    'gi',
  )
  return [...xml.matchAll(expression)].map((match) => decodeXml(match[1].trim()))
}

function xmlBlocks(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${escaped}>`,
    'gi',
  )
  return [...xml.matchAll(expression)].map((match) => match[1])
}

function objectKeyFromHref(href: string, profile: ProviderProfile): string {
  let path: string
  try {
    path = decodeURIComponent(new URL(href).pathname)
  } catch {
    path = decodeURIComponent(href)
  }
  const prefix = profile.prefix.replace(/^\/+|\/+$/g, '')
  const normalized = path.replace(/^\/+/, '')
  if (!prefix) return normalized.replace(/\/+$/, '')
  const marker = `${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`
  const expression = new RegExp(`(?:^|/)${marker}`)
  const match = expression.exec(normalized)
  return (match ? normalized.slice(match.index + (match[0].startsWith('/') ? 1 : 0)) : normalized)
    .replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '')
    .replace(/\/+$/, '')
}

function appendQuery(key: string, query: Record<string, string>): string {
  const parameters = new URLSearchParams(query)
  return `${key}${key.includes('?') ? '&' : '?'}${parameters.toString()}`
}

function abortableHostRequest<T>(
  request: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return request
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('request aborted'))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('request aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    request.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
    if (signal.aborted) onAbort()
  })
}

export function createHostProviderTransport(
  hostCall: NativeProviderHostCall,
): NativeProviderTransport {
  return {
    async request(request) {
      throwIfAborted(request.signal)
      let response: NativeProviderHostResponse
      try {
        response = await abortableHostRequest(
          hostCall({
            op: 'provider.request',
            args: {
              profile: { ...request.profile },
              method: request.method,
              key: request.key,
              ...(request.body ? { body: [...request.body] } : {}),
              ...(request.headers ? { headers: { ...request.headers } } : {}),
            },
          }),
          request.signal,
        )
      } catch (error) {
        throwIfAborted(request.signal)
        if (error instanceof ProviderError) throw error
        throw new ProviderError('native provider request failed', {
          code: 'NATIVE_REQUEST_FAILED',
          retryable: true,
          cause: error,
        })
      }
      throwIfAborted(request.signal)
      return {
        status: response.status,
        headers: normalizeHeaders(response.headers),
        body: toBytes(response.body),
      }
    },
  }
}

export const createNativeProviderTransport = createHostProviderTransport

export function providerSyncExclusionKeys(): readonly string[] {
  return [
    'roots',
    'rootId',
    'relativePath',
    'provider',
    'credentialId',
    'accessKeyId',
    'password',
    'secret',
    'token',
  ]
}

abstract class BoundProvider implements StorageProvider {
  readonly profile: Readonly<ProviderProfile>
  readonly bindingId: string
  protected readonly transport: NativeProviderTransport
  protected readonly digest: SyncDigest
  protected readonly sleep: NonNullable<ProviderRetryOptions['sleep']>

  protected constructor(
    profile: ProviderProfile,
    transport: NativeProviderTransport,
    digest: SyncDigest,
    sleep: NonNullable<ProviderRetryOptions['sleep']>,
  ) {
    this.profile = providerProfileCopy(profile)
    this.transport = transport
    this.digest = digest
    this.sleep = sleep
    this.bindingId = `${this.profile.type}:${this.profile.id}`
  }

  abstract capabilities(options?: ProviderRequestOptions): Promise<ProviderCapabilities>
  abstract list(prefix?: string, options?: ProviderRequestOptions): Promise<ProviderObject[]>
  abstract stat(key: string, options?: ProviderRequestOptions): Promise<ProviderStat | undefined>

  binding(): ProviderEngineBinding {
    return {
      profileId: this.profile.id,
      profileType: this.profile.type,
      bindingId: this.bindingId,
    }
  }

  protected async request(
    method: string,
    key: string,
    options: ProviderRequestOptions = {},
    body?: Uint8Array,
    keyIncludesPrefix = false,
  ): Promise<ProviderTransportResponse> {
    const retry = options.retry ?? {}
    const maxAttempts = Math.max(1, Math.floor(retry.maxAttempts ?? 3))
    const retryableStatuses = retry.retryableStatuses ?? []
    const sleep = retry.sleep ?? this.sleep

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfAborted(options.signal)
      let response: ProviderTransportResponse | undefined
      let requestError: unknown
      try {
        response = await this.transport.request({
          profile: this.profile,
          method,
          key: keyIncludesPrefix ? key : this.storageKey(key),
          ...(body ? { body: new Uint8Array(body) } : {}),
          ...(options.headers ? { headers: normalizeHeaders(options.headers) } : {}),
          signal: options.signal,
        })
      } catch (error) {
        requestError = error
        if (options.signal?.aborted) throw options.signal.reason ?? error
      }

      const retryable =
        requestError !== undefined ||
        (response !== undefined &&
          (retryableStatuses.includes(response.status) ||
            defaultRetryableStatus(response.status)))
      if (response && response.status < 400) return response
      if (!retryable || attempt >= maxAttempts) {
        if (response) {
          throw new ProviderError(`provider request failed with HTTP ${response.status}`, {
            code: response.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR',
            status: response.status,
            retryable: defaultRetryableStatus(response.status),
          })
        }
        if (requestError instanceof ProviderError) throw requestError
        throw new ProviderError('provider request failed', {
          code: 'NETWORK_ERROR',
          retryable: true,
          cause: requestError,
        })
      }

      const delay = Math.min(
        retry.maxDelayMs ?? 8_000,
        (retry.baseDelayMs ?? 250) * 2 ** Math.max(0, attempt - 1),
      )
      await sleep(delay, options.signal)
    }

    throw new ProviderError('provider request exhausted retries', {
      code: 'RETRY_EXHAUSTED',
      retryable: true,
    })
  }

  protected storageKey(key: string): string {
    const prefix = this.profile.prefix
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
    const queryIndex = key.indexOf('?')
    const rawPath = queryIndex < 0 ? key : key.slice(0, queryIndex)
    const query = queryIndex < 0 ? '' : key.slice(queryIndex + 1)
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '')
    const encodedPath = !prefix
      ? encodeLogicalKey(normalized)
      : !normalized
        ? encodeLogicalKey(prefix)
        : encodeLogicalKey(`${prefix}/${normalized}`)
    return query ? `${encodedPath}?${query}` : encodedPath
  }

  protected stripProviderPrefix(key: string): string {
    const prefix = this.profile.prefix
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
    if (!prefix) return key.replace(/^\/+/, '')
    if (key === prefix) return ''
    if (key.startsWith(`${prefix}/`)) return key.slice(prefix.length + 1)
    return key
  }

  async read(key: string, options: ProviderReadOptions = {}): Promise<Uint8Array> {
    const response = await this.request(
      'GET',
      key,
      {
        ...options,
        headers: { ...(options.headers ?? {}), Accept: 'application/octet-stream' },
      },
    )
    const body = toBytes(response.body)
    if (options.expectedSha256) {
      const actual = await (options.digest ?? this.digest)(body)
      if (actual.toLowerCase() !== options.expectedSha256.toLowerCase()) {
        throw new ProviderError('downloaded object checksum mismatch', {
          code: 'CHECKSUM_MISMATCH',
          retryable: true,
        })
      }
    }
    return body
  }

  async readRange(key: string, options: ProviderRangeOptions): Promise<Uint8Array> {
    if (!Number.isInteger(options.start) || options.start < 0) {
      throw new TypeError('range start must be a non-negative integer')
    }
    if (
      options.end !== undefined &&
      (!Number.isInteger(options.end) || options.end < options.start)
    ) {
      throw new TypeError('range end must be an integer at or after range start')
    }
    const range = `bytes=${options.start}-${options.end ?? ''}`
    return this.read(key, {
      ...options,
      headers: { ...(options.headers ?? {}), Range: range },
    })
  }

  async write(
    key: string,
    bytes: Uint8Array,
    options: ProviderWriteOptions = {},
  ): Promise<ProviderWriteResult> {
    const checksum = await (options.digest ?? this.digest)(bytes)
    const headers: ProviderHeaders = {
      'Content-Type': options.contentType ?? 'application/octet-stream',
      'x-granite-sha256': checksum,
      ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
      ...(options.ifNoneMatch ? { 'If-None-Match': options.ifNoneMatch } : {}),
      ...(options.headers ?? {}),
    }
    const response = await this.request('PUT', key, {
      ...options,
      headers,
    }, new Uint8Array(bytes))

    const serverChecksum = responseHeader(response.headers, 'x-granite-sha256')
    const responseEtag = responseHeader(response.headers, 'etag')
    const result = {
      checksum,
      status: response.status,
      ...(responseEtag ? { etag: responseEtag } : {}),
    }
    if (serverChecksum && serverChecksum.toLowerCase() !== checksum.toLowerCase()) {
      throw new ProviderError('provider reported a different uploaded checksum', {
        code: 'CHECKSUM_MISMATCH',
        retryable: false,
      })
    }
    return result
  }

  async remove(key: string, options: ProviderRequestOptions = {}): Promise<void> {
    try {
      await this.request('DELETE', key, options)
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return
      throw error
    }
  }
}

export interface WebDavProviderOptions {
  digest?: SyncDigest
  sleep?: NonNullable<ProviderRetryOptions['sleep']>
}

export class WebDavProvider extends BoundProvider {
  private readonly ensuredCollections = new Set<string>()
  private readonly pendingCollections = new Map<string, Promise<void>>()

  constructor(
    profile: ProviderProfile,
    transport: NativeProviderTransport,
    options: WebDavProviderOptions = {},
  ) {
    if (profile.type !== 'webdav') throw new ProviderBindingError('WebDAV provider requires a webdav profile')
    super(profile, transport, options.digest ?? sha256Hex, options.sleep ?? defaultSleep)
  }

  async capabilities(options: ProviderRequestOptions = {}): Promise<ProviderCapabilities> {
    let response: ProviderTransportResponse | undefined
    try {
      response = await this.request('OPTIONS', '', options)
    } catch {
      response = undefined
    }
    const allow = responseHeader(response?.headers ?? {}, 'allow')?.toLowerCase() ?? ''
    const dav = responseHeader(response?.headers ?? {}, 'dav')?.toLowerCase() ?? ''
    return {
      conditionalWrite: true,
      rangeRead: allow ? allow.includes('get') : true,
      serverChecksums: false,
      move: allow ? allow.includes('move') : true,
      versioning: dav.includes('version-control'),
      multipartUpload: false,
      etag: true,
    }
  }

  async list(
    prefix = '',
    options: ProviderRequestOptions = {},
  ): Promise<ProviderObject[]> {
    const key = prefix
    const body = new TextEncoder().encode(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<d:propfind xmlns:d="DAV:"><d:prop>' +
        '<d:displayname/><d:getcontentlength/><d:getetag/><d:getlastmodified/>' +
        '</d:prop></d:propfind>',
    )
    const response = await this.request(
      'PROPFIND',
      key,
      {
        ...options,
        headers: { ...(options.headers ?? {}), Depth: '1', 'Content-Type': 'application/xml' },
      },
      body,
    )
    const xml = new TextDecoder().decode(toBytes(response.body))
    const objects: ProviderObject[] = []
    for (const block of xmlBlocks(xml, 'response')) {
      const href = xmlTagValues(block, 'href')[0]
      if (!href) continue
      const keyFromResponse = objectKeyFromHref(href, this.profile)
      if (!keyFromResponse || (prefix && keyFromResponse === prefix.replace(/\/+$/, ''))) continue
      const sizeText = xmlTagValues(block, 'getcontentlength')[0]
      const etag = xmlTagValues(block, 'getetag')[0]?.replace(/^W\//, '').replace(/"/g, '')
      const lastModified = xmlTagValues(block, 'getlastmodified')[0]
      objects.push({
        key: this.stripProviderPrefix(keyFromResponse),
        ...(sizeText && Number.isFinite(Number(sizeText)) ? { size: Number(sizeText) } : {}),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      })
    }
    return objects.sort((left, right) => left.key.localeCompare(right.key))
  }

  async stat(key: string, options: ProviderRequestOptions = {}): Promise<ProviderStat | undefined> {
    try {
      const response = await this.request('HEAD', key, options)
      const sizeHeader = responseHeader(response.headers, 'content-length')
      return {
        key,
        ...(sizeHeader && Number.isFinite(Number(sizeHeader))
          ? { size: Number(sizeHeader) }
          : {}),
        ...(responseHeader(response.headers, 'etag')
          ? { etag: responseHeader(response.headers, 'etag') }
          : {}),
        ...(responseHeader(response.headers, 'last-modified')
          ? { lastModified: responseHeader(response.headers, 'last-modified') }
          : {}),
      }
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return undefined
      throw error
    }
  }

  async move(
    sourceKey: string,
    destinationKey: string,
    options: ProviderRequestOptions = {},
  ): Promise<void> {
    const destination = new URL(
      this.storageKey(destinationKey),
      this.profile.endpoint.endsWith('/')
        ? this.profile.endpoint
        : `${this.profile.endpoint}/`,
    ).toString()
    await this.request('MOVE', sourceKey, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        Destination: destination,
        Overwrite: 'F',
      },
    })
  }

  override async write(
    key: string,
    bytes: Uint8Array,
    options: ProviderWriteOptions = {},
  ): Promise<ProviderWriteResult> {
    await this.ensureParentCollections(key, options)
    return super.write(key, bytes, options)
  }

  private async ensureParentCollections(
    key: string,
    options: ProviderRequestOptions,
  ): Promise<void> {
    const storageKey = this.storageKey(key)
    const segments = storageKey.split('/')
    segments.pop()
    for (let index = 1; index <= segments.length; index += 1) {
      await this.ensureCollection(segments.slice(0, index).join('/'), options)
    }
  }

  private async ensureCollection(
    collectionKey: string,
    options: ProviderRequestOptions,
  ): Promise<void> {
    if (!collectionKey || this.ensuredCollections.has(collectionKey)) return
    const pending = this.pendingCollections.get(collectionKey)
    if (pending) {
      await pending
      return
    }

    const creation = (async () => {
      try {
        await this.request('MKCOL', collectionKey, options, undefined, true)
      } catch (error) {
        if (!(error instanceof ProviderError && error.status === 405)) throw error
      }
      this.ensuredCollections.add(collectionKey)
    })()
    this.pendingCollections.set(collectionKey, creation)
    try {
      await creation
    } finally {
      this.pendingCollections.delete(collectionKey)
    }
  }
}

export interface S3ProviderOptions {
  digest?: SyncDigest
  sleep?: NonNullable<ProviderRetryOptions['sleep']>
}

export class S3Provider extends BoundProvider {
  constructor(
    profile: ProviderProfile,
    transport: NativeProviderTransport,
    options: S3ProviderOptions = {},
  ) {
    if (profile.type !== 's3') throw new ProviderBindingError('S3 provider requires an s3 profile')
    if (!profile.bucket) throw new ProviderBindingError('S3 provider requires a bucket')
    super(profile, transport, options.digest ?? sha256Hex, options.sleep ?? defaultSleep)
  }

  async capabilities(_options: ProviderRequestOptions = {}): Promise<ProviderCapabilities> {
    return {
      conditionalWrite: true,
      rangeRead: true,
      serverChecksums: true,
      move: true,
      versioning: true,
      multipartUpload: true,
      etag: true,
    }
  }

  async list(
    prefix = '',
    options: ProviderRequestOptions = {},
  ): Promise<ProviderObject[]> {
    const objects: ProviderObject[] = []
    let continuationToken: string | undefined

    do {
      const query: Record<string, string> = {
        'list-type': '2',
        prefix: this.storageKey(prefix),
      }
      if (continuationToken) query['continuation-token'] = continuationToken
      const response = await this.request(
        'GET',
        appendQuery('', query),
        options,
      )
      const xml = new TextDecoder().decode(toBytes(response.body))
      for (const block of xmlBlocks(xml, 'Contents')) {
        const key = xmlTagValues(block, 'Key')[0]
        if (!key) continue
        const sizeText = xmlTagValues(block, 'Size')[0]
        const etag = xmlTagValues(block, 'ETag')[0]?.replace(/"/g, '')
        const lastModified = xmlTagValues(block, 'LastModified')[0]
        objects.push({
          key: this.stripProviderPrefix(key),
          ...(sizeText && Number.isFinite(Number(sizeText)) ? { size: Number(sizeText) } : {}),
          ...(etag ? { etag } : {}),
          ...(lastModified ? { lastModified } : {}),
        })
      }
      const truncated = xmlTagValues(xml, 'IsTruncated')[0]?.toLowerCase() === 'true'
      continuationToken = truncated
        ? xmlTagValues(xml, 'NextContinuationToken')[0]
        : undefined
    } while (continuationToken)

    return objects.sort((left, right) => left.key.localeCompare(right.key))
  }

  async stat(key: string, options: ProviderRequestOptions = {}): Promise<ProviderStat | undefined> {
    try {
      const response = await this.request('HEAD', key, options)
      const sizeHeader = responseHeader(response.headers, 'content-length')
      return {
        key,
        ...(sizeHeader && Number.isFinite(Number(sizeHeader))
          ? { size: Number(sizeHeader) }
          : {}),
        ...(responseHeader(response.headers, 'etag')
          ? { etag: responseHeader(response.headers, 'etag') }
          : {}),
        ...(responseHeader(response.headers, 'last-modified')
          ? { lastModified: responseHeader(response.headers, 'last-modified') }
          : {}),
      }
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return undefined
      throw error
    }
  }

  async move(
    sourceKey: string,
    destinationKey: string,
    options: ProviderRequestOptions = {},
  ): Promise<void> {
    const source = this.storageKey(sourceKey)
    await this.request('PUT', destinationKey, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        'x-amz-copy-source': `/${this.profile.bucket}/${source}`,
      },
    })
    await this.remove(sourceKey, options)
  }
}

export function createWebDavProvider(
  profile: ProviderProfile,
  transport: NativeProviderTransport,
  options: WebDavProviderOptions = {},
): WebDavProvider {
  return new WebDavProvider(profile, transport, options)
}

export function createS3Provider(
  profile: ProviderProfile,
  transport: NativeProviderTransport,
  options: S3ProviderOptions = {},
): S3Provider {
  return new S3Provider(profile, transport, options)
}

export function createProvider(
  profile: ProviderProfile,
  transport: NativeProviderTransport,
  options: WebDavProviderOptions & S3ProviderOptions = {},
): StorageProvider {
  return profile.type === 'webdav'
    ? createWebDavProvider(profile, transport, options)
    : createS3Provider(profile, transport, options)
}
