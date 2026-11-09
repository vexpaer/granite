import { Context } from '@cordisjs/core'
import type { ForkScope } from '@cordisjs/core'
import { satisfies, valid, validRange } from 'semver'

export const GRANITE_PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const
export const GRANITE_PLUGIN_API_VERSION = '1.0.0'

export const PLUGIN_PERMISSIONS = [
  'reader.observe',
  'reader.control',
  'library.read',
  'library.write',
  'bookfile.read',
  'bookfile.write',
  'annotation.read',
  'annotation.write',
  'network.request',
  'storage.namespace',
  'sync.namespace',
  'ui.register',
  'notification',
  'credential.use',
] as const

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]
export type PluginPlatform = 'windows' | 'android'
export type PluginTrust = 'trusted' | 'untrusted'
export type PluginSourceKind =
  | 'builtin'
  | 'official'
  | 'registry'
  | 'git'
  | 'url'
  | 'local'
  | 'user'

export interface PluginSource {
  kind: PluginSourceKind
  uri?: string
  publisher?: string
  signature?: string
}

export interface PluginUiDeclaration {
  kind: 'esm' | 'worker' | 'iframe'
  entry?: string
}

export interface PluginManifest {
  schemaVersion: typeof GRANITE_PLUGIN_MANIFEST_SCHEMA_VERSION
  id: string
  name: string
  version: string
  apiVersion: string
  main: string
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  permissions: PluginPermission[]
  permissionScopes?: Partial<Record<PluginPermission, string[]>>
  contributes: unknown[] | Record<string, unknown>
  platforms: PluginPlatform[]
  author: string
  license: string
  repository?: string
  integrity: string
  source: PluginSource
  trust: PluginTrust
  ui: PluginUiDeclaration
  description?: string
  signature?: string
  [key: string]: unknown
}

export interface ManifestIssue {
  severity: 'error' | 'warning'
  code: string
  path: string
  message: string
}

export interface ManifestValidationOptions {
  hostApiVersion?: string
  hostPlatform?: PluginPlatform
  manifests?: readonly unknown[]
  requireIntegrity?: boolean
}

export interface DependencyGraphIssue {
  severity: 'error' | 'warning'
  code: string
  pluginId: string
  dependencyId?: string
  message: string
}

export interface DependencyGraphResult {
  valid: boolean
  order: string[]
  issues: DependencyGraphIssue[]
}

export interface ManifestValidationResult {
  valid: boolean
  errors: ManifestIssue[]
  warnings: ManifestIssue[]
  manifest?: PluginManifest
  dependencyGraph?: DependencyGraphResult
}

export type IntegrityAlgorithm = 'sha256' | 'sha384' | 'sha512'
export type IntegrityDigest = (
  algorithm: IntegrityAlgorithm,
  bytes: Uint8Array,
) => Promise<Uint8Array>

export function webCryptoDigest(
  algorithm: IntegrityAlgorithm,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return Promise.reject(new Error('Web Crypto is unavailable'))
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return subtle
    .digest(`SHA-${algorithm.slice(3).toUpperCase()}`, copy)
    .then((result) => new Uint8Array(result))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return globalThis.btoa(binary)
}

function parseSri(integrity: string): Array<{ algorithm: IntegrityAlgorithm; digest: string }> {
  return integrity
    .trim()
    .split(/\s+/)
    .map((entry) => {
      const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=_-]+)$/.exec(entry)
      return match
        ? { algorithm: match[1] as IntegrityAlgorithm, digest: match[2] }
        : undefined
    })
    .filter((entry): entry is { algorithm: IntegrityAlgorithm; digest: string } => Boolean(entry))
}

export async function verifyBundleIntegrity(
  bytes: Uint8Array,
  integrity: string,
  digest: IntegrityDigest = webCryptoDigest,
): Promise<boolean> {
  const entries = parseSri(integrity)
  if (!entries.length) return false
  for (const entry of entries) {
    const actual = bytesToBase64(await digest(entry.algorithm, bytes)).replace(/=+$/, '')
    if (actual === entry.digest.replace(/=+$/, '')) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readStringMap(
  value: unknown,
  path: string,
  addIssue: (severity: ManifestIssue['severity'], code: string, issuePath: string, message: string) => void,
): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    addIssue('error', 'dependency-map', path, 'dependencies must be an object of ID to semver range')
    return {}
  }
  const output: Record<string, string> = {}
  for (const [dependencyId, range] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(dependencyId)) {
      addIssue('error', 'dependency-id', `${path}.${dependencyId}`, 'dependency ID is invalid')
      continue
    }
    if (typeof range !== 'string' || !validRange(range)) {
      addIssue(
        'error',
        'dependency-version',
        `${path}.${dependencyId}`,
        'dependency version must be a valid semver range',
      )
      continue
    }
    output[dependencyId] = range
  }
  return output
}

