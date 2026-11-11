import { reactive } from "vue";
import JSZip from "jszip";
import type {
  AppData,
  AppSettings,
  Book,
  Note,
  Annotation,
  ReaderLocation,
  LibraryRoot,
  Tag,
  InstalledPlugin,
  ImportResult,
  ReadingSession,
} from "../types";
import { hostCall, nativeHost, readNativeBook, sha256 } from "../services/host";
import { extractMetadata } from "../services/metadata";
import { appEvents } from "../services/events";
import { initializePlatform, updatePlatform } from "../services/platform";
import {
  addNotebookAttachmentsToZip,
  notebookBackupDirectory,
  notebookBackupMarkdownPath,
  notebookExportBaseName,
  notebookExportMarkdownFileName,
} from "../services/notebook-files";
import { validateShortcuts } from "../services/shortcuts";
import { exportProviderConfiguration, parseProviderConfiguration } from "../services/provider-backup";

export const defaultSettings = (): AppSettings => ({
  username: "读者",
  theme: "light",
  density: "comfortable",
  language: "zh-CN",
  dailyGoal: 30,
  idleMinutes: 5,
  reader: {
    fontFamily: "serif",
    fontSize: 20,
    lineHeight: 1.9,
    paragraphSpacing: 16,
    margin: 32,
    width: 760,
    theme: "paper",
    mode: "scroll",
    encoding: "auto",
    keepAwake: false,
    wheelThreshold: 100,
  },
  syncPolicy: "metadata",
  syncBookIds: [],
  syncCollectionIds: [],
  profile: "Minimal",
  sidebarExpanded: true,
  shortcuts: {
    search: "Control+k",
    next: "ArrowRight",
    previous: "ArrowLeft",
    fullscreen: "f",
    bookmark: "b",
  },
  layout: {},
});
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const CLEANUP_NAMESPACE = "granite.local-cleanup";
const MANAGED_BOOK_PATH =
  /^books\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/\\]+\.(?:epub|pdf|txt|mobi)$/i;
