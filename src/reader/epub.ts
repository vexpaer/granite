import JSZip from 'jszip';
import type { ReaderChapter, ReaderTocItem, ReflowBook } from './types';
import {
  normalizeZipPath,
  sanitizeCss,
  sanitizeHtml,
  splitResourceFragment,
  type ResourceResolver,
} from './sanitize';

const CONTAINER_PATH = 'META-INF/container.xml';
const MAX_TEXT_ASSET = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

interface EpubMetadata {
  title?: string;
  authors: string[];
  language?: string;
  publisher?: string;
  identifier?: string;
}

interface ResolvedToc {
  toc: ReaderTocItem[];
  pathToChapter: Map<string, number>;
}

function descendantElements(root: Document | Element, name: string): Element[] {
  return [...root.querySelectorAll('*')].filter((element) => element.localName === name);
}

function firstDescendant(root: Document | Element, name: string): Element | undefined {
  return descendantElements(root, name)[0];
}

function xmlDocument(text: string, source: string): XMLDocument {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) {
    throw new Error(`${source} 不是有效的 XML`);
  }
  return document;
}

function decodeHref(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mimeTypeFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    otf: 'font/otf',
    ttf: 'font/ttf',
    woff: 'font/woff',
    woff2: 'font/woff2',
  }[extension || ''] || 'application/octet-stream';
}

function chapterTitleFromHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return '';
  const document = new DOMParser().parseFromString(html, 'text/html');
  const heading = document.querySelector('h1,h2,h3,title');
  return heading?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) || '';
}

function plainText(html: string): string {
  if (typeof DOMParser === 'undefined') {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const document = new DOMParser().parseFromString(html, 'text/html');
  return document.body.textContent?.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() || '';
}

async function fileText(zip: JSZip, path: string, label: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`EPUB 缺少 ${label}`);
  const bytes = await file.async('uint8array');
  if (bytes.byteLength > MAX_TEXT_ASSET) throw new Error(`${label} 过大`);
  return new TextDecoder('utf-8').decode(bytes);
}

function parseMetadata(packageDocument: Document): EpubMetadata {
  const title = firstDescendant(packageDocument, 'title')?.textContent?.trim();
  const authors = descendantElements(packageDocument, 'creator')
    .map((element) => element.textContent?.trim() || '')
    .filter(Boolean);
  const language = firstDescendant(packageDocument, 'language')?.textContent?.trim();
  const publisher = firstDescendant(packageDocument, 'publisher')?.textContent?.trim();
  const identifier = firstDescendant(packageDocument, 'identifier')?.textContent?.trim();
  return { title, authors, language, publisher, identifier };
}