function validateSource(
  value: unknown,
  addIssue: (severity: ManifestIssue['severity'], code: string, issuePath: string, message: string) => void,
): PluginSource | undefined {
  if (!isRecord(value)) {
    addIssue('error', 'source', 'source', 'source is required')
    return undefined
  }
  const kinds: PluginSourceKind[] = [
    'builtin',
    'official',
    'registry',
    'git',
    'url',
    'local',
    'user',
  ]
  if (!kinds.includes(value.kind as PluginSourceKind)) {
    addIssue('error', 'source-kind', 'source.kind', 'source kind is not supported')
    return undefined
  }
  if (value.uri !== undefined && typeof value.uri !== 'string') {
    addIssue('error', 'source-uri', 'source.uri', 'source URI must be a string')
  }
  if (
    value.kind !== 'builtin' &&
    (!value.uri || typeof value.uri !== 'string')
  ) {
    addIssue('error', 'source-uri', 'source.uri', 'external plugin source requires a URI')
  }

  if (typeof value.uri === 'string') {
    if (value.kind === 'url' && !value.uri.startsWith('https://')) {
      addIssue('error', 'source-transport', 'source.uri', 'URL plugin sources must use HTTPS')
    }
    if (value.kind === 'git') {
      const validGit =
        value.uri.startsWith('https://') ||
        value.uri.startsWith('ssh://') ||
        /^git@[^:]+:[^/]+/.test(value.uri)
      if (!validGit) {
        addIssue('error', 'source-transport', 'source.uri', 'git source URI is not supported')
      }
    }
    if (value.kind === 'registry' || value.kind === 'official') {
      if (!value.uri.startsWith('https://')) {
        addIssue('error', 'source-transport', 'source.uri', 'registry sources must use HTTPS')
      }
    }
  }

  return {
    kind: value.kind as PluginSourceKind,
    ...(typeof value.uri === 'string' ? { uri: value.uri } : {}),
    ...(typeof value.publisher === 'string' ? { publisher: value.publisher } : {}),
    ...(typeof value.signature === 'string' ? { signature: value.signature } : {}),
  }
}

function isSafeBundlePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false
  return !path.replace(/\\/g, '/').split('/').some((part) => part === '..')
}

function contributionRequestsUi(contributes: unknown): boolean {
  if (Array.isArray(contributes)) {
    return contributes.some((entry) => JSON.stringify(entry).includes('"ui"'))
  }
  return isRecord(contributes) && Object.keys(contributes).some((key) => key.startsWith('ui'))
}

