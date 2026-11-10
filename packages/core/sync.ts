import type {
  Annotation,
  AppData,
  AppSettings,
  Book,
  Collection,
  Note,
  ReaderLocation,
  ReadingSession,
  Tag,
  Tombstone,
} from '../../src/types'

export const SYNC_PROTOCOL_VERSION = 1 as const
export const DEFAULT_SYNC_RETRY_ATTEMPTS = 5

export type SyncPolicy = AppSettings['syncPolicy']
export type SyncDigest = (value: string | Uint8Array) => Promise<string>

export interface SyncRevision {
  counter: number
  deviceId: string
}

export interface SyncChange<T = unknown> {
  id: string
  entityType: string
  entityId: string
  operation: 'upsert'
  value: T
  revision: SyncRevision
  parents?: SyncRevision[]
  baseChecksum?: string
  checksum?: string
}

export interface SyncTombstone extends Omit<Tombstone, 'revision'> {
  revision: number
  revisionStamp?: SyncRevision
}

export interface DeviceSyncDocument {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION
  deviceId: string
  revision: number
  generatedAt: string
  changes: SyncChange[]
  tombstones: SyncTombstone[]
  pluginData: Record<string, unknown>
  metadata?: Record<string, unknown>
  checksum: string
}

export interface DeviceSyncDocumentInput {
  deviceId: string
  revision: number
  generatedAt?: string
  changes?: SyncChange[]
  tombstones?: SyncTombstone[]
  pluginData?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface MergedSyncDocuments {
  changes: SyncChange[]
  tombstones: SyncTombstone[]
  pluginData: Record<string, unknown>
  conflicts: SyncConflict[]
}

export interface SyncConflict {
  id: string
  type: string
  entityId: string
  local: unknown
  remote: unknown
  deviceId: string
  at: string
}

export interface NoteChange extends SyncChange<Note> {
  entityType: 'note'
}

export interface NoteMergeResult {
  notes: Note[]
  conflicts: SyncConflict[]
}

export interface ReadingProgressPoint {
  id: string
  bookId: string
  location: ReaderLocation
  revision: SyncRevision
  recordedAt: string
  sessionId?: string
}

export interface ReadingProgressHistory {
  bookId: string
  current: ReadingProgressPoint
  history: ReadingProgressPoint[]
}

export interface OrSetOperation {
  element: string
  operation: 'add' | 'remove'
  /**
   * Add operations create a unique dot. Remove operations name the observed
   * add dot they tombstone, so a concurrent add from another replica survives.
   */
  operationId: string
}

export interface OrSetElementState {
  additions: string[]
  removals: string[]
}

export type OrSetState = Record<string, OrSetElementState>

export interface SyncSafeBook
  extends Omit<
    Book,
    'rootId' | 'relativePath' | 'managed' | 'available' | 'cover' | 'cloudState'
  > {}

export type SyncSafeNote = Omit<Note, 'attachments'> & {
  attachments?: Array<{ name: string; path?: string }>
}

export interface SyncSnapshot {
  books: SyncSafeBook[]
  notes: SyncSafeNote[]
  tags: Tag[]
  collections: Collection[]
  sessions: ReadingSession[]
  annotations: Annotation[]
  settings: Omit<AppSettings, 'provider' | 'background'>
  pluginData: Record<string, unknown>
}

export interface SyncPolicyInput {
  policy: SyncPolicy
  object: 'book-file' | 'metadata' | 'plugin-data' | 'delete'
  bookId?: string
  collectionIds?: readonly string[]
  selectedBookIds?: readonly string[]
  selectedCollectionIds?: readonly string[]
  requestedOnDemand?: boolean
}

export interface SyncPolicyDecision {
  syncMetadata: boolean
  syncBookFile: boolean
  syncTombstones: boolean
  deleteRemoteObject: boolean
  reason: string
}

export interface SyncQueueItem {
  id: string
  kind: string
  operation: string
  key: string
  dedupeKey?: string
  payload: unknown
  checksum: string
  attempts: number
  maxAttempts: number
  createdAt: string
  updatedAt: string
  nextAttemptAt: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  error?: string
  result?: unknown
}

export interface EnqueueSyncItem {
  id?: string
  kind: string
  operation: string
  key: string
  dedupeKey?: string
  payload?: unknown
  maxAttempts?: number
}

export interface SyncQueueSnapshot {
  revision: number
  items: SyncQueueItem[]
}

export interface SyncQueueOptions {
  digest?: SyncDigest
  now?: () => string
  createId?: () => string
  baseRetryDelayMs?: number
  maxRetryDelayMs?: number
}

export type SyncQueueRunner = (
  item: Readonly<SyncQueueItem>,
  signal: AbortSignal,
) => Promise<unknown>

const SENSITIVE_KEYS = new Set([
  'roots',
  'rootid',
  'relativepath',
  'provider',
  'credentialid',
  'accesskey',
  'accesskeyid',
  'secretkey',
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
])

let fallbackIdCounter = 0

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`)
  }
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined || value === null) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(value)
    } catch (error) {
      // Domain records may arrive through a reactive proxy. They remain JSON
      // data, but structuredClone rejects proxies even when every field is safe.
      if (!(error instanceof Error) || error.name !== 'DataCloneError') throw error
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

function bytesToHex(bytes: Uint8Array): string {
  let output = ''
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0')
  return output
}

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>()

  const encode = (current: unknown): string => {
    if (current === null) return 'null'

    switch (typeof current) {
      case 'string':
        return JSON.stringify(current)
      case 'boolean':
        return current ? 'true' : 'false'
      case 'number':
        if (!Number.isFinite(current)) {
          throw new TypeError('canonicalJson does not support non-finite numbers')
        }
        return JSON.stringify(current)
      case 'bigint':
        return JSON.stringify(current.toString())
      case 'undefined':
      case 'function':
      case 'symbol':
        return 'null'
      case 'object':
        break
    }

    const object = current as object
    if (seen.has(object)) throw new TypeError('canonicalJson does not support cyclic values')
    seen.add(object)

    let result: string
    if (object instanceof Date) {
      result = JSON.stringify(object.toISOString())
    } else if (object instanceof ArrayBuffer) {
      result = JSON.stringify(bytesToHex(new Uint8Array(object)))
    } else if (ArrayBuffer.isView(object)) {
      const view = object as ArrayBufferView
      result = JSON.stringify(
        bytesToHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
      )
    } else if (Array.isArray(object)) {
      result = `[${object.map(encode).join(',')}]`
    } else {
      const entries = Object.entries(object as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
      result = `{${entries
        .map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry)}`)
        .join(',')}}`
    }

    seen.delete(object)
    return result
  }

  return encode(value)
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable')
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', copy)))
}

