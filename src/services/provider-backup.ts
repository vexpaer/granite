import type { ProviderProfile } from '../types';

export interface ProviderBackup {
  schemaVersion: 1;
  requiresAuthorization: true;
  configuration: Pick<ProviderProfile, 'type' | 'name' | 'prefix'> & Partial<Pick<ProviderProfile, 'endpoint' | 'username' | 'region' | 'bucket'>>;
}

export function exportProviderConfiguration(profile: ProviderProfile): ProviderBackup {
  let endpoint = profile.endpoint;
  if (profile.type !== 'local') {
    const url = new URL(endpoint);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    endpoint = url.toString();
  }
  return {
    schemaVersion: 1, requiresAuthorization: true,
    configuration: {
      type: profile.type, name: profile.name, prefix: profile.prefix,
      ...(profile.type !== 'local' ? {
        endpoint,
        ...(profile.username ? { username: profile.username } : {}),
        ...(profile.region ? { region: profile.region } : {}),
        ...(profile.bucket ? { bucket: profile.bucket } : {}),
      } : {}),
    },
  };
}

export function parseProviderConfiguration(value: unknown): ProviderBackup {
  const input = value as Partial<ProviderBackup> | null;
  const config = input?.configuration;
  if (input?.schemaVersion !== 1 || !config || !['local', 's3', 'webdav'].includes(config.type) ||
    typeof config.name !== 'string' || typeof config.prefix !== 'string' || config.prefix.split(/[\\/]/).includes('..'))
    throw new Error('备份的 Provider 配置无效。');
  const draft: ProviderProfile = { id: '', credentialId: '', endpoint: '', type: config.type, name: config.name, prefix: config.prefix };
  if (config.type !== 'local') {
    let endpoint: URL;
    try { endpoint = new URL(config.endpoint || ''); } catch { throw new Error('备份的 Provider 地址无效。'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error('备份的 Provider 地址必须是无嵌入凭证的 HTTPS 地址。');
    draft.endpoint = endpoint.toString();
    for (const key of ['username', 'region', 'bucket'] as const) {
      if (typeof config[key] === 'string') draft[key] = config[key];
    }
  }
  return exportProviderConfiguration(draft);
}
