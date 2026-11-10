import { PDFDataRangeTransport } from 'pdfjs-dist';
import { hostCall } from '../services/host';
import type { LibraryRoot } from '../types';

export const NATIVE_PDF_INITIAL_CHUNK_BYTES = 64 * 1024;
export const NATIVE_PDF_MAX_RANGE_BYTES = 4 * 1024 * 1024;

export interface BookStreamStat {
  size: number;
  sha256?: string;
}

export interface BookStatRequest {
  root: LibraryRoot;
  relativePath: string;
}

export interface BookRangeRequest extends BookStatRequest {
  offset: number;
  length: number;
}

export interface NativeBookRangeHost {
  stat(request: BookStatRequest): Promise<BookStreamStat>;
  readRange(request: BookRangeRequest): Promise<number[] | Uint8Array>;
}

export interface OpenNativePdfRangeOptions {
  host?: NativeBookRangeHost;
  onError?: (error: Error) => void;
}

export interface OpenNativePdfRange {
  transport: NativePdfDataRangeTransport;
  initialData: Uint8Array;
  stat: BookStreamStat;
}

export const nativeBookRangeHost: NativeBookRangeHost = {
  stat: ({ root, relativePath }) =>
    hostCall<BookStreamStat>('book.stat', { root, relativePath }),
  readRange: ({ root, relativePath, offset, length }) =>
    hostCall<number[]>('book.readRange', {
      root,
      relativePath,
      offset,
      length,
    }),
};

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function invalidRange(message: string): Error {
  return new Error(`PDF 分块读取范围无效：${message}`);
}

function validateStat(stat: BookStreamStat): BookStreamStat {
  if (
    !stat ||
    !Number.isSafeInteger(stat.size) ||
    stat.size <= 0 ||
    (stat.sha256 !== undefined && typeof stat.sha256 !== 'string')
  ) {
    throw new Error('原生层返回的 PDF 文件信息无效。');
  }
  return stat;
}

function validateRange(offset: number, length: number, total: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw invalidRange('offset 必须是非负安全整数');
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw invalidRange('length 必须是正安全整数');
  }
  if (length > NATIVE_PDF_MAX_RANGE_BYTES) {
    throw invalidRange(`单次读取不能超过 ${NATIVE_PDF_MAX_RANGE_BYTES} 字节`);
  }
  if (offset > total || length > total - offset) {
    throw invalidRange(`范围 ${offset}..${offset + length} 超出文件长度 ${total}`);
  }
}

function toBytes(value: number[] | Uint8Array, expectedLength: number): Uint8Array {
  const source = value instanceof Uint8Array ? value : Array.from(value);
  if (
    !(value instanceof Uint8Array) &&
    (!Array.isArray(value) || source.length !== expectedLength)
  ) {
    throw new Error(
      `原生层返回了 ${source.length} 字节，PDF 请求需要 ${expectedLength} 字节。`,
    );
  }
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(source);
  if (bytes.byteLength !== expectedLength) {
    throw new Error(
      `原生层返回了 ${bytes.byteLength} 字节，PDF 请求需要 ${expectedLength} 字节。`,
    );
  }
  return bytes;
}

export class NativePdfDataRangeTransport extends PDFDataRangeTransport {
  onError?: (error: Error) => void;

  readonly #host: NativeBookRangeHost;
  readonly #root: LibraryRoot;
  readonly #relativePath: string;
  #disposed = false;
  #generation = 0;

  constructor(
    length: number,
    initialData: Uint8Array,
    root: LibraryRoot,
    relativePath: string,
    host: NativeBookRangeHost = nativeBookRangeHost,
  ) {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw invalidRange('文件总长度无效');
    }
    if (initialData.byteLength > length || initialData.byteLength > NATIVE_PDF_INITIAL_CHUNK_BYTES) {
      throw invalidRange('初始分块大小无效');
    }
    super(length, initialData);
    this.#root = root;
    this.#relativePath = relativePath;
    this.#host = host;
  }

  requestDataRange(begin: number, end: number): void {
    if (this.#disposed) return;
    try {
      validateRange(begin, end - begin, this.length);
    } catch (cause) {
      this.#report(cause);
      return;
    }

    const generation = this.#generation;
    void this.#readRange(begin, end - begin, generation);
  }

  abort(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    super.abort();
  }

  dispose(): void {
    this.abort();
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async #readRange(begin: number, length: number, generation: number): Promise<void> {
    try {
      const response = await this.#host.readRange({
        root: this.#root,
        relativePath: this.#relativePath,
        offset: begin,
        length,
      });
      if (this.#disposed || generation !== this.#generation) return;
      this.onDataRange(begin, toBytes(response, length));
    } catch (cause) {
      if (this.#disposed || generation !== this.#generation) return;
      this.#report(cause);
    }
  }

  #report(cause: unknown): void {
    this.onError?.(asError(cause));
  }
}

export async function openNativePdfRange(
  root: LibraryRoot,
  relativePath: string,
  options: OpenNativePdfRangeOptions = {},
): Promise<OpenNativePdfRange> {
  const host = options.host || nativeBookRangeHost;
  const stat = validateStat(await host.stat({ root, relativePath }));
  const initialLength = Math.min(stat.size, NATIVE_PDF_INITIAL_CHUNK_BYTES);
  const initialData = toBytes(
    await host.readRange({ root, relativePath, offset: 0, length: initialLength }),
    initialLength,
  );
  const transport = new NativePdfDataRangeTransport(
    stat.size,
    initialData,
    root,
    relativePath,
    host,
  );
  transport.onError = options.onError;
  return { transport, initialData, stat };
}
