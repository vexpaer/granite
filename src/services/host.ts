import { isTauri, invoke } from "@tauri-apps/api/core";
import type { LibraryRoot } from "../types";

export const nativeHost = isTauri();
const MAX_BROWSER_BOOK_RANGE_BYTES = 4 * 1024 * 1024;
let dbPromise: Promise<IDBDatabase> | undefined;
function db() {
  return (dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open("granite-local-preview", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
export async function localGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function localPut(key: string, value: unknown) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction("kv", "readwrite");
    t.objectStore("kv").put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function localDelete(key: string) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction("kv", "readwrite");
    t.objectStore("kv").delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function sha256(bytes: Uint8Array) {
  const buffer =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  const hash = await crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}

export async function readNativeBook(root: LibraryRoot, relativePath: string): Promise<Uint8Array> {
  const { size } = await hostCall<{ size: number }>('book.stat', { root, relativePath });
  if (!Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024)
    throw new Error('此操作最多读取 512 MiB；大型 PDF 可直接使用分块阅读。');
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 4 * 1024 * 1024) {
    const length = Math.min(4 * 1024 * 1024, size - offset);
    const part = await hostCall<number[]>('book.readRange', { root, relativePath, offset, length });
    if (!Array.isArray(part) || part.length !== length)
      throw new Error('读取时文件长度发生变化，已停止载入，请重新打开。');
    bytes.set(part, offset);
  }
  return bytes;
}
export function download(
  filename: string,
  bytes: Uint8Array,
  type = "application/octet-stream",
) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export async function hostCall<T = unknown>(
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (nativeHost) return invoke<T>("host_call", { request: { op, args } });
  switch (op) {
    case "state.load":
      return ((await localGet("state")) || null) as T;
    case "state.save":
      await localPut("state", JSON.parse(JSON.stringify(args.state)));
      return true as T;
    case "book.import": {
      const root = args.root as LibraryRoot;
      const bytes = new Uint8Array(args.bytes as number[]);
      const relativePath = `books/${crypto.randomUUID()}/${args.filename}`;
      await localPut(`${root.id}/${relativePath}`, bytes);
      return {
        relativePath,
        sha256: await sha256(bytes),
        size: bytes.length,
      } as T;
    }
    case "book.read": {
      const b = await localGet<Uint8Array>(
        `${(args.root as LibraryRoot).id}/${args.relativePath}`,
      );
      if (!b) throw new Error("书籍文件不存在，请重新关联文件。");
      return Array.from(b) as T;
    }
    case "book.stat": {
      const b = await localGet<Uint8Array>(
        `${(args.root as LibraryRoot).id}/${args.relativePath}`,
      );
      if (!b) throw new Error("书籍文件不存在，请重新关联文件。");
      return { size: b.byteLength } as T;
    }
    case "book.readRange": {
      const b = await localGet<Uint8Array>(
        `${(args.root as LibraryRoot).id}/${args.relativePath}`,
      );
      if (!b) throw new Error("书籍文件不存在，请重新关联文件。");
      const offset = Number(args.offset);
      const length = Number(args.length);
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length <= 0 ||
        length > MAX_BROWSER_BOOK_RANGE_BYTES ||
        offset > b.byteLength ||
        length > b.byteLength - offset
      ) {
        throw new Error("书籍分块范围无效。");
      }
      return Array.from(b.subarray(offset, offset + length)) as T;
    }
    case "book.write": {
      const key = `${(args.root as LibraryRoot).id}/${args.relativePath}`;
      const old = await localGet<Uint8Array>(key);
      const expectedSha256 = args.expectedSha256;
      if (
        old &&
        typeof expectedSha256 === "string" &&
        expectedSha256 &&
        (await sha256(old)) !== expectedSha256
      ) {
        throw new Error("PDF文件已被外部修改，请重新载入后重试");
      }
      if (old) await localPut(`${key}.backup`, old);
      const bytes = new Uint8Array(args.bytes as number[]);
      await localPut(key, bytes);
      return { sha256: await sha256(bytes), size: bytes.length } as T;
    }
    case "book.trash": {
      const key = `${(args.root as LibraryRoot).id}/${args.relativePath}`;
      const old = await localGet(key);
      if (old) {
        await localPut(
          `${(args.root as LibraryRoot).id}/.granite/trash/${args.bookId}`,
          old,
        );
        await localDelete(key);
      }
      return { trashed: true } as T;
    }
    case "book.export":
    case "backup.export":
      download(String(args.filename), new Uint8Array(args.bytes as number[]));
      return true as T;
    case "diagnostics":
      return {
        platform: "browser preview",
        native: false,
        note: "原生目录、安全凭证和云同步需在 Windows/Android 应用中使用。",
        userAgent: navigator.userAgent,
      } as T;
    case "root.validate":
      return { ...(args.root as object), permission: "granted" } as T;
    default:
      throw new Error("此功能需要在 Granite 原生应用中使用。");
  }
}
