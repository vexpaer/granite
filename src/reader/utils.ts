import type { Annotation, Book, ReaderLocation, ReaderSettings } from '../types';
import { DEFAULT_READER_SETTINGS } from './defaults';

export function mergeReaderSettings(
  globalSettings?: Partial<ReaderSettings>,
  bookSettings?: Partial<ReaderSettings>,
): ReaderSettings {
  return {
    ...DEFAULT_READER_SETTINGS,
    ...(globalSettings || {}),
    ...(bookSettings || {}),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function createId(prefix = 'reader'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeBookProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value <= 1 ? clamp01(value) * 100 : clamp(value, 0, 100);
}

export function readerLocationKey(location?: ReaderLocation): string {
  if (!location) return '';
  return [
    location.chapter ?? '',
    location.offset ?? '',
    location.page ?? '',
    Math.round(Number(location.scale || 0) * 1000),
    Math.round(Number(location.x || 0)),
    Math.round(Number(location.y || 0)),
    location.rotation ?? '',
  ].join(':');
}

export function withTimestamp(location: ReaderLocation): ReaderLocation {
  return {
    ...location,
    updatedAt: new Date().toISOString(),
  };
}

export function sameReaderSpot(a?: ReaderLocation, b?: ReaderLocation): boolean {
  if (!a || !b) return false;
  if (a.page != null || b.page != null) {
    return (
      a.page === b.page &&
      Math.abs((a.x || 0) - (b.x || 0)) < 12 &&
      Math.abs((a.y || 0) - (b.y || 0)) < 12
    );
  }
  return a.chapter === b.chapter && Math.abs((a.offset || 0) - (b.offset || 0)) < 40;
}

export function annotationsForBook(
  annotations: Annotation[],
  book: Book,
): Annotation[] {
  return annotations
    .filter((annotation) => annotation.bookId === book.id)
    .sort((a, b) => {
      const pageA = a.location.page || 0;
      const pageB = b.location.page || 0;
      if (pageA !== pageB) return pageA - pageB;
      const chapterA = a.location.chapter || 0;
      const chapterB = b.location.chapter || 0;
      if (chapterA !== chapterB) return chapterA - chapterB;
      return (a.location.offset || 0) - (b.location.offset || 0);
    });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && /abort|cancel/i.test(error.message))
  );
}

export function describeReaderError(error: unknown): string {
  if (error instanceof Error) {
    if (/password/i.test(error.message)) return '此 PDF 受密码保护，当前版本无法打开。';
    if (/invalid|format|corrupt|parse/i.test(error.message)) return '文件结构损坏或格式变体暂不受支持。';
    if (/worker/i.test(error.message)) return 'PDF 渲染组件启动失败，请重试。';
    return error.message;
  }
  return String(error || '未知错误');
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('无法访问剪贴板');
}

export async function shareText(text: string, title?: string): Promise<'shared' | 'copied'> {
  if (navigator.share) {
    try {
      await navigator.share({ title: title || 'Granite', text });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
    }
  }
  await copyText(text);
  return 'copied';
}

