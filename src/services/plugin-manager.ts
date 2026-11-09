import JSZip from 'jszip'
import {
  defineComponent,
  computed,
  h,
  markRaw,
  onMounted,
  onUnmounted,
  reactive,
  readonly,
  ref,
  shallowReactive,
  watch,
} from 'vue'
import type { Annotation, Book, InstalledPlugin } from '../types'
import { hostCall } from './host'
import {
  CommandRegistry,
  ControlledUiRegistry,
  GranitePluginRuntime,
  PluginRpcGate,
  PLUGIN_UI_TYPES,
  PLUGIN_UI_SLOTS,
  validateManifest,
  verifyBundleIntegrity,
  type AnyDisposable,
  type ManifestValidationOptions,
  type ManifestValidationResult,
  type PluginCommand,
  type PluginHostHandler,
  type PluginManifest,
  type PluginPermission,
  type PluginPlatform,
  type PluginStorageAdapter,
  type PluginUiContribution,
  type PluginUiSlot,
  type RegisteredUiContribution,
  type SandboxStartContext,
  type SandboxTransport,
  type TrustedPluginModule,
} from '../../packages/core/index'

export interface PluginLibraryHooks {
  listBooks?(): Book[] | Promise<Book[]>
  getBook?(bookId: string): Book | undefined | Promise<Book | undefined>
  searchBooks?(query: string): Book[] | Promise<Book[]>
  updateBook?(book: Book): void | Promise<void>
}

export interface PluginAnnotationHooks {
  listAnnotations?(bookId?: string): Annotation[] | Promise<Annotation[]>
  saveAnnotation?(annotation: Annotation): void | Promise<void>
  deleteAnnotation?(id: string): void | Promise<void>
}

export interface PluginEventHooks {
  emit(name: string, payload?: unknown): void | Promise<void>
  onAny?(listener: (name: string, payload: unknown) => void): () => void
}

export interface PluginAppHooks {
  library?: PluginLibraryHooks
  annotations?: PluginAnnotationHooks
  storage?: PluginStorageAdapter
  events?: PluginEventHooks
  notify?(message: string): void | Promise<void>
}

export interface ActivateInstalledOptions {
  trusted?: boolean
  hostPlatform?: PluginPlatform
  safeMode?: boolean
}

export interface InitializedPlugin {
  id: string
  version: string
  status: string
  trusted: boolean
  permissions: string[]
  error?: string
}

export interface PluginSandboxView {
  pluginId: string
  kind: 'worker' | 'iframe'
  mount?(container: HTMLElement): () => void
  notify?(event: string, payload: unknown): void
}

export interface PluginUiEntry extends RegisteredUiContribution {
  trusted: boolean
  sandbox?: PluginSandboxView
}

export interface PreviewPluginOptions extends ActivateInstalledOptions {
  hostApiVersion?: string
  maxBytes?: number
  actualSource?: {
    kind: 'local' | 'url'
    uri?: string
  }
}

export interface PluginPackagePreview {
  validation: ManifestValidationResult
  manifest?: PluginManifest
  bundle?: Uint8Array
  requiresUserReview: true
}

const initializedInternal: InitializedPlugin[] = []
export const initializedPlugins = shallowReactive(initializedInternal)

const uiEntriesInternal: PluginUiEntry[] = []
export const pluginUiContributions = shallowReactive(uiEntriesInternal)

const remoteUi = new Map<string, RegisteredUiContribution>()
const configuredHooks = new Map<string, PluginAppHooks>()
const sandboxViews = new Map<string, PluginSandboxView>()
const trustedPlugins = new Map<string, boolean>()
const eventDisposers = new Map<string, () => void>()
const controlledUi = new ControlledUiRegistry()
const commands = new CommandRegistry()
let runtime: GranitePluginRuntime | undefined

function manifestRecord(plugin: InstalledPlugin): Record<string, unknown> {
  if (!plugin.manifest) throw new Error(`plugin ${plugin.id} has no manifest`)
  return plugin.manifest
}

function executionManifest(
  rawManifest: Record<string, unknown>,
  trusted: boolean,
  actualSource: PreviewPluginOptions['actualSource'] = {
    kind: 'local',
    uri: 'installed-package',
  },
): Record<string, unknown> {
  const requestedUi =
    rawManifest.ui && typeof rawManifest.ui === 'object'
      ? (rawManifest.ui as Record<string, unknown>)
      : undefined
  const uiKind = trusted
    ? 'esm'
    : requestedUi?.kind === 'worker'
      ? 'worker'
      : 'iframe'
  return {
    ...rawManifest,
    source: {
      kind: actualSource.kind,
      uri:
        actualSource.uri ??
        (actualSource.kind === 'local' ? 'installed-package' : undefined),
    },
    trust: trusted ? 'trusted' : 'untrusted',
    ui: {
      ...(requestedUi ?? {}),
      kind: uiKind,
    },
  }
}

function activationManifest(
  rawManifest: Record<string, unknown>,
  grantedPermissions: readonly string[],
  trusted: boolean,
): Record<string, unknown> {
  const granted = new Set(grantedPermissions)
  const requested = Array.isArray(rawManifest.permissions)
    ? rawManifest.permissions.filter(
        (permission): permission is string =>
          typeof permission === 'string' && granted.has(permission),
      )
    : []
  return executionManifest(
    {
      ...rawManifest,
      permissions: requested,
    },
    trusted,
  )
}

export function previewPluginManifest(
  rawManifest: Record<string, unknown>,
  options: PreviewPluginOptions = {},
): ManifestValidationResult {
  const trusted = options.trusted === true
  return validateManifest(executionManifest(rawManifest, trusted, options.actualSource), {
    hostApiVersion: options.hostApiVersion,
    hostPlatform: options.hostPlatform ?? currentPluginPlatform(),
  })
}

function currentPluginPlatform(): PluginPlatform | undefined {
  if (typeof navigator === 'undefined') return undefined
  if (/Android/i.test(navigator.userAgent)) return 'android'
  if (/Windows/i.test(navigator.userAgent)) return 'windows'
  return undefined
}

function replaceInitialized(record: InitializedPlugin): void {
  const index = initializedPlugins.findIndex((entry) => entry.id === record.id)
  if (index < 0) initializedPlugins.push(record)
  else initializedPlugins.splice(index, 1, record)
}