export function compareSyncRevision(left: SyncRevision, right: SyncRevision): number {
  if (left.counter !== right.counter) return left.counter - right.counter
  if (left.deviceId === right.deviceId) return 0
  return left.deviceId < right.deviceId ? -1 : 1
}

export function syncRevisionId(revision: SyncRevision): string {
  return `${revision.counter}:${revision.deviceId}`
}

export function nextSyncRevision(deviceId: string, counter: number): SyncRevision {
  assertFiniteNonNegative(counter, 'revision counter')
  return { counter: Math.floor(counter), deviceId }
}

export function containsSensitiveSyncField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSensitiveSyncField)

  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizeKey(key))) return true
    if (containsSensitiveSyncField(entry)) return true
  }
  return false
}

export function assertSafeSyncDocument(document: unknown): void {
  if (containsSensitiveSyncField(document)) {
    throw new Error('sync document contains local paths, provider configuration, or credentials')
  }
}

function portableRelativePath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return undefined
  if (normalized.split('/').some((part) => part === '..')) return undefined
  return normalized
}

export function sanitizeMetadataForSync(
  data: Pick<
    AppData,
    'books' | 'notes' | 'tags' | 'collections' | 'sessions' | 'annotations' | 'settings' | 'pluginData'
  >,
): SyncSnapshot {
  const books = data.books.map((book) => {
    const {
      rootId: unusedRootId,
      relativePath: unusedRelativePath,
      managed: unusedManaged,
      available: unusedAvailable,
      cover: unusedCover,
      cloudState: unusedCloudState,
      ...safe
    } = book
    void unusedRootId
    void unusedRelativePath
    void unusedManaged
    void unusedAvailable
    void unusedCover
    void unusedCloudState
    return cloneJsonValue(safe) as SyncSafeBook
  })

  const notes = data.notes.map((note) => {
    const { attachments, ...safe } = note
    return {
      ...cloneJsonValue(safe),
      ...(attachments
        ? {
            attachments: attachments.map((attachment) => {
              const path = attachment.path
                ? portableRelativePath(attachment.path)
                : undefined
              return { name: attachment.name, ...(path ? { path } : {}) }
            }),
          }
        : {}),
    } as SyncSafeNote
  })

  const { provider: _provider, background: _background, ...safeSettings } = data.settings
  void _provider
  void _background

  return {
    books,
    notes,
    tags: cloneJsonValue(data.tags),
    collections: cloneJsonValue(data.collections),
    sessions: dedupeReadingSessions(data.sessions),
    annotations: cloneJsonValue(data.annotations),
    settings: cloneJsonValue(safeSettings),
    pluginData: cloneJsonValue(data.pluginData),
  }
}

