import { describe, expect, it, vi } from 'vitest';
import type { LibraryRoot } from '../src/types';
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: native.invoke }));
import { readNativeBook } from '../src/services/host';
const root = { id: 'root', path: 'E:/TestLibrary' } as LibraryRoot;

describe('bounded native book reads', () => {
  it('reads a large book through bounded ranges instead of a whole-file IPC message', async () => {
    const size = 5 * 1024 * 1024;
    const ranges: { offset: number; length: number }[] = [];
    native.invoke.mockImplementation(async (_command, { request }) => {
      if (request.op === 'book.stat') return { size };
      if (request.op !== 'book.readRange') throw new Error('whole-file reads are forbidden in this test');
      ranges.push(request.args);
      return Array.from({ length: request.args.length }, () => ranges.length);
    });
    const bytes = await readNativeBook(root, 'books/test.txt');
    expect(bytes.length).toBe(size);
    expect(ranges.map(({ offset, length }) => ({ offset, length }))).toEqual([
      { offset: 0, length: 4 * 1024 * 1024 },
      { offset: 4 * 1024 * 1024, length: 1024 * 1024 },
    ]);
    expect(bytes[0]).toBe(1);
    expect(bytes.at(-1)).toBe(2);
  });
  it('stops on a truncated range and refuses an oversized full-buffer parse', async () => {
    native.invoke.mockImplementation(async (_command, { request }) => request.op === 'book.stat' ? { size: 12 } : [1]);
    await expect(readNativeBook(root, 'books/test.txt')).rejects.toThrow('长度发生变化');
    native.invoke.mockResolvedValue({ size: 513 * 1024 * 1024 });
    await expect(readNativeBook(root, 'books/test.txt')).rejects.toThrow('512 MiB');
  });
});