function removeInitialized(id: string): void {
  const index = initializedPlugins.findIndex((entry) => entry.id === id)
  if (index >= 0) initializedPlugins.splice(index, 1)
}

function refreshUiRegistry(): void {
  const next: PluginUiEntry[] = []
  if (runtime) {
    for (const contribution of runtime.ui.list()) {
      next.push({
        ...contribution,
        trusted: trustedPlugins.get(contribution.pluginId) === true,
        ...(sandboxViews.get(contribution.pluginId)
          ? { sandbox: sandboxViews.get(contribution.pluginId) }
          : {}),
      })
    }
  }
  for (const contribution of remoteUi.values()) {
    const view = sandboxViews.get(contribution.pluginId)
    next.push({
      ...contribution,
      trusted: false,
      remote: true,
      ...(view ? { sandbox: view } : {}),
    })
  }
  next.sort(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id),
  )
  pluginUiContributions.splice(0, pluginUiContributions.length, ...next)
}

function remoteContributionKey(pluginId: string, id: string): string {
  return `${pluginId}\u0000${id}`
}

function registerRemoteContribution(pluginId: string, input: unknown): boolean {
  if (!input || typeof input !== 'object') throw new Error('UI contribution must be an object')
  const contribution = input as PluginUiContribution
  if (
    typeof contribution.id !== 'string' ||
    (!contribution.id.startsWith(`${pluginId}:`) &&
      !contribution.id.startsWith(`${pluginId}/`))
  ) {
    throw new Error('UI contribution ID must be namespaced by the plugin ID')
  }
  if (!PLUGIN_UI_SLOTS.includes(contribution.slot)) throw new Error('unsupported UI slot')
  if (!PLUGIN_UI_TYPES.includes(contribution.type)) throw new Error('unsupported UI type')
  if (typeof contribution.title !== 'string' || !contribution.title.trim()) {
    throw new Error('UI contribution title is required')
  }
  if (
    contribution.order !== undefined &&
    (!Number.isFinite(contribution.order) || !Number.isInteger(contribution.order))
  ) {
    throw new Error('UI contribution order must be a finite integer')
  }
  if (contribution.platforms !== undefined && !Array.isArray(contribution.platforms)) {
    throw new Error('UI contribution platforms must be an array')
  }
  if (
    contribution.platformsAllowed !== undefined &&
    !Array.isArray(contribution.platformsAllowed)
  ) {
    throw new Error('UI contribution allowed platforms must be an array')
  }
  for (const platform of contribution.platforms ?? []) {
    if (platform !== 'windows' && platform !== 'android') {
      throw new Error(`unsupported UI platform: ${String(platform)}`)
    }
  }
  if (
    contribution.props !== undefined &&
    (contribution.props === null ||
      typeof contribution.props !== 'object' ||
      Array.isArray(contribution.props))
  ) {
    throw new Error('UI contribution props must be an object')
  }
  for (const platform of contribution.platformsAllowed ?? []) {
    if (platform !== 'windows' && platform !== 'android') {
      throw new Error(`unsupported allowed UI platform: ${String(platform)}`)
    }
  }
  const key = remoteContributionKey(pluginId, contribution.id)
  if (remoteUi.has(key)) throw new Error('duplicate UI contribution ID')
  remoteUi.set(
    key,
    markRaw({
      id: contribution.id,
      type: contribution.type,
      slot: contribution.slot,
      title: contribution.title,
      icon: contribution.icon,
      order: contribution.order,
      props: contribution.props ? structuredClone(contribution.props) : undefined,
      ...(contribution.platforms
        ? { platforms: [...contribution.platforms] }
        : {}),
      ...(contribution.platformsAllowed
        ? { platformsAllowed: [...contribution.platformsAllowed] }
        : {}),
      pluginId,
    }),
  )
  refreshUiRegistry()
  return true
}

