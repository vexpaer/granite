import { compare, valid } from 'semver'
import type { InstalledPlugin } from '../types'
import { hostCall } from './host'
import { verifyBundleIntegrity } from '../../packages/core/plugins'

export const PLUGIN_REGISTRY_SCHEMA_VERSION = 1
export const PLUGIN_REGISTRY_MAX_BYTES = 1024 * 1024
export const PLUGIN_REGISTRY_MAX_ENTRIES = 128
export const OFFICIAL_PLUGIN_REGISTRY_URL =
  'https://raw.githubusercontent.com/vexpaer/granite/main/public/plugin-registry.json'

const FIELD_LIMITS = {
  id: 128,
  name: 160,
  version: 128,
  description: 4000,
  author: 240,
  license: 240,
  packageUrl: 2048,
  integrity: 1024,
} as const

export interface PluginRegistryEntry {
  id: string
  name: string
  version: string
  description: string
  author: string
  license: string
  packageUrl: string
  integrity?: string
}

export interface PluginRegistryCatalog {
  schemaVersion: typeof PLUGIN_REGISTRY_SCHEMA_VERSION
  plugins: PluginRegistryEntry[]
}

export interface LoadedPluginRegistry {
  catalog: PluginRegistryCatalog
  byteLength: number
  sourceUrl: string
}

