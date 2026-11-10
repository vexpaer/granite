import DOMPurify from 'dompurify';
import type JSZip from 'jszip';
import { marked } from 'marked';
import type { Note } from '../types';

export type NotebookAttachment = NonNullable<Note['attachments']>[number];

export interface DecodedNotebookAttachment {
  bytes: Uint8Array;
  mediaType: string;
}

export const NOTEBOOK_ATTACHMENT_ROOT = 'attachments/sha256';
export const NOTEBOOK_BACKUP_ROOT = 'notebook';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_IMAGE_MEDIA_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp',
};
const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot > 0 && dot < value.length - 1
    ? value.slice(dot + 1).toLowerCase()
    : '';
}

function truncatePathSegment(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  const extension = extensionOf(value);
  const suffix = extension ? `.${extension.slice(0, 16)}` : '';
  const stemLength = Math.max(1, maxLength - suffix.length);
  return `${value.slice(0, stemLength).replace(/[.-]+$/g, '') || 'file'}${suffix}`;
}

function safeFolderSegment(value: string): string {
  let safe = value
    .normalize('NFKC')
    .trim()
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[. ]+$/g, '');
  if (!safe) safe = 'folder';
  const basenameWithoutExtension = safe.split('.')[0]?.toLowerCase() || '';
  if (WINDOWS_RESERVED_NAMES.has(basenameWithoutExtension))
    safe = `_${safe}`;
  return safe.slice(0, 120).replace(/[. ]+$/g, '') || 'folder';
}

export function safeNotebookPathSegment(
  value: unknown,
  fallback = 'file',
): string {
  const basename =
    String(value ?? '')
      .normalize('NFKC')
      .trim()
      .split(/[\\/]/)
      .pop() || '';
  let safe = basename
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (!safe) safe = fallback;
  const basenameWithoutExtension = safe.split('.')[0]?.toLowerCase() || '';
  if (WINDOWS_RESERVED_NAMES.has(basenameWithoutExtension))
    safe = `_${safe}`;
  return truncatePathSegment(safe);
}

function isSafeArchiveSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    value !== '.' &&
    value !== '..' &&
    !/[%<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) &&
    !/[. ]$/.test(value)
  );
}

export function normalizeMediaType(value: string | undefined, filename = ''): string {
  const explicit = String(value ?? '')
    .trim()
    .toLowerCase()
    .split(';', 1)[0];
  if (
    explicit &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(
      explicit,
    )
  )
    return explicit;
  return MEDIA_TYPES_BY_EXTENSION[extensionOf(filename)] || 'application/octet-stream';
}

export async function sha256AttachmentBytes(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error('当前环境不支持附件内容校验。');
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function encodeAttachmentDataUrl(
  bytes: Uint8Array,
  mediaType: string,
): string {
  return `data:${normalizeMediaType(mediaType)};base64,${encodeBase64(bytes)}`;
}

export function decodeAttachmentDataUrl(
  data: string | undefined,
): DecodedNotebookAttachment {
  if (!data) throw new Error('附件缺少可移植内容。');
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i.exec(
    data,
  );
  if (!match) throw new Error('附件数据不是有效的 Base64 Data URL。');
  const mediaType = normalizeMediaType(match[1] || 'text/plain');
  const encoded = match[2]!.replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 === 1)
    throw new Error('附件 Base64 数据无效。');
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error('附件 Base64 数据无效。');
  }
  return {
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    mediaType,
  };
}

export async function createNotebookAttachment(
  name: string,
  mediaType: string | undefined,
  bytes: Uint8Array,
): Promise<NotebookAttachment> {
  const safeName = safeNotebookPathSegment(name, 'attachment');
  const resolvedMediaType = normalizeMediaType(mediaType, safeName);
  const hash = await sha256AttachmentBytes(bytes);
  return {
    name: safeName,
    path: attachmentRelativePath(safeName, hash),
    data: encodeAttachmentDataUrl(bytes, resolvedMediaType),
  };
}

export function attachmentRelativePath(filename: string, hash: string): string {
  if (!SHA256_HEX.test(hash))
    throw new Error('附件 SHA-256 内容地址无效。');
  return `${NOTEBOOK_ATTACHMENT_ROOT}/${hash}/${safeNotebookPathSegment(filename, 'attachment')}`;
}

function decodeReferencePath(value: string): string | null {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!/%[0-9a-f]{2}/i.test(decoded)) break;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }
  return decoded;
}

export function normalizePortableAttachmentPath(
  value: string,
): string | null {
  const trimmed = value.trim().replace(/^<|>$/g, '');
  if (
    !trimmed ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    trimmed.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    /[\\\u0000-\u001f\u007f]/.test(trimmed)
  )
    return null;
  const decoded = decodeReferencePath(trimmed);
  if (
    !decoded ||
    decoded.startsWith('/') ||
    decoded.startsWith('\\') ||
    decoded.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  )
    return null;
  const segments = decoded.split('/');
  if (
    segments[0] !== 'attachments' ||
    segments.length < 2 ||
    segments.some((segment) => !isSafeArchiveSegment(segment))
  )
    return null;
  return segments.join('/');
}

