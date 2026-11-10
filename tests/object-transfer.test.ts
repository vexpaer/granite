// @vitest-environment node
import "fake-indexeddb/auto";

import { createHash, webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  type ProviderCapabilities,
  type ProviderObject,
  type ProviderRangeOptions,
  type ProviderReadOptions,
  type ProviderRequestOptions,
  type ProviderStat,
  type ProviderWriteOptions,
  type ProviderWriteResult,
  type StorageProvider,
} from "../packages/core/provider";
import { canonicalJson, sha256Hex } from "../packages/core/sync";
import {
  BOOK_CHUNK_MANIFEST_MAX_BYTES,
  BOOK_CHUNK_MANIFEST_SCHEMA,
  BOOK_CHUNK_MAX_COUNT,
  BOOK_CHUNK_SIZE,
  BookObjectIntegrityError,
  bookPartObjectKey,
  bookPartsPrefix,
  canonicalBookObjectKey,
  createBookChunkCache,
  transferBook,
  uploadBookObject,
} from "../src/services/object-transfer";
import { localGet, localPut } from "../src/services/host";
import type { Book, ProviderProfile } from "../src/types";

const profile: ProviderProfile = {
  id: "memory-provider",
  type: "webdav",
  name: "Memory test provider",
  endpoint: "https://memory.invalid/root",
  username: "tester",
  prefix: "Test",
  credentialId: "test-only-reference",
};

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function patternedBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = (index * 31 + 17) & 0xff;
  return bytes;
}

function bookFor(bytes: Uint8Array, id = "book-large"): Book {
  return {
    id,
    title: `Book ${id}`,
    authors: ["Transfer QA"],
    format: "txt",
    sha256: hash(bytes),
    size: bytes.byteLength,
    rootId: "root-a",
    relativePath: `books/00000000-0000-0000-0000-000000000001/${id}.txt`,
    managed: true,
    available: true,
    status: "unread",
    favorite: false,
    tagIds: [],
    collectionIds: [],
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
  };
}