export type PluginRegistryByteFetcher = (
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<Uint8Array>

export interface FetchPluginRegistryOptions {
  signal?: AbortSignal
  fetchBytes?: PluginRegistryByteFetcher
}

export interface PluginRegistryUpdate {
  entry: PluginRegistryEntry
  installed: Pick<InstalledPlugin, 'id' | 'version'>
}

export async function verifyRegistryPackage(
  entry: PluginRegistryEntry,
  manifest: { id?: unknown; version?: unknown },
  bundle: Uint8Array,
): Promise<void> {
  if (manifest.id !== entry.id || valid(String(manifest.version)) !== entry.version)
    throw new Error('插件包标识或版本与目录条目不一致，未打开安装审查。')
  if (entry.integrity && !await verifyBundleIntegrity(bundle, entry.integrity))
    throw new Error('插件包与目录固定的 SRI 不一致，未打开安装审查。')
}

function registryError(message: string): never {
  throw new Error(`插件目录无效：${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(
  input: Record<string, unknown>,
  field: keyof typeof FIELD_LIMITS,
  path: string,
): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) {
    registryError(`${path}.${field} 必须是非空字符串`)
  }
  const normalized = value.trim()
  if (normalized.length > FIELD_LIMITS[field]) {
    registryError(`${path}.${field} 超过长度限制`)
  }
  return normalized
}

function normalizedHttpsUrl(value: string, path: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    registryError(`${path} 不是有效 URL`)
  }
  if (url.protocol !== 'https:') registryError(`${path} 必须使用 HTTPS`)
  if (!url.hostname) registryError(`${path} 缺少主机名`)
  if (url.username || url.password) {
    registryError(`${path} 不能包含嵌入凭证`)
  }
  url.hash = ''
  return url.toString()
}

function isValidSri(value: string): boolean {
  const entries = value.trim().split(/\s+/)
  if (!entries.length || entries.some((entry) => !entry)) return false
  const lengths: Record<string, readonly number[]> = {
    sha256: [43, 44],
    sha384: [64],
    sha512: [86, 88],
  }
  return entries.every((entry) => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})$/.exec(
      entry,
    )
    if (!match) return false
    return lengths[match[1]].includes(match[2].length)
  })
}

function parseEntry(input: unknown, index: number): PluginRegistryEntry {
  const path = `plugins.${index}`
  if (!isRecord(input)) registryError(`${path} 必须是对象`)

  const id = requiredString(input, 'id', path)
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    registryError(`${path}.id 必须是小写稳定标识符`)
  }
  if (id === 'granite.profiles' || id.startsWith('granite.local-')) {
    registryError(`${path}.id 使用了 Granite 保留命名空间`)
  }

  const versionInput = requiredString(input, 'version', path)
  const version = valid(versionInput)
  if (!version) registryError(`${path}.version 必须是语义化版本`)

  const packageUrl = normalizedHttpsUrl(
    requiredString(input, 'packageUrl', path),
    `${path}.packageUrl`,
  )
  let integrity: string | undefined
  if (Object.prototype.hasOwnProperty.call(input, 'integrity')) {
    integrity = requiredString(input, 'integrity', path)
    if (!isValidSri(integrity)) {
      registryError(`${path}.integrity 必须是有效的 SHA-256/384/512 SRI`)
    }
  }

  return {
    id,
    name: requiredString(input, 'name', path),
    version,
    description: requiredString(input, 'description', path),
    author: requiredString(input, 'author', path),
    license: requiredString(input, 'license', path),
    packageUrl,
    ...(integrity ? { integrity } : {}),
  }
}

export function parsePluginRegistryJson(
  bytes: Uint8Array,
): PluginRegistryCatalog {
  if (!(bytes instanceof Uint8Array)) {
    registryError('目录内容必须是字节数组')
  }
  if (bytes.byteLength > PLUGIN_REGISTRY_MAX_BYTES) {
    registryError(`目录超过 ${PLUGIN_REGISTRY_MAX_BYTES} 字节限制`)
  }

  let parsed: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('插件目录无效：')) {
      throw error
    }
    registryError('内容不是有效的 UTF-8 JSON')
  }

  if (!isRecord(parsed)) registryError('根节点必须是对象')
  if (parsed.schemaVersion !== PLUGIN_REGISTRY_SCHEMA_VERSION) {
    registryError(`schemaVersion 必须为 ${PLUGIN_REGISTRY_SCHEMA_VERSION}`)
  }
  if (!Array.isArray(parsed.plugins)) registryError('plugins 必须是数组')
  if (parsed.plugins.length > PLUGIN_REGISTRY_MAX_ENTRIES) {
    registryError(`插件条目超过 ${PLUGIN_REGISTRY_MAX_ENTRIES} 条限制`)
  }

  const ids = new Set<string>()
  const plugins = parsed.plugins.map((entry, index) => {
    const parsedEntry = parseEntry(entry, index)
    if (ids.has(parsedEntry.id)) {
      registryError(`plugins.${index}.id 与其他条目重复`)
    }
    ids.add(parsedEntry.id)
    return parsedEntry
  })

  return {
    schemaVersion: PLUGIN_REGISTRY_SCHEMA_VERSION,
    plugins,
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('请求已取消')
  error.name = 'AbortError'
  throw error
}

async function fetchRegistryBytesThroughHost(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal)
  const response = await hostCall<{ bytes: number[] }>('plugin.fetch', {
    url,
    maxBytes,
  })
  throwIfAborted(signal)
  if (!Array.isArray(response.bytes)) {
    throw new Error('原生插件目录请求未返回字节数据')
  }
  if (response.bytes.length > maxBytes) {
    throw new Error(`插件目录超过 ${maxBytes} 字节限制`)
  }
  if (
    response.bytes.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 255,
    )
  ) {
    throw new Error('原生插件目录请求返回了无效字节')
  }
  return Uint8Array.from(response.bytes)
}

export async function fetchPluginRegistry(
  sourceUrl: string,
  options: FetchPluginRegistryOptions = {},
): Promise<LoadedPluginRegistry> {
  const url = normalizedHttpsUrl(sourceUrl.trim(), '目录地址')
  const bytes = await (options.fetchBytes ?? fetchRegistryBytesThroughHost)(
    url,
    PLUGIN_REGISTRY_MAX_BYTES,
    options.signal,
  )
  throwIfAborted(options.signal)
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('插件目录请求未返回字节数组')
  }
  if (bytes.byteLength > PLUGIN_REGISTRY_MAX_BYTES) {
    throw new Error(
      `插件目录超过 ${PLUGIN_REGISTRY_MAX_BYTES} 字节限制`,
    )
  }
  return {
    catalog: parsePluginRegistryJson(bytes),
    byteLength: bytes.byteLength,
    sourceUrl: url,
  }
}

export async function fetchBundledPluginRegistry(
  sourceUrl = '/plugin-registry.json',
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<LoadedPluginRegistry> {
  throwIfAborted(signal)
  const response = await fetchImpl(sourceUrl, {
    cache: 'no-cache',
    signal,
  })
  if (!response.ok) {
    throw new Error(`内置插件目录读取失败：HTTP ${response.status}`)
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > PLUGIN_REGISTRY_MAX_BYTES
  ) {
    throw new Error(
      `插件目录超过 ${PLUGIN_REGISTRY_MAX_BYTES} 字节限制`,
    )
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  throwIfAborted(signal)
  return {
    catalog: parsePluginRegistryJson(bytes),
    byteLength: bytes.byteLength,
    sourceUrl,
  }
}

export function comparePluginRegistryVersion(
  availableVersion: string,
  installedVersion: string,
): number | undefined {
  if (!valid(availableVersion) || !valid(installedVersion)) return undefined
  return compare(availableVersion, installedVersion)
}

export function findPluginRegistryUpdates(
  plugins: readonly PluginRegistryEntry[],
  installed: readonly Pick<InstalledPlugin, 'id' | 'version'>[],
): PluginRegistryUpdate[] {
  const installedById = new Map(
    installed.map((plugin) => [plugin.id, plugin] as const),
  )
  const updates: PluginRegistryUpdate[] = []
  for (const entry of plugins) {
    const current = installedById.get(entry.id)
    if (!current) continue
    const comparison = comparePluginRegistryVersion(
      entry.version,
      current.version,
    )
    if (comparison !== undefined && comparison > 0) {
      updates.push({ entry, installed: current })
    }
  }
  return updates
}

export function isPluginRegistryAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