function stringArgument(args: readonly unknown[], index: number, label: string): string {
  const value = args[index]
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`)
  return value
}

function pluginStorageKey(args: readonly unknown[], index: number): string {
  const key = stringArgument(args, index, 'storage key')
  if (
    key.startsWith('/') ||
    key.includes('..') ||
    key.includes('\0') ||
    key === '__proto__' ||
    key === 'prototype' ||
    key === 'constructor'
  ) {
    throw new Error('plugin storage key must be a safe namespaced key')
  }
  return key
}

function recordArgument(args: readonly unknown[], index: number, label: string): Record<string, unknown> {
  const value = args[index]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function pluginNamespace(pluginId: string, name: string): void {
  if (!name.startsWith(`plugin:${pluginId}/`)) {
    throw new Error('sandbox events must use the plugin namespace')
  }
}

function pluginEventPayload(name: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const envelope = value as Record<string, unknown>
  if (
    envelope.schemaVersion === 1 &&
    typeof envelope.eventId === 'string' &&
    envelope.name === name &&
    typeof envelope.at === 'string' &&
    'payload' in envelope
  ) {
    return envelope.payload
  }
  return value
}

function rpcUnavailable(service: string): never {
  throw new Error(`${service} is not available from the host`)
}

function hostHandlers(): Record<string, PluginHostHandler> {
  const handlers: Record<string, PluginHostHandler> = {
    'library.list': {
      permission: 'library.read',
      handler: async (_args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        return hooks?.library?.listBooks?.() ?? rpcUnavailable('library.listBooks')
      },
    },
    'library.get': {
      permission: 'library.read',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        return (
          hooks?.library?.getBook?.(stringArgument(args, 0, 'bookId')) ??
          rpcUnavailable('library.getBook')
        )
      },
    },
    'library.search': {
      permission: 'library.read',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        return (
          hooks?.library?.searchBooks?.(stringArgument(args, 0, 'query')) ??
          rpcUnavailable('library.searchBooks')
        )
      },
    },
    'library.update': {
      permission: 'library.write',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        await (
          hooks?.library?.updateBook?.(recordArgument(args, 0, 'book') as unknown as Book) ??
          rpcUnavailable('library.updateBook')
        )
        return true
      },
    },
    'annotations.list': {
      permission: 'annotation.read',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        const bookId = typeof args[0] === 'string' ? args[0] : undefined
        return (
          hooks?.annotations?.listAnnotations?.(bookId) ??
          rpcUnavailable('annotations.listAnnotations')
        )
      },
    },
    'annotations.save': {
      permission: 'annotation.write',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        await (
          hooks?.annotations?.saveAnnotation?.(
            recordArgument(args, 0, 'annotation') as unknown as Annotation,
          ) ?? rpcUnavailable('annotations.saveAnnotation')
        )
        return true
      },
    },
    'annotations.delete': {
      permission: 'annotation.write',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        await (
          hooks?.annotations?.deleteAnnotation?.(stringArgument(args, 0, 'annotationId')) ??
          rpcUnavailable('annotations.deleteAnnotation')
        )
        return true
      },
    },
    'storage.get': {
      permission: 'storage.namespace',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        return (
          hooks?.storage?.get(context.pluginId, pluginStorageKey(args, 0)) ??
          rpcUnavailable('storage.get')
        )
      },
    },
    'storage.set': {
      permission: 'storage.namespace',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        await (
          hooks?.storage?.set(
            context.pluginId,
            pluginStorageKey(args, 0),
            structuredClone(args[1]),
          ) ?? rpcUnavailable('storage.set')
        )
        return true
      },
    },
    'storage.remove': {
      permission: 'storage.namespace',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        await (
          hooks?.storage?.remove(
            context.pluginId,
            pluginStorageKey(args, 0),
          ) ?? rpcUnavailable('storage.remove')
        )
        return true
      },
    },
    'events.emit': {
      handler: async (args, context) => {
        const name = stringArgument(args, 0, 'event name')
        pluginNamespace(context.pluginId, name)
        const hooks = configuredHooks.get(context.pluginId)
        await (hooks?.events?.emit(name, structuredClone(args[1])) ?? rpcUnavailable('events.emit'))
        return true
      },
    },
    'notifications.notify': {
      permission: 'notification',
      handler: async (args, context) => {
        const hooks = configuredHooks.get(context.pluginId)
        await (
          hooks?.notify?.(stringArgument(args, 0, 'notification')) ??
          rpcUnavailable('notifications.notify')
        )
        return true
      },
    },
    'ui.register': {
      permission: 'ui.register',
      handler: async (args, context) =>
        registerRemoteContribution(context.pluginId, args[0]),
    },
    'ui.unregister': {
      permission: 'ui.register',
      handler: async (args, context) => {
        const removed = remoteUi.delete(
          remoteContributionKey(context.pluginId, stringArgument(args, 0, 'contribution ID')),
        )
        if (removed) refreshUiRegistry()
        return removed
      },
    },
    'commands.register': {
      permission: 'ui.register',
      handler: async (args, context) => {
        const input = recordArgument(args, 0, 'command')
        const id = stringArgument([input.id], 0, 'command ID')
        const title = stringArgument([input.title], 0, 'command title')
        if (!id.startsWith(`${context.pluginId}:`) && !id.startsWith(`${context.pluginId}/`)) {
          throw new Error('command ID must use the plugin namespace')
        }
        const sandbox = sandboxViews.get(context.pluginId)
        commands.register(context.pluginId, {
          id,
          title,
          ...(typeof input.shortcut === 'string' ? { shortcut: input.shortcut } : {}),
          run: () => {
            if (!sandbox) throw new Error('sandbox is not running')
            return sandboxViewCall(sandbox, id)
          },
        })
        return true
      },
    },
  }
  return handlers
}

function sandboxViewCall(view: PluginSandboxView, method: string): Promise<unknown> {
  const transport = sandboxTransports.get(view.pluginId)
  if (!transport) return Promise.reject(new Error('sandbox is not available'))
  return transport.call(method)
}

const sandboxTransports = new Map<string, SandboxTransport>()

function ensureRuntime(): GranitePluginRuntime {
  if (runtime) return runtime
  runtime = new GranitePluginRuntime({
    ui: controlledUi,
    commands,
    hostHandlers: hostHandlers(),
    storage: {
      async get(pluginId, key) {
        const storage = configuredHooks.get(pluginId)?.storage
        return storage?.get(pluginId, key) ?? rpcUnavailable('storage.get')
      },
      async set(pluginId, key, value) {
        const storage = configuredHooks.get(pluginId)?.storage
        await (storage?.set(pluginId, key, value) ?? rpcUnavailable('storage.set'))
      },
      async remove(pluginId, key) {
        const storage = configuredHooks.get(pluginId)?.storage
        await (storage?.remove(pluginId, key) ?? rpcUnavailable('storage.remove'))
      },
    },
    extendApi: (api, manifest) => ({
      ...api,
      vue: Object.freeze({
        h,
        reactive,
        ref,
        computed,
        watch,
        defineComponent,
        onMounted,
        onUnmounted,
        markRaw,
      }),
      manifest,
    }),
  })
  runtime.ui.subscribe(refreshUiRegistry)
  refreshUiRegistry()
  return runtime
}

function normalizeTrustedModule(module: Record<string, unknown>): TrustedPluginModule {
  const candidate =
    module.default && typeof module.default === 'object'
      ? (module.default as Record<string, unknown>)
      : module
  const activate = candidate.activate
  if (typeof activate !== 'function') {
    throw new Error('trusted ESM bundle must export activate(api)')
  }
  return {
    activate: activate as TrustedPluginModule['activate'],
    ...(typeof candidate.ready === 'function'
      ? { ready: candidate.ready as TrustedPluginModule['ready'] }
      : {}),
  }
}

async function importTrustedBundle(source: string): Promise<TrustedPluginModule> {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const module = (await import(/* @vite-ignore */ url)) as Record<string, unknown>
    return normalizeTrustedModule(module)
  } finally {
    URL.revokeObjectURL(url)
  }
}

interface SandboxMessageBase {
  type?: string
  token?: string
  id?: number
  [key: string]: unknown
}

const SANDBOX_READY_TIMEOUT_MS = 10_000
const SANDBOX_CALL_TIMEOUT_MS = 30_000
const SANDBOX_DEACTIVATE_TIMEOUT_MS = 2_000

function withSandboxTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        globalThis.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

class SandboxReadyGate {
  private resolvePromise?: () => void
  private rejectPromise?: (error: Error) => void
  private timer?: ReturnType<typeof globalThis.setTimeout>
  readonly promise: Promise<void>

  constructor(label: string) {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolvePromise = resolve
      this.rejectPromise = reject
    })
    this.timer = globalThis.setTimeout(() => {
      this.reject(new Error(`${label} did not become ready within ${SANDBOX_READY_TIMEOUT_MS} ms`))
    }, SANDBOX_READY_TIMEOUT_MS)
  }

  resolve(): void {
    if (!this.resolvePromise) return
    globalThis.clearTimeout(this.timer)
    this.timer = undefined
    this.resolvePromise()
    this.resolvePromise = undefined
    this.rejectPromise = undefined
  }

  reject(error: Error): void {
    if (!this.rejectPromise) return
    globalThis.clearTimeout(this.timer)
    this.timer = undefined
    this.rejectPromise(error)
    this.resolvePromise = undefined
    this.rejectPromise = undefined
  }
}

function sandboxNetworkGuardSource(): string {
  return `
const graniteBlockedNetworkError = 'network access is only available through the permission-checked host RPC';
const graniteNetworkDenied = () => Promise.reject(new Error(graniteBlockedNetworkError));
const graniteNetworkConstructorDenied = function () { throw new Error(graniteBlockedNetworkError); };
function graniteBlockProperty(owner, name, value) {
  let target = owner;
  while (target) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      try {
        Object.defineProperty(target, name, { ...descriptor, value });
      } catch {}
      break;
    }
    target = Object.getPrototypeOf(target);
  }
  try {
    Object.defineProperty(owner, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value,
    });
  } catch {}
}
for (const name of [
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'mozRTCPeerConnection',
  'Worker',
  'SharedWorker',
]) {
  graniteBlockProperty(globalThis, name, graniteNetworkConstructorDenied);
}
graniteBlockProperty(globalThis, 'fetch', graniteNetworkDenied);
graniteBlockProperty(globalThis, 'importScripts', graniteNetworkConstructorDenied);
if (globalThis.navigator) {
  graniteBlockProperty(globalThis.navigator, 'sendBeacon', graniteNetworkConstructorDenied);
}
`
}

function sandboxRuntimeSource(bundleSourceExpression: string): string {
  return `
