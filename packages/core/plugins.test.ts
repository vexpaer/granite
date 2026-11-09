import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ControlledUiRegistry,
  createPluginRuntime,
  PermissionBroker,
  validateManifest,
  verifyBundleIntegrity,
  webCryptoDigest,
  type PluginManifest,
  type PluginRuntimeApi,
  type SandboxStartContext,
  type SandboxTransport,
} from './index'

async function integrityFor(source: string): Promise<string> {
  const digest = await webCryptoDigest('sha256', new TextEncoder().encode(source))
  return `sha256-${Buffer.from(digest).toString('base64')}`
}

function rawManifest(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version: '1.2.3',
    apiVersion: '^1.0.0',
    main: 'main.js',
    dependencies: {},
    optionalDependencies: {},
    permissions: ['storage.namespace', 'ui.register'],
    contributes: [{ id: `${id}:settings`, slot: 'settings.pages' }],
    platforms: ['windows', 'android'],
    author: 'Granite',
    license: 'MIT',
    integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    source: { kind: 'url', uri: 'https://plugins.example.test/package.zip' },
    trust: 'untrusted',
    ui: { kind: 'worker' },
    ...overrides,
  }
}

function normalizedManifest(
  id: string,
  overrides: Record<string, unknown> = {},
): PluginManifest {
  const result = validateManifest(rawManifest(id, overrides))
  if (!result.valid || !result.manifest) {
    throw new Error(result.errors.map((issue) => issue.message).join('; '))
  }
  return result.manifest
}

describe('plugin manifest validation', () => {
  it('validates semantic versions, permissions, source, UI trust, and SRI syntax', () => {
    const result = validateManifest(
      rawManifest('example.plugin', {
        version: '1.0',
        permissions: ['filesystem.read'],
        integrity: 'abcdef',
        trust: 'trusted',
        ui: { kind: 'iframe' },
        source: {
          kind: 'url',
          uri: 'https://user:secret@plugins.example.test/package.zip',
        },
      }),
    )

    expect(result.valid).toBe(false)
    expect(result.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'plugin-version',
        'permission',
        'integrity',
        'trusted-ui',
        'source-credentials',
      ]),
    )
  })

  it('returns a topological dependency order and rejects cycles', () => {
    const first = rawManifest('first.plugin', {
      dependencies: { 'second.plugin': '^2.0.0' },
    })
    const second = rawManifest('second.plugin', {
      version: '2.1.0',
      dependencies: { 'first.plugin': '^1.0.0' },
    })
    const result = validateManifest(first, {
      manifests: [first, second],
    })

    expect(result.valid).toBe(false)
    expect(result.dependencyGraph?.valid).toBe(false)
    expect(result.dependencyGraph?.issues).toContainEqual(
      expect.objectContaining({ code: 'dependency-cycle' }),
    )
  })

  it('verifies SRI rather than treating integrity as a plain hex digest', async () => {
    const source = 'export async function activate() {}'
    const integrity = await integrityFor(source)

    await expect(
      verifyBundleIntegrity(new TextEncoder().encode(source), integrity),
    ).resolves.toBe(true)
    await expect(
      verifyBundleIntegrity(
        new TextEncoder().encode(source),
        `sha256-${'0'.repeat(64)}`,
      ),
    ).resolves.toBe(false)
  })

  it('keeps the example package valid and SRI-verified', async () => {
    const root = join(process.cwd(), 'packages', 'core', 'examples', 'basic-plugin')
    const manifest = JSON.parse(
      await readFile(join(root, 'dist', 'manifest.json'), 'utf8'),
    )
    const main = await readFile(join(root, 'src', 'main.js'))

    expect(validateManifest(manifest).valid).toBe(true)
    await expect(
      verifyBundleIntegrity(main, manifest.integrity),
    ).resolves.toBe(true)
  })
})

