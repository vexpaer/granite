import type { ReaderLocation, ReadingSession } from '../../src/types'
import { dedupeReadingSessions } from './sync'

export type AnalyticsGranularity = 'day' | 'week' | 'month' | 'year'
export type ReadingVisibility = 'visible' | 'hidden'

export interface ReadingAggregate {
  key: string
  activeMs: number
  sessionCount: number
  bookCount: number
  sessionIds: string[]
  bookIds: string[]
}

export interface ReadingAggregationOptions {
  granularity?: AnalyticsGranularity
  timeZone?: string
  from?: string | Date
  to?: string | Date
}

export interface ReadingSummary {
  totalActiveMs: number
  sessionCount: number
  bookCount: number
  activeDays: number
  currentStreak: number
  longestStreak: number
}

export interface GoalProgress {
  activeMs: number
  goalMs: number
  remainingMs: number
  ratio: number
  complete: boolean
}

export interface ReadingTrackerOptions {
  bookId: string
  deviceId: string
  sessionId?: string
  idleMs?: number
  monotonic: () => number
  now?: () => string | Date
  createId?: () => string
  visibility?: ReadingVisibility
  startLocation?: ReaderLocation
}

export interface ReadingTrackerSnapshot {
  sessionId: string
  deviceId: string
  bookId: string
  startedAt: string
  activeMs: number
  visibility: ReadingVisibility
  running: boolean
  pauseReason?: string
  startLocation?: ReaderLocation
  endLocation?: ReaderLocation
  lastMonotonicMs: number
  lastActivityMonotonicMs: number
}

interface DateParts {
  year: number
  month: number
  day: number
}

interface DayContribution {
  activeMs: number
  sessionIds: Set<string>
  bookIds: Set<string>
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()
let fallbackTrackerId = 0

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  formatterCache.set(timeZone, formatter)
  return formatter
}

function zonedDateParts(milliseconds: number, timeZone: string): DateParts {
  const parts = dateFormatter(timeZone).formatToParts(new Date(milliseconds))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  }
}

function dateKey(milliseconds: number, timeZone: string): string {
  const parts = zonedDateParts(milliseconds, timeZone)
  return `${parts.year.toString().padStart(4, '0')}-${parts.month
    .toString()
    .padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`
}

function boundaryDateKey(value: string | Date | undefined, timeZone: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new TypeError('analytics range boundary is invalid')
  return dateKey(milliseconds, timeZone)
}

function firstInstantOnDifferentDate(
  startMilliseconds: number,
  endMilliseconds: number,
  startKey: string,
  timeZone: string,
): number | undefined {
  if (dateKey(endMilliseconds, timeZone) === startKey) return undefined
  let low = startMilliseconds + 1
  let high = endMilliseconds
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (dateKey(middle, timeZone) === startKey) low = middle + 1
    else high = middle
  }
  return low
}

function splitSessionAcrossLocalDays(
  session: ReadingSession,
  timeZone: string,
): Array<{ day: string; activeMs: number }> {
  const start = Date.parse(session.startedAt)
  const end = Date.parse(session.endedAt)
  const activeMs = Math.max(0, Number.isFinite(session.activeMs) ? session.activeMs : 0)
  if (!Number.isFinite(start) || !Number.isFinite(end) || activeMs === 0) return []
  if (end <= start) return [{ day: dateKey(start, timeZone), activeMs }]

  const wallDuration = end - start
  const output: Array<{ day: string; activeMs: number }> = []
  let cursor = start
  let attributed = 0

  while (cursor < end) {
    const currentDay = dateKey(cursor, timeZone)
    const nextBoundary = firstInstantOnDifferentDate(cursor, end, currentDay, timeZone)
    const segmentEnd = nextBoundary ?? end
    const isLast = segmentEnd === end
    const segmentActive = isLast
      ? activeMs - attributed
      : Math.round((activeMs * (segmentEnd - cursor)) / wallDuration)
    attributed += segmentActive
    output.push({ day: currentDay, activeMs: Math.max(0, segmentActive) })
    cursor = segmentEnd
  }

  return output
}

