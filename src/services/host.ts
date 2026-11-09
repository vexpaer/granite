import { isTauri, invoke } from "@tauri-apps/api/core";
import type { LibraryRoot } from "../types";

export const nativeHost = isTauri();
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
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
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
    case "book.write": {
      const key = `${(args.root as LibraryRoot).id}/${args.relativePath}`;
      const old = await localGet(key);
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
