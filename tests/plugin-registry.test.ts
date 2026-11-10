import { describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_REGISTRY_MAX_BYTES,
  PLUGIN_REGISTRY_MAX_ENTRIES,
  comparePluginRegistryVersion,
  fetchPluginRegistry,
  findPluginRegistryUpdates,
  parsePluginRegistryJson,
  verifyRegistryPackage,
  type PluginRegistryEntry,
} from '../src/services/plugin-registry'

const integrity = `sha256-${'A'.repeat(43)}`

it('pins directory identity, version and integrity before installation review', async () => {
  const candidate = entry();
  const bytes = new TextEncoder().encode('export default {}');
  await expect(verifyRegistryPackage(candidate, { id: 'another.plugin', version: candidate.version }, bytes)).rejects.toThrow('标识或版本');
  await expect(verifyRegistryPackage(candidate, { id: candidate.id, version: '9.0.0' }, bytes)).rejects.toThrow('标识或版本');
  await expect(verifyRegistryPackage(candidate, { id: candidate.id, version: candidate.version }, bytes)).rejects.toThrow('SRI');
  await expect(verifyRegistryPackage({ ...candidate, integrity: undefined }, { id: candidate.id, version: candidate.version }, bytes)).resolves.toBeUndefined();
});

function entry(
  overrides: Partial<PluginRegistryEntry> = {},
): PluginRegistryEntry {
  return {
    id: 'example.reader-tools',
    name: 'Reader Tools',
    version: '2.1.0',
    description: 'Reader utilities for Granite.',
    author: 'Example Author',
    license: 'MIT',
    packageUrl: 'https://plugins.example.test/reader-tools.granite',
    integrity,
    ...overrides,
  }
}

function catalogBytes(
  plugins: unknown[],
  schemaVersion: unknown = 1,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ schemaVersion, plugins }),
  )
}

describe('plugin registry catalog', () => {
  it('parses a valid bounded catalog and normalizes the package URL', () => {
    const parsed = parsePluginRegistryJson(
      catalogBytes([entry({ packageUrl: 'https://plugins.example.test/a.granite#ignored' })]),
    )

    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.plugins).toHaveLength(1)
    expect(parsed.plugins[0]).toMatchObject({
      id: 'example.reader-tools',
      version: '2.1.0',
      integrity,
      packageUrl: 'https://plugins.example.test/a.granite',
    })
  })

  it('rejects invalid fields, duplicate IDs, and credentialed package URLs', () => {
    expect(() =>
      parsePluginRegistryJson(
        catalogBytes([
          entry(),
          entry({ name: '' }),
        ]),
      ),
    ).toThrow('必须是非空字符串')

    expect(() =>
      parsePluginRegistryJson(
        catalogBytes([
          entry(),
          entry({ version: 'latest' }),
        ]),
      ),
    ).toThrow('语义化版本')

    expect(() =>
      parsePluginRegistryJson(catalogBytes([entry(), entry()])),
    ).toThrow('与其他条目重复')

    expect(() =>
      parsePluginRegistryJson(
        catalogBytes([
          entry({
            packageUrl:
              'https://user:secret@plugins.example.test/reader-tools.granite',
          }),
        ]),
      ),
    ).toThrow('不能包含嵌入凭证')
  })

  it('validates integrity metadata instead of accepting arbitrary claims', () => {
    expect(() =>
      parsePluginRegistryJson(
        catalogBytes([entry({ integrity: 'sha1-abc' })]),
      ),
    ).toThrow('SHA-256/384/512 SRI')

    expect(() =>
      parsePluginRegistryJson(
        catalogBytes([entry({ integrity: 'sha256-too-short' })]),
      ),
    ).toThrow('SHA-256/384/512 SRI')

    expect(() =>
      parsePluginRegistryJson(
        catalogBytes([entry({ integrity: `${integrity}==` })]),
      ),
    ).toThrow('SHA-256/384/512 SRI')
  })

  it('enforces entry and byte limits before accepting a catalog', () => {
    const tooMany = Array.from(
      { length: PLUGIN_REGISTRY_MAX_ENTRIES + 1 },
      (_, index) =>
        entry({
          id: `example.plugin-${index}`,
        }),
    )
    expect(() =>
      parsePluginRegistryJson(catalogBytes(tooMany)),
    ).toThrow(`${PLUGIN_REGISTRY_MAX_ENTRIES} 条限制`)

    expect(() =>
      parsePluginRegistryJson(new Uint8Array(PLUGIN_REGISTRY_MAX_BYTES + 1)),
    ).toThrow(`${PLUGIN_REGISTRY_MAX_BYTES} 字节限制`)
  })
})

describe('plugin registry updates', () => {
  it('uses semantic versions and ignores installed versions that cannot be compared', () => {
    expect(comparePluginRegistryVersion('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(comparePluginRegistryVersion('2.0.0', '2.0.0')).toBe(0)
    expect(comparePluginRegistryVersion('2.0.0', 'development')).toBeUndefined()

    const updates = findPluginRegistryUpdates(
      [
        entry({ id: 'example.newer', version: '2.0.0' }),
        entry({ id: 'example.current', version: '1.0.0' }),
        entry({ id: 'example.invalid-installed', version: '3.0.0' }),
        entry({ id: 'example.not-installed', version: '4.0.0' }),
      ],
      [
        { id: 'example.newer', version: '1.4.0' },
        { id: 'example.current', version: '1.0.0' },
        { id: 'example.invalid-installed', version: 'local-build' },
      ],
    )

    expect(updates.map((update) => update.entry.id)).toEqual([
      'example.newer',
    ])
  })
})

describe('plugin registry network boundary', () => {
  it('passes the 1 MiB bound to host fetches and rejects oversized responses', async () => {
    const fetchBytes = vi.fn(async () => {
      throw new Error('unreachable')
    })
    const oversized = vi.fn(
      async (
        _url: string,
        maxBytes: number,
      ): Promise<Uint8Array> =>
        new Uint8Array(maxBytes + 1),
    )

    await expect(
      fetchPluginRegistry('https://registry.example.test/catalog.json', {
        fetchBytes,
      }),
    ).rejects.toThrow('unreachable')
    expect(fetchBytes).toHaveBeenCalledWith(
      'https://registry.example.test/catalog.json',
      PLUGIN_REGISTRY_MAX_BYTES,
      undefined,
    )

    await expect(
      fetchPluginRegistry('https://registry.example.test/catalog.json', {
        fetchBytes: oversized,
      }),
    ).rejects.toThrow(`${PLUGIN_REGISTRY_MAX_BYTES} 字节限制`)
    expect(oversized).toHaveBeenCalledWith(
      'https://registry.example.test/catalog.json',
      PLUGIN_REGISTRY_MAX_BYTES,
      undefined,
    )
  })

  it('rejects insecure or credentialed registry URLs before fetching', async () => {
    const fetchBytes = vi.fn(async () => catalogBytes([]))

    await expect(
      fetchPluginRegistry('http://registry.example.test/catalog.json', {
        fetchBytes,
      }),
    ).rejects.toThrow('必须使用 HTTPS')
    await expect(
      fetchPluginRegistry(
        'https://user:secret@registry.example.test/catalog.json',
        { fetchBytes },
      ),
    ).rejects.toThrow('不能包含嵌入凭证')
    expect(fetchBytes).not.toHaveBeenCalled()
  })
})