export function validateManifest(
  input: unknown,
  options: ManifestValidationOptions = {},
): ManifestValidationResult {
  const errors: ManifestIssue[] = []
  const warnings: ManifestIssue[] = []
  const addIssue = (
    severity: ManifestIssue['severity'],
    code: string,
    path: string,
    message: string,
  ) => {
    const issue = { severity, code, path, message }
    ;(severity === 'error' ? errors : warnings).push(issue)
  }

  if (!isRecord(input)) {
    addIssue('error', 'manifest-type', '$', 'manifest must be an object')
    return { valid: false, errors, warnings }
  }

  if (input.schemaVersion !== GRANITE_PLUGIN_MANIFEST_SCHEMA_VERSION) {
    addIssue(
      'error',
      'schema-version',
      'schemaVersion',
      `schemaVersion must be ${GRANITE_PLUGIN_MANIFEST_SCHEMA_VERSION}`,
    )
  }
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(input.id)) {
    addIssue('error', 'plugin-id', 'id', 'plugin ID must use lowercase stable identifier characters')
  }
  for (const field of ['name', 'author', 'license'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim()) {
      addIssue('error', 'required-string', field, `${field} is required`)
    }
  }
  if (typeof input.version !== 'string' || !valid(input.version)) {
    addIssue('error', 'plugin-version', 'version', 'version must be valid semantic version')
  }

  const hostApiVersion = options.hostApiVersion ?? GRANITE_PLUGIN_API_VERSION
  if (!valid(hostApiVersion)) {
    addIssue('error', 'host-api-version', '$options.hostApiVersion', 'host API version is invalid')
  }
  if (
    typeof input.apiVersion !== 'string' ||
    !validRange(input.apiVersion) ||
    (valid(hostApiVersion) && !satisfies(hostApiVersion, input.apiVersion))
  ) {
    addIssue(
      'error',
      'api-compatibility',
      'apiVersion',
      `plugin API range is incompatible with host ${hostApiVersion}`,
    )
  }

  if (typeof input.main !== 'string' || !isSafeBundlePath(input.main)) {
    addIssue('error', 'main-path', 'main', 'main must be a safe relative ESM bundle path')
  } else if (!/\.(?:mjs|js)$/i.test(input.main)) {
    addIssue('error', 'main-esm', 'main', 'main must point to a JavaScript ESM bundle')
  }

  const dependencies = readStringMap(input.dependencies, 'dependencies', addIssue)
  const optionalDependencies = readStringMap(
    input.optionalDependencies,
    'optionalDependencies',
    addIssue,
  )

  const permissions: PluginPermission[] = []
  if (!Array.isArray(input.permissions)) {
    addIssue('error', 'permissions', 'permissions', 'permissions must be an array')
  } else {
    for (const [index, permission] of input.permissions.entries()) {
      if (!PLUGIN_PERMISSIONS.includes(permission as PluginPermission)) {
        addIssue(
          'error',
          'permission',
          `permissions.${index}`,
          `unknown permission: ${String(permission)}`,
        )
      } else if (permissions.includes(permission as PluginPermission)) {
        addIssue('warning', 'duplicate-permission', `permissions.${index}`, 'permission is duplicated')
      } else {
        permissions.push(permission as PluginPermission)
      }
    }
  }

  const platforms: PluginPlatform[] = []
  if (!Array.isArray(input.platforms) || !input.platforms.length) {
    addIssue('error', 'platforms', 'platforms', 'at least one target platform is required')
  } else {
    for (const [index, platform] of input.platforms.entries()) {
      if (platform !== 'windows' && platform !== 'android') {
        addIssue('error', 'platform', `platforms.${index}`, 'platform must be windows or android')
      } else if (!platforms.includes(platform)) {
        platforms.push(platform)
      }
    }
  }
  if (options.hostPlatform && platforms.length && !platforms.includes(options.hostPlatform)) {
    addIssue(
      'error',
      'platform-incompatible',
      'platforms',
      `plugin does not support ${options.hostPlatform}`,
    )
  }

  const source = validateSource(input.source, addIssue)
  const requireIntegrity = options.requireIntegrity ?? true
  if (
    (requireIntegrity || source?.kind !== 'builtin') &&
    (typeof input.integrity !== 'string' || !parseSri(input.integrity).length)
  ) {
    addIssue(
      'error',
      'integrity',
      'integrity',
      'integrity must contain a valid sha256, sha384, or sha512 SRI digest',
    )
  }

  const trust: PluginTrust =
    input.trust === 'trusted' ? 'trusted' : input.trust === 'untrusted' ? 'untrusted' : 'untrusted'
  if (input.trust !== 'trusted' && input.trust !== 'untrusted') {
    addIssue('error', 'trust', 'trust', 'trust must be trusted or untrusted')
  }
  const uiInput = isRecord(input.ui) ? input.ui : undefined
  const inferredUiKind: PluginUiDeclaration['kind'] =
    trust === 'trusted' ? 'esm' : 'iframe'
  const uiKind =
    uiInput?.kind === 'esm' || uiInput?.kind === 'worker' || uiInput?.kind === 'iframe'
      ? uiInput.kind
      : inferredUiKind
  if (input.ui !== undefined && !uiInput) {
    addIssue('error', 'ui-declaration', 'ui', 'ui must be an object')
  }
  if (trust === 'trusted' && uiKind !== 'esm') {
    addIssue('error', 'trusted-ui', 'ui.kind', 'trusted plugins must use the controlled ESM UI')
  }
  if (trust === 'untrusted' && uiKind === 'esm') {
    addIssue('error', 'untrusted-ui', 'ui.kind', 'untrusted plugins must use worker or iframe UI')
  }
  if (uiInput?.entry !== undefined && typeof uiInput.entry !== 'string') {
    addIssue('error', 'ui-entry', 'ui.entry', 'UI entry must be a string')
  }
  if (typeof uiInput?.entry === 'string' && !isSafeBundlePath(uiInput.entry)) {
    addIssue('error', 'ui-entry', 'ui.entry', 'UI entry must be a safe relative path')
  }

  const contributes =
    input.contributes === undefined
      ? []
      : Array.isArray(input.contributes) || isRecord(input.contributes)
        ? input.contributes
        : []
  if (
    input.contributes !== undefined &&
    !Array.isArray(input.contributes) &&
    !isRecord(input.contributes)
  ) {
    addIssue(
      'error',
      'contributes',
      'contributes',
      'contributes must be an array or object',
    )
  }
  if (contributionRequestsUi(contributes) && !permissions.includes('ui.register')) {
    addIssue(
      'error',
      'ui-permission',
      'permissions',
      'UI contributions require ui.register permission',
    )
  }

  if (input.repository !== undefined) {
    if (typeof input.repository !== 'string' || !/^https?:\/\//.test(input.repository)) {
      addIssue('warning', 'repository', 'repository', 'repository should be an HTTP(S) URL')
    }
  }

  const normalized: PluginManifest = {
    ...(input as Record<string, unknown>),
    schemaVersion: GRANITE_PLUGIN_MANIFEST_SCHEMA_VERSION,
    id: typeof input.id === 'string' ? input.id : '',
    name: typeof input.name === 'string' ? input.name : '',
    version: typeof input.version === 'string' ? input.version : '',
    apiVersion: typeof input.apiVersion === 'string' ? input.apiVersion : '',
    main: typeof input.main === 'string' ? input.main : '',
    dependencies,
    optionalDependencies,
    permissions,
    ...(isRecord(input.permissionScopes)
      ? { permissionScopes: input.permissionScopes as PluginManifest['permissionScopes'] }
      : {}),
    contributes,
    platforms,
    author: typeof input.author === 'string' ? input.author : '',
    license: typeof input.license === 'string' ? input.license : '',
    ...(typeof input.repository === 'string' ? { repository: input.repository } : {}),
    integrity: typeof input.integrity === 'string' ? input.integrity : '',
    source: source ?? { kind: 'user' },
    trust,
    ui: {
      kind: uiKind,
      ...(typeof uiInput?.entry === 'string' ? { entry: uiInput.entry } : {}),
    },
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    ...(typeof input.signature === 'string' ? { signature: input.signature } : {}),
  } as PluginManifest

  let dependencyGraph: DependencyGraphResult | undefined
  if (options.manifests?.length) {
    const manifests = options.manifests
      .map((manifest) => {
        if (manifest === input) return normalized
        const result = validateManifest(manifest, {
          hostApiVersion,
          hostPlatform: options.hostPlatform,
          requireIntegrity: options.requireIntegrity,
        })
        return result.manifest
      })
      .filter((manifest): manifest is PluginManifest => Boolean(manifest))
    dependencyGraph = validateDependencyGraph(manifests)
    if (!dependencyGraph.valid) {
      addIssue(
        'error',
        'dependency-graph',
        'dependencies',
        'plugin dependency graph is invalid or cyclic',
      )
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifest: normalized,
    ...(dependencyGraph ? { dependencyGraph } : {}),
  }
}