function isoWeekKey(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, date))
  const weekday = value.getUTCDay() || 7
  value.setUTCDate(value.getUTCDate() + 4 - weekday)
  const weekYear = value.getUTCFullYear()
  const yearStart = new Date(Date.UTC(weekYear, 0, 1))
  const week = Math.ceil(
    ((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  )
  return `${weekYear}-W${week.toString().padStart(2, '0')}`
}

function periodKey(day: string, granularity: AnalyticsGranularity): string {
  switch (granularity) {
    case 'day':
      return day
    case 'week':
      return isoWeekKey(day)
    case 'month':
      return day.slice(0, 7)
    case 'year':
      return day.slice(0, 4)
  }
}

function nextDayKey(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, date + 1))
  return value.toISOString().slice(0, 10)
}

function previousDayKey(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, date - 1))
  return value.toISOString().slice(0, 10)
}

function dayContributions(
  sessions: readonly ReadingSession[],
  timeZone: string,
  from?: string,
  to?: string,
): Map<string, DayContribution> {
  const days = new Map<string, DayContribution>()
  for (const session of dedupeReadingSessions([...sessions])) {
    for (const contribution of splitSessionAcrossLocalDays(session, timeZone)) {
      if (from && contribution.day < from) continue
      if (to && contribution.day > to) continue
      const day = days.get(contribution.day) ?? {
        activeMs: 0,
        sessionIds: new Set<string>(),
        bookIds: new Set<string>(),
      }
      day.activeMs += contribution.activeMs
      day.sessionIds.add(session.id)
      day.bookIds.add(session.bookId)
      days.set(contribution.day, day)
    }
  }
  return days
}

export function aggregateReadingSessions(
  sessions: readonly ReadingSession[],
  options: ReadingAggregationOptions = {},
): ReadingAggregate[] {
  const timeZone = options.timeZone ?? 'UTC'
  const granularity = options.granularity ?? 'day'
  const from = boundaryDateKey(options.from, timeZone)
  const to = boundaryDateKey(options.to, timeZone)
  const contributions = dayContributions(sessions, timeZone, from, to)
  const periods = new Map<string, DayContribution>()

  for (const [day, contribution] of contributions) {
    const key = periodKey(day, granularity)
    const period = periods.get(key) ?? {
      activeMs: 0,
      sessionIds: new Set<string>(),
      bookIds: new Set<string>(),
    }
    period.activeMs += contribution.activeMs
    for (const id of contribution.sessionIds) period.sessionIds.add(id)
    for (const id of contribution.bookIds) period.bookIds.add(id)
    periods.set(key, period)
  }

  return [...periods.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, contribution]) => ({
      key,
      activeMs: Math.max(0, Math.round(contribution.activeMs)),
      sessionCount: contribution.sessionIds.size,
      bookCount: contribution.bookIds.size,
      sessionIds: [...contribution.sessionIds].sort(),
      bookIds: [...contribution.bookIds].sort(),
    }))
}

export const aggregateReadingByDate = aggregateReadingSessions

