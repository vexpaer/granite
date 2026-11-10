import type { AppData, Book, Note, ReaderLocation } from "../types";
import {
  createHostProviderTransport,
  createProvider,
  type StorageProvider,
} from "../../packages/core/provider";
import {
  canonicalJson,
  createDeviceSyncDocument,
  parseDeviceSyncDocument,
  mergeSyncDocuments,
  mergeNoteChanges,
  compareSyncRevision,
  sanitizeMetadataForSync,
  getSyncPolicyDecision,
  type SyncChange,
  type SyncRevision,
  type DeviceSyncDocument,
  type NoteChange,
} from "../../packages/core/sync";
import { hostCall } from "./host";
import {
  isBookObjectComplete,
  removeBookObjects,
  transferBook,
  uploadBookObject,
} from "./object-transfer";
export { transferBook };
const localKey = "granite.local-sync-state";
interface LocalSyncState {
  authored: SyncChange[];
  known: Record<string, { signature: string; heads: SyncRevision[] }>;
}
interface SyncAccess {
  read(book: Book): Promise<Uint8Array>;
  download(book: Book, bytes: Uint8Array): Promise<Book>;
  progress(value: number): void;
}
const encode = (data: unknown) =>
  new TextEncoder().encode(JSON.stringify(data));
export function nativeProvider(data: AppData): StorageProvider {
  if (!data.settings.provider) throw new Error("请先配置存储 Provider。");
  return createProvider(
    data.settings.provider,
    createHostProviderTransport((request) =>
      hostCall(request.op, request.args),
    ),
  );
}
function safeSnapshot(data: AppData) {
  const pluginData = { ...data.pluginData };
  for (const key of Object.keys(pluginData))
    if (key.startsWith("granite.local-")) delete pluginData[key];
  return sanitizeMetadataForSync({ ...data, pluginData });
}
export async function synchronize(
  data: AppData,
  access: SyncAccess,
  signal: AbortSignal,
): Promise<AppData> {
  const provider = nativeProvider(data);
  const options = { signal };
  const check = () => {
    if (signal.aborted) throw new DOMException("同步已取消", "AbortError");
  };
  const previous = data.pluginData[localKey] as LocalSyncState | undefined;
  const local: LocalSyncState = {
    authored: previous?.authored || [],
    known: previous?.known || {},
  };
  const snapshot = safeSnapshot(data);
  const fields = [
    ["books", "book"],
    ["notes", "note"],
    ["tags", "tag"],
    ["collections", "collection"],
    ["sessions", "session"],
    ["annotations", "annotation"],
  ] as const;
  const candidates: { entityType: string; entityId: string; value: unknown }[] =
    [];
  for (const [key, type] of fields)
    for (const value of snapshot[key])
      candidates.push({ entityType: type, entityId: value.id, value });
  candidates.push({
    entityType: "settings",
    entityId: "shared",
    value: snapshot.settings,
  });
  for (const item of candidates) {
    const key = `${item.entityType}:${item.entityId}`;
    const signature = canonicalJson(item.value);
    if (local.known[key]?.signature === signature) continue;
    const change: SyncChange = {
      id: crypto.randomUUID(),
      entityType: item.entityType,
      entityId: item.entityId,
      operation: "upsert",
      value: item.value,
      revision: { counter: data.revision, deviceId: data.deviceId },
      parents: local.known[key]?.heads || [],
    };
    local.authored = local.authored.filter(
      (c) =>
        !(c.entityType === item.entityType && c.entityId === item.entityId),
    );
    local.authored.push(change);
  }
  const doc = await createDeviceSyncDocument({
    deviceId: data.deviceId,
    revision: data.revision,
    changes: local.authored,
    tombstones: data.tombstones.filter((t) => t.deviceId === data.deviceId),
    pluginData: snapshot.pluginData,
  });
  const version = await provider.stat("sync/protocol-version.json", options);
  if (version) {
    const remote = JSON.parse(
      new TextDecoder().decode(
        await provider.read("sync/protocol-version.json", options),
      ),
    );
    if (remote.protocolVersion !== 1)
      throw new Error("云端同步协议不兼容，已保留本地数据。");
  } else
    await provider.write(
      "sync/protocol-version.json",
      encode({ protocolVersion: 1 }),
      { ...options, contentType: "application/json" },
    );
  access.progress(0.08);
  check();
  const records = await provider.list("sync/devices/", options);
  const documents: DeviceSyncDocument[] = [doc];
  for (const record of records) {
    if (
      !record.key.endsWith(".json") ||
      record.key.endsWith(`/${data.deviceId}.json`)
    )
      continue;
    check();
    documents.push(
      await parseDeviceSyncDocument(
        new TextDecoder().decode(await provider.read(record.key, options)),
      ),
    );
  }
  access.progress(0.22);
  const merged = mergeSyncDocuments(...documents);
  const alive = new Map<string, SyncChange>();
  const heads: Record<string, SyncRevision[]> = {};
  for (const change of merged.changes) {
    const key = `${change.entityType}:${change.entityId}`;
    (heads[key] ||= []).push(change.revision);
    const existing = alive.get(key);
    if (
      !existing ||
      compareSyncRevision(change.revision, existing.revision) > 0
    )
      alive.set(key, change);
  }
  const deleted = new Set(
    merged.tombstones.map((t) => `${t.entityType}:${t.entityId}`),
  );
  const output: AppData = JSON.parse(JSON.stringify(data));
  output.tombstones = merged.tombstones;
  output.revision =
    Math.max(data.revision, ...documents.map((d) => d.revision)) + 1;
  const previousBooks = new Map(output.books.map((b) => [b.id, b]));
  output.books = [];
  output.tags = [];
  output.collections = [];
  output.sessions = [];
  output.annotations = [];
  for (const [key, change] of alive) {
    if (deleted.has(key)) continue;
    switch (change.entityType) {
      case "book": {
        const value = change.value as Book;
        const prior = previousBooks.get(value.id);
        const root = data.roots.find((r) => r.isDefault) || data.roots[0];
        output.books.push({
          ...value,
          rootId: prior?.rootId || root?.id || "",
          relativePath: prior?.relativePath || "",
          managed: prior?.managed ?? true,
          available: prior?.available ?? false,
          cover: prior?.cover,
          cloudState: prior?.available ? "synced" : "cloud",
        });
        break;
      }
      case "tag":
        output.tags.push(change.value as AppData["tags"][number]);
        break;
      case "collection":
        output.collections.push(change.value as AppData["collections"][number]);
        break;
      case "session":
        output.sessions.push(change.value as AppData["sessions"][number]);
        break;
      case "annotation":
        output.annotations.push(change.value as AppData["annotations"][number]);
        break;
      case "settings":
        if (change.revision.deviceId !== data.deviceId)
          output.settings = {
            ...output.settings,
            ...(change.value as object),
            provider: data.settings.provider,
            background: data.settings.background,
          };
        break;
    }
  }
  const notes = mergeNoteChanges(
    merged.changes.filter((c) => c.entityType === "note") as NoteChange[],
    { preferredDeviceId: data.deviceId },
  );
  output.notes = notes.notes.filter((n) => !deleted.has(`note:${n.id}`));
  output.conflicts = [
    ...new Map(
      [...output.conflicts, ...merged.conflicts, ...notes.conflicts].map(
        (c) => [c.id, c],
      ),
    ).values(),
  ];
  output.pluginData = { ...data.pluginData, ...merged.pluginData };
  const toTransfer = output.books.filter((book) => {
    const decision = getSyncPolicyDecision({
      policy: data.settings.syncPolicy,
      object: "book-file",
      bookId: book.id,
      collectionIds: book.collectionIds,
      selectedBookIds: data.settings.syncBookIds,
      selectedCollectionIds: data.settings.syncCollectionIds,
    });
    return (
      decision.syncBookFile ||
      (data.settings.syncPolicy === "on-demand" && book.available)
    );
  });
  for (let i = 0; i < toTransfer.length; i++) {
    check();
    const book = toTransfer[i]!;
    if (book.available) {
      if (!(await isBookObjectComplete(provider, book, signal))) {
        const bytes = await access.read(book);
        await uploadBookObject(provider, book, bytes, signal);
      }
      book.cloudState = "synced";
    } else {
      const bytes = await transferBook(provider, book, signal);
      Object.assign(book, await access.download(book, bytes), {
        cloudState: "synced",
      });
    }
    access.progress(0.25 + (0.55 * (i + 1)) / Math.max(1, toTransfer.length));
  }
  // Publish deletion intent before object removal. An interrupted run can never resurrect records.
  await provider.write(`sync/devices/${data.deviceId}.json`, encode(doc), {
    ...options,
    contentType: "application/json",
  });
  const unreferencedHashes = new Set(
    merged.tombstones.flatMap((tombstone) =>
      tombstone.entityType === "book" &&
      tombstone.hash &&
      !output.books.some((book) => book.sha256 === tombstone.hash)
        ? [tombstone.hash]
        : [],
    ),
  );
  for (const hash of unreferencedHashes) {
    check();
    await removeBookObjects(provider, hash, options);
  }
  const finalSafe = safeSnapshot(output);
  const nextKnown: LocalSyncState["known"] = {};
  for (const [field, type] of fields)
    for (const value of finalSafe[field]) {
      const key = `${type}:${value.id}`;
      nextKnown[key] = {
        signature: canonicalJson(value),
        heads: heads[key] || [],
      };
    }
  nextKnown["settings:shared"] = {
    signature: canonicalJson(finalSafe.settings),
    heads: heads["settings:shared"] || [],
  };
  output.pluginData[localKey] = { authored: local.authored, known: nextKnown };
  access.progress(1);
  return output;
}
