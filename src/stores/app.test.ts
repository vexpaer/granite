// @vitest-environment jsdom

import { createHash, webcrypto } from "node:crypto";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppData, AppSettings, ImportResult, LibraryRoot } from "../types";
import type { useApp } from "./app";

type AppStore = ReturnType<typeof useApp>;

const hostHarness = vi.hoisted(() => ({
  state: null as unknown,
  calls: [] as { op: string; args: Record<string, unknown> }[],
  trashHandler: null as
    | ((args: Record<string, unknown>) => void | Promise<void>)
    | null,
}));

vi.mock("../services/host", async () => {
  const { createHash } = await import("node:crypto");
  return {
    nativeHost: false,
    sha256: async (bytes: Uint8Array) =>
      createHash("sha256").update(bytes).digest("hex"),
    hostCall: vi.fn(
      async (op: string, args: Record<string, unknown> = {}) => {
        hostHarness.calls.push({ op, args });
        if (op === "state.load") return hostHarness.state;
        if (op === "state.save") return true;
        if (op === "book.trash") {
          await hostHarness.trashHandler?.(args);
          return { trashed: true };
        }
        throw new Error(`Unexpected host operation in store test: ${op}`);
      },
    ),
  };
});

vi.mock("../services/platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/platform")>();
  return {
    ...actual,
    initializePlatform: vi.fn(async () => {}),
    updatePlatform: vi.fn(async () => {}),
  };
});

vi.mock("../services/metadata", () => ({
  extractMetadata: vi.fn(),
}));

vi.mock("../services/plugin-manager", () => ({
  initializeInstalledPlugins: vi.fn(async () => []),
}));

const openStores: AppStore[] = [];

function root(overrides: Partial<LibraryRoot> = {}): LibraryRoot {
  return {
    id: "selected-root",
    displayName: "Selected library",
    path: "C:\\Granite Library",
    kind: "filesystem",
    permission: "granted",
    enabled: true,
    isDefault: true,
    readonly: false,
    scanState: "idle",
    ...overrides,
  };
}

function emptyData(settings: AppSettings): AppData {
  return {
    schemaVersion: 1,
    deviceId: "persisted-device",
    revision: 0,
    books: [],
    notes: [],
    tags: [],
    collections: [],
    roots: [],
    sessions: [],
    annotations: [],
    settings,
    plugins: [],
    tombstones: [],
    syncHistory: [],
    conflicts: [],
    pluginData: {},
  };
}

async function backupFile(state: AppData): Promise<File> {
  const zip = new JSZip();
  zip.file("granite-backup.json", JSON.stringify(state));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return {
    name: "granite-backup.zip",
    arrayBuffer: async () =>
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ),
  } as File;
}

async function freshApp() {
  const module = await import("./app");
  const app = module.useApp();
  openStores.push(app);
  return { app, defaultSettings: module.defaultSettings };
}

function stopStoreTimers(app: AppStore): void {
  if (app.sessionInterval) clearInterval(app.sessionInterval);
  if (app.toastTimer) clearTimeout(app.toastTimer);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  sessionStorage.clear();
  hostHarness.state = null;
  hostHarness.calls.length = 0;
  hostHarness.trashHandler = null;
  openStores.length = 0;
});