export const validatePluginManifest = validateManifest

export function validateDependencyGraph(
  manifests: readonly PluginManifest[],
): DependencyGraphResult {
  const issues: DependencyGraphIssue[] = []
  const byId = new Map<string, PluginManifest>()

  for (const manifest of manifests) {
    if (byId.has(manifest.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-plugin',
        pluginId: manifest.id,
        message: 'plugin ID is duplicated',
      })
      continue
    }
    byId.set(manifest.id, manifest)
  }

  for (const manifest of byId.values()) {
    for (const [dependencyId, range] of Object.entries(manifest.dependencies)) {
      const dependency = byId.get(dependencyId)
      if (!dependency) {
        issues.push({
          severity: 'error',
          code: 'missing-dependency',
          pluginId: manifest.id,
          dependencyId,
          message: `required dependency ${dependencyId} is not installed`,
        })
      } else if (!satisfies(dependency.version, range)) {
        issues.push({
          severity: 'error',
          code: 'dependency-version',
          pluginId: manifest.id,
          dependencyId,
          message: `${dependencyId}@${dependency.version} does not satisfy ${range}`,
        })
      }
    }
    for (const [dependencyId, range] of Object.entries(manifest.optionalDependencies)) {
      const dependency = byId.get(dependencyId)
      if (dependency && !satisfies(dependency.version, range)) {
        issues.push({
          severity: 'warning',
          code: 'optional-dependency-version',
          pluginId: manifest.id,
          dependencyId,
          message: `${dependencyId}@${dependency.version} does not satisfy optional range ${range}`,
        })
      }
    }
  }

  const state = new Map<string, 'visiting' | 'visited'>()
  const order: string[] = []

  const visit = (id: string, stack: string[]): void => {
    const currentState = state.get(id)
    if (currentState === 'visited') return
    if (currentState === 'visiting') {
      const start = stack.indexOf(id)
      const cycle = [...stack.slice(start), id]
      issues.push({
        severity: 'error',
        code: 'dependency-cycle',
        pluginId: id,
        message: `dependency cycle: ${cycle.join(' -> ')}`,
      })
      return
    }
    state.set(id, 'visiting')
    const manifest = byId.get(id)
    if (manifest) {
      for (const dependencyId of Object.keys(manifest.dependencies)) {
        if (byId.has(dependencyId)) visit(dependencyId, [...stack, id])
      }
    }
    state.set(id, 'visited')
    order.push(id)
  }

  for (const id of [...byId.keys()].sort()) visit(id, [])
  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    order,
    issues,
  }
}

export interface DisposableLike {
  dispose(): void | Promise<void>
}

export type DisposableFunction = () => void | Promise<void>
export type AnyDisposable = DisposableLike | DisposableFunction

export class DisposableScope implements DisposableLike {
  private readonly disposables: AnyDisposable[] = []
  private disposed = false

  get size(): number {
    return this.disposables.length
  }

  add(disposable: AnyDisposable | undefined | void): DisposableFunction {
    if (!disposable) return () => undefined
    if (this.disposed) {
      void disposeValue(disposable)
      return () => undefined
    }
    this.disposables.push(disposable)
    return () => {
      const index = this.disposables.lastIndexOf(disposable)
      if (index >= 0) this.disposables.splice(index, 1)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const failures: unknown[] = []
    for (const disposable of this.disposables.splice(0).reverse()) {
      try {
        await disposeValue(disposable)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, 'one or more plugin disposables failed')
    }
  }
}

async function disposeValue(disposable: AnyDisposable): Promise<void> {
  if (typeof disposable === 'function') await disposable()
  else await disposable.dispose()
}

export class PermissionBroker {
  readonly pluginId: string
  private readonly permissions = new Set<PluginPermission>()

  constructor(pluginId: string, granted: readonly PluginPermission[] = []) {
    this.pluginId = pluginId
    for (const permission of granted) this.permissions.add(permission)
  }

  has(permission: PluginPermission): boolean {
    return this.permissions.has(permission)
  }

  assert(permission: PluginPermission): void {
    if (!this.has(permission)) {
      throw new PermissionDeniedError(this.pluginId, permission)
    }
  }

  grant(permission: PluginPermission): void {
    this.permissions.add(permission)
  }

  revoke(permission: PluginPermission): void {
    this.permissions.delete(permission)
  }

  values(): PluginPermission[] {
    return [...this.permissions].sort()
  }
}

export class PermissionDeniedError extends Error {
  readonly pluginId: string
  readonly permission: PluginPermission