export function summarizeReadingSessions(
  sessions: readonly ReadingSession[],
  options: Pick<ReadingAggregationOptions, 'timeZone' | 'from' | 'to'> & {
    today?: string | Date
  } = {},
): ReadingSummary {
  const timeZone = options.timeZone ?? 'UTC'
  const deduped = dedupeReadingSessions([...sessions])
  const daily = aggregateReadingSessions(deduped, {
    granularity: 'day',
    timeZone,
    from: options.from,
    to: options.to,
  })
  const activeDays = daily.filter((entry) => entry.activeMs > 0).map((entry) => entry.key)
  const activeDaySet = new Set(activeDays)

  let longestStreak = 0
  let runningStreak = 0
  let previous: string | undefined
  for (const day of activeDays) {
    runningStreak =
      previous && nextDayKey(previous) === day
        ? runningStreak + 1
        : 1
    longestStreak = Math.max(longestStreak, runningStreak)
    previous = day
  }

  const today = boundaryDateKey(options.today ?? new Date(), timeZone) as string
  let cursor = activeDaySet.has(today) ? today : previousDayKey(today)
  let currentStreak = 0
  while (activeDaySet.has(cursor)) {
    currentStreak += 1
    cursor = previousDayKey(cursor)
  }

  return {
    totalActiveMs: deduped.reduce((total, session) => total + Math.max(0, session.activeMs), 0),
    sessionCount: deduped.length,
    bookCount: new Set(deduped.map((session) => session.bookId)).size,
    activeDays: activeDays.length,
    currentStreak,
    longestStreak,
  }
}

export function buildReadingCalendar(
  sessions: readonly ReadingSession[],
  options: Omit<ReadingAggregationOptions, 'granularity'> = {},
): ReadingAggregate[] {
  return aggregateReadingSessions(sessions, { ...options, granularity: 'day' })
}

export function calculateGoalProgress(
  sessions: readonly ReadingSession[],
  options: Omit<ReadingAggregationOptions, 'granularity'> & { goalMs: number },
): GoalProgress {
  if (!Number.isFinite(options.goalMs) || options.goalMs <= 0) {
    throw new TypeError('reading goal must be a positive duration')
  }
  const detail = aggregateReadingSessions(sessions, {
    granularity: 'day',
    timeZone: options.timeZone,
    from: options.from,
    to: options.to,
  })
  const activeMs = detail.reduce((total, entry) => total + entry.activeMs, 0)
  return {
    activeMs,
    goalMs: options.goalMs,
    remainingMs: Math.max(0, options.goalMs - activeMs),
    ratio: Math.min(1, activeMs / options.goalMs),
    complete: activeMs >= options.goalMs,
  }
}

function defaultWallNow(): string {
  return new Date().toISOString()
}

function defaultId(): string {
  const randomUuid = globalThis.crypto?.randomUUID
  if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto)
  fallbackTrackerId += 1
  return `session-${Date.now().toString(36)}-${fallbackTrackerId.toString(36)}`
}

function wallIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('wall clock returned an invalid date')
  return date.toISOString()
}

export class ReadingTracker {
  readonly sessionId: string
  readonly deviceId: string
  readonly bookId: string
  readonly startedAt: string
  private readonly monotonic: () => number
  private readonly now: () => string | Date
  private readonly idleMs: number
  private activeMs = 0
  private visibility: ReadingVisibility
  private running: boolean
  private manualPause = false
  private pauseReason: string | undefined
  private startLocation: ReaderLocation | undefined
  private endLocation: ReaderLocation | undefined
  private lastMonotonicMs: number
  private lastActivityMonotonicMs: number
  private ended = false

  constructor(options: ReadingTrackerOptions) {
    if (!options.bookId) throw new TypeError('tracker bookId is required')
    if (!options.deviceId) throw new TypeError('tracker deviceId is required')
    const idleMs = options.idleMs ?? 5 * 60_000
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
      throw new TypeError('idleMs must be a positive duration')
    }

