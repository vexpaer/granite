const ALLOWED_ELEMENTS = new Set([
  'a',
  'abbr',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'title',
  'desc',
]);

const REMOVE_WITH_CONTENT = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'base',
  'meta',
  'link',
  'style',
  'template',
]);

const GLOBAL_ATTRIBUTES = new Set(['id', 'class', 'title', 'lang', 'dir', 'role']);
const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding']),
  svg: new Set(['viewbox', 'width', 'height', 'preserveaspectratio']),
  path: new Set(['d', 'fill', 'stroke', 'stroke-width', 'fill-rule', 'clip-rule']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width']),
  circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width']),
  ellipse: new Set(['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width']),
  line: new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width']),
  polyline: new Set(['points', 'fill', 'stroke', 'stroke-width']),
  polygon: new Set(['points', 'fill', 'stroke', 'stroke-width']),
  ol: new Set(['start', 'type', 'reversed']),
  li: new Set(['value']),
  table: new Set(['summary']),
  th: new Set(['colspan', 'rowspan', 'scope', 'abbr']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  time: new Set(['datetime']),
  details: new Set(['open']),
  img2: new Set(),
};

const DANGEROUS_CSS = /(?:expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding\s*:|@import\b|@namespace\b|<\s*\/?\s*style)/i;
const RESOURCE_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;

export type ResourceResolver = (resource: string) => Promise<string | null> | string | null;

export interface SanitizeHtmlOptions {
  resolveResource?: ResourceResolver;
  resolveStylesheet?: ResourceResolver;
}

export interface SanitizedHtml {
  html: string;
  css: string;
  stylesheets: string[];
  removed: number;
}

export function isSafeImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(value);
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function normalizeZipPath(baseFile: string, relativePath: string): string | null {
  const cleanResource = relativePath.split('#')[0].split('?')[0].trim();
  if (!cleanResource) return null;
  const baseSegments = baseFile.split('/');
  baseSegments.pop();
  const segments = cleanResource.startsWith('/')
    ? cleanResource.slice(1).split('/')
    : [...baseSegments, ...cleanResource.split('/')];
  const normalized: string[] = [];
  for (const rawSegment of segments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      segment = rawSegment;
    }
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!normalized.length) return null;
      normalized.pop();
      continue;
    }
    if (segment.includes('\\') || segment.includes('\0')) return null;
    normalized.push(segment);
  }
  return normalized.join('/');
}

export function splitResourceFragment(value: string): { path: string; fragment: string } {
  const hashIndex = value.indexOf('#');
  if (hashIndex < 0) return { path: value, fragment: '' };
  return {
    path: value.slice(0, hashIndex),
    fragment: value.slice(hashIndex + 1),
  };
}

export async function sanitizeCss(
  css: string,
  resolveResource?: ResourceResolver,
): Promise<string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (DANGEROUS_CSS.test(withoutComments)) {
    throw new Error('CSS 包含不安全规则');
  }
  const matches = [...withoutComments.matchAll(RESOURCE_URL)];
  let output = withoutComments;
  for (const match of matches) {
    const original = match[1] ?? match[2] ?? match[3] ?? '';
    let replacement = 'none';
    if (/^data:image\//i.test(original)) {
      replacement = isSafeImageDataUrl(original) ? `url("${original}")` : 'none';
    } else if (original.startsWith('blob:') && resolveResource) {
      const resolved = await resolveResource(original);
      replacement = resolved ? `url("${resolved}")` : 'none';
    } else if (resolveResource && !isSafeExternalUrl(original)) {
      const resolved = await resolveResource(original);
      replacement = resolved ? `url("${resolved}")` : 'none';
    }
    output = output.replace(match[0], replacement);
  }
  return output
    .replace(/position\s*:\s*fixed\s*;?/gi, 'position:absolute;')
    .replace(/z-index\s*:\s*-?\d+\s*;?/gi, '')
    .slice(0, 1_000_000);
}