  constructor(pluginId: string, permission: PluginPermission) {
    super(`plugin ${pluginId} does not have ${permission}`)
    this.name = 'PermissionDeniedError'
    this.pluginId = pluginId
    this.permission = permission
  }
}

export const PLUGIN_UI_SLOTS = [
  'app.sidebar',
  'app.dashboard',
  'app.header.actions',
  'app.command-palette',
  'library.toolbar',
  'library.book.context-menu',
  'reader.toolbar',
  'reader.left-panel',
  'reader.right-panel',
  'reader.bottom-panel',
  'reader.selection-menu',
  'reader.status-bar',
  'settings.pages',
] as const

export type PluginUiSlot = (typeof PLUGIN_UI_SLOTS)[number]

export interface PluginUiContribution {
  id: string
  type: 'page' | 'panel' | 'toolbar' | 'menu' | 'widget' | 'settings'
  slot: PluginUiSlot
  title: string
  icon?: string
  order?: number
  platforms?: PluginPlatform[]
  platformsAllowed?: PluginPlatform[]
  props?: Record<string, unknown>
  component?: unknown
  remote?: boolean
}

export interface RegisteredUiContribution extends PluginUiContribution {
  pluginId: string
}

export class ControlledUiRegistry {
  private readonly contributions = new Map<string, RegisteredUiContribution>()
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): DisposableFunction {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  register(
    pluginId: string,
    permissions: PermissionBroker,
    contribution: PluginUiContribution,
  ): DisposableFunction {
    permissions.assert('ui.register')
    if (!PLUGIN_UI_SLOTS.includes(contribution.slot)) {
      throw new Error(`unsupported plugin UI slot: ${contribution.slot}`)
    }
    if (
      !contribution.id.startsWith(`${pluginId}:`) &&
      !contribution.id.startsWith(`${pluginId}/`)
    ) {
      throw new Error('UI contribution ID must be namespaced by the plugin ID')
    }
    if (!contribution.title.trim()) throw new Error('UI contribution title is required')
    const unsafeStyles = /(?:^|\.)(?:css|style|globalCss)$/i
    if (contribution.props && Object.keys(contribution.props).some((key) => unsafeStyles.test(key))) {
      throw new Error('UI contributions cannot inject global or arbitrary CSS')
    }
    const key = `${pluginId}\u0000${contribution.id}`
    if (this.contributions.has(key)) throw new Error('duplicate UI contribution ID')
    this.contributions.set(key, {
      ...contribution,
      ...(contribution.props ? { props: structuredClone(contribution.props) } : {}),
      pluginId,
    })
    this.changed()
    return () => {
      if (this.contributions.delete(key)) this.changed()
    }
  }

  list(): RegisteredUiContribution[] {
    return [...this.contributions.values()]
      .sort(
        (left, right) =>
          (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id),
      )
      .map((contribution) => ({
        ...contribution,
        ...(contribution.props ? { props: structuredClone(contribution.props) } : {}),
      }))
  }

  clearPlugin(pluginId: string): void {
    let changed = false
    for (const [key, contribution] of this.contributions) {
      if (contribution.pluginId === pluginId) {
        this.contributions.delete(key)
        changed = true
      }
    }
    if (changed) this.changed()
  }
}

export interface PluginCommand {
  id: string
  title: string
  run: () => unknown
  shortcut?: string
}

export class CommandRegistry {
  private readonly commands = new Map<string, PluginCommand & { pluginId: string }>()

  register(pluginId: string, command: PluginCommand): DisposableFunction {
    if (!command.id.startsWith(`${pluginId}:`) && !command.id.startsWith(`${pluginId}/`)) {
      throw new Error('command ID must be namespaced by the plugin ID')
    }
    const key = `${pluginId}\u0000${command.id}`
    if (this.commands.has(key)) throw new Error('duplicate command ID')
    this.commands.set(key, { ...command, pluginId })
    return () => {
      this.commands.delete(key)
    }
  }

  list(): Array<PluginCommand & { pluginId: string }> {
    return [...this.commands.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((command) => ({ ...command }))
  }
}

export interface PluginStorageAdapter {
  get(pluginId: string, key: string): Promise<unknown>
  set(pluginId: string, key: string, value: unknown): Promise<void>
  remove(pluginId: string, key: string): Promise<void>
}

export interface PluginHostHandlerContext {
  pluginId: string
  permissions: PermissionBroker
  signal?: AbortSignal
}

export interface PluginHostHandler {
  permission?: PluginPermission
  handler: (args: readonly unknown[], context: PluginHostHandlerContext) => Promise<unknown> | unknown
}

export class PluginRpcGate {
  constructor(
    readonly pluginId: string,
    readonly permissions: PermissionBroker,
    private readonly handlers: Readonly<Record<string, PluginHostHandler>>,
  ) {}

