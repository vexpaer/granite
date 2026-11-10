import { describe, expect, it } from 'vitest';
import { exportProviderConfiguration, parseProviderConfiguration } from '../src/services/provider-backup';
import type { ProviderProfile } from '../src/types';
const profile: ProviderProfile = { id: 'profile', type: 's3', name: 'Books', endpoint: 'https://s3.example/', prefix: 'Granite', credentialId: 'private-secret-ref', accessKeyId: 'private-access-key', bucket: 'books', region: 'auto' };
describe('portable provider configuration', () => {
  it('retains configuration without credentials and local paths', () => {
    const result = exportProviderConfiguration(profile);
    expect(result.configuration).toMatchObject({ name: 'Books', bucket: 'books', region: 'auto' });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(parseProviderConfiguration(result)).toEqual(result);
    const local = exportProviderConfiguration({ ...profile, type: 'local', endpoint: 'E:/PersonalLibrary', root: { path: 'E:/PersonalLibrary' } as never });
    expect(JSON.stringify(local)).not.toContain('PersonalLibrary');
    expect(local.configuration).not.toHaveProperty('endpoint');
  });
  it('does not reintroduce credentials, root grants or unsafe endpoints from a modified backup', () => {
    const safe = exportProviderConfiguration(profile);
    const restored = parseProviderConfiguration({ ...safe, configuration: { ...safe.configuration, credentialId: 'injected', root: { path: 'C:/' } } });
    expect(restored.configuration).not.toHaveProperty('credentialId');
    expect(restored.configuration).not.toHaveProperty('root');
    for (const endpoint of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret']) {
      expect(() => parseProviderConfiguration({ ...safe, configuration: { ...safe.configuration, endpoint } })).toThrow();
    }
  });
});