function parseManifest(packageDocument: Document, opfPath: string): Map<string, ManifestItem> {
  const manifest = firstDescendant(packageDocument, 'manifest');
  if (!manifest) throw new Error('EPUB 缺少 manifest');
  const items = new Map<string, ManifestItem>();
  for (const item of descendantElements(manifest, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    const resolved = normalizeZipPath(opfPath, decodeHref(href));
    if (!resolved) continue;
    items.set(id, {
      id,
      href: resolved,
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    });
  }
  return items;
}

function parseSpine(
  packageDocument: Document,
  manifest: Map<string, ManifestItem>,
): Array<{ manifest: ManifestItem; idref: string; linear: boolean }> {
  const spine = firstDescendant(packageDocument, 'spine');
  if (!spine) throw new Error('EPUB 缺少 spine');
  const result: Array<{ manifest: ManifestItem; idref: string; linear: boolean }> = [];
  for (const itemref of descendantElements(spine, 'itemref')) {
    const idref = itemref.getAttribute('idref');
    if (!idref) continue;
    const manifestItem = manifest.get(idref);
    if (!manifestItem) continue;
    result.push({
      manifest: manifestItem,
      idref,
      linear: itemref.getAttribute('linear') !== 'no',
    });
  }
  if (!result.length) throw new Error('EPUB spine 中没有可阅读章节');
  return result;
}

function parseNavList(
  list: Element,
  navPath: string,
  pathToChapter: Map<string, number>,
  level: number,
  idPath = 'nav',
): ReaderTocItem[] {
  const result: ReaderTocItem[] = [];
  const listItems = [...list.children].filter((element) => element.localName === 'li');
  for (let itemIndex = 0; itemIndex < listItems.length; itemIndex += 1) {
    const listItem = listItems[itemIndex];
    const anchor = [...listItem.children].find(
      (element) => element.localName === 'a' || element.localName === 'span',
    );
    const label = anchor?.textContent?.replace(/\s+/g, ' ').trim();
    const rawHref = anchor?.getAttribute('href') || '';
    const targetPath = rawHref
      ? normalizeZipPath(navPath, decodeHref(splitResourceFragment(rawHref).path)) || ''
      : '';
    const chapterIndex = pathToChapter.get(targetPath);
    const childList = [...listItem.children].find((element) => element.localName === 'ol');
    const children = childList
      ? parseNavList(childList, navPath, pathToChapter, level + 1, `${idPath}.${itemIndex}`)
      : undefined;
    if (label) {
      result.push({
        id: `epub-toc-${idPath}.${itemIndex}`,
        label,
        href: rawHref || undefined,
        chapterIndex,
        level,
        ...(children?.length ? { children } : {}),
      });
    }
  }
  return result;
}

function parseNcxPoints(
  parent: Element,
  ncxPath: string,
  pathToChapter: Map<string, number>,
  level: number,
  idPath = 'ncx',
): ReaderTocItem[] {
  const result: ReaderTocItem[] = [];
  const points = [...parent.children].filter((element) => element.localName === 'navPoint');
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    const label = firstDescendant(point, 'text')?.textContent?.replace(/\s+/g, ' ').trim();
    const rawHref = firstDescendant(point, 'content')?.getAttribute('src') || '';
    const targetPath = rawHref
      ? normalizeZipPath(ncxPath, decodeHref(splitResourceFragment(rawHref).path)) || ''
      : '';
    const hasChildren = [...point.children].some((element) => element.localName === 'navPoint');
    const children = hasChildren
      ? parseNcxPoints(point, ncxPath, pathToChapter, level + 1, `${idPath}.${pointIndex}`)
      : undefined;
    if (label) {
      result.push({
        id: point.getAttribute('id') || `epub-${idPath}.${pointIndex}`,
        label,
        href: rawHref || undefined,
        chapterIndex: pathToChapter.get(targetPath),
        level,
        ...(children?.length ? { children } : {}),
      });
    }
  }
  return result;
}

async function parseToc(
  zip: JSZip,
  packageDocument: Document,
  manifest: Map<string, ManifestItem>,
  spine: Array<{ manifest: ManifestItem; idref: string; linear: boolean }>,
): Promise<ResolvedToc> {
  const pathToChapter = new Map<string, number>();
  spine.forEach((entry, index) => pathToChapter.set(entry.manifest.href, index));

  const navItem = [...manifest.values()].find((item) =>
    item.properties.split(/\s+/).includes('nav'),
  );
  if (navItem) {
    const navDocument = xmlDocument(await fileText(zip, navItem.href, '导航文档'), navItem.href);
    const navs = descendantElements(navDocument, 'nav');
    const tocNav = navs.find((nav) => {
      const type =
        nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ||
        nav.getAttribute('epub:type') ||
        nav.getAttribute('type');
      return type?.split(/\s+/).includes('toc');
    }) || navs[0];
    const list = tocNav ? firstDescendant(tocNav, 'ol') : undefined;
    if (list) {
      const toc = parseNavList(list, navItem.href, pathToChapter, 0);
      if (toc.length) return { toc, pathToChapter };
    }
  }

  const spineElement = firstDescendant(packageDocument, 'spine');
  const ncxId = spineElement?.getAttribute('toc');
  const ncxItem = ncxId ? manifest.get(ncxId) : undefined;
  if (ncxItem) {
    const ncxDocument = xmlDocument(await fileText(zip, ncxItem.href, 'NCX 目录'), ncxItem.href);
    const navMap = firstDescendant(ncxDocument, 'navMap');
    if (navMap) {
      const toc = parseNcxPoints(navMap, ncxItem.href, pathToChapter, 0);
      if (toc.length) return { toc, pathToChapter };
    }
  }

  return {
    toc: spine.map((entry, index) => ({
      id: `spine-${entry.idref}`,
      label: `第 ${index + 1} 节`,
      chapterIndex: index,
      level: 0,
    })),
    pathToChapter,
  };
}

