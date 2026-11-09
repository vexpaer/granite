import { describe, expect, it } from 'vitest'
import type { ReadingSession } from '../../src/types'
import {
  aggregateReadingByDate,
  calculateGoalProgress,
  ReadingSessionLog,
  ReadingTracker,
  summarizeReadingSessions,
} from './index'

function session(
  id: string,
  startedAt: string,
  endedAt: string,
  activeMs: number,
  bookId = 'book-1',
): ReadingSession {
  return {
    id,
    deviceId: 'device-a',
    bookId,
    startedAt,
    endedAt,
    activeMs,
  }
}

describe('reading analytics', () => {
  it('deduplicates sessions and splits active time across local dates', () => {
    const crossingMidnight = session(
      'session-crossing',
      '2026-11-08T23:30:00.000Z',
      '2026-11-09T00:30:00.000Z',
      60 * 60_000,
    )
    const aggregate = aggregateReadingByDate(
      [crossingMidnight, crossingMidnight],
      { timeZone: 'UTC' },
    )

    expect(aggregate.map((entry) => [entry.key, entry.activeMs])).toEqual([
      ['2026-11-08', 30 * 60_000],
      ['2026-11-09', 30 * 60_000],
    ])
    expect(aggregate.every((entry) => entry.sessionCount === 1)).toBe(true)
  })

  it('uses the requested timezone and computes goals and streaks', () => {
    const sessions = [
      session(
        'day-1',
        '2026-11-07T12:00:00.000Z',
        '2026-11-07T12:10:00.000Z',
        10 * 60_000,
      ),
      session(
        'day-2',
        '2026-11-08T12:00:00.000Z',
        '2026-11-08T12:10:00.000Z',
        10 * 60_000,
      ),
      session(
        'local-date',
        '2026-11-09T00:30:00.000Z',
        '2026-11-09T00:35:00.000Z',
        5 * 60_000,
        'book-2',
      ),
    ]

    expect(
      aggregateReadingByDate(sessions, { timeZone: 'America/Los_Angeles' }).find(
        (entry) => entry.sessionIds.includes('local-date'),
      )?.key,
    ).toBe('2026-11-08')

    const summary = summarizeReadingSessions(sessions, {
      timeZone: 'UTC',
      today: '2026-11-09',
    })
    expect(summary).toMatchObject({
      totalActiveMs: 25 * 60_000,
      sessionCount: 3,
      bookCount: 2,
      activeDays: 3,
      currentStreak: 3,
      longestStreak: 3,
    })
    expect(
      calculateGoalProgress(sessions, { timeZone: 'UTC', goalMs: 30 * 60_000 }),
    ).toEqual({
      activeMs: 25 * 60_000,
      goalMs: 30 * 60_000,
      remainingMs: 5 * 60_000,
      ratio: 25 / 30,
      complete: false,
    })
  })

  it('uses monotonic time and excludes hidden or idle periods', () => {
    let monotonic = 0
    let wall = Date.parse('2026-11-09T00:00:00.000Z')
    const tracker = new ReadingTracker({
      bookId: 'book-1',
      deviceId: 'device-a',
      sessionId: 'tracked-session',
      idleMs: 5_000,
      monotonic: () => monotonic,
      now: () => new Date(wall).toISOString(),
    })

    monotonic = 1_000
    expect(tracker.checkpoint()).toBe(1_000)
    monotonic = 1_500
    tracker.setVisibility('hidden')
    monotonic = 10_000
    tracker.setVisibility('visible')
    monotonic = 12_000
    wall += 12_000
    const result = tracker.end()

    expect(result.activeMs).toBe(3_500)
    expect(result.pauseReason).toBeUndefined()

    let idleClock = 0
    const idle = new ReadingTracker({
      bookId: 'book-1',
      deviceId: 'device-a',
      sessionId: 'idle-session',
      idleMs: 5_000,
      monotonic: () => idleClock,
    })
    idleClock = 20_000
    expect(idle.checkpoint()).toBe(5_000)
    expect(idle.snapshot()).toMatchObject({
      running: false,
      pauseReason: 'idle',
    })
  })

  it('keeps one copy of a session received more than once', () => {
    const log = new ReadingSessionLog()
    const value = session(
      'deduplicated',
      '2026-11-09T00:00:00.000Z',
      '2026-11-09T00:01:00.000Z',
      60_000,
    )

    expect(log.add(value)).toBe(true)
    expect(log.add(value)).toBe(false)
    expect(log.merge([value])).toHaveLength(1)
  })
})