afterEach(() => {
  for (const app of openStores) stopStoreTimers(app);
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("backup restore boundaries", () => {
  it("drops local application namespaces, attacker device IDs, roots, and credentials", async () => {
    const { app } = await freshApp();
    const selectedRoot = root();
    const localProvider = {
      id: "local-provider",
      type: "webdav" as const,
      name: "Local provider",
      endpoint: "https://local.invalid",
      prefix: "Granite",
      credentialId: "local-credential",
    };
    const localDeviceId = app.deviceId;
    app.roots = [selectedRoot];
    app.settings.provider = localProvider;

    const incoming = app.snapshot();
    incoming.deviceId = "attacker-device";
    incoming.roots = [
      root({
        id: "attacker-root",
        path: "C:\\Attacker Path",
        isDefault: true,
      }),
    ];
    incoming.settings = {
      ...incoming.settings,
      provider: {
        ...localProvider,
        id: "attacker-provider",
        credentialId: "attacker-credential",
      },
    };
    Object.assign(incoming.settings as AppSettings & Record<string, unknown>, {
      credentialId: "attacker-top-level-credential",
      password: "attacker-password",
    });
    incoming.sessions = [
      {
        id: "backup-session",
        deviceId: "attacker-device",
        bookId: "backup-book",
        startedAt: "2026-11-09T00:00:00.000Z",
        endedAt: "2026-11-09T00:01:00.000Z",
        activeMs: 60_000,
      },
    ];
    incoming.tombstones = [
      {
        id: "backup-tombstone",
        entityType: "book",
        entityId: "backup-book",
        at: "2026-11-09T00:01:00.000Z",
        deviceId: "attacker-device",
        revision: 9,
      },
    ];
    incoming.pluginData = {
      "granite.local-cleanup": [
        {
          bookId: "backup-book",
          root: incoming.roots[0],
          relativePath:
            "books/00000000-0000-0000-0000-000000000001/backup.txt",
        },
      ],
      "granite.local-sync-state": { attackerControlled: true },
      "future.plugin": { retained: true },
    };

    await app.importBackup(await backupFile(incoming));

    expect(app.error).toBe("");
    expect(app.deviceId).toBe(localDeviceId);
    expect(app.roots).toEqual([selectedRoot]);
    expect(app.settings.provider).toEqual(localProvider);
    expect(app.settings).not.toHaveProperty("credentialId");
    expect(app.settings).not.toHaveProperty("password");
    expect(app.pluginData).not.toHaveProperty("granite.local-cleanup");
    expect(app.pluginData).not.toHaveProperty("granite.local-sync-state");
    expect(app.pluginData["future.plugin"]).toEqual({ retained: true });
    expect(app.sessions[0]?.deviceId).toBe(localDeviceId);
    expect(app.tombstones[0]?.deviceId).toBe(localDeviceId);
    expect(
      hostHarness.calls.some(({ op }) => op === "book.trash"),
    ).toBe(false);
  });
});

describe("managed cleanup recovery", () => {
  it("retries only a live managed root with a matching book tombstone", async () => {
    const { app, defaultSettings } = await freshApp();
    const managedRoot = root();
    const unlinkedRoot = root({
      id: "unlinked-root",
      path: "D:\\Unlinked Library",
      isDefault: false,
    });
    const managedBookId = "00000000-0000-0000-0000-000000000011";
    const externalBookId = "00000000-0000-0000-0000-000000000012";
    const unlinkedBookId = "00000000-0000-0000-0000-000000000013";
    const orphanBookId = "00000000-0000-0000-0000-000000000014";
    const managedPath =
      "books/00000000-0000-0000-0000-000000000021/managed.txt";
    const unlinkedPath =
      "books/00000000-0000-0000-0000-000000000022/unlinked.txt";
    const orphanPath =
      "books/00000000-0000-0000-0000-000000000023/orphan.txt";
    const externalPath = "external-original.txt";
    const externalFiles = new Map([
      [managedPath, "managed"],
      [externalPath, "external original"],
    ]);
    const saved = emptyData(defaultSettings());
    saved.deviceId = "persisted-device";
    saved.roots = [managedRoot];
    saved.tombstones = [
      {
        id: "tombstone-managed",
        entityType: "book",
        entityId: managedBookId,
        hash: "a".repeat(64),
        at: "2026-11-09T00:00:00.000Z",
        deviceId: "persisted-device",
        revision: 1,
      },
      {
        id: "tombstone-external",
        entityType: "book",
        entityId: externalBookId,
        hash: "b".repeat(64),
        at: "2026-11-09T00:00:00.000Z",
        deviceId: "persisted-device",
        revision: 2,
      },
      {
        id: "tombstone-unlinked",
        entityType: "book",
        entityId: unlinkedBookId,
        hash: "c".repeat(64),
        at: "2026-11-09T00:00:00.000Z",
        deviceId: "persisted-device",
        revision: 3,
      },
    ];
    saved.pluginData = {
      "granite.local-cleanup": [
        {
          bookId: managedBookId,
          root: managedRoot,
          relativePath: managedPath,
          sha256: "a".repeat(64),
        },
        {
          bookId: externalBookId,
          root: managedRoot,
          relativePath: externalPath,
          sha256: "b".repeat(64),
        },
        {
          bookId: unlinkedBookId,
          root: unlinkedRoot,
          relativePath: unlinkedPath,
          sha256: "c".repeat(64),
        },
        {
          bookId: orphanBookId,
          root: managedRoot,
          relativePath: orphanPath,
          sha256: "d".repeat(64),
        },
      ],
    };
    hostHarness.state = saved;
    hostHarness.trashHandler = (args) => {
      externalFiles.delete(String(args.relativePath));
    };

    await app.init();

    expect(app.error).toBe("");
    const trashCalls = hostHarness.calls.filter(
      ({ op }) => op === "book.trash",
    );
    expect(trashCalls).toHaveLength(1);
    expect(trashCalls[0]?.args).toMatchObject({
      bookId: managedBookId,
      relativePath: managedPath,
      root: managedRoot,
    });
    expect(externalFiles.has(externalPath)).toBe(true);
    expect(externalFiles.has(managedPath)).toBe(false);
    expect(app.pluginData).not.toHaveProperty("granite.local-cleanup");
  });
});

describe("Android share acknowledgements", () => {
  it("uses each import result so a failed same-name share is not acknowledged", async () => {
    const { successfulShareAcknowledgementIds } =
      await import("../services/platform");
    const files = [
      { id: "share-failed", name: "same-name.txt" },
      { id: "share-success", name: "same-name.txt" },
      { id: "share-duplicate", name: "another-name.txt" },
    ];
    const results: ImportResult[] = [
      { filename: "same-name.txt", status: "error" },
      { filename: "same-name.txt", status: "success" },
      { filename: "another-name.txt", status: "duplicate" },
    ];

    expect(successfulShareAcknowledgementIds(files, results)).toEqual([
      "share-success",
      "share-duplicate",
    ]);
  });
});