describe('Cordis plugin lifecycle and fault isolation', () => {
  it('rejects raw HTML elements and unsafe UI props', () => {
    const registry = new ControlledUiRegistry()
    const permissions = new PermissionBroker('safe.plugin', ['ui.register'])

    expect(() =>
      registry.register('safe.plugin', permissions, {
        id: 'safe.plugin:settings',
        type: 'settings',
        slot: 'settings.pages',
        title: 'Settings',
        component: 'iframe',
      }),
    ).toThrow('Vue component')
    expect(() =>
      registry.register('safe.plugin', permissions, {
        id: 'safe.plugin:settings',
        type: 'settings',
        slot: 'settings.pages',
        title: 'Settings',
        component: {},
        props: { innerHTML: '<script>alert(1)</script>' },
      }),
    ).toThrow('raw HTML')
  })

  it('runs a trusted ESM module, reverses registrations, and namespaces events', async () => {
    const bundle = 'trusted bundle'
    const integrity = await integrityFor(bundle)
    const manifest = normalizedManifest('trusted.plugin', {
      trust: 'trusted',
      ui: { kind: 'esm' },
      integrity,
    })
    const runtime = createPluginRuntime({
      storage: {
        async get() {
          return undefined
        },
        async set() {},
        async remove() {},
      },
    })
    const observed: unknown[] = []
    let cleanupCount = 0

    const record = await runtime.activate(manifest, {
      kind: 'trusted-esm',
      bundleBytes: new TextEncoder().encode(bundle),
      module: {
        activate(api: PluginRuntimeApi) {
          api.events.on('app.started', (payload) => observed.push(payload))
          api.events.emit('plugin:trusted.plugin/started', { ready: true })
          api.ui.register({
            id: 'trusted.plugin:settings',
            type: 'settings',
            slot: 'settings.pages',
            title: 'Trusted Settings',
          })
          expect(() => api.events.emit('other.plugin/started')).toThrow(/namespace/)
          return () => {
            cleanupCount += 1
          }
        },
        ready() {
          return () => {
            cleanupCount += 1
          }
        },
      },
    })

    expect(record.status).toBe('active')
    ;(runtime.cordis as unknown as {
      emit(name: string, payload: unknown): void
    }).emit('app.started', { bookId: 'book-1' })
    expect(observed).toEqual([{ bookId: 'book-1' }])
    expect(runtime.ui.list()).toEqual([
      expect.objectContaining({
        id: 'trusted.plugin:settings',
        pluginId: 'trusted.plugin',
      }),
    ])

    await expect(runtime.deactivate('trusted.plugin')).resolves.toBe(true)
    expect(cleanupCount).toBe(2)
    expect(runtime.ui.list()).toEqual([])
    await runtime.dispose()
  })

  it('contains an activation failure without stopping healthy plugins', async () => {
    const runtime = createPluginRuntime()
    const good = normalizedManifest('good.plugin', {
      trust: 'trusted',
      ui: { kind: 'esm' },
    })
    const bad = normalizedManifest('bad.plugin', {
      trust: 'trusted',
      ui: { kind: 'esm' },
    })

    await runtime.activate(good, {
      kind: 'trusted-esm',
      module: {
        activate() {
          return undefined
        },
      },
    })
    const failed = await runtime.activate(bad, {
      kind: 'trusted-esm',
      module: {
        activate() {
          throw new Error('plugin exploded')
        },
      },
    })

    expect(runtime.get('good.plugin')?.status).toBe('active')
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('plugin exploded')
    await runtime.dispose()
  })

  it('enforces RPC permissions at the host boundary', async () => {
    const bundle = 'sandbox bundle'
    const integrity = await integrityFor(bundle)
    const manifest = normalizedManifest('sandbox.plugin', {
      permissions: ['storage.namespace'],
      contributes: [],
      integrity,
    })
    let startContext: SandboxStartContext | undefined
    const transport: SandboxTransport = {
      async start(context: SandboxStartContext) {
        startContext = context
      },
      async call() {
        return undefined
      },
      dispose() {},
    }
    const runtime = createPluginRuntime({
      hostHandlers: {
        'library.list': {
          permission: 'library.read',
          handler: () => [],
        },
      },
    })

    const record = await runtime.activate(manifest, {
      kind: 'sandbox-worker',
      transport,
    })
    expect(record.status).toBe('active')
    await expect(
      startContext!.requestHost('library.list'),
    ).rejects.toMatchObject({ permission: 'library.read' })
    await runtime.dispose()
  })
})
