import type {
  ProviderRequestOptions,
  StorageProvider,
} from "../../packages/core/provider";
import { canonicalJson, sha256Hex } from "../../packages/core/sync";
import type { Book } from "../types";
import { localDelete, localGet, localPut } from "./host";

export const BOOK_CHUNK_SIZE = 4 * 1024 * 1024;
export const BOOK_CHUNK_THRESHOLD = BOOK_CHUNK_SIZE;
export const BOOK_CHUNK_MAX_COUNT = 128;
export const BOOK_CHUNK_MANIFEST_MAX_BYTES = 128 * 1024;
export const BOOK_CHUNK_MANIFEST_SCHEMA = "granite.book.chunks";
export const BOOK_CHUNK_MANIFEST_VERSION = 1;

const MAX_BOOK_SIZE = BOOK_CHUNK_SIZE * BOOK_CHUNK_MAX_COUNT;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface BookChunkDescriptor {
  index: number;
  sha256: string;
  size: number;
}

interface BookChunkManifestPayload {
  schema: typeof BOOK_CHUNK_MANIFEST_SCHEMA;
  version: typeof BOOK_CHUNK_MANIFEST_VERSION;
  bookSha256: string;
  size: number;
  chunkSize: typeof BOOK_CHUNK_SIZE;
  chunks: BookChunkDescriptor[];
}

export interface BookChunkManifest extends BookChunkManifestPayload {
  checksum: string;
}

export interface UploadBookObjectResult {
  layout: "raw" | "chunked";
  uploadedChunks: number[];
  reusedChunks: number[];
  manifestReused: boolean;
}

export interface BookChunkCache {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

function cachedBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  if (Array.isArray(value)) return Uint8Array.from(value);
  return undefined;
}

export class IndexedDbBookChunkCache implements BookChunkCache {
  private readonly chunks = new Map<string, Uint8Array>();
  private readonly persistent = typeof globalThis.indexedDB !== "undefined";

  async get(key: string): Promise<Uint8Array | undefined> {
    if (this.persistent) {
      try {
        const stored = await localGet<unknown>(key);
        const bytes = cachedBytes(stored);
        if (bytes) {
          this.chunks.set(key, new Uint8Array(bytes));
          return bytes;
        }
        if (stored !== undefined) await localDelete(key);
      } catch {
        /* Fall back to the in-memory copy for this session. */
      }
    }
    const bytes = this.chunks.get(key);
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  async set(key: string, bytes: Uint8Array): Promise<void> {
    this.chunks.set(key, new Uint8Array(bytes));
    if (!this.persistent) return;
    try {
      await localPut(key, new Uint8Array(bytes));
    } catch {
      /* The verified in-memory copy remains available for this session. */
    }
  }

  async delete(key: string): Promise<void> {
    this.chunks.delete(key);
    if (!this.persistent) return;
    try {
      await localDelete(key);
    } catch {
      /* Cache cleanup is best effort and cannot invalidate confirmed bytes. */
    }
  }
}

export function createBookChunkCache(): BookChunkCache {
  return new IndexedDbBookChunkCache();
}

const sessionBookChunkCache = createBookChunkCache();

export class BookObjectIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookObjectIntegrityError";
  }
}

export function canonicalBookObjectKey(hash: string): string {
  return `objects/sha256/${hash}`;
}

export function bookPartsPrefix(hash: string): string {
  return `${canonicalBookObjectKey(hash)}.parts/`;
}

export function bookPartObjectKey(
  hash: string,
  index: number,
  chunkHash: string,
): string {
  return `${bookPartsPrefix(hash)}${index}-${chunkHash}`;
}

function downloadChunkCacheKey(bookHash: string, chunkHash: string): string {
  return `download-chunk:${bookHash}:${chunkHash}`;
}

export function isBookObjectHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("书籍传输已取消", "AbortError");
}

function invalidManifest(): Error {
  return new BookObjectIntegrityError(
    "云端分块清单无法识别或与当前书籍不匹配。",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("status" in error && error.status === 404) ||
      ("code" in error && error.code === "NOT_FOUND"))
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++)
    if (left[index] !== right[index]) return false;
  return true;
}

