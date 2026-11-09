import type { Book, Format, ReaderLocation } from '../types';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
}

export function formatDateTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateTimeFormatter.format(date);
}

export function relativeTime(value?: string): string {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(value);
}

export function durationLabel(ms: number, compact = false): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 分钟';
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return compact ? '0 分钟' : '不足 1 分钟';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} 分钟`;
  if (!rest) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分`;
}

export function durationParts(ms: number): { hours: number; minutes: number } {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function normalizedProgress(location?: ReaderLocation): number {
  const raw = Number(location?.progress || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(100, Math.max(0, raw <= 1 ? raw * 100 : raw));
}

export function progressFor(book: Book): number {
  return book.status === 'finished' ? 100 : normalizedProgress(book.location);
}

export function progressLabel(book: Book): string {
  if (book.status === 'finished') return '已读';
  if (book.status === 'unread') return '未读';
  const value = Math.round(progressFor(book));
  return value ? `${value}%` : '阅读中';
}

export function statusLabel(status: Book['status']): string {
  return { unread: '未读', reading: '阅读中', finished: '已读' }[status];
}

export function authorsLabel(book: Book): string {
  return book.authors.filter(Boolean).join(' · ');
}

export function initials(name?: string): string {
  const value = (name || 'G').trim();
  return value.length > 2 ? value.slice(0, 2).toUpperCase() : value.toUpperCase();
}

export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'granite-export';
}

export function formatOf(name: string): Format | undefined {
  const value = name.split('.').pop()?.toLowerCase();
  return ['epub', 'pdf', 'txt', 'mobi'].includes(value || '') ? (value as Format) : undefined;
}

export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]]+)]]/g, '$1')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function startOfDay(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function dateKey(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