  async request(
    method: string,
    args: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Object.prototype.hasOwnProperty.call(this.handlers, method)) {
      throw new Error(`plugin host method is not allowed: ${method}`)
    }
    const handler = this.handlers[method]
    if (handler.permission) this.permissions.assert(handler.permission)
    return handler.handler(args, {
      pluginId: this.pluginId,
      permissions: this.permissions,
      signal,
    })
  }
}

export interface PluginLogger {
  debug(message: string, ...details: unknown[]): void
  info(message: string, ...details: unknown[]): void
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void
}

export interface PluginRuntimeApi {
  readonly pluginId: string
  readonly manifest: Readonly<PluginManifest>
  readonly permissions: Readonly<{
    has(permission: PluginPermission): boolean
    assert(permission: PluginPermission): void
  }>
  readonly events: Readonly<{
    on(name: string, listener: (...args: unknown[]) => unknown): DisposableFunction
    emit(name: string, ...args: unknown[]): void
  }>
  readonly ui: Readonly<{
    register(contribution: PluginUiContribution): DisposableFunction
  }>
  readonly commands: Readonly<{
    register(command: PluginCommand): DisposableFunction
  }>
  readonly storage: Readonly<{
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }>
  readonly scheduler: Readonly<{
    setTimeout(callback: () => void, milliseconds: number): DisposableFunction
  }>
  readonly host: Readonly<{
    request(method: string, ...args: unknown[]): Promise<unknown>
  }>
  readonly logger: PluginLogger
}

export interface TrustedPluginModule {
  activate(api: PluginRuntimeApi): AnyDisposable | void
  ready?(api: PluginRuntimeApi): Promise<AnyDisposable | void> | AnyDisposable | void
}

export interface TrustedEsmActivation {
  kind: 'trusted-esm'
  module: TrustedPluginModule
  bundleBytes?: Uint8Array
}

export interface SandboxStartContext {
  pluginId: string
  manifest: Readonly<PluginManifest>
  permissions: readonly PluginPermission[]
  requestHost(method: string, args?: readonly unknown[], signal?: AbortSignal): Promise<unknown>
}

export interface SandboxTransport {
  start(context: SandboxStartContext): Promise<void>
  call(method: string, args?: readonly unknown[], signal?: AbortSignal): Promise<unknown>
  dispose(): Promise<void> | void
}

export interface SandboxActivation {
  kind: 'sandbox-worker' | 'sandbox-iframe'
  transport: SandboxTransport
}

export type PluginActivation = TrustedEsmActivation | SandboxActivation

export type PluginRuntimeStatus =
  | 'activating'
  | 'active'
  | 'disabled'
  | 'failed'
  | 'disposed'

export interface RuntimePluginRecord {
  id: string
  manifest: PluginManifest
  status: PluginRuntimeStatus
  permissions: PluginPermission[]
  error?: string
}

export interface PluginRuntimeOptions {
  cordis?: Context
  hostApiVersion?: string
  hostPlatform?: PluginPlatform
  safeMode?: boolean
  hostHandlers?: Record<string, PluginHostHandler>
  storage?: PluginStorageAdapter
  ui?: ControlledUiRegistry
  commands?: CommandRegistry
  logger?: PluginLogger
  digest?: IntegrityDigest
  extendApi?: (
    api: PluginRuntimeApi,
    manifest: PluginManifest,
  ) => PluginRuntimeApi & Record<string, unknown>
}

interface InternalRuntimeRecord {
  public: RuntimePluginRecord
  manifest: PluginManifest
  activation?: PluginActivation
  permissions: PermissionBroker
  lifecycle: DisposableScope
  fork?: ForkScope
  api?: PluginRuntimeApi
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const silentLogger: PluginLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function namespacedEvent(pluginId: string, name: string): void {
  if (!name.startsWith(`plugin:${pluginId}/`)) {
    throw new Error('plugin-emitted events must use the plugin namespace')
  }
}

function assertNamespacedStorageKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\0')) {
    throw new Error('plugin storage key must be a safe namespaced key')
  }
}