class MemoryProvider implements StorageProvider {
  readonly profile = profile;
  readonly bindingId = "memory:test";
  readonly objects = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  readonly reads: string[] = [];
  writeFailure: ((key: string) => Error | undefined) | undefined;
  readFailure: ((key: string) => Error | undefined) | undefined;
  afterWrite: ((key: string) => void) | undefined;

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      conditionalWrite: true,
      rangeRead: true,
      serverChecksums: true,
      move: false,
      versioning: false,
      multipartUpload: false,
      etag: true,
    };
  }

  async list(
    prefix = "",
    _options: ProviderRequestOptions = {},
  ): Promise<ProviderObject[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => ({
        key,
        size: bytes.byteLength,
        etag: hash(bytes).slice(0, 12),
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async stat(
    key: string,
    _options: ProviderRequestOptions = {},
  ): Promise<ProviderStat | undefined> {
    const bytes = this.objects.get(key);
    return bytes
      ? {
          key,
          size: bytes.byteLength,
          etag: hash(bytes).slice(0, 12),
        }
      : undefined;
  }

  async read(
    key: string,
    options: ProviderReadOptions = {},
  ): Promise<Uint8Array> {
    if (options.signal?.aborted) throw options.signal.reason;
    const failure = this.readFailure?.(key);
    if (failure) throw failure;
    this.reads.push(key);
    const bytes = this.objects.get(key);
    if (!bytes)
      throw new ProviderError("not found", {
        code: "NOT_FOUND",
        status: 404,
      });
    const copy = new Uint8Array(bytes);
    if (
      options.expectedSha256 &&
      hash(copy) !== options.expectedSha256.toLowerCase()
    )
      throw new ProviderError("checksum mismatch", {
        code: "CHECKSUM_MISMATCH",
      });
    return copy;
  }

  async readRange(
    key: string,
    options: ProviderRangeOptions,
  ): Promise<Uint8Array> {
    const bytes = await this.read(key, options);
    return bytes.slice(options.start, (options.end ?? bytes.length - 1) + 1);
  }

  async write(
    key: string,
    bytes: Uint8Array,
    _options: ProviderWriteOptions = {},
  ): Promise<ProviderWriteResult> {
    const failure = this.writeFailure?.(key);
    if (failure) throw failure;
    const copy = new Uint8Array(bytes);
    this.objects.set(key, copy);
    this.writes.push(key);
    this.afterWrite?.(key);
    return { checksum: hash(copy), status: 201 };
  }

  async remove(
    key: string,
    _options: ProviderRequestOptions = {},
  ): Promise<void> {
    this.objects.delete(key);
  }
}

beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("resumable book object transfer", () => {
  it("resumes after one chunk without re-uploading the healthy remote chunk", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE + 33_777);
    const book = bookFor(bytes);
    const provider = new MemoryProvider();
    const firstChunkHash = hash(bytes.subarray(0, BOOK_CHUNK_SIZE));
    const secondChunkHash = hash(bytes.subarray(BOOK_CHUNK_SIZE));
    const firstPartKey = bookPartObjectKey(book.sha256, 0, firstChunkHash);
    const secondPartKey = bookPartObjectKey(book.sha256, 1, secondChunkHash);
    let partWrites = 0;
    const networkFailure = new Error("network offline");
    provider.writeFailure = (key) => {
      if (!key.startsWith(bookPartsPrefix(book.sha256))) return undefined;
      partWrites++;
      return partWrites === 2 ? networkFailure : undefined;
    };

    await expect(uploadBookObject(provider, book, bytes)).rejects.toBe(
      networkFailure,
    );

    expect(provider.objects.has(firstPartKey)).toBe(true);
    expect(provider.objects.has(secondPartKey)).toBe(false);
    expect(provider.objects.has(canonicalBookObjectKey(book.sha256))).toBe(
      false,
    );

    provider.writeFailure = undefined;
    provider.writes.length = 0;
    const resumed = await uploadBookObject(provider, book, bytes);

    expect(resumed).toMatchObject({
      layout: "chunked",
      uploadedChunks: [1],
      reusedChunks: [0],
    });
    expect(provider.writes).toEqual([
      secondPartKey,
      canonicalBookObjectKey(book.sha256),
    ]);
    expect(Array.from(await transferBook(provider, book))).toEqual(
      Array.from(bytes),
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(
        provider.objects.get(canonicalBookObjectKey(book.sha256)),
      ),
    ) as { schema: string; version: number };
    expect(manifest).toMatchObject({
      schema: BOOK_CHUNK_MANIFEST_SCHEMA,
      version: 1,
    });
  });

  it("keeps small books as raw canonical objects", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE);
    const book = bookFor(bytes, "book-small");
    const provider = new MemoryProvider();

    const uploaded = await uploadBookObject(provider, book, bytes);

    expect(uploaded.layout).toBe("raw");
    expect(provider.writes).toEqual([canonicalBookObjectKey(book.sha256)]);
    expect(
      [...provider.objects.keys()].some((key) =>
        key.startsWith(bookPartsPrefix(book.sha256)),
      ),
    ).toBe(false);

    provider.writes.length = 0;
    expect(Array.from(await transferBook(provider, book))).toEqual(
      Array.from(bytes),
    );
    expect(provider.writes).toEqual([]);
  });

  it("accepts a legacy raw large object when its full hash matches", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE + 7);
    const book = bookFor(bytes, "book-legacy-raw");
    const provider = new MemoryProvider();
    provider.objects.set(canonicalBookObjectKey(book.sha256), bytes);

    expect(Array.from(await transferBook(provider, book))).toEqual(
      Array.from(bytes),
    );
    expect(provider.writes).toEqual([]);
  });

  it("rejects a corrupt chunk before returning assembled bytes", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE + 1);
    const book = bookFor(bytes, "book-corrupt");
    const provider = new MemoryProvider();
    await uploadBookObject(provider, book, bytes);
    const firstPartKey = bookPartObjectKey(
      book.sha256,
      0,
      hash(bytes.subarray(0, BOOK_CHUNK_SIZE)),
    );
    const corrupt = new Uint8Array(provider.objects.get(firstPartKey)!);
    corrupt[0] ^= 0xff;
    provider.objects.set(firstPartKey, corrupt);

    await expect(transferBook(provider, book)).rejects.toBeInstanceOf(
      BookObjectIntegrityError,
    );
  });

  it("reuses IndexedDB chunks after rebuilding the cache adapter", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE + 11);
    const book = bookFor(bytes, "book-download-retry");
    const provider = new MemoryProvider();
    await uploadBookObject(provider, book, bytes);
    const firstPartKey = bookPartObjectKey(
      book.sha256,
      0,
      hash(bytes.subarray(0, BOOK_CHUNK_SIZE)),
    );
    const secondPartKey = bookPartObjectKey(
      book.sha256,
      1,
      hash(bytes.subarray(BOOK_CHUNK_SIZE)),
    );
    const firstChunkCacheKey = `download-chunk:${book.sha256}:${hash(
      bytes.subarray(0, BOOK_CHUNK_SIZE),
    )}`;
    const secondChunkCacheKey = `download-chunk:${book.sha256}:${hash(
      bytes.subarray(BOOK_CHUNK_SIZE),
    )}`;
    provider.reads.length = 0;
    const offlineFailure = new Error("download offline");
    provider.readFailure = (key) =>
      key === secondPartKey ? offlineFailure : undefined;

    await expect(transferBook(provider, book)).rejects.toBe(offlineFailure);
    expect(await localGet(firstChunkCacheKey)).toBeInstanceOf(Uint8Array);
    expect(await localGet(secondChunkCacheKey)).toBeUndefined();

    provider.readFailure = undefined;
    provider.reads.length = 0;
    const rebuiltCache = createBookChunkCache();
    expect(
      Array.from(await transferBook(provider, book, undefined, rebuiltCache)),
    ).toEqual(Array.from(bytes));
    expect(provider.reads).not.toContain(firstPartKey);
    expect(provider.reads).toContain(secondPartKey);
    expect(await localGet(firstChunkCacheKey)).toBeUndefined();
    expect(await localGet(secondChunkCacheKey)).toBeUndefined();
  });

  it("discards a corrupt cached chunk and reads it again from the provider", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE + 12);
    const book = bookFor(bytes, "book-corrupt-cache");
    const provider = new MemoryProvider();
    await uploadBookObject(provider, book, bytes);
    const firstChunkHash = hash(bytes.subarray(0, BOOK_CHUNK_SIZE));
    const firstPartKey = bookPartObjectKey(book.sha256, 0, firstChunkHash);
    const cacheKey = `download-chunk:${book.sha256}:${firstChunkHash}`;
    await localPut(cacheKey, new Uint8Array([1, 2, 3]));
    provider.reads.length = 0;

    expect(Array.from(await transferBook(provider, book))).toEqual(
      Array.from(bytes),
    );
    expect(provider.reads).toContain(firstPartKey);
    expect(await localGet(cacheKey)).toBeUndefined();
  });

  it("rejects a self-consistent manifest for a different book hash", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE + 2);
    const book = bookFor(bytes, "book-wrong-manifest");
    const provider = new MemoryProvider();
    await uploadBookObject(provider, book, bytes);
    const canonicalKey = canonicalBookObjectKey(book.sha256);
    const original = JSON.parse(
      new TextDecoder().decode(provider.objects.get(canonicalKey)),
    ) as Record<string, unknown>;
    const { checksum: _checksum, ...payload } = original;
    const wrongPayload = {
      ...payload,
      bookSha256: "f".repeat(64),
    };
    const wrongManifest = {
      ...wrongPayload,
      checksum: await sha256Hex(canonicalJson(wrongPayload)),
    };
    provider.objects.set(
      canonicalKey,
      new TextEncoder().encode(canonicalJson(wrongManifest)),
    );

    await expect(transferBook(provider, book)).rejects.toBeInstanceOf(
      BookObjectIntegrityError,
    );
  });

  it("rejects oversized manifest payloads before parsing or allocation", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE + 4);
    const book = bookFor(bytes, "book-manifest-limit");
    const provider = new MemoryProvider();
    provider.objects.set(
      canonicalBookObjectKey(book.sha256),
      patternedBytes(BOOK_CHUNK_MANIFEST_MAX_BYTES + 1),
    );

    await expect(transferBook(provider, book)).rejects.toBeInstanceOf(
      BookObjectIntegrityError,
    );
  });

  it("rejects size limits and metadata mismatches before attempting upload", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE + 5);
    const book = {
      ...bookFor(bytes, "book-size-mismatch"),
      size: bytes.length + 1,
    };
    const provider = new MemoryProvider();

    await expect(uploadBookObject(provider, book, bytes)).rejects.toThrow(
      "书籍大小与元数据不一致",
    );
    const oversized = {
      ...bookFor(bytes, "book-too-large"),
      size: BOOK_CHUNK_SIZE * BOOK_CHUNK_MAX_COUNT + 1,
    };
    await expect(uploadBookObject(provider, oversized, bytes)).rejects.toThrow(
      "书籍大小超过同步上限",
    );
    expect(provider.writes).toEqual([]);
  });

  it("aborts after the first uploaded chunk and leaves it for retry", async () => {
    const bytes = patternedBytes(BOOK_CHUNK_SIZE + 3);
    const book = bookFor(bytes, "book-abort");
    const provider = new MemoryProvider();
    const controller = new AbortController();
    let partWrites = 0;
    const cancelled = new DOMException("transfer cancelled", "AbortError");
    provider.afterWrite = (key) => {
      if (key.startsWith(bookPartsPrefix(book.sha256)) && ++partWrites === 1)
        controller.abort(cancelled);
    };

    await expect(
      uploadBookObject(provider, book, bytes, controller.signal),
    ).rejects.toBe(cancelled);
    expect(provider.objects.size).toBe(1);
    expect(provider.objects.has(canonicalBookObjectKey(book.sha256))).toBe(
      false,
    );
  });
});
