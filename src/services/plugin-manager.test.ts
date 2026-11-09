// @vitest-environment jsdom

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledPlugin } from '../types'
import {
  activateInstalled,
  deactivateInstalled,
  disposePluginManager,
  initializedPlugins,
} from './plugin-manager'

function sri(source: string): string {
  return `sha256-${createHash('sha256').update(source).digest('base64')}`
}

const blobs = new Map<string, Blob>()
let blobSequence = 0
const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL

class FakeWorker {
  static instances: FakeWorker[] = []
  static acknowledgeDeactivate = true
  readonly source: string
  readonly posted: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()
  private token = ''

  constructor(scriptUrl: string | URL) {
    this.source = String(scriptUrl)
    FakeWorker.instances.push(this)
    const blob = blobs.get(this.source)
    if (!blob) throw new Error(`missing mock blob: ${this.source}`)
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      try {
        this.token = /const activationToken = "([^"]+)"/.exec(text)?.[1] ?? ''
        this.emit('message', {
          data: { type: 'sandbox-ready', token: this.token },
        } as MessageEvent)
      } catch (error) {
        this.emit('error', {
          message: error instanceof Error ? error.message : String(error),
        } as ErrorEvent)
      }
    })
    reader.readAsText(blob)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(structuredClone(message))
    if (message.type === 'activate') {
      queueMicrotask(() => {
        this.emit('message', {
          data: { type: 'plugin-ready', token: this.token },
        } as MessageEvent)
      })
    }
    if (message.type === 'deactivate' && FakeWorker.acknowledgeDeactivate) {
      queueMicrotask(() => {
        this.emit('message', {
          data: {
            type: 'plugin-response',
            id: message.id,
            ok: true,
            value: true,
            token: this.token,
          },
        } as MessageEvent)
      })
    }
  }

  terminate(): void {}

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function installedPlugin(
  permissions: string[],
  requestedPermissions: string[],
  uiKind: 'worker' | 'iframe' = 'worker',
): InstalledPlugin {
  const bundle = 'export default { async activate() {} }'
  const manifest = {
    schemaVersion: 1,
    id: 'manager.example',
    name: 'Manager Example',
    version: '1.0.0',
    apiVersion: '^1.0.0',
    main: 'main.js',
    dependencies: {},
    optionalDependencies: {},
    permissions: requestedPermissions,
    contributes: [],
    platforms: ['windows', 'android'],
    author: 'Granite',
    license: 'MIT',
    integrity: sri(bundle),
    source: { kind: 'url', uri: 'https://plugins.example.test/manager-example.zip' },
    trust: 'untrusted',
    ui: { kind: uiKind },
  }
  return {
    id: 'manager.example',
    name: 'Manager Example',
    version: '1.0.0',
    enabled: true,
    permissions,
    manifest,
    bundle,
  }
}

async function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () =>
      resolve(typeof reader.result === 'string' ? reader.result : ''),
    )
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsText(blob)
  })
}

async function waitForIframe(pluginId: string): Promise<HTMLIFrameElement> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const iframe = document.querySelector<HTMLIFrameElement>(
      `iframe[data-granite-plugin-id="${pluginId}"]`,
    )
    if (iframe) return iframe
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  }
  throw new Error('sandbox iframe was not created')
}

describe('Granite plugin manager', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    FakeWorker.acknowledgeDeactivate = true
    blobs.clear()
    vi.stubGlobal('Worker', FakeWorker)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        blobSequence += 1
        const url = `blob:granite-test-${blobSequence}`
        blobs.set(url, blob)
        return url
      },
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => {
        blobs.delete(url)
      },
    })
  })

  afterEach(async () => {
    await disposePluginManager()
    vi.unstubAllGlobals()
    if (originalCreateObjectUrl) URL.createObjectURL = originalCreateObjectUrl
    else Reflect.deleteProperty(URL, 'createObjectURL')
    if (originalRevokeObjectUrl) URL.revokeObjectURL = originalRevokeObjectUrl
    else Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  it('waits for plugin readiness and intersects granted permissions', async () => {
    const plugin = installedPlugin(
      ['storage.namespace'],
      ['storage.namespace', 'library.read'],
    )
    const record = await activateInstalled(plugin, {})
    const worker = FakeWorker.instances[0]!
    const activation = worker.posted.find((message) => message.type === 'activate')

    expect(record).toMatchObject({
      status: 'active',
      permissions: ['storage.namespace'],
    })
    expect(activation?.permissions).toEqual(['storage.namespace'])
    expect(initializedPlugins).toContainEqual(record)
    await expect(deactivateInstalled(plugin.id)).resolves.toBe(true)
  })

  it('delivers only the owning plugin namespace to an untrusted sandbox', async () => {
    const plugin = installedPlugin(['storage.namespace'], ['storage.namespace'])
    let forwardEvent:
      | ((name: string, payload: unknown) => void)
      | undefined
    await activateInstalled(plugin, {
      events: {
        emit: () => undefined,
        onAny: (listener) => {
          forwardEvent = listener
          return () => undefined
        },
      },
    })
    const worker = FakeWorker.instances[0]!

    forwardEvent?.('plugin:manager.example/own-event', { allowed: true })
    forwardEvent?.('plugin:other.example/private-event', { secret: 'not-for-you' })
    forwardEvent?.('library.private-event', { secret: 'app-only' })

    expect(worker.posted.filter((message) => message.type === 'host-event')).toEqual([
      {
        type: 'host-event',
        event: 'plugin:manager.example/own-event',
        payload: { allowed: true },
        token: expect.any(String),
      },
    ])
  })

  it('bounds teardown when a worker never acknowledges deactivation', async () => {
    FakeWorker.acknowledgeDeactivate = false
    const plugin = installedPlugin(['storage.namespace'], ['storage.namespace'])
    await activateInstalled(plugin, {})

    const started = performance.now()
    await expect(deactivateInstalled(plugin.id)).resolves.toBe(true)
    const elapsed = performance.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(1_800)
    expect(elapsed).toBeLessThan(4_000)
  })

  it('loads iframe bootstrap from a blob URL and waits for plugin-ready', async () => {
    const plugin = installedPlugin(['storage.namespace'], ['storage.namespace'], 'iframe')
    const activation = activateInstalled(plugin, {})
    const iframe = await waitForIframe(plugin.id)
    const documentSource = iframe.srcdoc
    const bootstrapUrl = /<script src="([^"]+)"><\/script>/.exec(documentSource)?.[1]

    expect(documentSource).toContain("script-src blob:")
    expect(documentSource).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
    expect(bootstrapUrl).toMatch(/^blob:/)
    const bootstrap = blobs.get(bootstrapUrl!)
    expect(bootstrap).toBeDefined()
    const token = /const activationToken = "([^"]+)"/.exec(
      await blobText(bootstrap!),
    )?.[1]
    expect(token).toBeTruthy()

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'sandbox-ready', token },
        origin: 'null',
        source: iframe.contentWindow,
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'plugin-ready', token },
        origin: 'null',
        source: iframe.contentWindow,
      }),
    )

    await expect(activation).resolves.toMatchObject({ status: 'active' })
  })
})
