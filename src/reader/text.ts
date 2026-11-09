import type { ReaderChapter, ReaderSearchResult, ReaderTocItem } from './types';
import { escapeHtml } from './utils';

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];

export interface DecodedText {
  text: string;
  encoding: string;
  uncertain: boolean;
}

const ENCODINGS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'gb18030',
  'big5',
  'shift_jis',
  'windows-1252',
] as const;

function startsWith(bytes: Uint8Array, marker: number[]): boolean {
  return marker.every((value, index) => bytes[index] === value);
}

function decodeWith(bytes: Uint8Array, encoding: string, fatal = false): string {
  return new TextDecoder(encoding, { fatal }).decode(bytes);
}

function scoredDecode(bytes: Uint8Array, encoding: string): { text: string; score: number } {
  try {
    const text = decodeWith(bytes, encoding);
    const sample = text.slice(0, 60_000);
    let score = 0;
    for (const character of sample) {
      const code = character.codePointAt(0) || 0;
      if (character === '\uFFFD') score += 18;
      else if (code === 0) score += 20;
      else if (code < 9 || (code > 13 && code < 32)) score += 5;
      else if (/\s/u.test(character)) score -= 0.1;
      else if (/[\p{L}\p{N}\p{P}\p{S}]/u.test(character)) score -= 0.25;
    }
    return { text, score };
  } catch {
    return { text: '', score: Number.POSITIVE_INFINITY };
  }
}

export function decodeText(bytes: Uint8Array, requestedEncoding = 'auto'): DecodedText {
  if (startsWith(bytes, UTF8_BOM)) {
    return { text: decodeWith(bytes.subarray(3), 'utf-8'), encoding: 'utf-8', uncertain: false };
  }
  if (startsWith(bytes, UTF16_LE_BOM)) {
    return { text: decodeWith(bytes.subarray(2), 'utf-16le'), encoding: 'utf-16le', uncertain: false };
  }
  if (startsWith(bytes, UTF16_BE_BOM)) {
    return { text: decodeWith(bytes.subarray(2), 'utf-16be'), encoding: 'utf-16be', uncertain: false };
  }

  const requested = requestedEncoding && requestedEncoding !== 'auto'
    ? requestedEncoding.toLowerCase()
    : '';
  if (requested) {
    try {
      return {
        text: decodeWith(bytes, requested, requested === 'utf-8'),
        encoding: requested,
        uncertain: false,
      };
    } catch {
      throw new Error(`当前浏览器不支持 ${requestedEncoding} 编码`);
    }
  }

  try {
    return { text: decodeWith(bytes, 'utf-8', true), encoding: 'utf-8', uncertain: false };
  } catch {
    // Continue with heuristic decoding.
  }

  const candidates = ENCODINGS
    .filter((encoding) => encoding !== 'utf-16be')
    .map((encoding) => ({ encoding, ...scoredDecode(bytes, encoding) }))
    .sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best || !Number.isFinite(best.score)) {
    throw new Error('无法识别文本编码');
  }
  const second = candidates[1];
  return {
    text: best.text,
    encoding: best.encoding,
    uncertain: Boolean(second && best.score > second.score - 4),
  };
}

const CHAPTER_HEADING =
  /^\s*(?:第[〇零一二三四五六七八九十百千万两\d]+[章节卷部篇回幕]|chapter\s+[\divxlcdm]+|part\s+[\divxlcdm]+|prologue|epilogue|序章|楔子|引言|前言|序言|后记|尾声)/iu;

function titleFromLine(line: string): string {
  return line.replace(/<[^>]+>/g, '').trim().slice(0, 120);
}

function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`).join('\n');
}

export function txtToReflowChapters(text: string, encoding = 'utf-8'): {
  chapters: ReaderChapter[];
  toc: ReaderTocItem[];
  uncertain?: string;
} {
  if (!text.trim()) throw new Error('文本文件为空');
  const normalized = text.replace(/\r\n?/g, '\n');
  const pages = normalized.split('\f');
  const chapters: ReaderChapter[] = [];
  const toc: ReaderTocItem[] = [];
  let buffer: string[] = [];
  let currentTitle = '正文';
  let section = 0;

  const flush = (): void => {
    const content = buffer.join('\n').trim();
    if (!content) return;
    const index = chapters.length;
    const id = `txt-${index + 1}`;
    const href = `#${id}`;
    chapters.push({
      id,
      href,
      title: currentTitle,
      html: textToHtml(content),
      css: '',
      text: content,
      encoding,
    });
    toc.push({
      id: `toc-${id}`,
      label: currentTitle,
      href,
      chapterIndex: index,
      level: 0,
    });
    buffer = [];
  };

  const segments = pages.flatMap((page) => page.split('\n'));
  for (const line of segments) {
    const trimmed = line.trim();
    const looksLikeHeading =
      trimmed.length > 0 &&
      trimmed.length <= 90 &&
      (CHAPTER_HEADING.test(trimmed) || /^={2,}\s*.+?\s*={2,}$/.test(trimmed));
    if (looksLikeHeading && buffer.join('\n').trim().length > 60) {
      flush();
      currentTitle = titleFromLine(trimmed.replace(/^=+\s*|\s*=+$/g, '')) || `章节 ${section + 1}`;
      section += 1;
    } else if (looksLikeHeading && !buffer.join('\n').trim()) {
      currentTitle = titleFromLine(trimmed.replace(/^=+\s*|\s*=+$/g, '')) || `章节 ${section + 1}`;
    }
    buffer.push(line);
  }
  flush();

  if (!chapters.length) {
    const chunks = normalized.match(/[\s\S]{1,32000}(?=\n|$)/g) || [normalized];
    return txtToReflowChapters(chunks.join('\f'), encoding);
  }

  return { chapters, toc };
}

function normalizedSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

export function searchReflowChapters(
  chapters: ReaderChapter[],
  query: string,
  limit = 500,
): ReaderSearchResult[] {
  const needle = query.trim();
  if (!needle) return [];
  const results: ReaderSearchResult[] = [];
  const foldedNeedle = normalizedSearchText(needle);
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex];
    const folded = normalizedSearchText(chapter.text);
    let from = 0;
    while (results.length < limit) {
      const index = folded.indexOf(foldedNeedle, from);
      if (index < 0) break;
      const start = Math.max(0, index - 70);
      const end = Math.min(chapter.text.length, index + needle.length + 90);
      results.push({
        id: `search-${chapterIndex}-${index}`,
        text: chapter.text.slice(index, index + needle.length),
        before: chapter.text.slice(start, index),
        after: chapter.text.slice(index + needle.length, end),
        chapterIndex,
        offset: index,
      });
      from = index + Math.max(1, foldedNeedle.length);
    }
    if (results.length >= limit) break;
  }
  return results;
}

export function findOccurrences(
  text: string,
  quote: string,
  limit = 20,
): Array<{ start: number; end: number }> {
  const needle = quote.trim();
  if (!needle) return [];
  const haystack = text.normalize('NFKC');
  const normalizedNeedle = needle.normalize('NFKC');
  const occurrences: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (occurrences.length < limit) {
    const found = haystack.indexOf(normalizedNeedle, from);
    if (found < 0) break;
    occurrences.push({ start: found, end: found + normalizedNeedle.length });
    from = found + Math.max(1, normalizedNeedle.length);
  }
  return occurrences;
}

