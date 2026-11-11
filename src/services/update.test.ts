import { describe, expect, it } from 'vitest';
import { selectLatestRelease } from './update';

function release(tag: string, assetNames: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/vexpaer/granite/releases/tag/' + tag,
    body: 'Release notes',
    published_at: '2026-11-11T00:00:00Z',
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: 'https://github.com/vexpaer/granite/releases/download/' + tag + '/' + name,
    })),
    ...extra,
  };
}

describe('platform release selection', () => {
  it('selects the newest Windows release and ignores Android-only versions', () => {
    const result = selectLatestRelease([
      release('v0.1.2-android', ['Granite-0.1.2-android-aarch64.apk']),
      release('v0.1.1-windows', ['Granite-0.1.1-windows-x64-setup.exe']),
      release('v0.1.0', ['Granite-0.1.0-windows-x64-setup.exe']),
    ], 'windows');

    expect(result?.latestVersion).toBe('0.1.1');
    expect(result?.assetName).toBe('Granite-0.1.1-windows-x64-setup.exe');
  });

  it('selects the newest Android release independently', () => {
    const result = selectLatestRelease([
      release('v0.1.2-android', ['Granite-0.1.2-android-aarch64.apk']),
      release('v0.1.1-windows', ['Granite-0.1.1-windows-x64-setup.exe']),
      release('v0.1.0', ['Granite-v0.1.0-aarch64.apk']),
    ], 'android');

    expect(result?.latestVersion).toBe('0.1.2');
    expect(result?.assetName).toBe('Granite-0.1.2-android-aarch64.apk');
  });

  it('prefers a platform-specific release when versions match', () => {
    const result = selectLatestRelease([
      release('v0.1.1', ['Granite-0.1.1-windows-x64-setup.exe']),
      release('v0.1.1-windows', ['Granite-0.1.1-windows-x64-setup.exe']),
    ], 'windows');

    expect(result?.releaseUrl).toContain('v0.1.1-windows');
  });

  it('ignores drafts and prereleases', () => {
    const result = selectLatestRelease([
      release('v0.2.0-windows', ['Granite-0.2.0-windows-x64-setup.exe'], { draft: true }),
      release('v0.1.0', ['Granite-0.1.0-windows-x64-setup.exe']),
    ], 'windows');

    expect(result?.latestVersion).toBe('0.1.0');
  });
});