async function readOptional(
  provider: StorageProvider,
  key: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  try {
    return await provider.read(key, { signal });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readCachedChunk(
  cache: BookChunkCache | null,
  key: string,
  chunk: BookChunkDescriptor,
): Promise<Uint8Array | undefined> {
  if (!cache) return undefined;
  try {
    const bytes = await cache.get(key);
    if (
      bytes &&
      bytes.byteLength === chunk.size &&
      (await sha256Hex(bytes)) === chunk.sha256
    )
      return bytes;
    if (bytes) await cache.delete(key).catch(() => {});
  } catch {
    /* A cache failure must not block provider reads. */
  }
  return undefined;
}

async function writeCachedChunk(
  cache: BookChunkCache | null,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.set(key, bytes);
  } catch {
    /* A cache failure must not block a verified transfer. */
  }
}

async function clearCachedChunks(
  cache: BookChunkCache | null,
  keys: readonly string[],
): Promise<void> {
  if (!cache) return;
  await Promise.all(keys.map((key) => cache.delete(key).catch(() => {})));
}

async function listOptional(
  provider: StorageProvider,
  prefix: string,
  signal?: AbortSignal,
) {
  try {
    return await provider.list(prefix, { signal });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function describeChunks(
  bytes: Uint8Array,
): Promise<BookChunkDescriptor[]> {
  const chunks: BookChunkDescriptor[] = [];
  for (
    let offset = 0, index = 0;
    offset < bytes.byteLength;
    offset += BOOK_CHUNK_SIZE, index++
  ) {
    const end = Math.min(offset + BOOK_CHUNK_SIZE, bytes.byteLength);
    const chunk = bytes.subarray(offset, end);
    chunks.push({
      index,
      sha256: await sha256Hex(chunk),
      size: chunk.byteLength,
    });
  }
  return chunks;
}

async function buildManifest(
  bookSha256: string,
  size: number,
  chunks: BookChunkDescriptor[],
): Promise<BookChunkManifest> {
  const payload: BookChunkManifestPayload = {
    schema: BOOK_CHUNK_MANIFEST_SCHEMA,
    version: BOOK_CHUNK_MANIFEST_VERSION,
    bookSha256,
    size,
    chunkSize: BOOK_CHUNK_SIZE,
    chunks,
  };
  return {
    ...payload,
    checksum: await sha256Hex(canonicalJson(payload)),
  };
}

async function parseManifest(
  bytes: Uint8Array,
  book: Book,
): Promise<BookChunkManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw invalidManifest();
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "schema",
      "version",
      "bookSha256",
      "size",
      "chunkSize",
      "chunks",
      "checksum",
    ]) ||
    parsed.schema !== BOOK_CHUNK_MANIFEST_SCHEMA ||
    parsed.version !== BOOK_CHUNK_MANIFEST_VERSION
  )
    throw invalidManifest();
  if (
    parsed.bookSha256 !== book.sha256 ||
    !Number.isSafeInteger(parsed.size) ||
    parsed.size !== book.size ||
    parsed.size <= BOOK_CHUNK_THRESHOLD ||
    parsed.size > MAX_BOOK_SIZE ||
    parsed.chunkSize !== BOOK_CHUNK_SIZE ||
    !Array.isArray(parsed.chunks)
  )
    throw invalidManifest();

  const expectedCount = Math.ceil(parsed.size / BOOK_CHUNK_SIZE);
  if (
    expectedCount < 2 ||
    expectedCount > BOOK_CHUNK_MAX_COUNT ||
    parsed.chunks.length !== expectedCount
  )
    throw invalidManifest();

  const chunks: BookChunkDescriptor[] = [];
  for (let index = 0; index < parsed.chunks.length; index++) {
    const rawChunk = parsed.chunks[index];
    if (
      !isRecord(rawChunk) ||
      !hasExactKeys(rawChunk, ["index", "sha256", "size"]) ||
      rawChunk.index !== index ||
      !isBookObjectHash(rawChunk.sha256) ||
      rawChunk.size !==
        Math.min(BOOK_CHUNK_SIZE, parsed.size - index * BOOK_CHUNK_SIZE)
    )
      throw invalidManifest();
    chunks.push({
      index,
      sha256: rawChunk.sha256,
      size: rawChunk.size,
    });
  }

  const payload: BookChunkManifestPayload = {
    schema: BOOK_CHUNK_MANIFEST_SCHEMA,
    version: BOOK_CHUNK_MANIFEST_VERSION,
    bookSha256: book.sha256,
    size: parsed.size,
    chunkSize: BOOK_CHUNK_SIZE,
    chunks,
  };
  if (
    !isBookObjectHash(parsed.checksum) ||
    (await sha256Hex(canonicalJson(payload))) !== parsed.checksum
  )
    throw invalidManifest();
  return { ...payload, checksum: parsed.checksum };
}