let pluginModule;
let activationDisposable;
const eventListeners = new Map();
const hostPending = new Map();
let hostRequestId = 0;
function hostRequest(method, args = []) {
  return new Promise((resolve, reject) => {
    const id = ++hostRequestId;
    hostPending.set(id, { resolve, reject });
    post({ type: 'host-request', id, method, args });
  });
}
function pluginApi(activateMessage) {
  const call = (service, method, ...args) => hostRequest(service + '.' + method, args);
  return {
    pluginId: activateMessage.manifest.id,
    manifest: activateMessage.manifest,
    permissions: {
      has: (permission) => activateMessage.permissions.includes(permission),
      assert: (permission) => {
        if (!activateMessage.permissions.includes(permission)) {
          throw new Error('permission denied: ' + permission);
        }
      },
    },
    library: {
      listBooks: () => call('library', 'list'),
      getBook: (id) => call('library', 'get', id),
      searchBooks: (query) => call('library', 'search', query),
      updateBook: (book) => call('library', 'update', book),
    },
    annotations: {
      listAnnotations: (bookId) => call('annotations', 'list', bookId),
      saveAnnotation: (annotation) => call('annotations', 'save', annotation),
      deleteAnnotation: (id) => call('annotations', 'delete', id),
    },
    storage: {
      get: (key) => call('storage', 'get', key),
      set: (key, value) => call('storage', 'set', key, value),
      remove: (key) => call('storage', 'remove', key),
    },
    events: {
      emit: (name, payload) => call('events', 'emit', name, payload),
      on: (name, listener) => {
        const listeners = eventListeners.get(name) || new Set();
        listeners.add(listener);
        eventListeners.set(name, listeners);
        return () => listeners.delete(listener);
      },
    },
    ui: {
      register: (contribution) => call('ui', 'register', contribution),
      unregister: (id) => call('ui', 'unregister', id),
    },
    commands: {
      register: (command) => call('commands', 'register', command),
    },
    notifications: {
      notify: (message) => call('notifications', 'notify', message),
    },
    host: {
      request: (method, ...args) => hostRequest(method, args),
    },
  };
}
async function activate(message) {
  const module = await import(${bundleSourceExpression});
  pluginModule = module.default && typeof module.default === 'object' ? module.default : module;
  if (typeof pluginModule.activate !== 'function') {
    throw new Error('plugin bundle must export activate(api)');
  }
  activationDisposable = await pluginModule.activate(pluginApi(message));
  post({ type: 'plugin-ready' });
}
async function dispatchPluginCall(data) {
  try {
    const method = pluginModule && pluginModule[data.method];
    if (typeof method !== 'function') throw new Error('plugin method not found: ' + data.method);
    const value = await method(...data.args);
    post({ type: 'plugin-response', id: data.id, ok: true, value });
  } catch (error) {
    post({ type: 'plugin-response', id: data.id, ok: false, error: errorMessage(error) });
  }
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
`
}

function sandboxMessageHandlerSource(): string {
  return `
async function dispatch(data) {
  if (!data || data.token !== activationToken) return;
  if (data.type === 'activate') {
    try { await activate(data); } catch (error) { post({ type: 'plugin-error', error: errorMessage(error) }); }
  } else if (data.type === 'host-response') {
    const pending = hostPending.get(data.id);
    if (!pending) return;
    hostPending.delete(data.id);
    if (data.ok) pending.resolve(data.value); else pending.reject(new Error(data.error));
  } else if (data.type === 'host-event') {
    for (const listener of eventListeners.get(data.event) || []) {
      try { listener(data.payload); } catch (error) { console.error(error); }
    }
  } else if (data.type === 'plugin-call') {
    await dispatchPluginCall(data);
  } else if (data.type === 'deactivate') {
    try {
      if (typeof activationDisposable === 'function') await activationDisposable();
      else if (activationDisposable && activationDisposable.dispose) await activationDisposable.dispose();
      if (pluginModule && typeof pluginModule.deactivate === 'function') await pluginModule.deactivate();
      activationDisposable = undefined;
      pluginModule = undefined;
      post({ type: 'plugin-response', id: data.id, ok: true, value: true });
    } catch (error) {
      post({ type: 'plugin-response', id: data.id, ok: false, error: errorMessage(error) });
    }
  }
}
`
}

class WorkerSandboxTransport implements SandboxTransport {
  private worker?: Worker
  private pluginUrl?: string
  private bootstrapUrl?: string
  private startContext?: SandboxStartContext
  private readyGate?: SandboxReadyGate
  private activationRequested = false
  private disposePromise?: Promise<void>
  private readonly token = createSandboxToken()
  private readonly pluginPending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof globalThis.setTimeout>
    }
  >()
  private nextCallId = 0

  constructor(
    private readonly pluginId: string,
    private readonly bundleSource: string,
  ) {}

  async start(context: SandboxStartContext): Promise<void> {
    if (this.worker) throw new Error('sandbox worker already started')
    this.startContext = context
    const ready = this.prepareReady()
    this.pluginUrl = URL.createObjectURL(
      new Blob([this.bundleSource], { type: 'text/javascript' }),
    )
    const source =
      sandboxNetworkGuardSource() +
      sandboxRuntimeSource(JSON.stringify(this.pluginUrl)) +
      sandboxMessageHandlerSource() +
      `
const activationToken = ${JSON.stringify(this.token)};
function post(message) { self.postMessage({ ...message, token: activationToken }); }
self.addEventListener('message', (event) => { void dispatch(event.data); });
post({ type: 'sandbox-ready' });
`
    this.bootstrapUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      this.worker = new Worker(this.bootstrapUrl, {
        name: `granite-plugin-${this.pluginId}`,
      })
      this.worker.addEventListener('message', this.handleMessage)
      this.worker.addEventListener('error', this.handleWorkerError)
      await ready
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  private prepareReady(): Promise<void> {
    if (this.readyGate) throw new Error('sandbox worker readiness is already pending')
    this.readyGate = new SandboxReadyGate(`plugin worker ${this.pluginId}`)
    return this.readyGate.promise
  }

  private resolveReady(): void {
    this.readyGate?.resolve()
  }

  private failReady(error: Error): void {
    this.readyGate?.reject(error)
  }

  private post(message: Record<string, unknown>): void {
    if (!this.worker) throw new Error('sandbox worker is not running')
    this.worker.postMessage({ ...message, token: this.token })
  }

  private handleMessage = (event: MessageEvent): void => {
    const data = event.data as SandboxMessageBase
    if (!data || typeof data !== 'object' || data.token !== this.token) return
    switch (data.type) {
      case 'sandbox-ready':
        if (!this.activationRequested && this.startContext) {
          this.activationRequested = true
          this.post({
            type: 'activate',
            manifest: this.startContext.manifest,
            permissions: this.startContext.permissions,
          })
        }
        break
      case 'plugin-ready':
        this.resolveReady()
        break
      case 'plugin-error':
        this.failReady(new Error(String(data.error)))
        break
      case 'host-request': {
        const id = Number(data.id)
        Promise.resolve(
          this.startContext?.requestHost(
            String(data.method),
            Array.isArray(data.args) ? data.args : [],
          ) ?? Promise.reject(new Error('sandbox is not active')),
        )
          .then((value) => this.post({ type: 'host-response', id, ok: true, value }))
          .catch((error) =>
            this.post({
              type: 'host-response',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
        break
      }
      case 'plugin-response': {
        const id = Number(data.id)
        const pending = this.pluginPending.get(id)
        if (!pending) break
        this.pluginPending.delete(id)
        globalThis.clearTimeout(pending.timer)
        if (data.ok) pending.resolve(data.value)
        else pending.reject(new Error(String(data.error)))
        break
      }
    }
  }

  private handleWorkerError = (event: ErrorEvent): void => {
    const error = new Error(event.message || 'sandbox worker failed')
    this.failReady(error)
    this.rejectPending(error)
  }

  call(method: string, args: readonly unknown[] = []): Promise<unknown> {
    return this.sendPluginMessage({
      type: 'plugin-call',
      method,
      args,
    })
  }

  private sendPluginMessage(
    message: Record<string, unknown>,
    timeoutMs = SANDBOX_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error('sandbox worker is not running'))
    const id = ++this.nextCallId
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pluginPending.delete(id)
        reject(new Error(`sandbox plugin call timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pluginPending.set(id, { resolve, reject, timer })
      try {
        this.post({ ...message, id })
      } catch (error) {
        globalThis.clearTimeout(timer)
        this.pluginPending.delete(id)
        reject(error)
      }
    })
  }

  notify(event: string, payload: unknown): void {
    if (this.worker) this.post({ type: 'host-event', event, payload })
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pluginPending.values()) {
      globalThis.clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pluginPending.clear()
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal()
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void> {
    this.failReady(new Error(`plugin worker ${this.pluginId} was disposed before activation`))
    if (this.worker) {
      try {
        await withSandboxTimeout(
          this.sendPluginMessage(
            { type: 'deactivate' },
            SANDBOX_DEACTIVATE_TIMEOUT_MS,
          ),
          SANDBOX_DEACTIVATE_TIMEOUT_MS,
          `plugin worker ${this.pluginId} did not acknowledge deactivation`,
        )
      } catch {
        // The worker is terminated below even when plugin cleanup hangs.
      }
      this.worker.terminate()
      this.worker = undefined
    }
    this.rejectPending(new Error('sandbox worker disposed'))
    if (this.pluginUrl) URL.revokeObjectURL(this.pluginUrl)
    if (this.bootstrapUrl) URL.revokeObjectURL(this.bootstrapUrl)
    this.pluginUrl = undefined
    this.bootstrapUrl = undefined
    this.startContext = undefined
  }
}