function createPluginApi(
  runtime: GranitePluginRuntime,
  record: InternalRuntimeRecord,
): PluginRuntimeApi {
  const { manifest, permissions, lifecycle } = record
  const gate = new PluginRpcGate(
    manifest.id,
    permissions,
    runtime.hostHandlers,
  )
  const logger = runtime.logger
  const loggerForPlugin: PluginLogger = {
    debug: (message, ...details) => logger.debug(`[${manifest.id}] ${message}`, ...details),
    info: (message, ...details) => logger.info(`[${manifest.id}] ${message}`, ...details),
    warn: (message, ...details) => logger.warn(`[${manifest.id}] ${message}`, ...details),
    error: (message, ...details) => logger.error(`[${manifest.id}] ${message}`, ...details),
  }
  const eventContext = runtime.cordis as unknown as {
    on(name: string, listener: (...args: unknown[]) => unknown): () => boolean
    emit(name: string, ...args: unknown[]): void
  }

  const api: PluginRuntimeApi = {
    pluginId: manifest.id,
    manifest: Object.freeze(structuredClone(manifest)),
    permissions: Object.freeze({
      has: (permission: PluginPermission) => permissions.has(permission),
      assert: (permission: PluginPermission) => permissions.assert(permission),
    }),
    events: Object.freeze({
      on: (name: string, listener: (...args: unknown[]) => unknown) => {
        const dispose = eventContext.on(name, listener)
        return lifecycle.add(() => {
          dispose()
        })
      },
      emit: (name: string, ...args: unknown[]) => {
        namespacedEvent(manifest.id, name)
        eventContext.emit(name, ...args)
      },
    }),
    ui: Object.freeze({
      register: (contribution: PluginUiContribution) =>
        lifecycle.add(runtime.ui.register(manifest.id, permissions, contribution)),
    }),
    commands: Object.freeze({
      register: (command: PluginCommand) =>
        lifecycle.add(runtime.commands.register(manifest.id, command)),
    }),
    storage: Object.freeze({
      get: async (key: string) => {
        permissions.assert('storage.namespace')
        assertNamespacedStorageKey(key)
        if (!runtime.storage) throw new Error('plugin storage adapter is unavailable')
        return runtime.storage.get(manifest.id, key)
      },
      set: async (key: string, value: unknown) => {
        permissions.assert('storage.namespace')
        assertNamespacedStorageKey(key)
        if (!runtime.storage) throw new Error('plugin storage adapter is unavailable')
        await runtime.storage.set(manifest.id, key, structuredClone(value))
      },
      remove: async (key: string) => {
        permissions.assert('storage.namespace')
        assertNamespacedStorageKey(key)
        if (!runtime.storage) throw new Error('plugin storage adapter is unavailable')
        await runtime.storage.remove(manifest.id, key)
      },
    }),
    scheduler: Object.freeze({
      setTimeout: (callback: () => void, milliseconds: number) => {
        const timer = globalThis.setTimeout(callback, Math.max(0, milliseconds))
        return lifecycle.add(() => globalThis.clearTimeout(timer))
      },
    }),
    host: Object.freeze({
      request: (method: string, ...args: unknown[]) => gate.request(method, args),
    }),
    logger: loggerForPlugin,
  }
  return runtime.extendApi ? runtime.extendApi(api, manifest) : api
}

export class GranitePluginRuntime {
  readonly cordis: Context
  readonly hostHandlers: Readonly<Record<string, PluginHostHandler>>
  readonly storage?: PluginStorageAdapter
  readonly ui: ControlledUiRegistry
  readonly commands: CommandRegistry
  readonly logger: PluginLogger
  readonly safeMode: boolean
  private readonly hostApiVersion: string
  private readonly hostPlatform?: PluginPlatform
  private readonly digest: IntegrityDigest
  readonly extendApi?: PluginRuntimeOptions['extendApi']
  private readonly records = new Map<string, InternalRuntimeRecord>()

  constructor(options: PluginRuntimeOptions = {}) {
    this.cordis = options.cordis ?? new Context()
    this.hostApiVersion = options.hostApiVersion ?? GRANITE_PLUGIN_API_VERSION
    this.hostPlatform = options.hostPlatform
    this.safeMode = options.safeMode ?? false
    this.hostHandlers = Object.freeze({ ...(options.hostHandlers ?? {}) })
    this.storage = options.storage
    this.ui = options.ui ?? new ControlledUiRegistry()
    this.commands = options.commands ?? new CommandRegistry()
    this.logger = options.logger ?? silentLogger
    this.digest = options.digest ?? webCryptoDigest
    this.extendApi = options.extendApi
  }

  async activate(
    manifestInput: unknown,
    activation: PluginActivation,
  ): Promise<RuntimePluginRecord> {
    const validation = validateManifest(manifestInput, {
      hostApiVersion: this.hostApiVersion,
      hostPlatform: this.hostPlatform,
    })
    if (!validation.valid || !validation.manifest) {
      return this.failedRecord(
        typeof (manifestInput as { id?: unknown })?.id === 'string'
          ? (manifestInput as { id: string }).id
          : 'unknown',
        validation.errors.map((issue) => issue.message).join('; '),
      )
    }

    const manifest = validation.manifest
    if (this.records.has(manifest.id) && this.records.get(manifest.id)?.public.status !== 'disabled') {
      throw new Error(`plugin is already registered: ${manifest.id}`)
    }
    if (this.safeMode && manifest.source.kind !== 'builtin') {
      const record: InternalRuntimeRecord = {
        public: {
          id: manifest.id,
          manifest,
          status: 'disabled',
          permissions: [],
          error: 'safe mode only activates built-in plugins',
        },
        manifest,
        activation,
        permissions: new PermissionBroker(manifest.id),
        lifecycle: new DisposableScope(),
      }
      this.records.set(manifest.id, record)
      return structuredClone(record.public)
    }
    if (activation.kind === 'trusted-esm' && manifest.trust !== 'trusted') {
      return this.failedRecord(manifest.id, 'untrusted plugins cannot run as trusted ESM')
    }
    if (activation.kind !== 'trusted-esm' && manifest.trust === 'trusted') {
      return this.failedRecord(manifest.id, 'trusted plugins require the controlled ESM runtime')
    }
    if (
      activation.kind === 'trusted-esm' &&
      activation.bundleBytes &&
      !(await verifyBundleIntegrity(activation.bundleBytes, manifest.integrity, this.digest))
    ) {
      return this.failedRecord(manifest.id, 'plugin bundle integrity verification failed')
    }

    const record: InternalRuntimeRecord = {
      public: {
        id: manifest.id,
        manifest,
        status: 'activating',
        permissions: [...manifest.permissions],
      },
      manifest,
      activation,
      permissions: new PermissionBroker(manifest.id, manifest.permissions),
      lifecycle: new DisposableScope(),
    }
    this.records.set(manifest.id, record)

    try {
      if (activation.kind === 'trusted-esm') {
        await this.activateTrusted(record, activation)
      } else {
        await this.activateSandbox(record, activation)
      }
    } catch (error) {
      await this.failRecord(record, error)
    }
    return structuredClone(record.public)
  }

