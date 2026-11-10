<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  AlertTriangle,
  BarChart3,
  BookOpenCheck,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Flame,
  Goal,
  Pencil,
  Save,
  Timer,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import BookCover from '../components/BookCover.vue';
import DialogPanel from '../components/DialogPanel.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import ProgressRing from '../components/ProgressRing.vue';
import {
  dateKey,
  durationLabel,
  durationParts,
  formatDate,
  formatDateTime,
  progressFor,
} from '../components/utils';
import type { ReadingSession } from '../types';
import {
  aggregateReadingSessions,
  buildReadingCalendar,
  calculateGoalProgress,
  dedupeReadingSessions,
  summarizeReadingSessions,
} from '../../packages/core/index';
import {
  readStatisticsViewState,
  writeStatisticsViewState,
  type StatisticsRange,
} from '../services/view-state';

const app = useApp();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const range = ref<StatisticsRange>(readStatisticsViewState().range);
const calendarMonth = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
const selectedDate = ref(dateKey(new Date()));
const goalDraft = ref(app.settings.dailyGoal);
const goalSaving = ref(false);
const correctionTarget = ref<ReadingSession | null>(null);
const correctionStart = ref('');
const correctionEnd = ref('');
const correctionMinutes = ref('0');
const correctionError = ref('');
const savingCorrection = ref(false);

watch(range, (value) => {
  writeStatisticsViewState({ range: value });
});

watch(
  () => app.settings.dailyGoal,
  (value) => {
    goalDraft.value = value;
  },
);

const rangeStart = computed(() => {
  const now = new Date();
  if (range.value === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range.value === 'week') {
    const day = now.getDay() || 7;
    const value = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    value.setDate(value.getDate() - day + 1);
    return value;
  }
  if (range.value === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  return new Date(now.getFullYear(), 0, 1);
});

const rangeFromKey = computed(() => dateKey(rangeStart.value));
const rangeToKey = computed(() => dateKey(new Date()));
const dedupedSessions = computed(() => dedupeReadingSessions([...app.sessions]));
const dailyAggregates = computed(() =>
  aggregateReadingSessions(dedupedSessions.value, {
    granularity: 'day',
    timeZone,
    from: rangeFromKey.value,
    to: rangeToKey.value,
  }),
);
const monthlyAggregates = computed(() =>
  aggregateReadingSessions(dedupedSessions.value, {
    granularity: 'month',
    timeZone,
    from: rangeFromKey.value,
    to: rangeToKey.value,
  }),
);
const dailyByDate = computed(
  () => new Map(dailyAggregates.value.map((entry) => [entry.key, entry])),
);
const rangeSessionIds = computed(
  () => new Set(dailyAggregates.value.flatMap((entry) => entry.sessionIds)),
);
const rangeSessions = computed(() =>
  dedupedSessions.value
    .filter((session) => rangeSessionIds.value.has(session.id))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
);
const rangeContributionBySession = computed(() => {
  const values = new Map<string, number>();
  for (const session of rangeSessions.value) {
    const total = aggregateReadingSessions([session], {
      granularity: 'day',
      timeZone,
      from: rangeFromKey.value,
      to: rangeToKey.value,
    }).reduce((sum, entry) => sum + entry.activeMs, 0);
    values.set(session.id, total);
  }
  return values;
});
const totalMs = computed(() =>
  dailyAggregates.value.reduce((sum, entry) => sum + entry.activeMs, 0),
);
const readingDays = computed(
  () => dailyAggregates.value.filter((entry) => entry.activeMs > 0).length,
);
const averageMs = computed(() => (readingDays.value ? totalMs.value / readingDays.value : 0));
const sessionCount = computed(() => rangeSessionIds.value.size);
const completedBooks = computed(() => {
  const ids = new Set(rangeSessions.value.map((session) => session.bookId));
  return app.books.filter(
    (book) =>
      ids.has(book.id) &&
      book.status === 'finished' &&
      new Date(book.updatedAt).getTime() >= rangeStart.value.getTime() &&
      new Date(book.updatedAt).getTime() <= Date.now(),
  );
});

const streak = computed(
  () =>
    summarizeReadingSessions(dedupedSessions.value, {
      timeZone,
      today: new Date(),
    }).currentStreak,
);

const elapsedDays = computed(() => {
  const [startYear, startMonth, startDay] = rangeFromKey.value.split('-').map(Number);
  const [endYear, endMonth, endDay] = rangeToKey.value.split('-').map(Number);
  const start = Date.UTC(startYear, startMonth - 1, startDay);
  const end = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
});
const targetMs = computed(() => app.settings.dailyGoal * elapsedDays.value * 60_000);
const goal = computed(() =>
  calculateGoalProgress(dedupedSessions.value, {
    goalMs: Math.max(1, targetMs.value),
    timeZone,
    from: rangeFromKey.value,
    to: rangeToKey.value,
  }),
);
const goalProgress = computed(() => goal.value.ratio * 100);

const trend = computed(() => {
  if (range.value === 'year') {
    const monthlyByKey = new Map(monthlyAggregates.value.map((entry) => [entry.key, entry]));
    return Array.from({ length: 12 }, (_, index) => {
      const key = `${rangeStart.value.getFullYear()}-${String(index + 1).padStart(2, '0')}`;
      return { key, label: `${index + 1}月`, value: monthlyByKey.get(key)?.activeMs || 0 };
    });
  }
  if (range.value === 'month') {
    const year = rangeStart.value.getFullYear();
    const month = rangeStart.value.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: days }, (_, index) => {
      const date = new Date(year, month, index + 1);
      const key = dateKey(date);
      return {
        key,
        label: `${index + 1}`,
        value: dailyByDate.value.get(key)?.activeMs || 0,
      };
    });
  }
  if (range.value === 'week') {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(rangeStart.value);
      date.setDate(date.getDate() + index);
      const key = dateKey(date);
      return {
        key,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        value: dailyByDate.value.get(key)?.activeMs || 0,
      };
    });
  }
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    key: String(hour),
    label: String(hour).padStart(2, '0'),
    value: 0,
  }));
  for (const session of rangeSessions.value) {
    for (const contribution of sessionHourContributions(session, rangeToKey.value)) {
      if (hourly[contribution.hour]) hourly[contribution.hour].value += contribution.activeMs;
    }
  }
  return hourly;
});
const trendMax = computed(() => Math.max(1, ...trend.value.map((item) => item.value)));

