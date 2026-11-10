import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';

vi.mock('pdfjs-dist', async () => import('pdfjs-dist/legacy/build/pdf.mjs'));

import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
} from 'pdfjs-dist';
import type { LibraryRoot } from '../types';
import {
  NATIVE_PDF_INITIAL_CHUNK_BYTES,
  NATIVE_PDF_MAX_RANGE_BYTES,
  NativePdfDataRangeTransport,
  openNativePdfRange,
  type BookRangeRequest,
  type BookStatRequest,
  type NativeBookRangeHost,
} from './native-range';

const root: LibraryRoot = {
  id: 'root-1',
  displayName: 'Library',
  path: 'E:\\Library',
  kind: 'filesystem',
  permission: 'granted',
  enabled: true,
  isDefault: true,
  readonly: false,
  scanState: 'idle',
};

class FakeRangeHost implements NativeBookRangeHost {
  readonly statRequests: BookStatRequest[] = [];
  readonly rangeRequests: BookRangeRequest[] = [];
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  async stat(request: BookStatRequest) {
    this.statRequests.push(request);
    return { size: this.#bytes.byteLength, sha256: 'a'.repeat(64) };
  }

  async readRange(request: BookRangeRequest) {
    this.rangeRequests.push(request);
    const end = request.offset + request.length;
    return Array.from(this.#bytes.subarray(request.offset, end));
  }
}

function fixtureBytes(size = NATIVE_PDF_INITIAL_CHUNK_BYTES * 2 + 17): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  for (let index = 9; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('native PDF range transport', () => {
  it('stats once and reads the initial 64 KiB bounded chunk', async () => {
    const bytes = fixtureBytes();
    const host = new FakeRangeHost(bytes);

    const range = await openNativePdfRange(root, 'books/large.pdf', { host });

    expect(host.statRequests).toEqual([{ root, relativePath: 'books/large.pdf' }]);
    expect(host.rangeRequests).toEqual([{
      root,
      relativePath: 'books/large.pdf',
      offset: 0,
      length: NATIVE_PDF_INITIAL_CHUNK_BYTES,
    }]);
    expect(range.initialData).toEqual(bytes.slice(0, NATIVE_PDF_INITIAL_CHUNK_BYTES));
    expect(range.stat.size).toBe(bytes.byteLength);
    range.transport.dispose();
  });

  it('serves PDF.js requests with exact bounded ranges', async () => {
    const bytes = fixtureBytes();
    const host = new FakeRangeHost(bytes);
    const range = await openNativePdfRange(root, 'books/large.pdf', { host });
    const chunks: Array<{ begin?: number; bytes: Uint8Array }> = [];
    range.transport.transportReady((event: {
      type: string;
      begin?: number;
      chunk: Uint8Array;
    }) => {
      if (event.type === 'range') {
        chunks.push({ begin: event.begin, bytes: event.chunk });
      }
    });
    host.rangeRequests.length = 0;

    range.transport.requestDataRange(
      NATIVE_PDF_INITIAL_CHUNK_BYTES,
      NATIVE_PDF_INITIAL_CHUNK_BYTES * 2,
    );
    await vi.waitFor(() => expect(chunks).toHaveLength(1));

    expect(host.rangeRequests).toEqual([{
      root,
      relativePath: 'books/large.pdf',
      offset: NATIVE_PDF_INITIAL_CHUNK_BYTES,
      length: NATIVE_PDF_INITIAL_CHUNK_BYTES,
    }]);
    expect(chunks[0].begin).toBe(NATIVE_PDF_INITIAL_CHUNK_BYTES);
    expect(chunks[0].bytes.byteLength).toBe(NATIVE_PDF_INITIAL_CHUNK_BYTES);
    range.transport.dispose();
  });

  it('rejects oversized ranges without calling the host', async () => {
    const bytes = fixtureBytes(NATIVE_PDF_MAX_RANGE_BYTES + 1);
    const host = new FakeRangeHost(bytes);
    const range = await openNativePdfRange(root, 'books/large.pdf', { host });
    const onError = vi.fn();
    range.transport.onError = onError;
    host.rangeRequests.length = 0;

    range.transport.requestDataRange(0, NATIVE_PDF_MAX_RANGE_BYTES + 1);

    expect(onError).toHaveBeenCalledOnce();
    expect(host.rangeRequests).toHaveLength(0);
    range.transport.dispose();
  });

  it('suppresses in-flight and later requests after disposal', async () => {
    const bytes = fixtureBytes();
    const host = new FakeRangeHost(bytes);
    const range = await openNativePdfRange(root, 'books/large.pdf', { host });
    const onData = vi.fn();
    range.transport.transportReady(onData);
    host.rangeRequests.length = 0;
    let resolveRead!: (value: number[]) => void;
    const pending = new Promise<number[]>((resolve) => {
      resolveRead = resolve;
    });
    const readRange = vi.spyOn(host, 'readRange').mockImplementationOnce((request) => {
      host.rangeRequests.push(request);
      return pending;
    });

    range.transport.requestDataRange(1024, 2048);
    await vi.waitFor(() => expect(readRange).toHaveBeenCalledOnce());
    range.transport.abort();
    resolveRead(Array.from(bytes.subarray(1024, 2048)));
    await Promise.resolve();
    range.transport.requestDataRange(2048, 3072);

    expect(onData).not.toHaveBeenCalled();
    expect(readRange).toHaveBeenCalledOnce();
    expect(range.transport.disposed).toBe(true);
  });

  it('drives real PDF.js range requests through the fake host', async () => {
    const bytes = await largePdfBytes();
    const host = new FakeRangeHost(bytes);
    const range = await openNativePdfRange(root, 'books/large.pdf', { host });
    host.rangeRequests.length = 0;
    GlobalWorkerOptions.workerSrc = new URL(
      '../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).href;
    let task: PDFDocumentLoadingTask | undefined;

    try {
      task = getDocument({
        range: range.transport,
        rangeChunkSize: 8192,
        disableStream: true,
        disableAutoFetch: true,
        useSystemFonts: false,
      });
      const document = await task.promise;
      expect(document.numPages).toBe(48);
      expect(host.rangeRequests.length).toBeGreaterThan(0);
      expect(
        host.rangeRequests.every(
          (request) => request.length > 0 && request.length <= NATIVE_PDF_MAX_RANGE_BYTES,
        ),
      ).toBe(true);
    } finally {
      await task?.destroy();
      range.transport.dispose();
    }
  });
});

async function largePdfBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 48; pageNumber += 1) {
    const page = document.addPage([612, 792]);
    for (let line = 0; line < 36; line += 1) {
      page.drawText(
        `Native streaming fixture page ${pageNumber}, line ${line}: ${'abcdefghijklmnopqrstuvwxyz'.repeat(4)}`,
        { x: 36, y: 750 - line * 19, size: 9, font },
      );
    }
  }
  const bytes = await document.save({ useObjectStreams: false });
  expect(bytes.byteLength).toBeGreaterThan(NATIVE_PDF_INITIAL_CHUNK_BYTES);
  return bytes;
}
