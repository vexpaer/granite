import type { Book, Format, ReaderSettings } from '../types';
import { parseEpub } from './epub';
import { parseMobi } from './mobi';
import { decodeText, txtToReflowChapters } from './text';
import type { ReflowBook } from './types';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function sniffFormat(bytes: Uint8Array, filename = ''): Format | undefined {
  if (bytes.byteLength >= 5 && ascii(bytes, 0, 5) === '%PDF-') return 'pdf';
  if (bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return 'epub';
  }
  const extension = filename.split('.').pop()?.toLowerCase();
  if (['mobi', 'prc', 'azw'].includes(extension || '')) return 'mobi';
  if (extension === 'txt') return 'txt';
  if (bytes.byteLength > 60) {
    const signature = ascii(bytes, 60, 8);
    if (signature.startsWith('BOOKMOBI') || signature.startsWith('TEXtREAd')) return 'mobi';
  }
  return extension === 'epub' ? 'epub' : undefined;
}

export function assertFormat(book: Book, bytes: Uint8Array): void {
  const sniffed = sniffFormat(bytes, book.relativePath || book.title);
  if (sniffed && sniffed !== book.format) {
    throw new Error(`文件内容识别为 ${sniffed.toUpperCase()}，与书库记录的 ${book.format.toUpperCase()} 不一致`);
  }
  if (book.format === 'pdf' && sniffed !== 'pdf') {
    throw new Error('PDF 文件头无效或文件已损坏');
  }
  if (book.format === 'epub' && sniffed !== 'epub') {
    throw new Error('EPUB 压缩容器无效或文件已损坏');
  }
}

export async function parseReflowBook(
  book: Book,
  bytes: Uint8Array,
  settings: ReaderSettings,
): Promise<ReflowBook> {
  assertFormat(book, bytes);
  if (book.format === 'epub') return parseEpub(bytes);
  if (book.format === 'mobi') return parseMobi(bytes);
  if (book.format === 'txt') {
    const decoded = decodeText(bytes, settings.encoding);
    const parsed = txtToReflowChapters(decoded.text, decoded.encoding);
    const warnings: string[] = [];
    if (decoded.uncertain) {
      warnings.push('编码识别存在歧义；如出现乱码，请在阅读外观中手动选择编码。');
    }
    return {
      format: 'txt',
      title: book.title,
      authors: book.authors,
      chapters: parsed.chapters,
      toc: parsed.toc,
      warnings,
    };
  }
  throw new Error('PDF 不属于重排文本格式');
}