const bookBreakdown = computed(() => {
  const values = new Map<string, number>();
  for (const session of rangeSessions.value) {
    values.set(
      session.bookId,
      (values.get(session.bookId) || 0) + (rangeContributionBySession.value.get(session.id) || 0),
    );
  }
  return [...values.entries()]
    .map(([bookId, activeMs]) => ({ book: app.books.find((book) => book.id === bookId), activeMs }))
    .filter((item): item is { book: NonNullable<typeof item.book>; activeMs: number } => Boolean(item.book))
    .sort((a, b) => b.activeMs - a.activeMs);
});

const tagDistribution = computed(() => {
  const colors = ['#8067ce', '#9f82d9', '#c09bc6', '#809e9d', '#b18b72', '#7f8bb6', '#b47f8d'];
  const values = new Map<string, { label: string; value: number; color: string }>();
  for (const entry of bookBreakdown.value) {
    const tags = app.tags.filter((tag) => entry.book.tagIds.includes(tag.id));
    if (!tags.length) {
      const item = values.get('uncategorized') || { label: '未分类', value: 0, color: colors[0] };
      item.value += entry.activeMs;
      values.set('uncategorized', item);
    } else {
      const share = entry.activeMs / tags.length;
      for (const tag of tags) {
        const item = values.get(tag.id) || { label: tag.name, value: 0, color: tag.color || colors[values.size % colors.length] };
        item.value += share;
        values.set(tag.id, item);
      }
    }
  }
  const items = [...values.values()].sort((a, b) => b.value - a.value);
  let cursor = 0;
  const segments = items.map((item) => {
    const start = cursor;
    const end = cursor + (totalMs.value ? (item.value / totalMs.value) * 100 : 0);
    cursor = end;
    return { ...item, start, end };
  });
  return segments;
});

const distributionStyle = computed(() => {
  if (!tagDistribution.value.length) return { background: 'var(--surface-muted)' };
  return {
    background: `conic-gradient(${tagDistribution.value
      .map((item) => `${item.color} ${item.start}% ${item.end}%`)
      .join(', ')})`,
  };
});

const calendarDays = computed(() => {
  const year = calendarMonth.value.getFullYear();
  const month = calendarMonth.value.getMonth();
  const first = new Date(year, month, 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const cells = 42;
  const firstDate = new Date(year, month, 1 - mondayOffset);
  const lastDate = new Date(firstDate);
  lastDate.setDate(lastDate.getDate() + cells - 1);
  const calendarValues = new Map(
    buildReadingCalendar(app.sessions, {
      timeZone,
      from: dateKey(firstDate),
      to: dateKey(lastDate),
    }).map((entry) => [entry.key, entry.activeMs]),
  );
  return Array.from({ length: cells }, (_, index) => {
    const date = new Date(year, month, index - mondayOffset + 1);
    const key = dateKey(date);
    return {
      date,
      key,
      activeMs: calendarValues.get(key) || 0,
      outside: date.getMonth() !== month,
    };
  });
});
const calendarMax = computed(() => Math.max(1, ...calendarDays.value.map((day) => day.activeMs)));
const selectedDayValues = computed(
  () =>
    new Map(
      aggregateReadingSessions(dedupedSessions.value, {
        granularity: 'day',
        timeZone,
        from: selectedDate.value,
        to: selectedDate.value,
      })
        .flatMap((entry) => entry.sessionIds)
        .map((id) => {
          const activeMs = aggregateReadingSessions(
            dedupedSessions.value.filter((session) => session.id === id),
            {
              granularity: 'day',
              timeZone,
              from: selectedDate.value,
              to: selectedDate.value,
            },
          ).reduce((sum, entry) => sum + entry.activeMs, 0);
          return [id, activeMs] as const;
        }),
    ),
);
const selectedDaySessions = computed(() =>
  dedupedSessions.value
    .filter((session) => selectedDayValues.value.has(session.id))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
);
const selectedDayMs = computed(() =>
  [...selectedDayValues.value.values()].reduce((sum, value) => sum + value, 0),
);

const recentSessions = computed(() =>
  [...rangeSessions.value].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 12),
);