function effectiveTombstoneRevision(tombstone: SyncTombstone): SyncRevision {
  return tombstone.revisionStamp ?? {
    counter: tombstone.revision,
    deviceId: tombstone.deviceId,
  }
}

export function tombstoneEntityKey(entityType: string, entityId: string): string {
  return `${entityType}\u0000${entityId}`
}

export function mergeTombstones(
  ...collections: ReadonlyArray<readonly SyncTombstone[]>
): SyncTombstone[] {
  const merged = new Map<string, SyncTombstone>()

  for (const collection of collections) {
    for (const tombstone of collection) {
      const key = tombstoneEntityKey(tombstone.entityType, tombstone.entityId)
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, cloneJsonValue(tombstone))
        continue
      }

      const comparison = compareSyncRevision(
        effectiveTombstoneRevision(tombstone),
        effectiveTombstoneRevision(existing),
      )
      if (
        comparison > 0 ||
        (comparison === 0 && canonicalJson(tombstone) < canonicalJson(existing))
      ) {
        merged.set(key, cloneJsonValue(tombstone))
      }
    }
  }

  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, tombstone]) => tombstone)
}

export function filterResurrectedChanges(
  changes: readonly SyncChange[],
  tombstones: readonly SyncTombstone[],
): SyncChange[] {
  const deleted = new Set(
    tombstones.map((tombstone) => tombstoneEntityKey(tombstone.entityType, tombstone.entityId)),
  )
  return changes.filter(
    (change) => !deleted.has(tombstoneEntityKey(change.entityType, change.entityId)),
  )
}