class IframeSandboxTransport implements SandboxTransport {
  private iframe?: HTMLIFrameElement
  private readonly token = createSandboxToken()
  private startContext?: SandboxStartContext
  private readyGate?: SandboxReadyGate
  private bootstrapUrl?: string
  private activationRequested = false
  private disposePromise?: Promise<void>
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof globalThis.setTimeout>
    }
  >()
  private nextCallId = 0

  constructor(
    private readonly pluginId: string,
    private readonly bundleSource: string,
  ) {}

  async start(context: SandboxStartContext): Promise<void> {
    if (this.iframe) throw new Error('sandbox iframe already started')
    this.startContext = context
    const ready = this.prepareReady()
    const bootstrap =
      `
const activationToken = ${JSON.stringify(this.token)};
` +
      sandboxNetworkGuardSource() +
      sandboxRuntimeSource('pluginUrl') +
      sandboxMessageHandlerSource() +
      `
let pluginUrl;
const parentOrigin = ${JSON.stringify(globalThis.location?.origin ?? '')};
function post(message) { parent.postMessage({ ...message, token: activationToken }, parentOrigin); }
window.addEventListener('message', async (event) => {
  if (event.source !== parent || event.origin !== parentOrigin) return;
  if (!event.data || event.data.token !== activationToken) return;
  if (event.data.type === 'activate') {
    pluginUrl = URL.createObjectURL(new Blob([event.data.bundle], { type: 'text/javascript' }));
  }
  await dispatch(event.data);
});
post({ type: 'sandbox-ready' });
`
    this.bootstrapUrl = URL.createObjectURL(
      new Blob([bootstrap], { type: 'text/javascript' }),
    )
    this.iframe = document.createElement('iframe')
    this.iframe.dataset.granitePluginId = this.pluginId
    this.iframe.setAttribute('sandbox', 'allow-scripts')
    this.iframe.setAttribute('aria-label', `${context.manifest.name} sandbox`)
    this.iframe.style.display = 'none'
    window.addEventListener('message', this.handleMessage)
    try {
      this.iframe.srcdoc = this.documentSource(this.bootstrapUrl)
      document.body.appendChild(this.iframe)
      await ready
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  private documentSource(bootstrapUrl: string): string {
    const escapedBootstrapUrl = bootstrapUrl
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:auto;font:14px system-ui;background:transparent;color:#282333}body{box-sizing:border-box;padding:16px}</style></head><body><div id="app"></div><script src="${escapedBootstrapUrl}"></script></body></html>`
  }

  private prepareReady(): Promise<void> {
    if (this.readyGate) throw new Error('sandbox iframe readiness is already pending')
    this.readyGate = new SandboxReadyGate(`plugin iframe ${this.pluginId}`)
    return this.readyGate.promise
  }

  private resolveReady(): void {
    this.readyGate?.resolve()
  }

  private failReady(error: Error): void {
    this.readyGate?.reject(error)
  }

  private post(message: Record<string, unknown>): void {
    this.iframe?.contentWindow?.postMessage({ ...message, token: this.token }, '*')
  }

  private handleMessage = (event: MessageEvent): void => {
    if (event.source !== this.iframe?.contentWindow || event.origin !== 'null') return
    const data = event.data as SandboxMessageBase
    if (!data || data.token !== this.token) return
    switch (data.type) {
      case 'sandbox-ready':
        if (this.bootstrapUrl) URL.revokeObjectURL(this.bootstrapUrl)
        this.bootstrapUrl = undefined
        if (!this.activationRequested && this.startContext) {
          this.activationRequested = true
          this.post({
            type: 'activate',
            bundle: this.bundleSource,
            manifest: this.startContext.manifest,
            permissions: this.startContext.permissions,
          })
        }
        break
      case 'plugin-ready':
        this.resolveReady()
        break
      case 'plugin-error':
        this.failReady(new Error(String(data.error)))
        break
      case 'host-request': {
        const id = Number(data.id)
        Promise.resolve(
          this.startContext?.requestHost(
            String(data.method),
            Array.isArray(data.args) ? data.args : [],
          ) ?? Promise.reject(new Error('sandbox is not active')),
        )
          .then((value) => this.post({ type: 'host-response', id, ok: true, value }))
          .catch((error) =>
            this.post({
              type: 'host-response',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
        break
      }
      case 'plugin-response': {
        const id = Number(data.id)
        const pending = this.pending.get(id)
        if (!pending) break
        this.pending.delete(id)
        globalThis.clearTimeout(pending.timer)
        if (data.ok) pending.resolve(data.value)
        else pending.reject(new Error(String(data.error)))
        break
      }
    }
  }

  call(method: string, args: readonly unknown[] = []): Promise<unknown> {
    return this.sendPluginMessage({
      type: 'plugin-call',
      method,
      args,
    })
  }

  private sendPluginMessage(
    message: Record<string, unknown>,
    timeoutMs = SANDBOX_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.iframe) return Promise.reject(new Error('sandbox iframe is not running'))
    const id = ++this.nextCallId
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`sandbox plugin call timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.post({ ...message, id })
      } catch (error) {
        globalThis.clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(event: string, payload: unknown): void {
    this.post({ type: 'host-event', event, payload })
  }

  mount(container: HTMLElement): () => void {
    if (!this.iframe) throw new Error('sandbox iframe is not running')
    this.iframe.style.display = 'block'
    this.iframe.style.width = '100%'
    this.iframe.style.height = '100%'
    this.iframe.style.border = '0'
    container.appendChild(this.iframe)
    return () => {
      if (this.iframe?.parentElement === container) this.iframe.remove()
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      globalThis.clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal()
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void> {
    this.failReady(new Error(`plugin iframe ${this.pluginId} was disposed before activation`))
    window.removeEventListener('message', this.handleMessage)
    if (this.iframe) {
      try {
        await withSandboxTimeout(
          this.sendPluginMessage(
            { type: 'deactivate' },
            SANDBOX_DEACTIVATE_TIMEOUT_MS,
          ),
          SANDBOX_DEACTIVATE_TIMEOUT_MS,
          `plugin iframe ${this.pluginId} did not acknowledge deactivation`,
        )
      } catch {
        // Removing the iframe is the isolation boundary when cleanup hangs.
      }
      this.iframe.remove()
      this.iframe = undefined
    }
    this.rejectPending(new Error('sandbox iframe disposed'))
    if (this.bootstrapUrl) URL.revokeObjectURL(this.bootstrapUrl)
    this.bootstrapUrl = undefined
    this.startContext = undefined
  }
}

function createSandboxToken(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
}

function createSandboxTransport(
  manifest: PluginManifest,
  bundleSource: string,
): SandboxTransport & { kind: 'worker' | 'iframe'; mount?(container: HTMLElement): () => void; notify(event: string, payload: unknown): void } {
  if (manifest.ui.kind === 'worker') {
    const worker = new WorkerSandboxTransport(manifest.id, bundleSource)
    return Object.assign(worker, {
      kind: 'worker' as const,
    })
  }
  const iframe = new IframeSandboxTransport(manifest.id, bundleSource)
  return Object.assign(iframe, {
    kind: 'iframe' as const,
  })
}

async function bundleForPlugin(plugin: InstalledPlugin): Promise<{ source: string; bytes: Uint8Array }> {
  if (typeof plugin.bundle !== 'string' || !plugin.bundle.trim()) {
    throw new Error(`plugin ${plugin.id} has no executable bundle`)
  }
  return {
    source: plugin.bundle,
    bytes: new TextEncoder().encode(plugin.bundle),
  }
}

export async function activateInstalled(
  plugin: InstalledPlugin,
  appHooks: PluginAppHooks = {},
  options: ActivateInstalledOptions = {},
): Promise<InitializedPlugin> {
  const existing = initializedPlugins.find((entry) => entry.id === plugin.id)
  if (existing && runtime?.get(plugin.id)?.status === 'active') return existing
  if (runtime?.get(plugin.id)) await deactivateInstalled(plugin.id)

  const trusted = options.trusted === true
  const validation = previewPluginManifest(
    activationManifest(manifestRecord(plugin), plugin.permissions, trusted),
    options,
  )
  if (!validation.valid || !validation.manifest) {
    const message = validation.errors.map((issue) => issue.message).join('; ')
    replaceInitialized({
      id: plugin.id,
      version: plugin.version,
      status: 'failed',
      trusted,
      permissions: plugin.permissions,
      error: message,
    })
    throw new Error(`plugin manifest validation failed: ${message}`)
  }
  const manifest = validation.manifest
  if (options.safeMode && manifest.source.kind !== 'builtin') {
    const disabled = {
      id: plugin.id,
      version: plugin.version,
      status: 'disabled',
      trusted,
      permissions: manifest.permissions,
      error: 'safe mode only activates built-in plugins',
    }
    replaceInitialized(disabled)
    return disabled
  }

  const bundle = await bundleForPlugin(plugin)
  if (!(await verifyBundleIntegrity(bundle.bytes, manifest.integrity))) {
    throw new Error('plugin bundle integrity verification failed')
  }

  configuredHooks.set(plugin.id, appHooks)
  trustedPlugins.set(plugin.id, trusted)
  const activeRuntime = ensureRuntime()
  let sandbox: ReturnType<typeof createSandboxTransport> | undefined
  try {
    const record = trusted
      ? await activeRuntime.activate(manifest, {
          kind: 'trusted-esm',
          module: await importTrustedBundle(bundle.source),
          bundleBytes: bundle.bytes,
        })
      : await (async () => {
          sandbox = createSandboxTransport(manifest, bundle.source)
          sandboxTransports.set(plugin.id, sandbox)
          sandboxViews.set(plugin.id, {
            pluginId: plugin.id,
            kind: sandbox!.kind,
            ...(sandbox!.mount ? { mount: (container) => sandbox!.mount!(container) } : {}),
            notify: (event, payload) => sandbox!.notify(event, payload),
          })
          return activeRuntime.activate(manifest, {
            kind: sandbox!.kind === 'worker' ? 'sandbox-worker' : 'sandbox-iframe',
            transport: sandbox!,
          })
        })()

    if (record.status !== 'active') {
      throw new Error(record.error ?? `plugin activation ended in ${record.status}`)
    }
    const disposeEvents = appHooks.events?.onAny?.((name, payload) => {
      const eventContext = activeRuntime.cordis as unknown as {
        emit(event: string, value: unknown): void
      }
      const deliveredPayload = pluginEventPayload(name, payload)
      eventContext.emit(name, deliveredPayload)
      if (sandbox && name.startsWith(`plugin:${plugin.id}/`)) {
        sandbox.notify(name, deliveredPayload)
      }
    })
    if (disposeEvents) eventDisposers.set(plugin.id, disposeEvents)
    refreshUiRegistry()

    const initialized: InitializedPlugin = {
      id: plugin.id,
      version: plugin.version,
      status: record.status,
      trusted,
      permissions: record.permissions,
    }
    replaceInitialized(initialized)
    return initialized
  } catch (error) {
    if (sandbox && !sandboxTransports.has(plugin.id)) await sandbox.dispose()
    await activeRuntime.deactivate(plugin.id)
    configuredHooks.delete(plugin.id)
    trustedPlugins.delete(plugin.id)
    sandboxViews.delete(plugin.id)
    sandboxTransports.delete(plugin.id)
    replaceInitialized({
      id: plugin.id,
      version: plugin.version,
      status: 'failed',
      trusted,
      permissions: plugin.permissions,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export async function initializeInstalledPlugins(
  plugins: readonly InstalledPlugin[],
  appHooks: PluginAppHooks = {},
  options: ActivateInstalledOptions = {},
): Promise<InitializedPlugin[]> {
  const output: InitializedPlugin[] = []
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    try {
      output.push(await activateInstalled(plugin, appHooks, options))
    } catch {
      const failed = initializedPlugins.find((entry) => entry.id === plugin.id)
      if (failed) output.push(failed)
    }
  }
  return output
}

export async function deactivateInstalled(id: string): Promise<boolean> {
  try {
    eventDisposers.get(id)?.()
  } catch {
    // A host event adapter cannot prevent the plugin's remaining resources
    // from being released.
  }
  eventDisposers.delete(id)
  const deactivated = runtime ? await runtime.deactivate(id).catch(() => false) : false
  const transport = sandboxTransports.get(id)
  if (transport) await Promise.resolve(transport.dispose()).catch(() => undefined)
  sandboxTransports.delete(id)
  sandboxViews.delete(id)
  configuredHooks.delete(id)
  trustedPlugins.delete(id)
  for (const key of [...remoteUi.keys()]) {
    if (key.startsWith(`${id}\u0000`)) remoteUi.delete(key)
  }
  removeInitialized(id)
  refreshUiRegistry()
  return deactivated
}

export async function disposePluginManager(): Promise<void> {
  for (const id of [...initializedPlugins.map((plugin) => plugin.id)]) {
    await deactivateInstalled(id)
  }
  await runtime?.dispose()
  runtime = undefined
  pluginUiContributions.splice(0, pluginUiContributions.length)
}

export function pluginUiForSlot(slot: PluginUiSlot): readonly PluginUiEntry[] {
  return pluginUiContributions.filter((entry) => entry.slot === slot)
}

export function pluginSandboxFor(id: string): PluginSandboxView | undefined {
  return sandboxViews.get(id)
}

export function pluginRuntimeStatus(id: string): string | undefined {
  return runtime?.get(id)?.status
}

export const pluginUiRegistry = readonly({
  contributions: pluginUiContributions,
  forSlot: pluginUiForSlot,
  sandbox: pluginSandboxFor,
})

export interface RestrictedPluginSourceOptions extends PreviewPluginOptions {
  maxBytes?: number
  allowedHosts?: readonly string[]
  fetchArchive?: (url: string, maxBytes: number) => Promise<Uint8Array>
}

const DEFAULT_PLUGIN_SOURCE_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
]
const PLUGIN_ARCHIVE_LIMIT_BYTES = 20 * 1024 * 1024
const PLUGIN_BUNDLE_LIMIT_BYTES = 20 * 1024 * 1024
const PLUGIN_MANIFEST_LIMIT_BYTES = 256 * 1024

function validatePluginSourceUrl(sourceUrl: string, allowedHosts: readonly string[]): URL {
  const url = new URL(sourceUrl)
  if (url.protocol !== 'https:') throw new Error('plugin source must use HTTPS')
  if (url.username || url.password) throw new Error('plugin source URLs cannot contain credentials')
  if (url.port && url.port !== '443') throw new Error('plugin source must use the HTTPS port')
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`plugin source host is not allowed: ${url.hostname}`)
  }
  return url
}

async function fetchArchiveThroughHost(url: string, maxBytes: number): Promise<Uint8Array> {
  const response = await hostCall<{ bytes: number[] }>('plugin.fetch', {
    url,
    maxBytes,
  })
  if (!Array.isArray(response.bytes)) throw new Error('native plugin fetch returned no bytes')
  if (response.bytes.length > maxBytes) throw new Error('plugin archive exceeds size limit')
  return Uint8Array.from(response.bytes)
}

export async function previewPluginSource(
  sourceUrl: string,
  options: RestrictedPluginSourceOptions = {},
): Promise<PluginPackagePreview & { sourceUrl: string }> {
  const maxBytes = Math.min(options.maxBytes ?? PLUGIN_ARCHIVE_LIMIT_BYTES, PLUGIN_ARCHIVE_LIMIT_BYTES)
  const url = validatePluginSourceUrl(
    sourceUrl,
    options.allowedHosts ?? DEFAULT_PLUGIN_SOURCE_HOSTS,
  ).toString()
  const bytes = await (options.fetchArchive ?? fetchArchiveThroughHost)(url, maxBytes)
  if (bytes.byteLength > maxBytes) throw new Error('plugin archive exceeds size limit')
  const preview = await previewPluginPackage(bytes, {
    ...options,
    maxBytes,
    actualSource: { kind: 'url', uri: url },
  })
  return { ...preview, sourceUrl: url }
}

export async function previewPluginPackage(
  packageBytes: Uint8Array,
  options: PreviewPluginOptions = {},
): Promise<PluginPackagePreview> {
  const maxBytes = Math.min(options.maxBytes ?? PLUGIN_ARCHIVE_LIMIT_BYTES, PLUGIN_ARCHIVE_LIMIT_BYTES)
  if (packageBytes.byteLength > maxBytes) throw new Error('plugin archive exceeds size limit')
  const zip = await JSZip.loadAsync(packageBytes)
  const manifestEntry = zip.file('manifest.json')
  if (!manifestEntry) throw new Error('plugin package is missing manifest.json')
  const manifestBytes = await readBoundedZipEntry(
    manifestEntry,
    'manifest.json',
    Math.min(PLUGIN_MANIFEST_LIMIT_BYTES, maxBytes),
  )
  const rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>
  const validation = previewPluginManifest(rawManifest, options)
  if (!validation.valid || !validation.manifest) {
    return { validation, requiresUserReview: true }
  }
  const mainPath = validation.manifest.main
  const main = zip.file(mainPath)
  if (!main) throw new Error(`plugin package is missing ${mainPath}`)
  const bundle = await readBoundedZipEntry(
    main,
    mainPath,
    Math.min(PLUGIN_BUNDLE_LIMIT_BYTES, maxBytes),
  )
  if (!(await verifyBundleIntegrity(bundle, validation.manifest.integrity))) {
    throw new Error('plugin bundle integrity verification failed')
  }
  return {
    validation,
    manifest: validation.manifest,
    bundle,
    requiresUserReview: true,
  }
}

interface BoundedZipStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): BoundedZipStream
  on(event: 'end', callback: () => void): BoundedZipStream
  on(event: 'error', callback: (error: Error) => void): BoundedZipStream
  pause(): BoundedZipStream
  resume(): BoundedZipStream
}

function readBoundedZipEntry(
  entry: JSZip.JSZipObject,
  name: string,
  maxBytes: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let length = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      stream.pause()
      reject(error)
    }
    const stream = (
      entry as JSZip.JSZipObject & {
        internalStream(type: 'uint8array'): BoundedZipStream
      }
    ).internalStream('uint8array')
    stream
      .on('data', (chunk) => {
        if (settled) return
        length += chunk.byteLength
        if (length > maxBytes) {
          fail(new Error(`plugin entry ${name} exceeds the ${maxBytes}-byte extraction limit`))
          return
        }
        chunks.push(new Uint8Array(chunk))
      })
      .on('error', (error) => fail(error))
      .on('end', () => {
        if (settled) return
        settled = true
        const output = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          output.set(chunk, offset)
          offset += chunk.byteLength
        }
        resolve(output)
      })
      .resume()
  })
}

export const PluginSandboxHost = defineComponent({
  name: 'PluginSandboxHost',
  props: {
    pluginId: { type: String, required: true },
    title: { type: String, default: '' },
    kind: { type: String, default: 'iframe' },
  },
  setup(props) {
    const container = ref<HTMLElement>()
    let unmount: (() => void) | undefined
    onMounted(() => {
      const view = sandboxViews.get(props.pluginId)
      if (container.value && view?.mount) unmount = view.mount(container.value)
    })
    onUnmounted(() => unmount?.())
    return () =>
      h('div', { class: 'plugin-sandbox-host', ref: container }, [
        props.kind === 'worker'
          ? h('div', { class: 'plugin-sandbox-host__notice' }, `${props.title || props.pluginId} · Worker 插件运行中`)
          : undefined,
      ])
  },
})