async function verifyBookBytes(book: Book, bytes: Uint8Array): Promise<void> {
  if (book.size > MAX_BOOK_SIZE)
    throw new Error(`书籍大小超过同步上限：${book.title}`);
  if (
    !isBookObjectHash(book.sha256) ||
    !Number.isSafeInteger(book.size) ||
    book.size < 0 ||
    bytes.byteLength !== book.size
  )
    throw new Error(`书籍大小与元数据不一致：${book.title}`);
  if ((await sha256Hex(bytes)) !== book.sha256)
    throw new Error(`书籍内容校验失败：${book.title}`);
}

export async function uploadBookObject(
  provider: StorageProvider,
  book: Book,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<UploadBookObjectResult> {
  throwIfAborted(signal);
  await verifyBookBytes(book, bytes);
  const canonicalKey = canonicalBookObjectKey(book.sha256);

  if (bytes.byteLength <= BOOK_CHUNK_THRESHOLD) {
    const existing = await readOptional(provider, canonicalKey, signal);
    throwIfAborted(signal);
    if (existing && (await sha256Hex(existing)) === book.sha256)
      return {
        layout: "raw",
        uploadedChunks: [],
        reusedChunks: [],
        manifestReused: true,
      };
    await provider.write(canonicalKey, bytes, {
      signal,
      contentType: "application/octet-stream",
    });
    throwIfAborted(signal);
    return {
      layout: "raw",
      uploadedChunks: [],
      reusedChunks: [],
      manifestReused: false,
    };
  }

  const chunks = await describeChunks(bytes);
  throwIfAborted(signal);
  const existing = new Set(
    (await listOptional(provider, bookPartsPrefix(book.sha256), signal)).map(
      (object) => object.key,
    ),
  );
  const uploadedChunks: number[] = [];
  const reusedChunks: number[] = [];

  for (const chunk of chunks) {
    throwIfAborted(signal);
    const key = bookPartObjectKey(book.sha256, chunk.index, chunk.sha256);
    if (existing.has(key)) {
      let remote: Uint8Array | undefined;
      try {
        remote = await provider.read(key, { signal });
      } catch (error) {
        throwIfAborted(signal);
        if (!isNotFound(error)) throw error;
      }
      if (
        remote &&
        remote.byteLength === chunk.size &&
        (await sha256Hex(remote)) === chunk.sha256
      ) {
        reusedChunks.push(chunk.index);
        continue;
      }
    }

    throwIfAborted(signal);
    const offset = chunk.index * BOOK_CHUNK_SIZE;
    await provider.write(key, bytes.subarray(offset, offset + chunk.size), {
      signal,
      contentType: "application/octet-stream",
    });
    uploadedChunks.push(chunk.index);
    throwIfAborted(signal);
  }

  const manifest = await buildManifest(book.sha256, bytes.byteLength, chunks);
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  throwIfAborted(signal);
  const currentManifest = await readOptional(provider, canonicalKey, signal);
  const manifestReused = Boolean(
    currentManifest && sameBytes(currentManifest, manifestBytes),
  );
  if (!manifestReused) {
    throwIfAborted(signal);
    await provider.write(canonicalKey, manifestBytes, {
      signal,
      contentType: "application/json",
    });
    throwIfAborted(signal);
  }
  return {
    layout: "chunked",
    uploadedChunks,
    reusedChunks,
    manifestReused,
  };
}

async function inspectBookObject(
  provider: StorageProvider,
  book: Book,
  signal?: AbortSignal,
  chunkCache?: BookChunkCache | null,
): Promise<{ layout: "raw" | "chunked"; bytes: Uint8Array }> {
  throwIfAborted(signal);
  if (!isBookObjectHash(book.sha256))
    throw new Error(`书籍校验值无效：${book.title}`);
  const canonical = await provider.read(canonicalBookObjectKey(book.sha256), {
    signal,
  });
  throwIfAborted(signal);
  if ((await sha256Hex(canonical)) === book.sha256)
    return { layout: "raw", bytes: canonical };
  if (canonical.byteLength > BOOK_CHUNK_MANIFEST_MAX_BYTES)
    throw invalidManifest();

  const manifest = await parseManifest(canonical, book);
  const assembled = new Uint8Array(manifest.size);
  const cache =
    chunkCache === null ? null : (chunkCache ?? sessionBookChunkCache);
  const cachedKeys: string[] = [];
  for (const chunk of manifest.chunks) {
    throwIfAborted(signal);
    const objectKey = bookPartObjectKey(book.sha256, chunk.index, chunk.sha256);
    const cacheKey = downloadChunkCacheKey(book.sha256, chunk.sha256);
    let bytes = await readCachedChunk(cache, cacheKey, chunk);
    if (!bytes) {
      bytes = await provider.read(objectKey, { signal });
      if (
        bytes.byteLength !== chunk.size ||
        (await sha256Hex(bytes)) !== chunk.sha256
      )
        throw new BookObjectIntegrityError(
          `分块校验失败：第 ${chunk.index + 1} 块`,
        );
      await writeCachedChunk(cache, cacheKey, bytes);
    }
    cachedKeys.push(cacheKey);
    assembled.set(bytes, chunk.index * BOOK_CHUNK_SIZE);
    throwIfAborted(signal);
  }
  if ((await sha256Hex(assembled)) !== book.sha256) {
    await clearCachedChunks(cache, cachedKeys);
    throw new BookObjectIntegrityError(`书籍分块重组校验失败：${book.title}`);
  }
  throwIfAborted(signal);
  await clearCachedChunks(cache, cachedKeys);
  return { layout: "chunked", bytes: assembled };
}

export async function downloadBookObject(
  provider: StorageProvider,
  book: Book,
  signal?: AbortSignal,
  chunkCache?: BookChunkCache | null,
): Promise<Uint8Array> {
  return (await inspectBookObject(provider, book, signal, chunkCache)).bytes;
}

export async function isBookObjectComplete(
  provider: StorageProvider,
  book: Book,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const inspected = await inspectBookObject(provider, book, signal, null);
    return inspected.layout === "chunked" || book.size <= BOOK_CHUNK_THRESHOLD;
  } catch (error) {
    throwIfAborted(signal);
    if (isNotFound(error) || error instanceof BookObjectIntegrityError)
      return false;
    throw error;
  }
}

export async function transferBook(
  provider: StorageProvider,
  book: Book,
  signal?: AbortSignal,
  chunkCache?: BookChunkCache | null,
): Promise<Uint8Array> {
  return downloadBookObject(provider, book, signal, chunkCache);
}

export async function removeBookObjects(
  provider: StorageProvider,
  hash: string,
  options: ProviderRequestOptions = {},
): Promise<number> {
  if (!isBookObjectHash(hash)) return 0;
  throwIfAborted(options.signal);
  const prefix = bookPartsPrefix(hash);
  const parts = await listOptional(provider, prefix, options.signal);
  let removed = 0;
  for (const part of parts) {
    throwIfAborted(options.signal);
    const suffix = part.key.startsWith(prefix)
      ? part.key.slice(prefix.length)
      : "";
    if (!suffix || /[/\\\0]/.test(suffix)) continue;
    await provider.remove(part.key, options);
    removed++;
  }
  await provider.remove(canonicalBookObjectKey(hash), options);
  return removed;
}