export function mergeReadingSessions(...groups: readonly ReadingSession[][]): ReadingSession[] {
  const byId = new Map<string, ReadingSession>()

  for (const session of groups.flat()) {
    if (!session.id) continue
    const existing = byId.get(session.id)
    if (!existing) {
      byId.set(session.id, cloneJsonValue(session))
      continue
    }

    const existingScore = Math.max(0, existing.activeMs)
    const incomingScore = Math.max(0, session.activeMs)
    if (
      incomingScore > existingScore ||
      (incomingScore === existingScore && canonicalJson(session) > canonicalJson(existing))
    ) {
      byId.set(session.id, cloneJsonValue(session))
    }
  }

  return [...byId.values()].sort((left, right) => {
    if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

export const dedupeReadingSessions = mergeReadingSessions

export function applyOrSetOperation(
  current: OrSetState,
  operation: OrSetOperation,
): OrSetState {
  const next = cloneJsonValue(current)
  const state = next[operation.element] ?? { additions: [], removals: [] }
  const list = operation.operation === 'add' ? state.additions : state.removals
  if (!list.includes(operation.operationId)) list.push(operation.operationId)
  list.sort()
  next[operation.element] = state
  return next
}

export function applyOrSetOperations(
  current: OrSetState,
  operations: readonly OrSetOperation[],
): OrSetState {
  return operations.reduce(applyOrSetOperation, current)
}

export function mergeOrSets(...sets: readonly OrSetState[]): OrSetState {
  const merged: OrSetState = {}

  for (const set of sets) {
    for (const [element, state] of Object.entries(set)) {
      const current = merged[element] ?? { additions: [], removals: [] }
      current.additions = [...new Set([...current.additions, ...state.additions])].sort()
      current.removals = [...new Set([...current.removals, ...state.removals])].sort()
      merged[element] = current
    }
  }

  return merged
}

export function orSetValues(state: OrSetState): string[] {
  return Object.entries(state)
    .filter(([, element]) => element.additions.some((id) => !element.removals.includes(id)))
    .map(([element]) => element)
    .sort()
}

function noteConflictCopyId(note: Note, revision: SyncRevision, used: Set<string>): string {
  const base = `${note.id}:conflict:${revision.deviceId}:${revision.counter}`
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) candidate = `${base}:${suffix++}`
  used.add(candidate)
  return candidate
}

export function mergeNoteChanges(
  changes: readonly NoteChange[],
  options: { preferredDeviceId?: string } = {},
): NoteMergeResult {
  const groups = new Map<string, NoteChange[]>()
  for (const change of changes) {
    const group = groups.get(change.entityId) ?? []
    group.push(change)
    groups.set(change.entityId, group)
  }

  const notes: Note[] = []
  const conflicts: SyncConflict[] = []

  for (const [entityId, group] of groups) {
    const groupRevisionIds = new Set(group.map((change) => syncRevisionId(change.revision)))
    const referencedParents = new Set<string>()
    for (const change of group) {
      for (const parent of change.parents ?? []) {
        const id = syncRevisionId(parent)
        if (groupRevisionIds.has(id)) referencedParents.add(id)
      }
    }

    let heads = group.filter(
      (change) => !referencedParents.has(syncRevisionId(change.revision)),
    )
    if (!heads.length) heads = [...group]

    heads.sort((left, right) => {
      const comparison = compareSyncRevision(right.revision, left.revision)
      if (comparison !== 0) return comparison
      return canonicalJson(left.value) < canonicalJson(right.value) ? -1 : 1
    })

    const preferred = options.preferredDeviceId
      ? heads.find((head) => head.revision.deviceId === options.preferredDeviceId)
      : undefined
    const primary = preferred ?? heads[0]
    if (!primary) continue

    const primaryNote = cloneJsonValue(primary.value)
    notes.push(primaryNote)
    const usedIds = new Set([entityId, ...group.map((change) => change.value.id)])

    for (const head of heads) {
      if (head === primary) continue
      if (canonicalJson(head.value) === canonicalJson(primary.value)) continue

      const conflictId = noteConflictCopyId(head.value, head.revision, usedIds)
      const conflictNote = cloneJsonValue(head.value)
      conflictNote.id = conflictId
      conflictNote.conflictOf = entityId
      conflictNote.title = `${head.value.title} (Conflict ${head.revision.deviceId})`
      notes.push(conflictNote)
      conflicts.push({
        id: `${entityId}:${syncRevisionId(head.revision)}`,
        type: 'note-conflict',
        entityId,
        local: cloneJsonValue(primary.value),
        remote: cloneJsonValue(head.value),
        deviceId: head.revision.deviceId,
        at: head.value.updatedAt,
      })
    }
  }

  return { notes, conflicts }
}

export function mergeReadingProgressHistory(
  ...histories: readonly ReadingProgressHistory[]
): ReadingProgressHistory[] {
  const grouped = new Map<string, ReadingProgressPoint[]>()

  for (const history of histories) {
    const points = grouped.get(history.bookId) ?? []
    points.push(...history.history, history.current)
    grouped.set(history.bookId, points)
  }

  return [...grouped.entries()]
    .map(([bookId, points]) => {
      const byRevision = new Map<string, ReadingProgressPoint>()
      for (const point of points) {
        const id = syncRevisionId(point.revision)
        const existing = byRevision.get(id)
        if (
          !existing ||
          canonicalJson(point) > canonicalJson(existing)
        ) {
          byRevision.set(id, cloneJsonValue(point))
        }
      }
      const history = [...byRevision.values()].sort((left, right) =>
        compareSyncRevision(left.revision, right.revision),
      )
      const current = history[history.length - 1]
      if (!current) throw new Error(`progress history for ${bookId} is empty`)
      return { bookId, current, history }
    })
    .sort((left, right) => left.bookId.localeCompare(right.bookId))
}

export function getSyncPolicyDecision(input: SyncPolicyInput): SyncPolicyDecision {
  const metadata =
    input.object === 'metadata' ||
    input.object === 'plugin-data' ||
    input.policy !== 'metadata'
  const selectedBook =
    Boolean(input.bookId && input.selectedBookIds?.includes(input.bookId)) ||
    Boolean(
      input.collectionIds?.some((id) => input.selectedCollectionIds?.includes(id)),
    )

  let syncBookFile = false
  let reason = ''
  switch (input.policy) {
    case 'full':
      syncBookFile = input.object === 'book-file'
      reason = 'full policy transfers every selected book file'
      break
    case 'metadata':
      syncBookFile = false
      reason = 'metadata policy never downloads or uploads book files automatically'
      break
    case 'selected':
      syncBookFile = input.object === 'book-file' && selectedBook
      reason = selectedBook
        ? 'book or collection is selected'
        : 'book is outside the selected books and collections'
      break
    case 'on-demand':
      syncBookFile = input.object === 'book-file' && input.requestedOnDemand === true
      reason = input.requestedOnDemand
        ? 'book was explicitly opened or requested'
        : 'on-demand file transfer has not been requested'
      break
  }

  return {
    syncMetadata: metadata,
    syncBookFile,
    syncTombstones: true,
    deleteRemoteObject: input.object === 'delete',
    reason,
  }
}

async function checksumChange(
  change: SyncChange,
  digest: SyncDigest,
): Promise<SyncChange> {
  const unsigned = {
    id: change.id,
    entityType: change.entityType,
    entityId: change.entityId,
    operation: change.operation,
    value: change.value,
    revision: change.revision,
    parents: change.parents,
    baseChecksum: change.baseChecksum,
  }
  return {
    ...cloneJsonValue(change),
    checksum: await digest(canonicalJson(unsigned)),
  }
}

function unsignedDocument(document: DeviceSyncDocument): Omit<DeviceSyncDocument, 'checksum'> {
  const { checksum: _checksum, ...unsigned } = document
  void _checksum
  return unsigned
}

export async function createDeviceSyncDocument(
  input: DeviceSyncDocumentInput,
  digest: SyncDigest = sha256Hex,
): Promise<DeviceSyncDocument> {
  if (!input.deviceId) throw new TypeError('deviceId is required')
  assertFiniteNonNegative(input.revision, 'document revision')

  const changes = input.changes ?? []
  const tombstones = input.tombstones ?? []
  for (const change of changes) {
    if (change.revision.deviceId !== input.deviceId) {
      throw new Error('a per-device sync document may only contain its own changes')
    }
  }
  for (const tombstone of tombstones) {
    if (tombstone.deviceId !== input.deviceId) {
      throw new Error('a per-device sync document may only contain its own tombstones')
    }
  }

  const sealedChanges = await Promise.all(
    changes.map((change) => checksumChange(change, digest)),
  )
  const unsigned: Omit<DeviceSyncDocument, 'checksum'> = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    deviceId: input.deviceId,
    revision: Math.floor(input.revision),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    changes: sealedChanges,
    tombstones: cloneJsonValue(tombstones),
    pluginData: cloneJsonValue(input.pluginData ?? {}),
    ...(input.metadata ? { metadata: cloneJsonValue(input.metadata) } : {}),
  }
  assertSafeSyncDocument(unsigned)
  const document = {
    ...unsigned,
    checksum: await digest(canonicalJson(unsigned)),
  }
  const validationErrors = validateDeviceSyncDocument(document)
  if (validationErrors.length) {
    throw new TypeError(`invalid sync document: ${validationErrors.join('; ')}`)
  }
  return document
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSyncRevision(value: unknown): value is SyncRevision {
  return (
    isRecord(value) &&
    Number.isInteger(value.counter) &&
    (value.counter as number) >= 0 &&
    typeof value.deviceId === 'string' &&
    !value.deviceId.includes('/') &&
    !value.deviceId.includes('\\') &&
    !value.deviceId.includes('\0')
  )
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

export function validateDeviceSyncDocument(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['document must be an object']
  const document = value as Partial<DeviceSyncDocument>

  if (document.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    errors.push(`unsupported protocolVersion: ${String(document.protocolVersion)}`)
  }
  if (
    typeof document.deviceId !== 'string' ||
    !document.deviceId ||
    document.deviceId.includes('/') ||
    document.deviceId.includes('\\') ||
    document.deviceId.includes('\0') ||
    document.deviceId === '.' ||
    document.deviceId === '..'
  ) {
    errors.push('deviceId must be a non-empty path-safe string')
  }
  if (!Number.isInteger(document.revision) || (document.revision ?? -1) < 0) {
    errors.push('revision must be a non-negative integer')
  }
  if (!isIsoDate(document.generatedAt)) {
    errors.push('generatedAt must be an ISO date')
  }
  if (!Array.isArray(document.changes)) errors.push('changes must be an array')
  if (!Array.isArray(document.tombstones)) errors.push('tombstones must be an array')
  if (!isRecord(document.pluginData)) {
    errors.push('pluginData must be an object')
  }
  if (document.metadata !== undefined && !isRecord(document.metadata)) {
    errors.push('metadata must be an object')
  }
  if (typeof document.checksum !== 'string' || !document.checksum) {
    errors.push('checksum is required')
  }

  const changes = Array.isArray(document.changes) ? document.changes : []
  const tombstones = Array.isArray(document.tombstones) ? document.tombstones : []

  for (const [index, rawChange] of changes.entries()) {
    if (!isRecord(rawChange)) {
      errors.push(`changes.${index} must be an object`)
      continue
    }
    if (typeof rawChange.id !== 'string' || !rawChange.id) {
      errors.push(`changes.${index}.id is required`)
    }
    if (typeof rawChange.entityType !== 'string' || !rawChange.entityType) {
      errors.push(`changes.${index}.entityType is required`)
    }
    if (typeof rawChange.entityId !== 'string' || !rawChange.entityId) {
      errors.push(`changes.${index}.entityId is required`)
    }
    if (rawChange.operation !== 'upsert') {
      errors.push(`changes.${index}.operation must be upsert`)
    }
    if (!isSyncRevision(rawChange.revision)) {
      errors.push(`changes.${index}.revision is invalid`)
    }
    if (
      isRecord(rawChange.revision) &&
      rawChange.revision.deviceId !== document.deviceId
    ) {
      errors.push(`changes.${index}.revision belongs to another device`)
    }
    if (
      rawChange.parents !== undefined &&
      (!Array.isArray(rawChange.parents) || !rawChange.parents.every(isSyncRevision))
    ) {
      errors.push(`changes.${index}.parents must contain valid revisions`)
    }
    if (rawChange.baseChecksum !== undefined && typeof rawChange.baseChecksum !== 'string') {
      errors.push(`changes.${index}.baseChecksum must be a string`)
    }
    if (typeof rawChange.checksum !== 'string' || !rawChange.checksum) {
      errors.push(`changes.${index}.checksum is required`)
    }
  }

  for (const [index, rawTombstone] of tombstones.entries()) {
    if (!isRecord(rawTombstone)) {
      errors.push(`tombstones.${index} must be an object`)
      continue
    }
    if (typeof rawTombstone.id !== 'string' || !rawTombstone.id) {
      errors.push(`tombstones.${index}.id is required`)
    }
    if (typeof rawTombstone.entityType !== 'string' || !rawTombstone.entityType) {
      errors.push(`tombstones.${index}.entityType is required`)
    }
    if (typeof rawTombstone.entityId !== 'string' || !rawTombstone.entityId) {
      errors.push(`tombstones.${index}.entityId is required`)
    }
    if (!isIsoDate(rawTombstone.at)) {
      errors.push(`tombstones.${index}.at must be an ISO date`)
    }
    if (rawTombstone.deviceId !== document.deviceId) {
      errors.push(`tombstones.${index}.deviceId belongs to another device`)
    }
    if (!Number.isInteger(rawTombstone.revision) || (rawTombstone.revision as number) < 0) {
      errors.push(`tombstones.${index}.revision must be a non-negative integer`)
    }
    if (
      rawTombstone.revisionStamp !== undefined &&
      (!isSyncRevision(rawTombstone.revisionStamp) ||
        rawTombstone.revisionStamp.deviceId !== document.deviceId)
    ) {
      errors.push(`tombstones.${index}.revisionStamp is invalid`)
    }
    if (rawTombstone.hash !== undefined && typeof rawTombstone.hash !== 'string') {
      errors.push(`tombstones.${index}.hash must be a string`)
    }
  }
  return errors
}

export async function verifyDeviceSyncDocument(
  document: DeviceSyncDocument,
  digest: SyncDigest = sha256Hex,
): Promise<boolean> {
  const errors = validateDeviceSyncDocument(document)
  if (errors.length) return false
  if (containsSensitiveSyncField(unsignedDocument(document))) return false

  for (const change of document.changes) {
    if (!change.checksum) return false
    const sealed = await checksumChange(change, digest)
    if (sealed.checksum !== change.checksum) return false
  }
  return (await digest(canonicalJson(unsignedDocument(document)))) === document.checksum
}

export async function parseDeviceSyncDocument(
  serialized: string,
  digest: SyncDigest = sha256Hex,
): Promise<DeviceSyncDocument> {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error('sync document is not valid JSON')
  }
  const errors = validateDeviceSyncDocument(parsed)
  if (errors.length) throw new Error(errors.join('; '))
  const document = parsed as DeviceSyncDocument
  if (!(await verifyDeviceSyncDocument(document, digest))) {
    throw new Error('sync document checksum verification failed')
  }
  return document
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function mergePluginDataPair(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  remoteDeviceId: string,
): { pluginData: Record<string, unknown>; conflicts: SyncConflict[] } {
  const pluginData: Record<string, unknown> = cloneJsonValue(local)
  const conflicts: SyncConflict[] = []

  for (const [namespace, remoteValue] of Object.entries(remote)) {
    if (!hasOwn(pluginData, namespace)) {
      setOwn(pluginData, namespace, cloneJsonValue(remoteValue))
      continue
    }

    const localValue = pluginData[namespace]
    if (canonicalJson(localValue) === canonicalJson(remoteValue)) continue

    const bothObjects =
      localValue !== null &&
      remoteValue !== null &&
      typeof localValue === 'object' &&
      typeof remoteValue === 'object' &&
      !Array.isArray(localValue) &&
      !Array.isArray(remoteValue)

    if (bothObjects) {
      const nested = mergePluginDataPair(
        localValue as Record<string, unknown>,
        remoteValue as Record<string, unknown>,
        remoteDeviceId,
      )
      setOwn(pluginData, namespace, nested.pluginData)
      conflicts.push(...nested.conflicts)
      continue
    }

    let conflictNamespace = `${namespace}#conflict-${remoteDeviceId}`
    let suffix = 2
    while (hasOwn(pluginData, conflictNamespace)) {
      conflictNamespace = `${namespace}#conflict-${remoteDeviceId}-${suffix++}`
    }
    setOwn(pluginData, conflictNamespace, cloneJsonValue(remoteValue))
    conflicts.push({
      id: `${namespace}:${remoteDeviceId}`,
      type: 'plugin-data',
      entityId: namespace,
      local: cloneJsonValue(localValue),
      remote: cloneJsonValue(remoteValue),
      deviceId: remoteDeviceId,
      at: new Date(0).toISOString(),
    })
  }

  return { pluginData, conflicts }
}

export function mergeSyncDocuments(
  ...documents: readonly DeviceSyncDocument[]
): MergedSyncDocuments {
  const tombstones = mergeTombstones(...documents.map((document) => document.tombstones))
  const changeByRevision = new Map<string, SyncChange>()

  for (const document of documents) {
    for (const change of filterResurrectedChanges(document.changes, tombstones)) {
      const key = [
        change.entityType,
        change.entityId,
        syncRevisionId(change.revision),
        change.checksum ?? canonicalJson(change),
      ].join('\u0000')
      if (!changeByRevision.has(key)) changeByRevision.set(key, cloneJsonValue(change))
    }
  }

  let pluginData: Record<string, unknown> = {}
  const conflicts: SyncConflict[] = []
  for (const document of documents) {
    const merged = mergePluginDataPair(pluginData, document.pluginData, document.deviceId)
    pluginData = merged.pluginData
    conflicts.push(...merged.conflicts)
  }

  return {
    changes: [...changeByRevision.values()].sort((left, right) => {
      const comparison = compareSyncRevision(left.revision, right.revision)
      if (comparison !== 0) return comparison
      return left.entityId.localeCompare(right.entityId)
    }),
    tombstones,
    pluginData,
    conflicts,
  }
}

function cloneQueuePayload(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return value.slice(0)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
  }
  try {
    return cloneJsonValue(value)
  } catch {
    return value
  }
}

function defaultQueueId(): string {
  const randomUuid = globalThis.crypto?.randomUUID
  if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto)
  fallbackIdCounter += 1
  return `sync-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`
}

async function checksumQueuePayload(payload: unknown, digest: SyncDigest): Promise<string> {
  if (payload instanceof Uint8Array) return digest(payload)
  if (payload instanceof ArrayBuffer) return digest(new Uint8Array(payload))
  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView
    return digest(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  }
  return digest(canonicalJson(payload))
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ABORT_ERR')
  )
}

