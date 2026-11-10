import { describe, expect, it } from 'vitest';
import { createHostProviderTransport, createProvider, LocalFilesystemProvider, ProviderError } from './provider';
import type { ProviderProfile } from '../../src/types';

const profile: ProviderProfile = {
  id: 'local-store', type: 'local', name: 'Selected folder', endpoint: 'E:/Library',
  prefix: '.granite-provider', credentialId: '',
  root: { id: 'selected-root', displayName: 'Selected folder', path: 'E:/Library', kind: 'filesystem', permission: 'granted', enabled: true, isDefault: false, readonly: false, scanState: 'idle' },
};

describe('local filesystem provider', () => {
  it('keeps the granted root and prefix across the bridge without requiring a credential', async () => {
    const requests: { op: string; args: Record<string, unknown> }[] = [];
    const transport = createHostProviderTransport(async request => {
      requests.push(request);
      return { status: 200, headers: {}, body: Array.from(new TextEncoder().encode(JSON.stringify([{ key: '.granite-provider/sync/device.json', size: 12 }]))) };
    });
    const provider = createProvider(profile, transport);
    expect(provider).toBeInstanceOf(LocalFilesystemProvider);
    expect(await provider.list('sync/')).toEqual([{ key: 'sync/device.json', size: 12 }]);
    expect(requests[0]?.args.profile).toMatchObject({ type: 'local', prefix: '.granite-provider', root: { id: 'selected-root' } });
    expect(requests[0]?.args.key).toBe('.granite-provider/sync/');
  });

  it('retains conditional writes, ranges and checksum failures through the common contract', async () => {
    const requests: { method: string; headers?: Record<string, string> }[] = [];
    const provider = createProvider(profile, { request: async request => {
      requests.push(request);
      if (request.headers?.['if-match'] === 'stale') return { status: 412, headers: {} };
      return { status: 200, headers: {}, body: new Uint8Array([1, 2, 3]) };
    } });
    await expect(provider.write('object', new Uint8Array([1]), { ifMatch: 'stale' })).rejects.toMatchObject({ status: 412 });
    expect(await provider.readRange('object', { start: 1, end: 3 })).toEqual(new Uint8Array([1, 2, 3]));
    expect(requests.at(-1)?.headers?.range).toBe('bytes=1-3');
    await expect(provider.read('object', { expectedSha256: '0'.repeat(64) })).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects rootless, empty-prefix and traversal profiles before contacting native storage', () => {
    const transport = { request: async () => { throw new Error('must not be called'); } };
    for (const invalid of [{ ...profile, root: undefined }, { ...profile, prefix: '' }, { ...profile, prefix: '../books' }]) {
      expect(() => createProvider(invalid, transport)).toThrow();
    }
  });
});