function sessionContribution(session: ReadingSession) {
  return rangeContributionBySession.value.get(session.id) || 0;
}

function dayContribution(session: ReadingSession) {
  return selectedDayValues.value.get(session.id) || 0;
}

function sessionHourContributions(session: ReadingSession, dayKey: string) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const dayStart = new Date(year, month - 1, day).getTime();
  const dayEnd = new Date(year, month - 1, day + 1).getTime();
  const sessionStart = Date.parse(session.startedAt);
  const sessionEnd = Date.parse(session.endedAt);
  const activeMs = aggregateReadingSessions([session], {
    granularity: 'day',
    timeZone,
    from: dayKey,
    to: dayKey,
  }).reduce((sum, entry) => sum + entry.activeMs, 0);
  if (!activeMs || !Number.isFinite(sessionStart) || !Number.isFinite(sessionEnd)) return [];
  const clippedStart = Math.max(dayStart, sessionStart);
  const clippedEnd = Math.min(dayEnd, sessionEnd > sessionStart ? sessionEnd : sessionStart + 1);
  if (clippedEnd <= clippedStart) {
    return [{ hour: new Date(sessionStart).getHours(), activeMs }];
  }

  const segments: Array<{ hour: number; wallMs: number; activeMs: number }> = [];
  let cursor = clippedStart;
  let attributed = 0;
  while (cursor < clippedEnd) {
    const date = new Date(cursor);
    const next = Math.min(
      clippedEnd,
      new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours() + 1,
      ).getTime(),
    );
    const wallMs = Math.max(1, next - cursor);
    const isLast = next === clippedEnd;
    const segmentActive = isLast
      ? activeMs - attributed
      : Math.round((activeMs * wallMs) / Math.max(1, clippedEnd - clippedStart));
    attributed += segmentActive;
    segments.push({ hour: date.getHours(), wallMs, activeMs: Math.max(0, segmentActive) });
    cursor = next;
  }
  return segments;
}

function toLocalDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function openSessionCorrection(session: ReadingSession) {
  if (app.activeSession?.id === session.id) {
    app.notify('当前正在进行的阅读会话需先退出阅读器后再修正。');
    return;
  }
  correctionTarget.value = session;
  correctionStart.value = toLocalDateTime(session.startedAt);
  correctionEnd.value = toLocalDateTime(session.endedAt);
  correctionMinutes.value = (Math.max(0, session.activeMs) / 60_000).toFixed(1);
  correctionError.value = '';
}

async function saveSessionCorrection() {
  const target = correctionTarget.value;
  if (!target) return;
  if (app.activeSession?.id === target.id) {
    correctionError.value = '当前活动会话不能在这里修改。';
    return;
  }
  const startedAt = new Date(correctionStart.value);
  const endedAt = new Date(correctionEnd.value);
  const activeMinutes = Number(correctionMinutes.value);
  const wallMs = endedAt.getTime() - startedAt.getTime();
  const activeMs = Math.round(activeMinutes * 60_000);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    correctionError.value = '开始和结束时间必须有效。';
    return;
  }
  if (wallMs <= 0) {
    correctionError.value = '结束时间必须晚于开始时间。';
    return;
  }
  if (!Number.isFinite(activeMs) || activeMs <= 0) {
    correctionError.value = '有效阅读时长必须大于 0 分钟。';
    return;
  }
  if (activeMs > wallMs + 1_000) {
    correctionError.value = '有效阅读时长不能超过开始与结束时间之间的跨度。';
    return;
  }

  const priorReason = (target.pauseReason || '').replace(/(?:\s*·\s*)?手动修正/g, '').trim();
  const corrected: ReadingSession = {
    ...target,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    activeMs,
    pauseReason: priorReason ? `${priorReason} · 手动修正` : '手动修正',
  };
  savingCorrection.value = true;
  correctionError.value = '';
  try {
    const extendedApp = app as typeof app & {
      updateSession?: (session: ReadingSession) => Promise<void>;
    };
    if (extendedApp.updateSession) {
      await extendedApp.updateSession(corrected);
    } else {
      const index = app.sessions.findIndex((session) => session.id === corrected.id);
      if (index < 0) throw new Error('阅读会话已不存在，未保存修正。');
      app.sessions.splice(index, 1, corrected);
      await app.persist();
      app.notify('阅读会话已修正，统计已重新计算');
    }
    selectedDate.value = dateKey(new Date(corrected.startedAt));
    correctionTarget.value = null;
  } catch (error) {
    correctionError.value = error instanceof Error ? error.message : String(error);
    app.error = correctionError.value;
  } finally {
    savingCorrection.value = false;
  }
}