export class SyncQueueError extends Error {
  readonly retryable: boolean

  constructor(message: string, options: { retryable: boolean; cause?: unknown } = { retryable: true }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SyncQueueError'
    this.retryable = options.retryable
  }
}

export class SyncQueue {
  private readonly digest: SyncDigest
  private readonly now: () => string
  private readonly createId: () => string
  private readonly baseRetryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly items = new Map<string, SyncQueueItem>()
  private readonly controllers = new Map<string, AbortController>()
  private revision = 0

  constructor(options: SyncQueueOptions = {}) {
    this.digest = options.digest ?? sha256Hex
    this.now = options.now ?? (() => new Date().toISOString())
    this.createId = options.createId ?? defaultQueueId
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000
  }

  async enqueue(input: EnqueueSyncItem): Promise<SyncQueueItem> {
    if (input.dedupeKey) {
      const existing = [...this.items.values()].find(
        (item) =>
          item.dedupeKey === input.dedupeKey &&
          item.status !== 'cancelled' &&
          item.status !== 'failed',
      )
      if (existing) return cloneJsonValue(existing)
    }

    const id = input.id ?? this.createId()
    if (this.items.has(id)) throw new Error(`sync queue item already exists: ${id}`)
    const createdAt = this.now()
    const item: SyncQueueItem = {
      id,
      kind: input.kind,
      operation: input.operation,
      key: input.key,
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      payload: cloneQueuePayload(input.payload),
      checksum: await checksumQueuePayload(input.payload, this.digest),
      attempts: 0,
      maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_SYNC_RETRY_ATTEMPTS)),
      createdAt,
      updatedAt: createdAt,
      nextAttemptAt: createdAt,
      status: 'pending',
    }
    this.items.set(id, item)
    this.revision += 1
    return cloneJsonValue(item)
  }

  list(): SyncQueueItem[] {
    return [...this.items.values()]
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt)
        return left.id.localeCompare(right.id)
      })
      .map((item) => cloneJsonValue(item))
  }

  get(id: string): SyncQueueItem | undefined {
    const item = this.items.get(id)
    return item ? cloneJsonValue(item) : undefined
  }

  nextReady(at = this.now()): SyncQueueItem | undefined {
    const atMs = Date.parse(at)
    const ready = [...this.items.values()]
      .filter(
        (item) =>
          item.status === 'pending' &&
          Date.parse(item.nextAttemptAt) <= atMs,
      )
      .sort((left, right) => {
        const byTime = left.nextAttemptAt.localeCompare(right.nextAttemptAt)
        return byTime || left.id.localeCompare(right.id)
      })
    return ready[0] ? cloneJsonValue(ready[0]) : undefined
  }

  async runNext(runner: SyncQueueRunner, signal?: AbortSignal): Promise<SyncQueueItem | undefined> {
    if (signal?.aborted) throw signal.reason ?? new Error('sync queue was cancelled')
    const next = this.nextReady()
    if (!next) return undefined

    const item = this.items.get(next.id)
    if (!item) return undefined

    const controller = new AbortController()
    this.controllers.set(item.id, controller)
    const cancelFromOutside = () => this.cancel(item.id, signal?.reason)
    signal?.addEventListener('abort', cancelFromOutside, { once: true })

    item.status = 'running'
    item.attempts += 1
    item.updatedAt = this.now()
    this.revision += 1

    try {
      const currentChecksum = await checksumQueuePayload(item.payload, this.digest)
      if (currentChecksum !== item.checksum) {
        throw new SyncQueueError('queued payload checksum mismatch', { retryable: false })
      }
      if (controller.signal.aborted) throw controller.signal.reason

      const result = await runner(cloneJsonValue(item), controller.signal)
      if (this.items.get(item.id)?.status !== 'cancelled') {
        item.status = 'succeeded'
        item.result = cloneQueuePayload(result)
        item.error = undefined
      }
    } catch (error) {
      if (this.items.get(item.id)?.status !== 'cancelled') {
        if (isAbortError(error) || controller.signal.aborted) {
          item.status = 'cancelled'
          item.error = String(controller.signal.reason ?? error)
        } else {
          const retryable =
            error instanceof SyncQueueError ? error.retryable : true
          item.error = error instanceof Error ? error.message : String(error)
          if (retryable && item.attempts < item.maxAttempts) {
            item.status = 'pending'
            const delay = Math.min(
              this.maxRetryDelayMs,
              this.baseRetryDelayMs * 2 ** Math.max(0, item.attempts - 1),
            )
            item.nextAttemptAt = new Date(Date.parse(this.now()) + delay).toISOString()
          } else {
            item.status = 'failed'
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancelFromOutside)
      this.controllers.delete(item.id)
      item.updatedAt = this.now()
      this.revision += 1
    }

    return cloneJsonValue(item)
  }

  cancel(id: string, reason: unknown = 'cancelled by user'): boolean {
    const item = this.items.get(id)
    if (!item || item.status === 'succeeded' || item.status === 'failed') return false
    item.status = 'cancelled'
    item.error = reason instanceof Error ? reason.message : String(reason)
    item.updatedAt = this.now()
    this.revision += 1
    this.controllers.get(id)?.abort(reason instanceof Error ? reason : new Error(String(reason)))
    return true
  }

  cancelAll(reason: unknown = 'cancelled by user'): number {
    let cancelled = 0
    for (const item of this.items.values()) {
      if (this.cancel(item.id, reason)) cancelled += 1
    }
    return cancelled
  }

  retry(id: string): boolean {
    const item = this.items.get(id)
    if (!item || (item.status !== 'failed' && item.status !== 'cancelled')) return false
    item.status = 'pending'
    item.attempts = 0
    item.error = undefined
    item.nextAttemptAt = this.now()
    item.updatedAt = item.nextAttemptAt
    this.revision += 1
    return true
  }

  removeFinished(): number {
    let removed = 0
    for (const [id, item] of this.items) {
      if (item.status === 'succeeded' || item.status === 'failed' || item.status === 'cancelled') {
        this.items.delete(id)
        removed += 1
      }
    }
    if (removed) this.revision += 1
    return removed
  }

  snapshot(): SyncQueueSnapshot {
    return {
      revision: this.revision,
      items: this.list().map((item) => ({
        ...item,
        payload: cloneQueuePayload(item.payload),
      })),
    }
  }

  restore(snapshot: SyncQueueSnapshot): void {
    this.items.clear()
    for (const item of snapshot.items) {
      this.items.set(item.id, {
        ...cloneJsonValue(item),
        payload: cloneQueuePayload(item.payload),
        status: item.status === 'running' ? 'pending' : item.status,
      })
    }
    this.revision = snapshot.revision
  }
}