type CleanupQueueItem = {
  bookId: string;
  root: LibraryRoot;
  relativePath: string;
  sha256?: string;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSafeBookId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== "." &&
    value !== ".." &&
    !/[/\\\0]/.test(value)
  );
}
function restorablePluginData(value: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (!isRecord(value)) return data;
  for (const [key, entry] of Object.entries(value)) {
    if (
      key.startsWith("granite.local-") ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      continue;
    data[key] = clone(entry);
  }
  return data;
}
function mergeKnownSettings<T extends object>(defaults: T, source: unknown): T {
  const merged = clone(defaults) as Record<string, unknown>;
  if (isRecord(source))
    for (const key of Object.keys(defaults))
      if (source[key] !== undefined) merged[key] = clone(source[key]);
  return merged as T;
}
function restorableSettings(
  incoming: unknown,
  provider: AppSettings["provider"],
): AppSettings {
  const source = isRecord(incoming) ? incoming : {};
  const defaults = defaultSettings();
  const settings = mergeKnownSettings(defaults, source);
  settings.reader = mergeKnownSettings(defaults.reader, source.reader);
  if (typeof source.background === "string")
    settings.background = source.background;
  settings.provider = provider ? clone(provider) : undefined;
  return settings;
}
function cleanupQueue(value: unknown): CleanupQueueItem[] {
  if (!Array.isArray(value)) return [];
  const queue: CleanupQueueItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.root)) continue;
    const { bookId, relativePath } = item;
    const root = item.root;
    if (
      !isSafeBookId(bookId) ||
      typeof relativePath !== "string" ||
      !MANAGED_BOOK_PATH.test(relativePath) ||
      typeof root.id !== "string" ||
      typeof root.path !== "string" ||
      !["filesystem", "saf", "browser"].includes(String(root.kind))
    )
      continue;
    queue.push({
      bookId,
      root: clone(root) as unknown as LibraryRoot,
      relativePath,
      ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
    });
  }
  return queue;
}
function restorableDeviceRecords<T extends { id: string; deviceId: string }>(
  value: unknown,
  deviceId: string,
): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item.id === "string"
      ? [{ ...(clone(item) as T), deviceId }]
      : [],
  );
}
function sameRootIdentity(left: LibraryRoot, right: LibraryRoot): boolean {
  return (
    left.id === right.id &&
    left.path === right.path &&
    left.kind === right.kind
  );
}
function emptyData(): AppData {
  return {
    schemaVersion: 1,
    deviceId: uid(),
    revision: 0,
    books: [],
    notes: [],
    tags: [],
    collections: [],
    roots: [],
    sessions: [],
    annotations: [],
    settings: defaultSettings(),
    plugins: [],
    tombstones: [],
    syncHistory: [],
    conflicts: [],
    pluginData: {},
  };
}
const dataKeys = Object.keys(emptyData()) as (keyof AppData)[];
class GraniteApp implements AppData {
  schemaVersion = 1;
  deviceId = uid();
  revision = 0;
  books: Book[] = [];
  notes: Note[] = [];
  tags: Tag[] = [];
  collections: AppData["collections"] = [];
  roots: LibraryRoot[] = [];
  sessions: ReadingSession[] = [];
  annotations: Annotation[] = [];
  settings = defaultSettings();
  plugins: InstalledPlugin[] = [];
  tombstones: AppData["tombstones"] = [];
  syncHistory: AppData["syncHistory"] = [];
  conflicts: AppData["conflicts"] = [];
  pluginData: Record<string, unknown> = {};
  ready = false;
  busy = false;
  error = "";
  toast = "";
  route: { name: string; id?: string } = { name: "home" };
  history: { name: string; id?: string }[] = [];
  search = "";
  shelfFilter = "all";
  readerBookId = "";
  importResults: ImportResult[] = [];
  importProgress = 0;
  syncStatus = "unconfigured";
  syncProgress = 0;
  cancelImport = false;
  saveQueue = Promise.resolve();
  toastTimer: ReturnType<typeof setTimeout> | undefined;
  syncAbort: AbortController | undefined;
  stagedPluginSources = new WeakMap<File, string>();
  activeSession: ReadingSession | undefined;
  sessionTick = 0;
  lastActivity = 0;
  sessionInterval: ReturnType<typeof setInterval> | undefined;
  get currentBook() {
    return this.books.find(
      (b) => b.id === (this.readerBookId || this.route.id),
    );
  }
  get native() {
    return nativeHost;
  }
  get defaultRoot() {
    return (
      this.roots.find((r) => r.isDefault && r.enabled) ||
      this.roots.find((r) => r.enabled)
    );
  }
  snapshot(): AppData {
    return Object.fromEntries(
      dataKeys.map((k) => [k, clone(this[k])]),
    ) as unknown as AppData;
  }
  async init() {
    if (this.ready) return;
    try {
      const saved = await hostCall<Partial<AppData> | null>("state.load");
      if (saved) {
        if ((saved.schemaVersion || 1) > 1)
          throw new Error(
            "数据版本高于当前应用，已保留原始数据，请升级 Granite。",
          );
        for (const k of dataKeys)
          if (saved[k] !== undefined)
            (this as unknown as Record<string, unknown>)[k] = saved[k];
        this.settings = {
          ...defaultSettings(),
          ...saved.settings,
          reader: { ...defaultSettings().reader, ...saved.settings?.reader },
        };
      }
      if (!this.roots.length) {
        if (nativeHost) {
          try {
            const root = await hostCall<LibraryRoot>("root.default");
            if (root) this.roots.push(root);
          } catch {
            /* native state.load may create its own default */
          }
        } else
          this.roots.push({
            id: "browser-preview",
            displayName: "浏览器本地书库",
            path: "IndexedDB（浏览器预览）",
            kind: "browser",
            permission: "granted",
            enabled: true,
            isDefault: true,
            readonly: false,
            scanState: "idle",
          });
      }
      await this.flushCleanup();
      this.syncStatus = this.settings.provider ? "idle" : "unconfigured";
      try {
        const nav = JSON.parse(
          sessionStorage.getItem("granite-navigation") || "null",
        );
        if (nav?.route && typeof nav.route.name === "string") {
          this.route = nav.route;
          this.history = nav.history || [];
          this.search = nav.search || "";
          this.shelfFilter = nav.shelfFilter || "all";
          if (this.route.name === "reader") {
            const book = this.books.find((b) => b.id === this.route.id);
            if (book) {
              this.readerBookId = book.id;
              this.beginSession(book.id);
            } else this.route = { name: "home" };
          }
        }
      } catch {
        /* invalid transient navigation */
      }
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.pauseSession("background");
        else this.sessionTick = performance.now();
      });
      window.addEventListener("pagehide", () => {
        this.pauseSession("shutdown");
        void this.persist();
      });
      for (const event of ["pointerdown", "keydown", "wheel", "touchstart"])
        window.addEventListener(event, () => this.activity(), {
          passive: true,
        });
      this.sessionInterval = setInterval(() => this.flushSession(), 15000);
      if (nativeHost) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        await win.onDragDropEvent((event) => {
          if (event.payload.type === "drop")
            void this.importNativePaths(event.payload.paths);
        });
      }
      await this.persist();
      appEvents.emit("app.started", { deviceId: this.deviceId });
      void initializePlatform(this).catch((e) =>
        this.notify(`系统能力初始化失败：${String(e)}`),
      );
      void import("../services/plugin-manager")
        .then(async (manager) => {
          const results = await manager.initializeInstalledPlugins(
            clone(this.plugins),
            this.pluginHooks(),
            {
              safeMode: this.settings.layout.safeMode === true,
              hostPlatform: /Android/i.test(navigator.userAgent)
                ? "android"
                : "windows",
            },
          );
          for (const result of results) {
            const plugin = this.plugins.find((p) => p.id === result.id);
            if (plugin && result.status === "failed") {
              plugin.error = result.error;
              plugin.enabled = false;
            }
          }
        })
        .catch((e) =>
          this.notify(`插件恢复失败，本地书库仍可使用：${String(e)}`),
        );
    } catch (e) {
      this.fail(e);
    } finally {
      this.ready = true;
    }
  }
  notify(message: string) {
    this.toast = message;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = ""), 4200);
  }
  fail(e: unknown) {
    this.error = e instanceof Error ? e.message : String(e);
    this.notify(this.error);
  }
  async persist() {
    this.revision++;
    const snapshot = this.snapshot();
    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(() => hostCall("state.save", { state: snapshot }))
      .then(() => {});
    try {
      await this.saveQueue;
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }
  navigate(name: string, id?: string) {
    if (this.route.name === name && this.route.id === id) return;
    const previous = this.route.name;
    this.history.push({ ...this.route });
    this.route = { name, id };
    this.routeChanged(previous);
    this.rememberNavigation();
  }
  back() {
    const previous = this.route.name;
    this.route = this.history.pop() || { name: "home" };
    this.routeChanged(previous);
    this.rememberNavigation();
  }
  routeChanged(previous: string) {
    if (this.route.name === "bookshelf" && this.route.id &&
      ["all", "reading", "unread", "finished", "favorite"].includes(this.route.id))
      this.shelfFilter = this.route.id;
    if (previous === "reader" && this.route.name !== "reader") {
      this.endSession();
      appEvents.emit("reader.book-closed", { bookId: this.readerBookId });
    }
    if (this.route.name === "reader" && this.route.id) {
      this.readerBookId = this.route.id;
      this.beginSession(this.route.id);
      appEvents.emit("reader.book-opened", { bookId: this.route.id });
    }
    void updatePlatform(this).catch((e) =>
      this.notify(`系统界面更新失败：${String(e)}`),
    );
  }
  rememberNavigation() {
    sessionStorage.setItem(
      "granite-navigation",
      JSON.stringify({
        route: this.route,
        history: this.history,
        search: this.search,
        shelfFilter: this.shelfFilter,
      }),
    );
  }
  openReader(bookId: string, location?: ReaderLocation) {
    const b = this.books.find((b) => b.id === bookId);
    if (!b) return;
    if (location) b.location = location;
    this.readerBookId = bookId;
    this.navigate("reader", bookId);
    this.beginSession(bookId);
  }
  private async importOneInput(
    file: { name: string; bytes: Uint8Array },
    root: LibraryRoot,
  ): Promise<ImportResult> {
    const hash = await sha256(file.bytes);
    const duplicate = this.books.find((book) => book.sha256 === hash);
    if (duplicate) {
      return {
        filename: file.name,
        status: "duplicate",
        bookId: duplicate.id,
        message: "内容相同，已保留现有书籍和阅读记录。",
      };
    }

    const meta = await extractMetadata(file.name, file.bytes);
    const saved = await hostCall<{
      relativePath: string;
      sha256: string;
      size: number;
    }>("book.import", {
      rootId: root.id,
      root: clone(root),
      filename: file.name,
      bytes: Array.from(file.bytes),
    });
    const at = now();
    const book: Book = {
      id: uid(),
      title: file.name,
      authors: [],
      format: "txt",
      ...meta,
      ...saved,
      rootId: root.id,
      managed: true,
      available: true,
      status: "unread",
      favorite: false,
      tagIds: [],
      collectionIds: [],
      createdAt: at,
      updatedAt: at,
      cloudState: "local",
    };
    this.books.push(book);
    await this.persist();
    return { filename: file.name, status: "success", bookId: book.id };
  }

  private async processImportBatch(
    count: number,
    filenameAt: (index: number) => string,
    readAt: (index: number) => Promise<{ name: string; bytes: Uint8Array }>,
    shouldNotify = true,
  ): Promise<ImportResult[]> {
    const root = this.defaultRoot;
    if (!root) throw new Error("请先在设置中添加本地书库文件夹。");
    if (root.readonly || root.permission !== "granted")
      throw new Error("目标书库不可写，请重新授权或更改默认书库。");

    const results: ImportResult[] = [];
    const record = (result: ImportResult) => {
      this.importResults.push(result);
      results.push(result);
    };
    this.busy = true;
    try {
      for (let i = 0; i < count; i++) {
        const filename = filenameAt(i);
        if (this.cancelImport) {
          record({ filename, status: "cancelled" });
          this.importProgress = (i + 1) / Math.max(1, count);
          continue;
        }
        try {
          record(await this.importOneInput(await readAt(i), root));
        } catch (error) {
          record({
            filename,
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          this.importProgress = (i + 1) / Math.max(1, count);
        }
      }
      if (shouldNotify) {
        this.notify(
          `导入完成：${results.filter((result) => result.status === "success").length} 本书籍`,
        );
      }
    } finally {
      this.busy = false;
    }
    return results;
  }

  async importFiles(files?: FileList | File[]) {
    this.cancelImport = false;
    this.importResults = [];
    this.importProgress = 0;
    this.navigate("import");
    try {
      if (files) {
        const selected = Array.from(files);
        if (!selected.length) return;
        await this.processImportBatch(
          selected.length,
          (index) => selected[index]!.name,
          async (index) => {
            const file = selected[index]!;
            return {
              name: file.name,
              bytes: new Uint8Array(await file.arrayBuffer()),
            };
          },
        );
        return;
      }

      if (nativeHost) {
        const picked = await hostCall<
          Array<{ id?: string; name: string; size?: number; bytes?: number[] }>
        >("file.pickBooks");
        if (!picked?.length) return;
        const ids = picked.flatMap((item) => item.id ? [item.id] : []);
        try {
          await this.processImportBatch(
            picked.length,
            (index) => picked[index]!.name,
            async (index) => {
              const item = picked[index]!;
              if (Array.isArray(item.bytes)) {
                return { name: item.name, bytes: new Uint8Array(item.bytes) };
              }
              if (!item.id) throw new Error("原生文件选择器未返回有效文件句柄。");
              const loaded = await hostCall<{ name: string; bytes: number[] }>(
                "file.readPickedBook",
                { id: item.id },
              );
              return { name: loaded.name || item.name, bytes: new Uint8Array(loaded.bytes) };
            },
          );
        } finally {
          if (ids.length) {
            await hostCall("file.releasePickedBooks", { ids }).catch(() => undefined);
          }
        }
        return;
      }

      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".epub,.pdf,.txt,.mobi";
      input.onchange = () => void this.importFiles(input.files || undefined);
      input.click();
    } catch (error) {
      this.fail(error);
    }
  }

  async importNativePaths(paths: string[]) {
    this.cancelImport = false;
    this.navigate("import");
    this.importResults = [];
    this.importProgress = 0;
    try {
      await this.processImportBatch(
        paths.length,
        (index) => paths[index]!.split(/[\\/]/).pop() || paths[index]!,
        async (index) => {
          const picked = await hostCall<{ name: string; bytes: number[] }[]>(
            "file.readPaths",
            { paths: [paths[index]!] },
          );
          const file = picked[0];
          if (!file) throw new Error("未能读取所选书籍文件。");
          return { name: file.name, bytes: new Uint8Array(file.bytes) };
        },
      );
    } catch (error) {
      this.fail(error);
    }
  }

  async importInputs(
    inputs: { name: string; bytes: Uint8Array }[],
    options: { notify?: boolean } = {},
  ): Promise<ImportResult[]> {
    this.cancelImport = false;
    return this.processImportBatch(
      inputs.length,
      (index) => inputs[index]!.name,
      async (index) => inputs[index]!,
      options.notify !== false,
    );
  }
  async saveBook(book: Book) {
    book.updatedAt = now();
    const i = this.books.findIndex((b) => b.id === book.id);
    if (i >= 0) this.books[i] = clone(book);
    else this.books.push(clone(book));
    await this.persist();
    this.notify("书籍信息已保存");
  }
  async deleteBooks(ids: string[]) {
    const removed = this.books.filter((b) => ids.includes(b.id));
    for (const b of removed)
      this.tombstones.push({
        id: uid(),
        entityType: "book",
        entityId: b.id,
        hash: b.sha256,
        at: now(),
        deviceId: this.deviceId,
        revision: this.revision + 1,
      });
    this.books = this.books.filter((b) => !ids.includes(b.id));
    this.annotations = this.annotations.filter((a) => !ids.includes(a.bookId));
    for (const book of removed) this.queueCleanup(book);
    await this.persist();
    await this.flushCleanup();
    this.notify("书籍已移除，云端删除已加入同步队列；外部原始文件保留。");
  }
  queueCleanup(book: Book) {
    if (!book.managed) return;
    const root = this.roots.find((r) => r.id === book.rootId);
    if (!root) return;
    const queue = cleanupQueue(this.pluginData[CLEANUP_NAMESPACE]);
    if (!queue.some((q) => q.bookId === book.id))
      queue.push({
        bookId: book.id,
        root: clone(root),
        relativePath: book.relativePath,
        sha256: book.sha256,
      });
    this.pluginData[CLEANUP_NAMESPACE] = queue;
  }
  async flushCleanup() {
    const rawQueue = this.pluginData[CLEANUP_NAMESPACE];
    if (rawQueue === undefined) return;
    const queue = cleanupQueue(rawQueue);
    const pending: CleanupQueueItem[] = [];
    for (const item of queue) {
      const root = this.roots.find((candidate) => candidate.id === item.root.id);
      if (!root || !sameRootIdentity(root, item.root)) continue;
      const tombstone = this.tombstones.find(
        (candidate) =>
          candidate.entityType === "book" &&
          candidate.entityId === item.bookId,
      );
      if (
        !tombstone ||
        (item.sha256 && tombstone.hash && item.sha256 !== tombstone.hash)
      )
        continue;
      if (
        this.books.some(
          (b) =>
            b.id === item.bookId ||
            (b.rootId === item.root.id &&
              b.relativePath === item.relativePath),
        )
      )
        continue;
      if (
        !root.enabled ||
        root.readonly ||
        root.permission === "denied" ||
        root.permission === "unavailable"
      ) {
        pending.push(item);
        continue;
      }
      try {
        await hostCall("book.trash", {
          bookId: item.bookId,
          root: clone(root),
          relativePath: item.relativePath,
        });
      } catch {
        pending.push(item);
      }
    }
    if (pending.length) this.pluginData[CLEANUP_NAMESPACE] = pending;
    else delete this.pluginData[CLEANUP_NAMESPACE];
    if (JSON.stringify(pending) !== JSON.stringify(rawQueue))
      await this.persist();
  }
  newNote(bookId?: string, quote?: string, location?: ReaderLocation) {
    const at = now();
    const note: Note = {
      id: uid(),
      title: "未命名笔记",
      body: quote ? `> ${quote}\n\n` : "",
      folder: "",
      tagIds: [],
      bookId,
      quote,
      location,
      attachments: [],
      createdAt: at,
      updatedAt: at,
    };
    this.notes.unshift(note);
    void this.persist();
    this.navigate("notebook", note.id);
    return note;
  }
  async saveNote(note: Note) {
    const old = this.notes.find((n) => n.id === note.id);
    if (old && old.title !== note.title) {
      const escaped = old.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, "g");
      for (const n of this.notes)
        n.body = n.body.replace(
          re,
          (_, alias) => `[[${note.title}${alias || ""}]]`,
        );
    }
    note.updatedAt = now();
    const i = this.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) this.notes[i] = clone(note);
    else this.notes.push(clone(note));
    await this.persist();
  }
  async deleteNote(id: string) {
    this.notes = this.notes.filter((n) => n.id !== id);
    this.tombstones.push({
      id: uid(),
      entityType: "note",
      entityId: id,
      at: now(),
      deviceId: this.deviceId,
      revision: this.revision + 1,
    });
    await this.persist();
    this.notify("笔记已删除，可从备份或冲突历史恢复");
  }
  async saveTag(tag: Tag) {
    const existing = this.tags.find(
      (t) =>
        t.name.trim().toLocaleLowerCase() ===
          tag.name.trim().toLocaleLowerCase() && t.id !== tag.id,
    );
    if (existing) throw new Error("同名标签已存在，请使用合并标签。");
    tag.updatedAt = now();
    const i = this.tags.findIndex((t) => t.id === tag.id);
    if (i >= 0) this.tags[i] = clone(tag);
    else this.tags.push(clone(tag));
    await this.persist();
    this.notify("标签已保存");
  }
  async deleteTag(id: string) {
    this.tags = this.tags.filter((t) => t.id !== id);
    for (const o of [...this.books, ...this.notes])
      o.tagIds = o.tagIds.filter((t) => t !== id);
    this.tombstones.push({
      id: uid(),
      entityType: "tag",
      entityId: id,
      at: now(),
      deviceId: this.deviceId,
      revision: this.revision + 1,
    });
    await this.persist();
    this.notify("标签已删除，书籍与笔记保留");
  }
  async saveCollection(collection: { id: string; name: string }) {
    if (!collection.name.trim()) throw new Error("请输入集合名称。");
    const i = this.collections.findIndex((c) => c.id === collection.id);
    if (i >= 0) this.collections[i] = clone(collection);
    else this.collections.push(clone(collection));
    await this.persist();
    this.notify("集合已保存");
  }
  async deleteCollection(id: string) {
    this.collections = this.collections.filter((c) => c.id !== id);
    for (const b of this.books)
      b.collectionIds = b.collectionIds.filter((c) => c !== id);
    this.tombstones.push({
      id: uid(),
      entityType: "collection",
      entityId: id,
      at: now(),
      deviceId: this.deviceId,
      revision: this.revision + 1,
    });
    await this.persist();
    this.notify("集合已删除，书籍保留");
  }
  async revealBook(book: Book) {
    const root = this.roots.find((r) => r.id === book.rootId);
    if (!root) throw new Error("书库已解除关联。");
    try {
      await hostCall("book.locate", {
        root: clone(root),
        relativePath: book.relativePath,
      });
    } catch (e) {
      this.fail(e);
    }
  }
  async relocateBook(id: string, file?: File) {
    const book = this.books.find((b) => b.id === id);
    if (!book) return;
    try {
      let selected: { name: string; bytes: Uint8Array } | undefined;
      if (file)
        selected = {
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      else if (nativeHost) {
        const files =
          await hostCall<{ name: string; bytes: number[] }[]>("file.pickBooks");
        const first = files[0];
        if (first)
          selected = { name: first.name, bytes: new Uint8Array(first.bytes) };
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = `.${book.format}`;
        input.onchange = () => {
          if (input.files?.[0]) void this.relocateBook(id, input.files[0]);
        };
        input.click();
        return;
      }
      if (!selected) return;
      if ((await sha256(selected.bytes)) !== book.sha256)
        throw new Error(
          "文件内容与原书不同，已保留原书记录与标注。请把新版本作为独立书籍导入。",
        );
      const restored = await this.saveDownloaded(book, selected.bytes);
      Object.assign(book, restored);
      await this.persist();
      this.notify("书籍文件已重新关联，阅读位置和标注保留");
    } catch (e) {
      this.fail(e);
    }
  }
  async mergeTags(source: string, target: string) {
    if (source === target) return;
    if (!this.tags.find((t) => t.id === target))
      throw new Error("目标标签不存在。");
    for (const o of [...this.books, ...this.notes])
      o.tagIds = [...new Set(o.tagIds.map((t) => (t === source ? target : t)))];
    await this.deleteTag(source);
    this.notify("标签及所有关联已合并");
  }
  async saveSettings() {
    if (
      this.settings.dailyGoal < 1 ||
      this.settings.idleMinutes < 1 ||
      this.settings.reader.fontSize < 10
    )
      throw new Error("目标、空闲阈值或字号无效。");
    validateShortcuts(this.settings.shortcuts);
    await this.persist();
    this.notify("设置已保存");
  }
  async saveProfile(name: string) {
    const key = name.trim();
    if (!key) throw new Error("请输入配置名称。");
    const profiles = (this.pluginData["granite.profiles"] ||= {}) as Record<
      string,
      unknown
    >;
    const settings = clone(this.settings);
    settings.provider = undefined;
    profiles[key] = {
      settings,
      plugins: this.plugins.map((p) => ({
        id: p.id,
        version: p.version,
        enabled: p.enabled,
        permissions: p.permissions,
      })),
    };
    await this.persist();
    this.notify(`配置 ${key} 已保存`);
  }
  async applyProfile(name: string) {
    const profiles = this.pluginData["granite.profiles"] as
      | Record<
          string,
          {
            settings: AppSettings;
            plugins: {
              id: string;
              version: string;
              enabled: boolean;
              permissions: string[];
            }[];
          }
        >
      | undefined;
    const saved = profiles?.[name];
    const provider = this.settings.provider;
    if (saved) {
      this.settings = { ...clone(saved.settings), provider, profile: name };
      for (const plugin of this.plugins) {
        const desired = saved.plugins.find((p) => p.id === plugin.id);
        if (
          desired?.version === plugin.version &&
          desired.permissions.every((p) => plugin.permissions.includes(p))
        )
          await this.setPluginEnabled(plugin.id, desired.enabled);
        else if (plugin.enabled) await this.setPluginEnabled(plugin.id, false);
      }
    } else {
      const layouts: Record<string, string[]> = {
        Minimal: ["continue", "recent", "notes", "statistics", "goal", "tags"],
        Research: ["continue", "notes", "recent", "tags", "statistics", "goal"],
        Knowledge: [
          "notes",
          "tags",
          "continue",
          "recent",
          "statistics",
          "goal",
        ],
        Dashboard: [
          "statistics",
          "goal",
          "continue",
          "recent",
          "notes",
          "tags",
        ],
        Custom: ["continue", "recent", "notes", "statistics", "goal", "tags"],
      };
      this.settings = {
        ...this.settings,
        profile: name,
        layout: {
          ...this.settings.layout,
          homeOrder: layouts[name] || layouts.Custom,
          homeHidden: [],
        },
        reader: {
          ...this.settings.reader,
          width: name === "Research" ? 960 : 760,
        },
      };
    }
    await this.persist();
    this.notify(`已应用 ${name} 配置`);
  }
  async addRoot() {
    try {
      const root = await hostCall<LibraryRoot | null>("root.pick");
      if (!root) return;
      if (this.roots.some((r) => r.path === root.path)) {
        this.notify("此文件夹已关联");
        return;
      }
      if (!this.roots.length) root.isDefault = true;
      this.roots.push(root);
      await this.persist();
      this.notify("已关联文件夹，原文件保持原位");
      await this.rescanRoot(root.id);
    } catch (e) {
      this.fail(e);
    }
  }
  async updateRoot(root: LibraryRoot) {
    if (root.isDefault)
      for (const r of this.roots) r.isDefault = r.id === root.id;
    const i = this.roots.findIndex((r) => r.id === root.id);
    if (i >= 0) this.roots[i] = clone(root);
    await this.persist();
    this.notify("书库文件夹设置已保存");
  }
  async removeRoot(id: string) {
    this.roots = this.roots.filter((r) => r.id !== id);
    for (const b of this.books) if (b.rootId === id) b.available = false;
    if (this.pluginData[CLEANUP_NAMESPACE] !== undefined) {
      const pending = cleanupQueue(
        this.pluginData[CLEANUP_NAMESPACE],
      ).filter((item) => item.root.id !== id);
      if (pending.length) this.pluginData[CLEANUP_NAMESPACE] = pending;
      else delete this.pluginData[CLEANUP_NAMESPACE];
    }
    if (!this.roots.some((r) => r.isDefault) && this.roots[0])
      this.roots[0].isDefault = true;
    await this.persist();
    this.notify("已解除本机文件夹关联；磁盘文件和云端记录保留。");
  }
  async rescanRoot(id: string) {
    const root = this.roots.find((r) => r.id === id);
    if (!root) return;
    root.scanState = "scanning";
    try {
      const validated = await hostCall<LibraryRoot>("root.validate", {
        root: clone(root),
      });
      Object.assign(root, validated);
      if (root.permission !== "granted" && root.permission !== "readonly")
        throw new Error("书库不可访问，请重新授权。");
      const files = await hostCall<
        {
          name: string;
          relativePath: string;
          size: number;
          format: Book["format"];
        }[]
      >("root.scan", { root: clone(root) });
      for (const f of files) {
        if (
          this.books.some(
            (b) => b.rootId === id && b.relativePath === f.relativePath,
          )
        )
          continue;
        try {
          const bytes = new Uint8Array(
            await hostCall<number[]>("book.read", {
              root: clone(root),
              relativePath: f.relativePath,
            }),
          );
          const hash = await sha256(bytes);
          const meta = await extractMetadata(f.name, bytes);
          const at = now();
          this.books.push({
            id: uid(),
            title: f.name,
            authors: [],
            ...meta,
            format: f.format,
            sha256: hash,
            size: f.size,
            rootId: id,
            relativePath: f.relativePath,
            managed: false,
            available: true,
            status: "unread",
            favorite: false,
            tagIds: [],
            collectionIds: [],
            createdAt: at,
            updatedAt: at,
          });
        } catch (e) {
          this.notify(`无法索引 ${f.name}：${String(e)}`);
        }
      }
      root.scanState = "idle";
      root.lastValidatedAt = now();
      await this.persist();
      this.notify("重新扫描完成");
    } catch (e) {
      root.scanState = "error";
      root.permission = "unavailable";
      await this.persist();
      this.fail(e);
    }
  }
  async reauthorizeRoot(id: string) {
    const old = this.roots.find((r) => r.id === id);
    if (!old) return;
    try {
      const selected = await hostCall<LibraryRoot | null>("root.pick");
      if (!selected) return;
      const duplicate = this.roots.find(
        (r) => r.id !== id && r.path === selected.path,
      );
      if (duplicate) throw new Error("该位置已关联至其他书库。");
      const next = {
        ...selected,
        id: old.id,
        displayName: old.displayName,
        isDefault: old.isDefault,
      };
      await this.updateRoot(next);
      await this.rescanRoot(id);
    } catch (e) {
      this.fail(e);
    }
  }
  async migrateRoot(from: string, to: string) {
    const source = this.roots.find((r) => r.id === from);
    const target = this.roots.find((r) => r.id === to);
    if (!source || !target || from === to)
      throw new Error("请选择两个不同的书库文件夹。");
    this.busy = true;
    try {
      const report = await hostCall<{
        completed: boolean;
        cancelled: boolean;
        failed: unknown[];
      }>("root.migrate", { from: clone(source), to: clone(target) });
      if (!report.completed)
        throw new Error(
          report.cancelled
            ? "迁移已取消，源文件及原记录保留。"
            : "迁移未完成，源文件及原记录保留，请查看失败项目后重试。",
        );
      for (const b of this.books)
        if (b.rootId === from && b.managed) b.rootId = to;
      await this.persist();
      this.notify("书库副本迁移并校验完成，源文件已保留。");
      return { completed: true, message: "迁移已完成校验，源文件保留。" };
    } catch (e) {
      this.fail(e);
      return {
        completed: false,
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      this.busy = false;
    }
  }
  async cancelMigration() {
    await hostCall("root.migrateCancel");
    this.notify("正在取消迁移，已复制文件与源文件均保留。");
  }
  async readBook(book: Book) {
    const root = this.roots.find((r) => r.id === book.rootId);
    if (!root) throw new Error("本机未关联此书库，请重新关联或下载书籍。");
    try {
      const bytes = nativeHost ? await readNativeBook(clone(root), book.relativePath) : new Uint8Array(
        await hostCall<number[]>("book.read", {
          root: clone(root),
          relativePath: book.relativePath,
        }),
      );
      book.available = true;
      return bytes;
    } catch (e) {
      book.available = false;
      if (
        this.settings.provider &&
        ["full", "on-demand", "selected"].includes(this.settings.syncPolicy)
      ) {
        return this.downloadBook(book);
      }
      throw e;
    }
  }
  async writeBook(book: Book, bytes: Uint8Array) {
    const root = this.roots.find((r) => r.id === book.rootId);
    if (!root || root.readonly) throw new Error("当前书库不可写。");
    const saved = await hostCall<{ sha256: string; size: number }>(
      "book.write",
      {
        root: clone(root),
        relativePath: book.relativePath,
        expectedSha256: book.sha256,
        bytes: Array.from(bytes),
      },
    );
    book.sha256 = saved.sha256;
    book.size = saved.size;
    book.updatedAt = now();
    book.cloudState = "pending";
    await this.persist();
    this.notify("PDF 标注已写入文件，保留可恢复副本");
  }
  saveLocation(bookId: string, location: ReaderLocation) {
    const b = this.books.find((b) => b.id === bookId);
    if (!b) return;
    b.location = { ...location, updatedAt: now() };
    b.lastReadAt = now();
    b.status = location.progress >= 0.995 ? "finished" : "reading";
    b.updatedAt = now();
    this.activity();
    void this.persist();
  }
  async saveAnnotation(annotation: Annotation) {
    annotation.updatedAt = now();
    const i = this.annotations.findIndex((a) => a.id === annotation.id);
    if (i >= 0) this.annotations[i] = clone(annotation);
    else this.annotations.push(clone(annotation));
    await this.persist();
    this.notify(annotation.type === "bookmark" ? "书签已保存" : "标注已保存");
  }
  async deleteAnnotation(id: string) {
    this.annotations = this.annotations.filter((a) => a.id !== id);
    this.tombstones.push({
      id: uid(),
      entityType: "annotation",
      entityId: id,
      at: now(),
      deviceId: this.deviceId,
      revision: this.revision + 1,
    });
    await this.persist();
    this.notify("标注已删除");
  }
  beginSession(bookId: string) {
    if (this.activeSession?.bookId === bookId) return;
    this.endSession();
    const at = now();
    this.activeSession = {
      id: uid(),
      deviceId: this.deviceId,
      bookId,
      startedAt: at,
      endedAt: at,
      activeMs: 0,
      startLocation: clone(
        this.books.find((b) => b.id === bookId)?.location || { progress: 0 },
      ),
    };
    this.sessions.push(this.activeSession);
    this.sessionTick = performance.now();
    this.lastActivity = this.sessionTick;
  }
  activity() {
    const t = performance.now();
    if (
      this.activeSession &&
      t - this.lastActivity > this.settings.idleMinutes * 60000
    )
      this.sessionTick = t;
    this.lastActivity = t;
  }
  flushSession() {
    if (!this.activeSession || document.hidden) return;
    const t = performance.now();
    const until = Math.min(
      t,
      this.lastActivity + this.settings.idleMinutes * 60000,
    );
    this.activeSession.activeMs += Math.max(0, until - this.sessionTick);
    this.sessionTick = t;
    this.activeSession.endedAt = now();
    this.activeSession.endLocation = clone(
      this.books.find((b) => b.id === this.activeSession?.bookId)?.location || {
        progress: 0,
      },
    );
    const i = this.sessions.findIndex((s) => s.id === this.activeSession?.id);
    if (i >= 0) this.sessions[i] = clone(this.activeSession);
    void this.persist();
  }
  pauseSession(reason: string) {
    if (!this.activeSession) return;
    const hidden = document.hidden;
    const t = performance.now();
    if (hidden) {
      const until = Math.min(
        t,
        this.lastActivity + this.settings.idleMinutes * 60000,
      );
      this.activeSession.activeMs += Math.max(0, until - this.sessionTick);
      this.sessionTick = t;
    } else this.flushSession();
    this.activeSession.pauseReason = reason;
    const i = this.sessions.findIndex((s) => s.id === this.activeSession?.id);
    if (i >= 0) this.sessions[i] = clone(this.activeSession);
    void this.persist();
  }
  endSession() {
    if (!this.activeSession) return;
    this.pauseSession("closed");
    this.activeSession = undefined;
  }
  async exportBook(book: Book) {
    try {
      await hostCall("book.export", {
        filename: `${book.title}.${book.format}`,
        bytes: Array.from(await this.readBook(book)),
      });
      this.notify("书籍已导出");
    } catch (e) {
      this.fail(e);
    }
  }
  async exportNote(note: Note) {
    const attachments = note.attachments || [];
    if (!attachments.length) {
      await hostCall("book.export", {
        filename: `${note.title}.md`,
        bytes: Array.from(new TextEncoder().encode(note.body)),
      });
      this.notify("Markdown 已导出");
      return;
    }
    try {
      const zip = new JSZip();
      zip.file(notebookExportMarkdownFileName(note), note.body);
      await addNotebookAttachmentsToZip(zip, note);
      const bytes = await zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
      });
      await hostCall("backup.export", {
        filename: `${notebookExportBaseName(note)}.zip`,
        bytes: Array.from(bytes),
      });
      this.notify(`Markdown 与 ${attachments.length} 个附件已导出`);
    } catch (e) {
      this.fail(e);
    }
  }
  async exportBackup() {
    this.busy = true;
    try {
      const zip = new JSZip();
      const state = this.snapshot();
      state.roots = [];
      if (state.settings.provider)
        zip.file("provider-profile.json", JSON.stringify(exportProviderConfiguration(state.settings.provider), null, 2));
      state.settings.provider = undefined;
      state.pluginData = restorablePluginData(state.pluginData);
      for (const b of state.books) {
        const original = this.books.find((x) => x.id === b.id)!;
        try {
          zip.file(`books/${b.id}.${b.format}`, await this.readBook(original));
        } catch (e) {
          throw new Error(
            `无法备份 ${b.title}：${String(e)}。请先恢复文件访问。`,
          );
        }
        b.relativePath = `books/${b.id}.${b.format}`;
        b.rootId = "restore-target";
      }
      zip.file("granite-backup.json", JSON.stringify(state, null, 2));
      for (const n of this.notes) {
        zip.file(notebookBackupMarkdownPath(n), n.body);
        await addNotebookAttachmentsToZip(
          zip,
          n,
          notebookBackupDirectory(n),
        );
      }
      zip.file(
        "README.txt",
        "Granite open backup v1. Credentials and device-specific library paths are excluded. Markdown notes, notebook attachment files, and original book files are independently readable.",
      );
      const bytes = await zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
      });
      await hostCall("backup.export", {
        filename: `Granite-${new Date().toISOString().slice(0, 10)}.zip`,
        bytes: Array.from(bytes),
      });
      this.notify("完整开放备份已导出");
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy = false;
    }
  }
  async previewBackup(file: File) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const meta = zip.file("granite-backup.json");
    if (!meta) throw new Error("不是 Granite 备份。");
    const incoming = JSON.parse(await meta.async("string")) as AppData;
    if (incoming.schemaVersion !== 1) throw new Error("备份版本不兼容。");
    return {
      books: incoming.books.length,
      notes: incoming.notes.length,
      duplicates: incoming.books.filter((b) =>
        this.books.some((x) => x.sha256 === b.sha256),
      ).length,
    };
  }
  async importBackup(file: File) {
    this.busy = true;
    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entry = zip.file("granite-backup.json");
      if (!entry) throw new Error("备份缺少清单。");
      const incoming = JSON.parse(await entry.async("string")) as AppData;
      if (incoming.schemaVersion !== 1) throw new Error("备份版本不兼容。");
      const providerEntry = zip.file("provider-profile.json");
      const providerTemplate = providerEntry
        ? parseProviderConfiguration(JSON.parse(await providerEntry.async("string")))
        : undefined;
      const root = this.defaultRoot;
      if (!root) throw new Error("请选择恢复目标书库。");
      const staged: Book[] = [];
      for (const b of incoming.books) {
        if (this.books.some((x) => x.id === b.id || x.sha256 === b.sha256))
          continue;
        const fileEntry = zip.file(`books/${b.id}.${b.format}`);
        if (!fileEntry) throw new Error(`备份缺少书籍：${b.title}`);
        const bytes = await fileEntry.async("uint8array");
        if ((await sha256(bytes)) !== b.sha256)
          throw new Error(`备份校验失败：${b.title}`);
        const saved = await hostCall<{ relativePath: string }>("book.import", {
          root: clone(root),
          rootId: root.id,
          filename: `${b.title}.${b.format}`,
          bytes: Array.from(bytes),
        });
        staged.push({
          ...b,
          rootId: root.id,
          relativePath: saved.relativePath,
          managed: true,
          available: true,
        });
      }
      this.books.push(...staged);
      for (const n of incoming.notes) {
        const existing = this.notes.find((x) => x.id === n.id);
        if (!existing) this.notes.push(n);
        else if (existing.body !== n.body)
          this.notes.push({
            ...n,
            id: uid(),
            title: `${n.title}（恢复副本）`,
            conflictOf: n.id,
          });
      }
      for (const key of ["tags", "collections", "annotations"] as const) {
        const list = this[key] as { id: string }[];
        for (const item of Array.isArray(incoming[key]) ? incoming[key] : [])
          if (!list.some((x) => x.id === item.id)) list.push(item);
      }
      for (const item of restorableDeviceRecords<ReadingSession>(
        incoming.sessions,
        this.deviceId,
      ))
        if (!this.sessions.some((x) => x.id === item.id))
          this.sessions.push(item);
      for (const item of restorableDeviceRecords<AppData["tombstones"][number]>(
        incoming.tombstones,
        this.deviceId,
      ))
        if (!this.tombstones.some((x) => x.id === item.id))
          this.tombstones.push(item);
      this.pluginData = {
        ...restorablePluginData(incoming.pluginData),
        ...this.pluginData,
      };
      if (providerTemplate)
        this.pluginData["granite.local-provider-template"] = providerTemplate;
      this.settings = restorableSettings(
        incoming.settings,
        this.settings.provider,
      );
      for (const plugin of incoming.plugins || [])
        if (!this.plugins.some((p) => p.id === plugin.id))
          this.plugins.push({ ...plugin, enabled: false });
      await this.persist();
      this.notify("备份已合并恢复，已有内容保留");
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy = false;
    }
  }
  async previewPlugin(file: File) {
    const { previewPluginPackage } = await import("../services/plugin-manager");
    const preview = await previewPluginPackage(
      new Uint8Array(await file.arrayBuffer()),
    );
    if (!preview.validation.valid || !preview.manifest)
      throw new Error(
        preview.validation.errors.map((i) => i.message).join("；"),
      );
    return {
      ...preview.manifest,
      source: { kind: "local", uri: file.name },
    } as unknown as Record<string, unknown>;
  }
  async installPlugin(file: File) {
    try {
      const { previewPluginPackage, deactivateInstalled } =
        await import("../services/plugin-manager");
      const preview = await previewPluginPackage(
        new Uint8Array(await file.arrayBuffer()),
      );
      if (!preview.validation.valid || !preview.manifest || !preview.bundle)
        throw new Error(
          preview.validation.errors.map((i) => i.message).join("；"),
        );
      const manifest = preview.manifest;
      if (
        manifest.id === "granite.profiles" ||
        manifest.id.startsWith("granite.local-")
      )
        throw new Error("插件 ID 与应用保留命名空间冲突。");
      const source = this.stagedPluginSources.get(file);
      manifest.source = {
        kind: source ? "url" : "local",
        uri: source || file.name,
      };
      const { validateDependencyGraph } =
        await import("../../packages/core/plugins");
      const graph = validateDependencyGraph([
        ...this.plugins
          .filter((p) => p.id !== manifest.id)
          .map((p) => p.manifest),
        manifest,
      ]);
      if (!graph.valid)
        throw new Error(
          graph.issues
            .filter((i) => i.severity === "error")
            .map((i) => i.message)
            .join("；"),
        );
      const old = this.plugins.find((p) => p.id === manifest.id);
      if (old) {
        await deactivateInstalled(old.id);
        this.pluginData[`backup:${manifest.id}`] = clone(old);
      }
      const plugin: InstalledPlugin = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        enabled: false,
        permissions: [...manifest.permissions],
        manifest: manifest as unknown as Record<string, unknown>,
        bundle: new TextDecoder().decode(preview.bundle),
      };
      if (old) this.plugins.splice(this.plugins.indexOf(old), 1, plugin);
      else this.plugins.push(plugin);
      await this.persist();
      this.notify("插件已安装，可在插件中心启用");
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }
  async rollbackPlugin(id: string) {
    const backup = this.pluginData[`backup:${id}`] as
      InstalledPlugin | undefined;
    if (!backup) throw new Error("没有可恢复的插件版本。");
    await this.setPluginEnabled(id, false);
    const i = this.plugins.findIndex((p) => p.id === id);
    if (i < 0) throw new Error("插件未安装。");
    this.plugins[i] = { ...clone(backup), enabled: false };
    await this.persist();
    this.notify("已恢复上一版本，插件保持禁用");
  }
  async stagePluginSource(url: string) {
    const source = new URL(url);
    if (source.protocol !== "https:")
      throw new Error("插件来源需要 HTTPS 地址。");
    const { previewPluginSource } = await import("../services/plugin-manager");
    const preview = await previewPluginSource(url, {
      allowedHosts: [source.hostname],
    });
    if (!preview.validation.valid || !preview.manifest || !preview.bundle)
      throw new Error(
        preview.validation.errors.map((i) => i.message).join("；"),
      );
    const manifest = {
      ...preview.manifest,
      source: {
        kind: source.hostname === "github.com" ? "git" : "url",
        uri: source.toString(),
      },
    };
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(manifest));
    zip.file(manifest.main, preview.bundle);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const file = new File(
      [bytes.slice().buffer],
      `${manifest.id}-${manifest.version}.granite`,
      { type: "application/zip" },
    );
    this.stagedPluginSources.set(file, source.toString());
    return { file, manifest: manifest as unknown as Record<string, unknown> };
  }
  pluginHooks() {
    return {
      library: {
        listBooks: () => clone(this.books),
        getBook: (id: string) => {
          const b = this.books.find((b) => b.id === id);
          return b ? clone(b) : undefined;
        },
        searchBooks: (query: string) =>
          clone(
            this.books.filter((b) =>
              `${b.title} ${b.authors.join(" ")}`
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            ),
          ),
        updateBook: (book: Book) => this.saveBook(book),
      },
      annotations: {
        listAnnotations: (bookId?: string) =>
          clone(this.annotations.filter((a) => !bookId || a.bookId === bookId)),
        saveAnnotation: (a: Annotation) => this.saveAnnotation(a),
        deleteAnnotation: (id: string) => this.deleteAnnotation(id),
      },
      storage: {
        get: async (pluginId: string, key: string) =>
          (this.pluginData[pluginId] as Record<string, unknown> | undefined)?.[
            key
          ],
        set: async (pluginId: string, key: string, value: unknown) => {
          const data = (this.pluginData[pluginId] ||= {}) as Record<
            string,
            unknown
          >;
          data[key] = clone(value);
          await this.persist();
        },
        remove: async (pluginId: string, key: string) => {
          const data = this.pluginData[pluginId] as
            Record<string, unknown> | undefined;
          if (data) delete data[key];
          await this.persist();
        },
      },
      events: {
        emit: (name: string, payload?: unknown) => {
          if (!name.startsWith("plugin:"))
            throw new Error("插件事件必须使用 plugin: 命名空间。");
          appEvents.emit(name, payload);
        },
        onAny: appEvents.onAny,
      },
      notify: (message: string) => this.notify(message),
    };
  }
  async setPluginEnabled(id: string, enabled: boolean) {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) return;
    const manager = await import("../services/plugin-manager");
    try {
      if (enabled) {
        await manager.activateInstalled(clone(plugin), this.pluginHooks(), {
          hostPlatform: /Android/i.test(navigator.userAgent)
            ? "android"
            : "windows",
          safeMode: this.settings.layout.safeMode === true,
        });
        plugin.error = undefined;
      } else await manager.deactivateInstalled(id);
      plugin.enabled = enabled;
      await this.persist();
      appEvents.emit(enabled ? "plugin.enabled" : "plugin.disabled", {
        pluginId: id,
      });
      this.notify(enabled ? "插件已启用" : "插件已禁用，插件数据保留");
    } catch (e) {
      plugin.enabled = false;
      plugin.error = e instanceof Error ? e.message : String(e);
      await this.persist();
      this.fail(e);
    }
  }
  async uninstallPlugin(id: string) {
    const manager = await import("../services/plugin-manager");
    await manager.deactivateInstalled(id);
    this.plugins = this.plugins.filter((p) => p.id !== id);
    await this.persist();
    this.notify("插件已卸载，命名空间数据保留");
  }
  async revokePluginPermission(id: string, permission: string) {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) return;
    await this.setPluginEnabled(id, false);
    plugin.permissions = plugin.permissions.filter((p) => p !== permission);
    await this.persist();
    this.notify("权限已撤销，插件已停止");
  }
  async sync() {
    if (this.syncStatus === "syncing") return;
    if (!this.settings.provider) {
      this.navigate("sync");
      this.notify("请先配置一个存储 Provider");
      return;
    }
    this.syncAbort = new AbortController();
    this.syncStatus = "syncing";
    this.syncProgress = 0;
    try {
      await this.persist();
      const startRevision = this.revision;
      const { synchronize } = await import("../services/synchronization");
      const result = await synchronize(
        this.snapshot(),
        {
          read: (book) => this.readBook(book),
          download: (book, bytes) => this.saveDownloaded(book, bytes),
          progress: (value) => (this.syncProgress = value),
        },
        this.syncAbort.signal,
      );
      if (this.revision !== startRevision)
        throw new Error(
          "同步期间有新的本机修改，已保留修改，请再次同步以完成合并。",
        );
      const removed = this.books.filter(
        (b) => !result.books.some((other) => other.id === b.id),
      );
      for (const key of [
        "books",
        "notes",
        "tags",
        "collections",
        "sessions",
        "annotations",
        "settings",
        "tombstones",
        "conflicts",
        "pluginData",
      ] as const)
        (this as unknown as Record<string, unknown>)[key] = result[key];
      for (const book of removed) this.queueCleanup(book);
      await this.flushCleanup();
      this.revision = Math.max(this.revision, result.revision);
      this.syncStatus = "success";
      this.syncHistory.unshift({
        id: uid(),
        at: now(),
        status: "success",
        message: "书籍与元数据已完成校验和同步",
      });
      await this.persist();
      this.notify("同步完成");
    } catch (e) {
      const cancelled = this.syncAbort.signal.aborted;
      this.syncStatus = cancelled ? "cancelled" : "error";
      this.syncHistory.unshift({
        id: uid(),
        at: now(),
        status: cancelled ? "cancelled" : "error",
        message: cancelled
          ? "用户取消，本地数据保留"
          : e instanceof Error
            ? e.message
            : String(e),
      });
      await this.persist();
      if (!cancelled) this.fail(e);
    } finally {
      this.syncAbort = undefined;
    }
  }
  cancelSync() {
    this.syncAbort?.abort();
    this.syncStatus = "cancelled";
    this.notify("同步已取消，本地修改保留");
  }
  async saveDownloaded(book: Book, bytes: Uint8Array) {
    if ((await sha256(bytes)) !== book.sha256)
      throw new Error("下载书籍校验失败，已保留本地健康文件。");
    const root =
      this.roots.find(
        (r) => r.isDefault && r.permission === "granted" && !r.readonly,
      ) || this.roots.find((r) => r.permission === "granted" && !r.readonly);
    if (!root) throw new Error("没有可写书库，请重新授权或添加文件夹。");
    const saved = await hostCall<{ relativePath: string }>("book.import", {
      root: clone(root),
      rootId: root.id,
      filename: `${book.title}.${book.format}`,
      bytes: Array.from(bytes),
    });
    return {
      ...book,
      rootId: root.id,
      relativePath: saved.relativePath,
      managed: true,
      available: true,
      cloudState: "synced",
    };
  }
  async downloadBook(book: Book): Promise<Uint8Array> {
    const { nativeProvider, transferBook } =
      await import("../services/synchronization");
    const provider = nativeProvider(this.snapshot());
    const bytes = await transferBook(provider, book);
    Object.assign(book, await this.saveDownloaded(book, bytes));
    await this.persist();
    this.notify("书籍已下载并通过完整性校验");
    return bytes;
  }
}
const instance = reactive(new GraniteApp());
export function useApp() {
  return instance;
}