function isAllowedAttribute(element: Element, name: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith('on')) return false;
  if (lowerName.startsWith('aria-')) return true;
  if (GLOBAL_ATTRIBUTES.has(lowerName)) return true;
  return ELEMENT_ATTRIBUTES[element.tagName.toLowerCase()]?.has(lowerName) ?? false;
}

async function sanitizeSrcset(
  value: string,
  resolver: ResourceResolver | undefined,
): Promise<string> {
  if (!resolver) return '';
  const candidates = await Promise.all(
    value.split(',').map(async (entry) => {
      const [url, descriptor] = entry.trim().split(/\s+/, 2);
      if (!url) return '';
      const resolved = isSafeImageDataUrl(url) ? url : await resolver(url);
      return resolved ? `${resolved}${descriptor ? ` ${descriptor}` : ''}` : '';
    }),
  );
  return candidates.filter(Boolean).join(', ');
}

export async function sanitizeHtml(
  input: string,
  options: SanitizeHtmlOptions = {},
): Promise<SanitizedHtml> {
  if (typeof DOMParser === 'undefined') {
    throw new Error('当前环境缺少 HTML 解析器');
  }
  const parsed = new DOMParser().parseFromString(input, 'text/html');
  const stylesheets: string[] = [];
  const cssParts: string[] = [];
  let removed = 0;

  for (const link of [...parsed.querySelectorAll('link[rel~="stylesheet"]')]) {
    const href = link.getAttribute('href')?.trim();
    if (href) stylesheets.push(href);
    link.remove();
  }
  for (const style of [...parsed.querySelectorAll('style')]) {
    try {
      const css = await sanitizeCss(style.textContent || '', options.resolveResource);
      if (css.trim()) cssParts.push(css);
    } catch {
      removed += 1;
    }
    style.remove();
  }

  const allElements = [...parsed.body.querySelectorAll('*')];
  for (const element of allElements.reverse()) {
    const tag = element.tagName.toLowerCase();
    if (REMOVE_WITH_CONTENT.has(tag)) {
      element.remove();
      removed += 1;
      continue;
    }
    if (!ALLOWED_ELEMENTS.has(tag)) {
      element.replaceWith(...element.childNodes);
      removed += 1;
      continue;
    }

    for (const attribute of [...element.getAttributeNames()]) {
      const lowerName = attribute.toLowerCase();
      if (!isAllowedAttribute(element, lowerName) && lowerName !== 'style' && lowerName !== 'xlink:href') {
        element.removeAttribute(attribute);
      }
    }

    const style = element.getAttribute('style');
    if (style) {
      try {
        const safeStyle = await sanitizeCss(`g{${style}}`, options.resolveResource);
        element.setAttribute('style', safeStyle.slice(2, -1));
      } catch {
        element.removeAttribute('style');
      }
    }

    if (tag === 'a') {
      const href = element.getAttribute('href') || '';
      if (href.startsWith('#') || (!href.includes(':') && !href.startsWith('//'))) {
        element.setAttribute('data-granite-href', href);
        element.removeAttribute('href');
      } else if (isSafeExternalUrl(href)) {
        element.setAttribute('href', href);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      } else {
        element.removeAttribute('href');
      }
    }

    const srcset = element.getAttribute('srcset');
    if (srcset) {
      const safeSrcset = await sanitizeSrcset(srcset, options.resolveResource);
      if (safeSrcset) element.setAttribute('srcset', safeSrcset);
      else element.removeAttribute('srcset');
    }

    for (const attribute of ['src', 'poster', 'xlink:href']) {
      const source = element.getAttribute(attribute);
      if (!source || !options.resolveResource) continue;
      if (isSafeImageDataUrl(source)) continue;
      if (source.startsWith('#')) continue;
      if (isSafeExternalUrl(source)) {
        element.removeAttribute(attribute);
        continue;
      }
      const resolved = await options.resolveResource(source);
      if (resolved) element.setAttribute(attribute, resolved);
      else element.removeAttribute(attribute);
    }
  }

  return {
    html: parsed.body.innerHTML,
    css: cssParts.join('\n'),
    stylesheets,
    removed,
  };
}