function shiftCalendar(amount: number) {
  calendarMonth.value = new Date(
    calendarMonth.value.getFullYear(),
    calendarMonth.value.getMonth() + amount,
    1,
  );
}

function isToday(key: string) {
  return key === dateKey(new Date());
}

function heatLevel(ms: number) {
  if (!ms) return 0;
  return Math.max(1, Math.ceil((ms / calendarMax.value) * 4));
}

async function saveGoal() {
  const value = Math.max(1, Math.round(Number(goalDraft.value) || 0));
  app.settings.dailyGoal = value;
  goalSaving.value = true;
  try {
    await app.saveSettings();
  } finally {
    goalSaving.value = false;
  }
}
</script>

<template>
  <div class="statistics-view page-view">
    <PageHeader title="统计" description="所有数值均由本机阅读会话重新计算；没有记录的日期不会补造趋势。">
      <template #actions>
        <div class="segmented" role="group" aria-label="统计范围">
          <button v-for="item in [{ id: 'day', label: '日' }, { id: 'week', label: '周' }, { id: 'month', label: '月' }, { id: 'year', label: '年' }]" :key="item.id" type="button" :class="{ 'is-active': range === item.id }" @click="range = item.id">
            {{ item.label }}
          </button>
        </div>
      </template>
    </PageHeader>

    <section class="stat-cards">
      <article class="surface-card stat-card stat-card--primary">
        <div class="stat-card__icon"><Clock3 :size="20" /></div>
        <span>本{{ range === 'day' ? '日' : range === 'week' ? '周' : range === 'month' ? '月' : '年' }}阅读</span>
        <strong>{{ durationLabel(totalMs) }}</strong>
        <small>{{ sessionCount }} 个有效会话</small>
      </article>
      <article class="surface-card stat-card">
        <div class="stat-card__icon"><CalendarDays :size="20" /></div>
        <span>阅读天数</span>
        <strong>{{ readingDays }} 天</strong>
        <small>日均 {{ readingDays ? durationLabel(averageMs) : '—' }}</small>
      </article>
      <article class="surface-card stat-card">
        <div class="stat-card__icon"><Flame :size="20" /></div>
        <span>连续阅读</span>
        <strong>{{ streak }} 天</strong>
        <small>截至今天</small>
      </article>
      <article class="surface-card stat-card">
        <div class="stat-card__icon"><BookOpenCheck :size="20" /></div>
        <span>本周期读完</span>
        <strong>{{ completedBooks.length }} 本</strong>
        <small>{{ bookBreakdown.length }} 本书产生阅读记录</small>
      </article>
    </section>

    <div class="stats-layout stats-layout--top">
      <section class="surface-card section-card trend-card">
        <div class="section-heading">
          <h2>阅读趋势</h2>
          <span class="muted">{{ formatDate(rangeStart.toISOString()) }}起</span>
        </div>
        <div v-if="rangeSessions.length" class="trend-chart" :class="{ 'trend-chart--dense': range === 'month' }">
          <button
            v-for="item in trend"
            :key="item.key"
            type="button"
            class="trend-chart__column"
            :title="`${item.label}：${durationLabel(item.value)}`"
            @click="range === 'day' || range === 'year' ? undefined : (selectedDate = item.key)"
          >
            <span class="trend-chart__value" :style="{ height: `${item.value ? Math.max(3, (item.value / trendMax) * 100) : 0}%` }"></span>
            <small>{{ item.label }}</small>
          </button>
        </div>
        <EmptyState
          v-else
          compact
          title="这个时间范围内还没有阅读记录"
          description="打开一本书开始阅读，统计会实时从真实会话中生成。"
          action-label="前往书架"
          @action="app.navigate('bookshelf')"
        />
      </section>

      <section class="surface-card section-card goal-detail">
        <div class="section-heading"><h2>阅读目标</h2><Goal :size="18" /></div>
        <div class="goal-detail__ring">
          <ProgressRing :value="goalProgress" :size="164" :stroke="12" :label="`阅读目标完成 ${Math.round(goalProgress)}%`">
            <strong>{{ Math.round(goalProgress) }}%</strong>
            <small>本期目标</small>
          </ProgressRing>
        </div>
        <div class="goal-detail__facts">
          <div><span>已完成</span><strong>{{ durationLabel(totalMs) }}</strong></div>
          <div><span>目标</span><strong>{{ durationLabel(targetMs) }}</strong></div>
        </div>
        <form class="goal-form" @submit.prevent="saveGoal">
          <label for="daily-goal">每日目标</label>
          <div>
            <input id="daily-goal" v-model.number="goalDraft" class="field" type="number" min="1" max="1440" inputmode="numeric" />
            <span>分钟</span>
            <button class="button button--secondary button--small" type="submit" :disabled="goalSaving || goalDraft === app.settings.dailyGoal">
              <Check :size="14" />{{ goalSaving ? '保存中' : '保存' }}
            </button>
          </div>
        </form>
      </section>
    </div>

    <div class="stats-layout stats-layout--middle">
      <section class="surface-card section-card calendar-card">
        <div class="section-heading calendar-heading">
          <h2>阅读日历</h2>
          <div>
            <button class="icon-button icon-button--small" type="button" aria-label="上个月" @click="shiftCalendar(-1)"><ChevronLeft :size="16" /></button>
            <strong>{{ calendarMonth.getFullYear() }} 年 {{ calendarMonth.getMonth() + 1 }} 月</strong>
            <button class="icon-button icon-button--small" type="button" aria-label="下个月" @click="shiftCalendar(1)"><ChevronRight :size="16" /></button>
          </div>
        </div>
        <div class="calendar-weekdays" aria-hidden="true">
          <span v-for="weekday in ['一', '二', '三', '四', '五', '六', '日']" :key="weekday">{{ weekday }}</span>
        </div>
        <div class="calendar-grid" role="grid" aria-label="月阅读日历">
          <button
            v-for="day in calendarDays"
            :key="day.key"
            type="button"
            role="gridcell"
            :class="[
              `heat-${heatLevel(day.activeMs)}`,
              { 'is-outside': day.outside, 'is-today': isToday(day.key), 'is-selected': selectedDate === day.key },
            ]"
            :aria-label="`${day.date.getMonth() + 1}月${day.date.getDate()}日，阅读${durationLabel(day.activeMs)}`"
            :aria-selected="selectedDate === day.key"
            @click="selectedDate = day.key"
          >
            {{ day.date.getDate() }}
          </button>
        </div>
        <div class="calendar-legend"><span>少</span><i class="heat-0"></i><i class="heat-1"></i><i class="heat-2"></i><i class="heat-3"></i><i class="heat-4"></i><span>多</span></div>
      </section>

      <section class="surface-card section-card selected-day">
        <div class="section-heading">
          <h2>{{ formatDate(`${selectedDate}T12:00:00`) }}会话</h2>
          <span class="muted">{{ durationLabel(selectedDayMs) }}</span>
        </div>
        <div v-if="selectedDaySessions.length" class="session-list">
          <article v-for="session in selectedDaySessions" :key="session.id" class="session-row">
            <span class="session-row__time">{{ new Date(session.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</span>
            <div>
              <button type="button" @click="app.navigate('book-detail', session.bookId)">
                {{ app.books.find((book) => book.id === session.bookId)?.title || '书籍记录不可用' }}
              </button>
              <span>{{ durationLabel(dayContribution(session)) }}<template v-if="session.pauseReason"> · {{ session.pauseReason }}</template></span>
            </div>
            <button
              class="icon-button icon-button--small session-row__edit"
              type="button"
              :aria-label="`修正 ${app.books.find((book) => book.id === session.bookId)?.title || '阅读'} 的会话`"
              @click="openSessionCorrection(session)"
            >
              <Pencil :size="14" />
            </button>
          </article>
        </div>
        <EmptyState v-else compact title="这一天没有阅读会话" description="有记录时，这里会展示开始时间、书籍与有效阅读时长。" />
      </section>

      <section class="surface-card section-card distribution-card">
        <div class="section-heading"><h2>阅读分布</h2></div>
        <div v-if="tagDistribution.length" class="distribution">
          <div class="distribution__donut" :style="distributionStyle">
            <span><strong>{{ durationParts(totalMs).hours }}</strong>小时</span>
          </div>
          <div class="distribution__legend">
            <div v-for="item in tagDistribution" :key="item.label">
              <span :style="{ background: item.color }"></span>
              <span>{{ item.label }}</span>
              <strong>{{ Math.round((item.value / Math.max(1, totalMs)) * 100) }}%</strong>
            </div>
          </div>
        </div>
        <EmptyState v-else compact title="暂无可分布数据" description="会话关联书籍的标签后，将按标签呈现阅读时间分布。" />
      </section>
    </div>

    <div class="stats-layout stats-layout--bottom">
      <section class="surface-card section-card">
        <div class="section-heading"><h2>书籍阅读时长</h2><span class="muted">{{ bookBreakdown.length }} 本</span></div>
        <div v-if="bookBreakdown.length" class="ranking-list">
          <button v-for="(entry, index) in bookBreakdown.slice(0, 8)" :key="entry.book.id" type="button" @click="app.navigate('book-detail', entry.book.id)">
            <span class="ranking-number">{{ index + 1 }}</span>
            <BookCover :book="entry.book" compact />
            <span class="ranking-book"><strong>{{ entry.book.title }}</strong><small>{{ durationLabel(entry.activeMs) }}</small></span>
            <ProgressRing :value="progressFor(entry.book)" :size="32" :stroke="3" />
          </button>
        </div>
        <EmptyState v-else compact title="还没有书籍阅读时长" description="开始阅读后自动累计。" />
      </section>

      <section class="surface-card section-card">
        <div class="section-heading"><h2>最近会话</h2><Timer :size="18" /></div>
        <div v-if="recentSessions.length" class="data-list">
          <div v-for="session in recentSessions" :key="session.id" class="data-row">
            <span class="session-dot"><BarChart3 :size="15" /></span>
            <div class="data-row__body">
              <strong>{{ app.books.find((book) => book.id === session.bookId)?.title || '书籍记录不可用' }}</strong>
              <span>{{ formatDateTime(session.startedAt) }} · {{ durationLabel(sessionContribution(session)) }}</span>
            </div>
            <button
              class="icon-button icon-button--small"
              type="button"
              :aria-label="`修正 ${app.books.find((book) => book.id === session.bookId)?.title || '阅读'} 的会话`"
              @click="openSessionCorrection(session)"
            >
              <Pencil :size="14" />
            </button>
          </div>
        </div>
        <EmptyState v-else compact title="还没有会话" description="有效阅读会话会显示在这里。" />
      </section>

      <section class="surface-card section-card">
        <div class="section-heading"><h2>阅读进度</h2></div>
        <div v-if="app.books.length" class="progress-books">
          <button
            v-for="book in [...app.books].sort((a, b) => progressFor(b) - progressFor(a)).slice(0, 5)"
            :key="book.id"
            type="button"
            @click="app.navigate('book-detail', book.id)"
          >
            <span><strong>{{ book.title }}</strong><small>{{ book.status === 'finished' ? '已读' : book.status === 'unread' ? '未读' : `${Math.round(progressFor(book))}%` }}</small></span>
            <ProgressRing :value="progressFor(book)" :size="34" :stroke="3.5" />
          </button>
        </div>
        <EmptyState v-else compact title="书架为空" description="导入书籍后查看进度。" action-label="导入书籍" @action="app.navigate('import')" />
      </section>
    </div>

    <DialogPanel
      v-if="correctionTarget"
      title="修正阅读会话"
      description="修正会直接参与日、周、月、年统计。开始和结束时间可在不同日期，有效时长不能超过会话时间跨度。"
      @close="correctionTarget = null"
    >
      <div class="correction-book">
        <BookOpenCheck :size="18" />
        <span>
          <strong>{{ app.books.find((book) => book.id === correctionTarget?.bookId)?.title || '书籍记录不可用' }}</strong>
          <small>会话 {{ correctionTarget?.id }}</small>
        </span>
      </div>
      <div class="form-grid correction-form">
        <label class="form-field">
          <span>开始时间</span>
          <input v-model="correctionStart" class="field" type="datetime-local" />
        </label>
        <label class="form-field">
          <span>结束时间</span>
          <input v-model="correctionEnd" class="field" type="datetime-local" />
        </label>
        <label class="form-field">
          <span>有效阅读时长（分钟）</span>
          <input v-model="correctionMinutes" class="field" type="number" min="0.1" step="0.1" inputmode="decimal" />
        </label>
      </div>
      <div v-if="correctionError" class="correction-error" role="alert">
        <AlertTriangle :size="16" />{{ correctionError }}
      </div>
      <p class="correction-note">原始设备、书籍、阅读位置与标注关联保持不变；当前活动会话不能修改。</p>
      <template #footer>
        <button class="button button--ghost" type="button" @click="correctionTarget = null">取消</button>
        <button class="button button--primary" type="button" :disabled="savingCorrection" @click="saveSessionCorrection">
          <Save :size="15" />{{ savingCorrection ? '保存中' : '保存修正' }}
        </button>
      </template>
    </DialogPanel>
  </div>
</template>

<style scoped>
.statistics-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.stat-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.85rem;
}

.stat-card {
  display: grid;
  min-height: 146px;
  align-content: end;
  gap: 0.22rem;
  padding: 1.1rem;
  overflow: hidden;
}

.stat-card--primary {
  color: #fff;
  background:
    radial-gradient(circle at 90% 0, rgba(255, 255, 255, 0.22), transparent 36%),
    linear-gradient(145deg, #7460ba, #9a80d5);
}

.stat-card__icon {
  display: grid;
  width: 35px;
  height: 35px;
  place-items: center;
  border-radius: 11px;
  margin-bottom: auto;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.stat-card--primary .stat-card__icon {
  color: #fff;
  background: rgba(255, 255, 255, 0.16);
}

.stat-card > span {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.stat-card--primary > span,
.stat-card--primary > small {
  color: rgba(255, 255, 255, 0.76);
}

.stat-card > strong {
  font-family: var(--font-display);
  font-size: clamp(1.6rem, 3vw, 2.15rem);
  font-weight: 600;
  letter-spacing: -0.02em;
}

.stat-card > small {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.stats-layout {
  display: grid;
  gap: 1rem;
}

.stats-layout--top {
  grid-template-columns: minmax(0, 1.55fr) minmax(280px, 0.6fr);
}

.stats-layout--middle {
  grid-template-columns: minmax(360px, 1.2fr) minmax(250px, 0.72fr) minmax(250px, 0.72fr);
}

.stats-layout--bottom {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.trend-card {
  min-height: 310px;
}

.trend-chart {
  display: flex;
  height: 225px;
  align-items: flex-end;
  gap: clamp(4px, 1vw, 10px);
  padding-top: 1rem;
  border-bottom: 1px solid var(--border);
}

.trend-chart--dense {
  gap: 3px;
}

.trend-chart__column {
  display: flex;
  height: 100%;
  min-width: 0;
  flex: 1;
  align-items: center;
  flex-direction: column;
  justify-content: flex-end;
  gap: 0.4rem;
  padding: 0;
  border: 0;
  background: transparent;
}

.trend-chart__value {
  width: min(18px, 75%);
  min-height: 0;
  border-radius: 5px 5px 1px 1px;
  background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 26%, transparent));
  transition: height var(--motion-slow) var(--ease-out);
}

.trend-chart__column:hover .trend-chart__value {
  background: var(--accent-strong);
}

.trend-chart__column small {
  overflow: hidden;
  width: 100%;
  color: var(--text-tertiary);
  font-size: 0.75rem;
  text-align: center;
  text-overflow: ellipsis;
}

.goal-detail {
  display: flex;
  flex-direction: column;
}

.goal-detail__ring {
  display: grid;
  min-height: 185px;
  place-items: center;
}

.goal-detail__ring :deep(.progress-ring__content) {
  display: grid;
  place-items: center;
}

.goal-detail__ring :deep(.progress-ring__content strong) {
  color: var(--text);
  font-family: var(--font-display);
  font-size: 2.1rem;
}

.goal-detail__ring :deep(.progress-ring__content small) {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.goal-detail__facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  margin-bottom: 0.85rem;
}

.goal-detail__facts div {
  display: grid;
  gap: 0.1rem;
  padding: 0.6rem;
  border-radius: 10px;
  background: var(--surface-muted);
}

.goal-detail__facts span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.goal-detail__facts strong {
  font-size: 0.77rem;
}

.goal-form {
  display: grid;
  gap: 0.35rem;
}

.goal-form > label {
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 650;
}

.goal-form > div {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 0.35rem;
}

.goal-form .field {
  min-width: 0;
  min-height: 34px;
}

.goal-form > div > span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.calendar-heading > div {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.calendar-heading > div > strong {
  min-width: 105px;
  font-size: 0.75rem;
  text-align: center;
}

.calendar-weekdays,
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 5px;
}

.calendar-weekdays {
  margin-bottom: 5px;
}

.calendar-weekdays span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  text-align: center;
}

.calendar-grid button {
  position: relative;
  aspect-ratio: 1;
  min-height: 31px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.calendar-grid .is-outside {
  color: var(--text-tertiary);
  opacity: 0.4;
}

.calendar-grid .is-today {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.calendar-grid .is-selected {
  border-color: var(--accent-strong);
  color: var(--text);
  outline: 2px solid color-mix(in srgb, var(--accent) 18%, transparent);
}

.heat-0 { background: var(--surface-muted); }
.heat-1 { background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated)); }
.heat-2 { background: color-mix(in srgb, var(--accent) 25%, var(--surface-elevated)); }
.heat-3 { background: color-mix(in srgb, var(--accent) 42%, var(--surface-elevated)); color: var(--text); }
.heat-4 { background: var(--accent); color: var(--accent-contrast); }

.calendar-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 0.6rem;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.calendar-legend i {
  width: 12px;
  height: 12px;
  border-radius: 3px;
}

.session-list {
  display: grid;
  gap: 0.2rem;
  max-height: 300px;
  overflow-y: auto;
}

.session-row {
  display: flex;
  gap: 0.65rem;
  padding: 0.65rem 0;
  border-bottom: 1px solid var(--border);
}

.session-row__time {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.session-row div {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 0.15rem;
}

.session-row button {
  overflow: hidden;
  padding: 0;
  border: 0;
  color: var(--text);
  background: transparent;
  font-size: 0.75rem;
  font-weight: 650;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-row div span {
  color: var(--text-secondary);
  font-size: 0.76rem;
}

.session-row .session-row__edit {
  flex: 0 0 auto;
  margin-left: auto;
}

.distribution {
  display: grid;
  min-height: 230px;
  place-items: center;
  gap: 1rem;
}

.distribution__donut {
  position: relative;
  display: grid;
  width: 128px;
  height: 128px;
  place-items: center;
  border-radius: 50%;
}

.distribution__donut::after {
  position: absolute;
  width: 76px;
  height: 76px;
  border-radius: 50%;
  background: var(--surface-elevated);
  content: '';
}

.distribution__donut span {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.distribution__donut strong {
  color: var(--text);
  font-family: var(--font-display);
  font-size: 1.55rem;
  line-height: 1;
}

.distribution__legend {
  display: grid;
  width: 100%;
  gap: 0.35rem;
}

.distribution__legend div {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
}

.distribution__legend div > span:first-child {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.distribution__legend div > span:nth-child(2) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.distribution__legend strong {
  color: var(--text-secondary);
}

.ranking-list,
.progress-books {
  display: grid;
  gap: 0.25rem;
}

.ranking-list button {
  display: grid;
  grid-template-columns: 16px 32px minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
  padding: 0.4rem;
  border: 0;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  text-align: left;
}

.ranking-list button:hover,
.progress-books button:hover {
  background: var(--surface-muted);
}

.ranking-number {
  color: var(--text-tertiary);
  font-family: var(--font-display);
  font-size: 1rem;
  text-align: center;
}

.ranking-book,
.progress-books button > span {
  display: grid;
  min-width: 0;
}

.ranking-book strong,
.progress-books strong {
  overflow: hidden;
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ranking-book small,
.progress-books small {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.session-dot {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.progress-books button {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.55rem 0.4rem;
  border: 0;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  text-align: left;
}

.progress-books button > span {
  flex: 1;
}

.correction-book {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.75rem;
  border-radius: 11px;
  margin-bottom: 0.9rem;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.correction-book > span {
  display: grid;
  min-width: 0;
  gap: 0.1rem;
}

.correction-book strong,
.correction-book small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.correction-book strong {
  color: var(--text);
  font-size: 0.82rem;
}

.correction-book small {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.correction-form {
  grid-template-columns: 1fr 1fr;
}

.correction-form .form-field:last-child {
  grid-column: 1 / -1;
}

.correction-error {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  padding: 0.65rem;
  border-radius: 9px;
  margin-top: 0.75rem;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 0.78rem;
  line-height: 1.5;
}

.correction-note {
  margin: 0.75rem 0 0;
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.55;
}

@media (max-width: 1200px) {
  .stats-layout--middle {
    grid-template-columns: 1fr 1fr;
  }

  .distribution-card {
    grid-column: 1 / -1;
  }

  .distribution {
    grid-template-columns: 160px minmax(0, 1fr);
  }

  .stats-layout--bottom {
    grid-template-columns: 1fr 1fr;
  }

  .stats-layout--bottom > :last-child {
    grid-column: 1 / -1;
  }
}

@media (max-width: 900px) {
  .stat-cards {
    grid-template-columns: 1fr 1fr;
  }

  .stats-layout--top {
    grid-template-columns: 1fr;
  }

  .goal-detail {
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    align-items: center;
    gap: 1rem;
  }

  .goal-detail > .section-heading {
    grid-column: 1 / -1;
  }

  .goal-detail__ring {
    min-height: 0;
  }
}

@media (max-width: 680px) {
  .stats-layout--middle,
  .stats-layout--bottom {
    grid-template-columns: 1fr;
  }

  .distribution-card,
  .stats-layout--bottom > :last-child {
    grid-column: auto;
  }

  .goal-detail {
    display: flex;
  }

  .trend-chart {
    gap: 3px;
  }

  .trend-chart__column small {
    font-size: 0.75rem;
  }
}

@media (max-width: 420px) {
  .stat-cards {
    gap: 0.6rem;
  }

  .stat-card {
    min-height: 132px;
    padding: 0.85rem;
  }

  .stat-card > strong {
    font-size: 1.45rem;
  }

  .calendar-grid {
    gap: 3px;
  }

  .correction-form {
    grid-template-columns: 1fr;
  }

  .correction-form .form-field:last-child {
    grid-column: auto;
  }
}
</style>

