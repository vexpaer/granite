import {
  initMobiFile,
  type Mobi,
  type MobiTocItem,
} from '@lingo-reader/mobi-parser';
import type { ReaderChapter, ReaderTocItem, ReflowBook } from './types';
import { sanitizeCss, sanitizeHtml } from './sanitize';

function plainText(html: string): string {
  if (typeof DOMParser === 'undefined') {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const document = new DOMParser().parseFromString(html, 'text/html');
  return document.body.textContent?.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() || '';
}

function titleFromHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return '';
  const document = new DOMParser().parseFromString(html, 'text/html');
  return document.querySelector('h1,h2,h3,title')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) || '';
}

async function cssText(href: string): Promise<string> {
  if (!href) return '';
  if (href.startsWith('data:text/css')) {
    const comma = href.indexOf(',');
    return comma >= 0 ? decodeURIComponent(href.slice(comma + 1)) : '';
  }
  const response = await fetch(href);
  if (!response.ok) throw new Error(`MOBI 样式资源读取失败：${response.status}`);
  return response.text();
}

function convertToc(
  items: MobiTocItem[],
  idToChapter: Map<string, number>,
  resolver: (href: string) => { id: string } | undefined,
  level = 0,
): ReaderTocItem[] {
  return items.map((item, index) => {
    const resolved = item.href ? resolver(item.href) : undefined;
    const children = item.children
      ? convertToc(item.children, idToChapter, resolver, level + 1)
      : undefined;
    return {
      id: `mobi-toc-${level}-${index}-${item.href}`,
      label: item.label,
      href: item.href,
      chapterIndex: resolved ? idToChapter.get(resolved.id) : undefined,
      level,
      ...(children?.length ? { children } : {}),
    };
  });
}

export async function parseMobi(bytes: Uint8Array): Promise<ReflowBook> {
  if (bytes.byteLength === 0) throw new Error('MOBI 文件为空');
  if (typeof DOMParser === 'undefined') throw new Error('当前环境缺少 MOBI 内容解析器');

  let mobi: Mobi | undefined;
  try {
    mobi = await initMobiFile(bytes);
    const metadata = mobi.getMetadata();
    const spine = mobi.getSpine();
    if (!spine.length) throw new Error('MOBI 文件没有可阅读章节');
    const idToChapter = new Map(spine.map((entry, index) => [entry.id, index]));
    const warnings: string[] = [];
    const chapters: ReaderChapter[] = [];

    for (const spineEntry of spine) {
      let processed: ReturnType<Mobi['loadChapter']>;
      try {
        processed = mobi.loadChapter(spineEntry.id);
      } catch (error) {
        warnings.push(
          `章节 ${spineEntry.id} 解析失败：${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!processed) {
        warnings.push(`章节 ${spineEntry.id} 无可显示内容`);
        continue;
      }
      const sanitized = await sanitizeHtml(processed.html, {
        resolveResource: async (resource) =>
          resource.startsWith('blob:') || /^data:image\//i.test(resource) ? resource : null,
      });
      const cssParts = [sanitized.css];
      for (const part of processed.css) {
        try {
          cssParts.push(await sanitizeCss(await cssText(part.href)));
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
      const text = plainText(sanitized.html);
      chapters.push({
        id: spineEntry.id,
        href: spineEntry.id,
        title: titleFromHtml(sanitized.html) || `第 ${chapters.length + 1} 节`,
        html: sanitized.html,
        css: cssParts.filter(Boolean).join('\n'),
        text,
      });
    }

    if (!chapters.length) throw new Error('MOBI 内容无法解析，文件可能是暂不支持的压缩或加密变体');

    const originalToc = mobi.getToc();
    const resolver = (href: string): { id: string } | undefined => {
      try {
        const resolved = mobi?.resolveHref(href);
        return resolved ? { id: resolved.id } : undefined;
      } catch {
        return undefined;
      }
    };
    let toc = convertToc(originalToc, idToChapter, resolver);
    if (!toc.length) {
      toc = chapters.map((chapter, index) => ({
        id: `mobi-spine-${chapter.id}`,
        label: chapter.title,
        href: chapter.href,
        chapterIndex: index,
        level: 0,
      }));
    }

    const parser = mobi;
    return {
      format: 'mobi',
      title: metadata.title,
      authors: metadata.author,
      chapters,
      toc,
      warnings: [...new Set(warnings)].slice(0, 20),
      destroy: () => parser.destroy(),
    };
  } catch (error) {
    mobi?.destroy();
    if (error instanceof Error && /encrypt|drm|compression/i.test(error.message)) {
      throw new Error('MOBI 文件使用 DRM、加密或不支持的压缩变体');
    }
    throw error;
  }
}