function referencedAttachmentPath(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    trimmed.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  )
    return null;
  const pathOnly = trimmed.split(/[?#]/, 1)[0] || '';
  return normalizePortableAttachmentPath(pathOnly);
}

export function contentAddressHash(path: string): string | null {
  const normalized = normalizePortableAttachmentPath(path);
  if (!normalized) return null;
  const match = new RegExp(
    `^${NOTEBOOK_ATTACHMENT_ROOT}/([0-9a-f]{64})/[^/]+$`,
  ).exec(normalized);
  return match?.[1] || null;
}

function attachmentBytes(attachment: NotebookAttachment): DecodedNotebookAttachment {
  try {
    return decodeAttachmentDataUrl(attachment.data);
  } catch (error) {
    throw new Error(
      `附件“${attachment.name}”缺少可导出的实际文件：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function attachmentMediaType(attachment: NotebookAttachment): string {
  try {
    return decodeAttachmentDataUrl(attachment.data).mediaType;
  } catch {
    return normalizeMediaType(undefined, attachment.name);
  }
}

export function isPreviewableImageAttachment(
  attachment: NotebookAttachment,
): boolean {
  try {
    const decoded = decodeAttachmentDataUrl(attachment.data);
    return SAFE_IMAGE_MEDIA_TYPES.has(decoded.mediaType);
  } catch {
    return false;
  }
}

function safePreviewImageDataUrl(
  attachment: NotebookAttachment,
): string | null {
  try {
    const decoded = decodeAttachmentDataUrl(attachment.data);
    return SAFE_IMAGE_MEDIA_TYPES.has(decoded.mediaType)
      ? encodeAttachmentDataUrl(decoded.bytes, decoded.mediaType)
      : null;
  } catch {
    return null;
  }
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([\[\]])/g, '\\$1');
}

function encodeMarkdownDestination(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function attachmentMarkdown(attachment: NotebookAttachment): string {
  const path = normalizePortableAttachmentPath(attachment.path);
  if (!path) throw new Error(`附件“${attachment.name}”的相对路径不安全。`);
  const label = escapeMarkdownLabel(attachment.name);
  const destination = encodeMarkdownDestination(path);
  return `${
    isPreviewableImageAttachment(attachment) ? '!' : ''
  }[${label}](${destination})`;
}

export function insertAttachmentMarkdown(
  body: string,
  attachment: NotebookAttachment,
  position = body.length,
): string {
  const safePosition = Math.max(0, Math.min(position, body.length));
  const before = body.slice(0, safePosition);
  const after = body.slice(safePosition);
  const leading =
    before && !before.endsWith('\n')
      ? '\n\n'
      : '';
  const trailing = after && !after.startsWith('\n') ? '\n\n' : '';
  return `${before}${leading}${attachmentMarkdown(attachment)}${trailing}${after}`;
}

export function removeAttachmentMarkdown(
  body: string,
  attachment: NotebookAttachment,
): string {
  const destinations = [
    attachment.path,
    encodeMarkdownDestination(attachment.path),
  ]
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return body
    .replace(
      new RegExp(
        `!?\\[[^\\]\\n]*\\]\\((?:<)?(?:${destinations})(?:>)?(?:\\s+["'][^"']*["'])?\\)[ \\t]*\\n?`,
        'g',
      ),
      '',
    )
    .replace(/\n{3,}/g, '\n\n');
}

function attachmentMap(
  attachments: readonly NotebookAttachment[] | undefined,
): Map<string, NotebookAttachment | null> {
  const result = new Map<string, NotebookAttachment | null>();
  for (const attachment of attachments || []) {
    const path = normalizePortableAttachmentPath(attachment.path);
    if (!path) continue;
    const existing = result.get(path);
    if (existing === undefined) result.set(path, attachment);
    else if (existing?.data !== attachment.data) result.set(path, null);
  }
  return result;
}

export function resolveDeclaredAttachment(
  reference: string,
  attachments: readonly NotebookAttachment[] | undefined,
): NotebookAttachment | undefined {
  const path = referencedAttachmentPath(reference);
  if (!path) return undefined;
  const attachment = attachmentMap(attachments).get(path);
  return attachment || undefined;
}

function safeExternalUrl(
  value: string,
  protocols = new Set(['http:', 'https:', 'mailto:', 'tel:']),
): boolean {
  try {
    return protocols.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function renderNotebookMarkdown(
  body: string,
  attachments: readonly NotebookAttachment[] | undefined,
): string {
  const source = body.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, label?: string) =>
      `[${label || target}](#wikilink:${encodeURIComponent(target.trim())})`,
  );
  const sanitized = DOMPurify.sanitize(marked.parse(source) as string, {
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target', 'rel', 'loading', 'decoding'],
    FORBID_TAGS: [
      'svg',
      'math',
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'select',
      'textarea',
      'template',
      'video',
      'audio',
      'canvas',
    ],
    FORBID_ATTR: ['style'],
  });
  const parsed = new DOMParser().parseFromString(sanitized, 'text/html');
  const declared = attachmentMap(attachments);
  const imageProtocols = new Set(['http:', 'https:']);

  for (const image of [...parsed.body.querySelectorAll('img')]) {
    const sourceUrl = image.getAttribute('src') || '';
    const path = referencedAttachmentPath(sourceUrl);
    const attachment = path ? declared.get(path) : undefined;
    const dataUrl = attachment ? safePreviewImageDataUrl(attachment) : null;
    image.removeAttribute('srcset');
    if (dataUrl) image.setAttribute('src', dataUrl);
    else if (safeExternalUrl(sourceUrl, imageProtocols))
      image.setAttribute('src', sourceUrl);
    else image.removeAttribute('src');
    image.setAttribute('loading', 'lazy');
    image.setAttribute('decoding', 'async');
  }

  for (const anchor of [...parsed.body.querySelectorAll('a')]) {
    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#')) continue;
    const path = referencedAttachmentPath(href);
    const attachment = path ? declared.get(path) : undefined;
    if (attachment && path) {
      anchor.setAttribute('href', `#attachment:${encodeURIComponent(path)}`);
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
    } else if (safeExternalUrl(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    } else {
      anchor.removeAttribute('href');
    }
  }

  return parsed.body.innerHTML;
}

function notebookFolderPath(folder: string): string {
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[a-z]:/i.test(trimmed) ||
    trimmed.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  )
    throw new Error('笔记文件夹包含不安全路径。');
  return trimmed
    .split('/')
    .map((segment) => {
      if (segment === '.' || segment === '..')
        throw new Error('笔记文件夹不得包含路径穿越片段。');
      return safeFolderSegment(segment);
    })
    .join('/');
}

export function notebookBackupDirectory(note: Note): string {
  const folder = notebookFolderPath(note.folder);
  return folder
    ? `${NOTEBOOK_BACKUP_ROOT}/${folder}`
    : NOTEBOOK_BACKUP_ROOT;
}

function notebookTitleStem(note: Note): string {
  return (
    safeNotebookPathSegment(note.title, 'note').replace(/\.md$/i, '') ||
    'note'
  );
}

export function notebookBackupMarkdownPath(note: Note): string {
  const id = safeNotebookPathSegment(note.id, 'note-id');
  return `${notebookBackupDirectory(note)}/${notebookTitleStem(note)}-${id}.md`;
}

export function notebookExportBaseName(note: Note): string {
  return notebookTitleStem(note);
}

export function notebookExportMarkdownFileName(note: Note): string {
  return `${notebookExportBaseName(note)}.md`;
}

function normalizeArchiveDirectory(directory: string): string {
  const trimmed = directory.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[a-z]:/i.test(trimmed) ||
    trimmed.includes('\\') ||
    trimmed.split('/').some((segment) => !isSafeArchiveSegment(segment))
  )
    throw new Error('附件归档目录不安全。');
  return trimmed;
}

function joinArchivePath(directory: string, relativePath: string): string {
  return directory ? `${directory}/${relativePath}` : relativePath;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++)
    if (left[index] !== right[index]) return false;
  return true;
}

export async function addNotebookAttachmentsToZip(
  zip: JSZip,
  note: Note,
  directory = '',
): Promise<number> {
  const safeDirectory = normalizeArchiveDirectory(directory);
  let added = 0;
  for (const attachment of note.attachments || []) {
    const relativePath = normalizePortableAttachmentPath(attachment.path);
    if (!relativePath)
      throw new Error(`附件“${attachment.name}”的相对路径不安全，无法导出。`);
    const decoded = attachmentBytes(attachment);
    const expectedHash = contentAddressHash(relativePath);
    if (
      expectedHash &&
      (await sha256AttachmentBytes(decoded.bytes)) !== expectedHash
    )
      throw new Error(
        `附件“${attachment.name}”的实际内容与内容地址不一致。`,
      );

    const archivePath = joinArchivePath(safeDirectory, relativePath);
    const existing = zip.file(archivePath);
    if (existing) {
      const existingBytes = await existing.async('uint8array');
      if (!sameBytes(existingBytes, decoded.bytes))
        throw new Error(`附件归档路径冲突：${archivePath}`);
      continue;
    }
    zip.file(archivePath, decoded.bytes);
    added++;
  }
  return added;
}