  private async activateTrusted(
    record: InternalRuntimeRecord,
    activation: TrustedEsmActivation,
  ): Promise<void> {
    const api = createPluginApi(this, record)
    record.api = api
    const plugin = (ctx: Context) => {
      ctx.on('dispose', () => {
        void record.lifecycle.dispose().catch((error) => {
          record.public.error = errorMessage(error)
        })
      })
      try {
        record.lifecycle.add(activation.module.activate(api))
      } catch (error) {
        record.public.status = 'failed'
        record.public.error = errorMessage(error)
      }
      ctx.on('ready', async () => {
        if (record.public.status === 'failed') return
        try {
          record.lifecycle.add(await activation.module.ready?.(api))
          record.public.status = 'active'
        } catch (error) {
          await this.failRecord(record, error)
        }
      })
    }
    record.fork = this.cordis.plugin(plugin)
    await this.cordis.start()
    if (record.public.status === 'activating') record.public.status = 'active'
  }

  private async activateSandbox(
    record: InternalRuntimeRecord,
    activation: SandboxActivation,
  ): Promise<void> {
    const api = createPluginApi(this, record)
    record.api = api
    const gate = new PluginRpcGate(record.manifest.id, record.permissions, this.hostHandlers)
    const plugin = (ctx: Context) => {
      ctx.on('dispose', () => {
        void Promise.resolve(activation.transport.dispose()).catch((error) => {
          record.public.error = errorMessage(error)
        })
      })
      ctx.on('ready', async () => {
        try {
          await activation.transport.start({
            pluginId: record.manifest.id,
            manifest: Object.freeze(structuredClone(record.manifest)),
            permissions: record.permissions.values(),
            requestHost: (method, args = [], signal) => gate.request(method, args, signal),
          })
          record.public.status = 'active'
        } catch (error) {
          await this.failRecord(record, error)
        }
      })
    }
    record.fork = this.cordis.plugin(plugin)
    await this.cordis.start()
  }

  private failedRecord(id: string, message: string): RuntimePluginRecord {
    return {
      id,
      manifest: {
        schemaVersion: GRANITE_PLUGIN_MANIFEST_SCHEMA_VERSION,
        id,
        name: id,
        version: '0.0.0',
        apiVersion: '*',
        main: '',
        dependencies: {},
        optionalDependencies: {},
        permissions: [],
        contributes: [],
        platforms: [],
        author: '',
        license: '',
        integrity: '',
        source: { kind: 'user' },
        trust: 'untrusted',
        ui: { kind: 'iframe' },
      },
      status: 'failed',
      permissions: [],
      error: message,
    }
  }

  private async failRecord(record: InternalRuntimeRecord, error: unknown): Promise<void> {
    record.public.status = 'failed'
    record.public.error = errorMessage(error)
    this.ui.clearPlugin(record.manifest.id)
    try {
      await record.lifecycle.dispose()
    } catch (cleanupError) {
      record.public.error += `; cleanup failed: ${errorMessage(cleanupError)}`
    }
    const activation = record.activation
    if (activation && activation.kind !== 'trusted-esm') {
      try {
        await activation.transport.dispose()
      } catch (disposeError) {
        record.public.error += `; sandbox cleanup failed: ${errorMessage(disposeError)}`
      }
    }
  }

  get(id: string): RuntimePluginRecord | undefined {
    const record = this.records.get(id)
    return record ? structuredClone(record.public) : undefined
  }

  list(): RuntimePluginRecord[] {
    return [...this.records.values()]
      .map((record) => structuredClone(record.public))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  setPermission(id: string, permission: PluginPermission, granted: boolean): void {
    const record = this.records.get(id)
    if (!record) throw new Error(`plugin is not registered: ${id}`)
    if (granted) record.permissions.grant(permission)
    else record.permissions.revoke(permission)
    record.public.permissions = record.permissions.values()
  }

  async deactivate(id: string): Promise<boolean> {
    const record = this.records.get(id)
    if (!record || record.public.status === 'disposed') return false
    record.public.status = 'disabled'
    try {
      record.fork?.dispose()
      await record.lifecycle.dispose()
      const activation = record.activation
      if (activation && activation.kind !== 'trusted-esm') {
        await activation.transport.dispose()
      }
    } catch (error) {
      record.public.status = 'failed'
      record.public.error = errorMessage(error)
    }
    this.ui.clearPlugin(id)
    return true
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = []
    for (const id of [...this.records.keys()]) {
      try {
        await this.deactivate(id)
        const record = this.records.get(id)
        if (record) record.public.status = 'disposed'
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await this.cordis.stop()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) {
      throw new AggregateError(failures, 'one or more plugins failed to stop')
    }
  }
}

export function createPluginRuntime(options: PluginRuntimeOptions = {}): GranitePluginRuntime {
  return new GranitePluginRuntime(options)
}