function flattenToc(toc: ReaderTocItem[]): ReaderTocItem[] {
  return toc.flatMap((item) => [item, ...(item.children ? flattenToc(item.children) : [])]);
}

export async function parseEpub(bytes: Uint8Array): Promise<ReflowBook> {
  if (bytes.byteLength === 0) throw new Error('EPUB 文件为空');
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('EPUB 文件过大');
  if (typeof DOMParser === 'undefined') throw new Error('当前环境缺少 EPUB XML 解析器');

  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  for (const file of Object.values(zip.files)) {
    if (file.unsafeOriginalName?.split('/').some((segment) => segment === '..')) {
      throw new Error('EPUB 包含不安全的压缩路径');
    }
  }

  const container = xmlDocument(await fileText(zip, CONTAINER_PATH, 'container.xml'), CONTAINER_PATH);
  const rootfile = firstDescendant(container, 'rootfile');
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath || !zip.file(opfPath)) throw new Error('EPUB 缺少 package 文件');

  const packageDocument = xmlDocument(await fileText(zip, opfPath, 'package 文件'), opfPath);
  const metadata = parseMetadata(packageDocument);
  const manifest = parseManifest(packageDocument, opfPath);
  const spine = parseSpine(packageDocument, manifest);
  const { toc, pathToChapter } = await parseToc(zip, packageDocument, manifest, spine);
  const flatToc = flattenToc(toc);
  const titleByChapter = new Map<number, string>();
  for (const item of flatToc) {
    if (item.chapterIndex != null && !titleByChapter.has(item.chapterIndex)) {
      titleByChapter.set(item.chapterIndex, item.label);
    }
  }

  const objectUrls = new Set<string>();
  const warnings: string[] = [];
  const chapters: ReaderChapter[] = [];

  const resourceResolverFor = (baseFile: string): ResourceResolver => async (resource) => {
    if (/^data:image\//i.test(resource)) return resource;
    const path = normalizeZipPath(baseFile, decodeHref(splitResourceFragment(resource).path));
    if (!path) return null;
    const file = zip.file(path);
    if (!file) {
      warnings.push(`缺少资源：${path}`);
      return null;
    }
    const data = await file.async('uint8array');
    const blob = new Blob([data as BlobPart], { type: mimeTypeFor(path) });
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    return url;
  };

  for (let index = 0; index < spine.length; index += 1) {
    const entry = spine[index];
    const source = await fileText(zip, entry.manifest.href, entry.manifest.href);
    const resolver = resourceResolverFor(entry.manifest.href);
    const sanitized = await sanitizeHtml(source, { resolveResource: resolver });
    const cssParts = [sanitized.css];
    for (const stylesheet of sanitized.stylesheets) {
      const cssPath = normalizeZipPath(
        entry.manifest.href,
        decodeHref(splitResourceFragment(stylesheet).path),
      );
      if (!cssPath) continue;
      const cssFile = zip.file(cssPath);
      if (!cssFile) {
        warnings.push(`缺少样式：${cssPath}`);
        continue;
      }
      try {
        const css = await fileText(zip, cssPath, cssPath);
        cssParts.push(await sanitizeCss(css, resourceResolverFor(cssPath)));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    const text = plainText(sanitized.html);
    const title =
      titleByChapter.get(index) ||
      chapterTitleFromHtml(sanitized.html) ||
      `第 ${index + 1} 节`;
    chapters.push({
      id: entry.idref,
      href: entry.manifest.href,
      title,
      html: sanitized.html,
      css: cssParts.filter(Boolean).join('\n'),
      text,
    });
  }

  return {
    format: 'epub',
    title: metadata.title,
    authors: metadata.authors,
    chapters,
    toc,
    warnings: [...new Set(warnings)].slice(0, 20),
    destroy: () => {
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
    },
  };
}