    this.sessionId = options.sessionId ?? (options.createId ?? defaultId)()
    this.deviceId = options.deviceId
    this.bookId = options.bookId
    this.monotonic = options.monotonic
    this.now = options.now ?? defaultWallNow
    this.idleMs = idleMs
    this.visibility = options.visibility ?? 'visible'
    this.running = this.visibility === 'visible'
    this.startLocation = options.startLocation
      ? structuredClone(options.startLocation)
      : undefined
    this.endLocation = this.startLocation
    this.startedAt = wallIso(this.now())
    this.lastMonotonicMs = this.monotonic()
    this.lastActivityMonotonicMs = this.lastMonotonicMs
  }

  private assertActive(): void {
    if (this.ended) throw new Error('reading tracker session already ended')
  }

  private flush(location?: ReaderLocation): void {
    const now = this.monotonic()
    if (now < this.lastMonotonicMs) {
      throw new Error('monotonic clock moved backwards')
    }
    if (this.running) {
      const activeEnd = Math.min(now, this.lastActivityMonotonicMs + this.idleMs)
      this.activeMs += Math.max(0, activeEnd - this.lastMonotonicMs)
      if (now - this.lastActivityMonotonicMs >= this.idleMs) {
        this.running = false
        this.pauseReason = 'idle'
      }
    }
    this.lastMonotonicMs = now
    if (location) this.endLocation = structuredClone(location)
  }

  activity(location?: ReaderLocation): void {
    this.assertActive()
    this.flush(location)
    const now = this.monotonic()
    this.lastActivityMonotonicMs = now
    if (this.visibility === 'visible' && !this.manualPause) {
      this.running = true
      this.pauseReason = undefined
    }
  }

  setVisibility(state: ReadingVisibility, location?: ReaderLocation): void {
    this.assertActive()
    this.flush(location)
    this.visibility = state
    if (state === 'hidden') {
      this.running = false
      this.pauseReason = 'hidden'
    } else if (!this.manualPause) {
      this.lastActivityMonotonicMs = this.monotonic()
      this.running = true
      this.pauseReason = undefined
    }
  }

  pause(reason = 'paused', location?: ReaderLocation): void {
    this.assertActive()
    this.flush(location)
    this.manualPause = true
    this.running = false
    this.pauseReason = reason
  }

  resume(location?: ReaderLocation): void {
    this.assertActive()
    this.flush(location)
    this.manualPause = false
    this.lastActivityMonotonicMs = this.monotonic()
    if (this.visibility === 'visible') {
      this.running = true
      this.pauseReason = undefined
    }
  }

  checkpoint(location?: ReaderLocation): number {
    this.assertActive()
    this.flush(location)
    return Math.round(this.activeMs)
  }

  end(location?: ReaderLocation): ReadingSession {
    this.assertActive()
    this.checkpoint(location)
    this.ended = true
    return {
      id: this.sessionId,
      deviceId: this.deviceId,
      bookId: this.bookId,
      startedAt: this.startedAt,
      endedAt: wallIso(this.now()),
      activeMs: Math.round(this.activeMs),
      ...(this.startLocation ? { startLocation: structuredClone(this.startLocation) } : {}),
      ...(this.endLocation ? { endLocation: structuredClone(this.endLocation) } : {}),
      ...(this.pauseReason ? { pauseReason: this.pauseReason } : {}),
    }
  }

  snapshot(): ReadingTrackerSnapshot {
    return {
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      bookId: this.bookId,
      startedAt: this.startedAt,
      activeMs: Math.round(this.activeMs),
      visibility: this.visibility,
      running: this.running,
      ...(this.pauseReason ? { pauseReason: this.pauseReason } : {}),
      ...(this.startLocation ? { startLocation: structuredClone(this.startLocation) } : {}),
      ...(this.endLocation ? { endLocation: structuredClone(this.endLocation) } : {}),
      lastMonotonicMs: this.lastMonotonicMs,
      lastActivityMonotonicMs: this.lastActivityMonotonicMs,
    }
  }
}

export class ReadingSessionLog {
  private readonly sessions = new Map<string, ReadingSession>()

  add(session: ReadingSession): boolean {
    if (this.sessions.has(session.id)) return false
    this.sessions.set(session.id, structuredClone(session))
    return true
  }

  merge(sessions: readonly ReadingSession[]): ReadingSession[] {
    for (const session of sessions) this.add(session)
    return this.values()
  }

  values(): ReadingSession[] {
    return mergeSessionValues([...this.sessions.values()])
  }
}

function mergeSessionValues(sessions: ReadingSession[]): ReadingSession[] {
  return dedupeReadingSessions(sessions)
}
