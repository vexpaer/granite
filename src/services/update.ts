import { compare, valid } from 'semver';
import packageInfo from '../../package.json';
import { hostCall, nativeHost } from './host';

export type ReleasePlatform = 'windows' | 'android';

type GitHubRelease = {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  body?: string | null;
  published_at?: string | null;
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
  }>;
};

export interface AppUpdate {
  currentVersion: string;
  latestVersion: string;
  platform: ReleasePlatform;
  available: boolean;
  releaseUrl: string;
  downloadUrl: string;
  hasAsset: boolean;
  assetName: string | null;
  notes: string;
  publishedAt: string | null;
}

function parseReleaseTag(tag: string) {
  const match = /^v?(\d+\.\d+\.\d+)(?:-(windows|android))?$/.exec(tag);
  if (!match || !valid(match[1])) return null;
  return {
    version: match[1],
    platform: (match[2] || null) as ReleasePlatform | null,
  };
}

function expectedAssetNames(version: string, platform: ReleasePlatform) {
  if (platform === 'windows') return ['Granite-' + version + '-windows-x64-setup.exe'];
  return [
    'Granite-' + version + '-android-aarch64.apk',
    'Granite-v' + version + '-aarch64.apk',
  ];
}

export function selectLatestRelease(releases: GitHubRelease[], platform: ReleasePlatform) {
  const candidates = releases.flatMap((release) => {
    if (release.draft || release.prerelease || !release.html_url) return [];
    const parsed = parseReleaseTag(String(release.tag_name || ''));
    if (!parsed || (parsed.platform && parsed.platform !== platform)) return [];
    const asset = (release.assets || []).find((item) =>
      expectedAssetNames(parsed.version, platform).includes(String(item.name || '')),
    );
    const assetUrl = asset?.browser_download_url;
    return [{
      latestVersion: parsed.version,
      tagPlatform: parsed.platform,
      releaseUrl: release.html_url,
      downloadUrl: assetUrl || release.html_url,
      hasAsset: Boolean(assetUrl),
      assetName: asset?.name || null,
      notes: String(release.body || '').trim(),
      publishedAt: release.published_at || null,
    }];
  });

  candidates.sort((a, b) =>
    compare(b.latestVersion, a.latestVersion) ||
    Number(b.tagPlatform === platform) - Number(a.tagPlatform === platform),
  );
  const latest = candidates[0];
  if (!latest) return null;
  return {
    latestVersion: latest.latestVersion,
    releaseUrl: latest.releaseUrl,
    downloadUrl: latest.downloadUrl,
    hasAsset: latest.hasAsset,
    assetName: latest.assetName,
    notes: latest.notes,
    publishedAt: latest.publishedAt,
  };
}

export function detectReleasePlatform(): ReleasePlatform {
  return /Android/i.test(navigator.userAgent) ? 'android' : 'windows';
}

export async function checkForUpdates(
  platform: ReleasePlatform = detectReleasePlatform(),
  fetcher: typeof fetch = fetch,
): Promise<AppUpdate> {
  const response = await fetcher(
    'https://api.github.com/repos/vexpaer/granite/releases?per_page=100',
    {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    },
  );
  if (!response.ok) throw new Error('GitHub Releases 请求失败（HTTP ' + response.status + '）');
  const releases = await response.json() as GitHubRelease[];
  if (!Array.isArray(releases)) throw new Error('GitHub Releases 返回了无效数据。');
  const latest = selectLatestRelease(releases, platform);
  if (!latest) throw new Error('暂时没有找到该平台的正式版本。');
  return {
    ...latest,
    currentVersion: packageInfo.version,
    platform,
    available: compare(latest.latestVersion, packageInfo.version) > 0,
  };
}

export async function openExternalUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/vexpaer/granite/releases/')
  ) {
    throw new Error('只允许打开 Granite 官方发布页面。');
  }

  if (nativeHost) {
    await hostCall('app.openUrl', { url: url.href });
    return;
  }
  const opened = window.open(url.href, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.assign(url.href);
}
