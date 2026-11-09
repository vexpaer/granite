<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowRight,
  BookOpen,
  Clock3,
  FilePlus2,
  Flame,
  NotebookPen,
  Play,
  Plus,
  Sparkles,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import BookCover from '../components/BookCover.vue';
import EmptyState from '../components/EmptyState.vue';
import PluginSlots from '../components/PluginSlots.vue';
import ProgressRing from '../components/ProgressRing.vue';
import { resolveHomeLayout } from '../components/homeLayout';
import {
  authorsLabel,
  dateKey,
  durationLabel,
  formatDate,
  normalizedProgress,
  plainText,
  progressFor,
  progressLabel,
  relativeTime,
} from '../components/utils';
import {
  aggregateReadingSessions,
  calculateGoalProgress,
} from '../../packages/core/index';

const app = useApp();
const period = ref<'week' | 'month' | 'year'>('week');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const homeLayout = computed(() => resolveHomeLayout(app.settings.layout));
const visibleHomeModules = computed(() =>
  homeLayout.value.order.filter((id) => !homeLayout.value.hidden.includes(id)),
);

const readingBooks = computed(() =>
  [...app.books]
    .filter((book) => book.status === 'reading')
    .sort((a, b) => Date.parse(b.lastReadAt || b.updatedAt) - Date.parse(a.lastReadAt || a.updatedAt)),
);
const continueBook = computed(() => readingBooks.value[0]);
const recentBooks = computed(() =>
  [...app.books]
    .sort((a, b) => Date.parse(b.lastReadAt || b.updatedAt) - Date.parse(a.lastReadAt || a.updatedAt))
    .slice(0, homeLayout.value.counts.recent),
);
const recentNotes = computed(() =>
  [...app.notes]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, homeLayout.value.counts.notes),
);
const pinnedTags = computed(() =>
  [...app.tags]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, homeLayout.value.counts.tags),
);

const rangeStart = computed(() => {
  const now = new Date();
  if (period.value === 'week') {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekday = date.getDay() || 7;
    date.setDate(date.getDate() - weekday + 1);
    return date;
  }
  if (period.value === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  return new Date(now.getFullYear(), 0, 1);
});

const todayKey = computed(() => dateKey(new Date()));
const rangeFromKey = computed(() => dateKey(rangeStart.value));
const dailyAggregates = computed(() =>
  aggregateReadingSessions(app.sessions, {
    granularity: 'day',
    timeZone,
    from: rangeFromKey.value,
    to: todayKey.value,
  }),
);
const monthlyAggregates = computed(() =>
  aggregateReadingSessions(app.sessions, {
    granularity: 'month',
    timeZone,
    from: rangeFromKey.value,
    to: todayKey.value,
  }),
);
const dailyByDate = computed(
  () => new Map(dailyAggregates.value.map((entry) => [entry.key, entry])),
);
const periodSessionIds = computed(
  () =>
    new Set(
      dailyAggregates.value.flatMap((entry) => entry.sessionIds),
    ),
);
const periodSessions = computed(() =>
  app.sessions.filter((session) => periodSessionIds.value.has(session.id)),
);
const periodMs = computed(() =>
  dailyAggregates.value.reduce((total, entry) => total + entry.activeMs, 0),
);
const activeDays = computed(
  () => dailyAggregates.value.filter((entry) => entry.activeMs > 0).length,
);
const averageMs = computed(() =>
  activeDays.value ? periodMs.value / activeDays.value : 0,
);
const finishedBookIds = computed(
  () =>
    new Set(
      app.sessions
        .filter((session) => periodSessionIds.value.has(session.id))
        .map((session) => session.bookId),
    ),
);
const finishedCount = computed(
  () =>
    app.books.filter(
      (book) =>
        finishedBookIds.value.has(book.id) &&
        book.status === 'finished' &&
        new Date(book.updatedAt).getTime() >= rangeStart.value.getTime() &&
        new Date(book.updatedAt).getTime() <= Date.now(),
    ).length,
);

const trend = computed(() => {
  if (period.value === 'week') {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(rangeStart.value);
      date.setDate(date.getDate() + index);
      const key = dateKey(date);
      return {
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        value: dailyByDate.value.get(key)?.activeMs || 0,
      };
    });
  }
  if (period.value === 'month') {
    const days = Math.max(1, new Date().getDate());
    const segments = Math.min(10, days);
    return Array.from({ length: segments }, (_, index) => {
      const from = Math.floor((index * days) / segments) + 1;
      const to = Math.floor(((index + 1) * days) / segments);
      const value = dailyAggregates.value
        .filter((entry) => {
          const day = Number(entry.key.slice(-2));
          return day >= from && day <= to;
        })
        .reduce((sum, entry) => sum + entry.activeMs, 0);
      return { label: from === to ? String(from) : `${from}–${to}`, value };
    });
  }
  const monthlyByKey = new Map(monthlyAggregates.value.map((entry) => [entry.key, entry]));
  return Array.from({ length: 12 }, (_, index) => {
    const key = `${new Date().getFullYear()}-${String(index + 1).padStart(2, '0')}`;
    return { label: `${index + 1}月`, value: monthlyByKey.get(key)?.activeMs || 0 };
  });
});
const maxTrend = computed(() => Math.max(1, ...trend.value.map((item) => item.value)));

const todayGoal = computed(() =>
  calculateGoalProgress(app.sessions, {
    goalMs: Math.max(1, app.settings.dailyGoal) * 60_000,
    timeZone,
    from: todayKey.value,
    to: todayKey.value,
  }),
);
const todayMs = computed(() => todayGoal.value.activeMs);
const goalPercent = computed(() => todayGoal.value.ratio * 100);
const goalRemaining = computed(() => todayGoal.value.remainingMs);
const greeting = computed(() => {
  const hour = new Date().getHours();
  return hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
});
const username = computed(() => app.settings.username?.trim() || '读者');

function tagCount(tagId: string) {
  return (
    app.books.filter((book) => book.tagIds.includes(tagId)).length +
    app.notes.filter((note) => note.tagIds.includes(tagId)).length
  );
}

function openBook(bookId: string) {
  app.navigate('book-detail', bookId);
}

function readBook(bookId: string) {
  const book = app.books.find((item) => item.id === bookId);
  if (book) app.openReader(book.id, book.location);
}

async function createNote() {
  await app.newNote();
  app.navigate('notebook');
}

async function toggleFavorite(bookId: string) {
  const book = app.books.find((item) => item.id === bookId);
  if (!book) return;
  await app.saveBook({ ...book, favorite: !book.favorite, updatedAt: new Date().toISOString() });
}
</script>

<template>
  <div class="home-view page-view">
    <section class="home-hero">
      <div class="home-hero__landscape" aria-hidden="true"></div>
      <div class="home-hero__shade" aria-hidden="true"></div>
      <div class="home-hero__content">
        <span class="home-hero__date">{{ new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()) }}</span>
        <h1>{{ greeting }}，{{ username }}</h1>
        <p>把今天读到的一句话，留在安静的书房里。</p>
      </div>
      <button class="home-hero__import" type="button" @click="app.navigate('import')">
        <FilePlus2 :size="17" />导入书籍
      </button>
    </section>

    <section v-if="!app.books.length" class="surface-card home-first-run">
      <div class="home-first-run__copy">
        <h2>从第一本书开始</h2>
        <p>导入 EPUB、PDF、TXT 或 MOBI，或先选择一个书库文件夹。</p>
        <div class="inline-actions">
          <button class="button button--primary" type="button" @click="app.navigate('import')">
            <Plus :size="16" />导入第一本书
          </button>
          <button class="button button--secondary" type="button" @click="app.navigate('settings', 'library')">
            选择书库文件夹
          </button>
        </div>
      </div>
    </section>

    <div class="home-layout">
      <template v-for="module in visibleHomeModules" :key="module">
        <section v-if="module === 'continue'" class="surface-card continue-card home-module--continue">
          <div class="section-heading">
            <h2>继续阅读</h2>
            <button type="button" @click="app.navigate('bookshelf', 'reading')">阅读中</button>
          </div>
          <template v-if="continueBook">
            <div class="continue-card__body">
              <button type="button" class="continue-card__cover" @click="openBook(continueBook.id)">
                <BookCover :book="continueBook" />
              </button>
              <div class="continue-card__copy">
                <button type="button" class="continue-card__title" @click="openBook(continueBook.id)">
                  {{ continueBook.title }}
                </button>
                <p v-if="authorsLabel(continueBook)">{{ authorsLabel(continueBook) }}</p>
                <blockquote v-if="continueBook.location?.quote">“{{ continueBook.location.quote }}”</blockquote>
                <div class="continue-card__progress">
                  <ProgressRing
                    :value="progressFor(continueBook)"
                    :size="48"
                    :stroke="4"
                    :label="`阅读进度 ${Math.round(progressFor(continueBook))}%`"
                  >
                    {{ Math.round(progressFor(continueBook)) }}%
                  </ProgressRing>
                  <div>
                    <strong>{{ progressLabel(continueBook) }}</strong>
                    <span>{{ continueBook.location?.chapter ? `第 ${continueBook.location.chapter} 章` : '上次阅读位置已记录' }}</span>
                  </div>
                </div>
              </div>
              <button class="button button--primary continue-card__action" type="button" @click="readBook(continueBook.id)">
                <Play :size="16" fill="currentColor" />继续阅读
              </button>
            </div>
          </template>
          <EmptyState
            v-else
            compact
            title="还没有正在阅读的书"
            description="从书架选择一本书，阅读位置会自动保存。"
            action-label="前往书架"
            @action="app.navigate('bookshelf')"
          />
        </section>

        <section v-else-if="module === 'recent'" class="surface-card recent-books-card home-module--recent-books">
          <div class="section-heading">
            <h2>最近阅读</h2>
            <button type="button" @click="app.navigate('bookshelf', 'recent')">
              查看全部 <ArrowRight :size="14" />
            </button>
          </div>
          <div v-if="recentBooks.length" class="recent-books">
            <article v-for="book in recentBooks" :key="book.id" class="recent-book">
              <button type="button" @click="openBook(book.id)">
                <BookCover :book="book" compact />
              </button>
              <button type="button" class="recent-book__title" @click="openBook(book.id)">{{ book.title }}</button>
              <span>{{ progressLabel(book) }}</span>
            </article>
          </div>
          <EmptyState
            v-else
            compact
            title="还没有最近阅读"
            description="打开一本书后，最近记录会出现在这里。"
            action-label="前往书架"
            @action="app.navigate('bookshelf')"
          />
        </section>

        <section v-else-if="module === 'notes'" class="surface-card section-card notes-card home-module--recent-notes">
          <div class="section-heading">
            <h2>最近笔记</h2>
            <button type="button" @click="createNote"><Plus :size="14" />新建笔记</button>
          </div>
          <div v-if="recentNotes.length" class="data-list">
            <button
              v-for="note in recentNotes"
              :key="note.id"
              class="data-row note-row"
              type="button"
              @click="app.navigate('notebook', note.id)"
            >
              <span class="note-row__icon"><NotebookPen :size="17" /></span>
              <span class="data-row__body">
                <strong>{{ note.title || '未命名笔记' }}</strong>
                <span>{{ plainText(note.body) || '空白笔记' }}</span>
              </span>
              <time :datetime="note.updatedAt">{{ relativeTime(note.updatedAt) }}</time>
            </button>
          </div>
          <EmptyState
            v-else
            compact
            title="还没有笔记"
            description="新建一篇笔记，或用 WikiLink 开始连接阅读。"
            action-label="新建笔记"
            @action="createNote"
          />
        </section>

        <section v-else-if="module === 'statistics'" class="surface-card section-card stats-mini home-module--statistics">
          <div class="section-heading">
            <h2>阅读统计</h2>
            <div class="segmented" role="group" aria-label="统计时间范围">
              <button v-for="item in [{ id: 'week', label: '周' }, { id: 'month', label: '月' }, { id: 'year', label: '年' }]" :key="item.id" type="button" :class="{ 'is-active': period === item.id }" @click="period = item.id as typeof period">
                {{ item.label }}
              </button>
            </div>
          </div>
          <div class="stats-mini__hero">
            <div>
              <span>本{{ period === 'week' ? '周' : period === 'month' ? '月' : '年' }}阅读</span>
              <strong>{{ durationLabel(periodMs) }}</strong>
            </div>
            <Sparkles :size="22" aria-hidden="true" />
          </div>
          <div v-if="periodSessions.length" class="mini-chart" role="img" :aria-label="`${trend.length} 个时间段的阅读时长趋势`">
            <span
              v-for="item in trend"
              :key="item.label"
              class="mini-chart__bar"
              :style="{ height: `${Math.max(7, (item.value / maxTrend) * 100)}%` }"
              :title="`${item.label}：${durationLabel(item.value)}`"
            ></span>
          </div>
          <div v-else class="mini-chart-empty">
            <Clock3 :size="20" />
            <span>此时间范围内还没有阅读会话</span>
          </div>
          <div class="stats-mini__facts">
            <div><strong>{{ finishedCount }}</strong><span>读完</span></div>
            <div><strong>{{ activeDays }}</strong><span>阅读天</span></div>
            <div><strong>{{ activeDays ? durationLabel(averageMs, true) : '—' }}</strong><span>日均</span></div>
          </div>
          <button class="stats-mini__link" type="button" @click="app.navigate('statistics')">
            查看统计 <ArrowRight :size="14" />
          </button>
        </section>

        <section v-else-if="module === 'goal'" class="surface-card section-card goal-card home-module--goal">
          <div class="section-heading">
            <h2>今日目标</h2>
            <button type="button" @click="app.navigate('statistics')">调整目标</button>
          </div>
          <div class="goal-card__main">
            <ProgressRing :value="goalPercent" :size="134" :stroke="11" :label="`今日目标完成 ${Math.round(goalPercent)}%`">
              <strong>{{ Math.round(goalPercent) }}%</strong>
              <small>今日</small>
            </ProgressRing>
            <div class="goal-card__copy">
              <span>已完成</span>
              <strong>{{ durationLabel(todayMs, true) }}</strong>
              <span>目标 {{ app.settings.dailyGoal }} 分钟</span>
              <p v-if="goalRemaining">{{ durationLabel(goalRemaining, true) }}后完成</p>
              <p v-else>今日目标已完成</p>
            </div>
          </div>
        </section>

        <section v-else-if="module === 'tags'" class="surface-card tags-strip home-module--tags">
          <div class="section-heading">
            <h2>我的标签</h2>
            <button type="button" @click="app.navigate('tags')">管理标签 <ArrowRight :size="14" /></button>
          </div>
          <div v-if="pinnedTags.length" class="tags-strip__items">
            <button
              v-for="tag in pinnedTags"
              :key="tag.id"
              class="home-tag"
              type="button"
              :style="{ '--tag-color': tag.color }"
              @click="app.navigate('tag-results', tag.id)"
            >
              <span class="home-tag__dot"></span>
              <span># {{ tag.name }}</span>
              <strong>{{ tagCount(tag.id) }}</strong>
            </button>
          </div>
          <EmptyState
            v-else
            compact
            title="还没有标签"
            description="标签可以同时整理书籍和笔记。"
            action-label="创建标签"
            @action="app.navigate('tags')"
          />
        </section>
      </template>
    </div>

    <div class="home-plugin-slot">
      <PluginSlots slot="app.dashboard" />
    </div>

    <section v-if="app.books.length" class="home-footnote">
      <BookOpen :size="15" />
      <span>{{ app.books.length }} 本书 · {{ app.notes.length }} 篇笔记 · {{ app.tags.length }} 个标签</span>
      <span v-if="continueBook?.lastReadAt"><Flame :size="14" /> 最近阅读于 {{ formatDate(continueBook.lastReadAt) }}</span>
    </section>
  </div>
</template>

<style scoped>
.home-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.home-hero {
  position: relative;
  display: flex;
  min-height: 205px;
  overflow: hidden;
  align-items: flex-start;
  padding: clamp(1.4rem, 4vw, 2.65rem);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 30px;
  color: #fff;
  isolation: isolate;
  box-shadow: 0 24px 60px -42px rgba(43, 32, 59, 0.65);
}

.home-hero__landscape {
  position: absolute;
  z-index: -2;
  inset: 0;
  background-image: url('/assets/mountains.jpg');
  background-position: center 44%;
  background-size: cover;
  transform: scale(1.015);
}

.home-hero__shade {
  position: absolute;
  z-index: -1;
  inset: 0;
  background:
    linear-gradient(90deg, rgba(35, 28, 51, 0.56), rgba(38, 29, 56, 0.14) 62%, rgba(53, 37, 58, 0.06)),
    linear-gradient(0deg, rgba(40, 30, 53, 0.28), transparent 58%);
}

.home-hero__content {
  max-width: 720px;
}

.home-hero__date {
  font-size: 0.76rem;
  font-weight: 650;
  letter-spacing: 0.08em;
  opacity: 0.82;
  text-transform: uppercase;
}

.home-hero h1 {
  margin: 0.42rem 0 0.35rem;
  font-family: var(--font-display);
  font-size: clamp(2.4rem, 5vw, 4.3rem);
  font-weight: 600;
  letter-spacing: -0.04em;
  line-height: 0.98;
  text-shadow: 0 2px 20px rgba(28, 21, 42, 0.22);
}

.home-hero p {
  margin: 0;
  font-size: 0.96rem;
  opacity: 0.9;
}

.home-hero__import {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  gap: 0.45rem;
  margin-left: auto;
  padding: 0.5rem 0.8rem;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 10px;
  color: #fff;
  background: rgba(42, 32, 55, 0.25);
  font-size: 0.78rem;
  font-weight: 650;
  backdrop-filter: blur(15px);
}

.home-first-run {
  display: flex;
  min-height: 210px;
  align-items: center;
  padding: clamp(1.5rem, 4vw, 2.5rem);
}

.home-first-run__copy h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(1.9rem, 3.5vw, 2.65rem);
  font-weight: 600;
}

.home-first-run__copy p {
  max-width: 58ch;
  margin: 0.6rem 0 1.15rem;
  color: var(--text-secondary);
  font-size: 0.92rem;
  line-height: 1.75;
}

.home-layout {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 1rem;
  align-items: stretch;
}

.home-module--continue {
  grid-column: span 7;
}

.home-module--recent-books {
  grid-column: span 5;
}

.home-module--recent-notes,
.home-module--statistics,
.home-module--goal {
  grid-column: span 4;
}

.home-module--tags {
  grid-column: 1 / -1;
}

.continue-card,
.recent-books-card,
.notes-card,
.stats-mini,
.goal-card {
  padding: 1.25rem;
}

.continue-card__body {
  display: grid;
  grid-template-columns: 106px minmax(0, 1fr) auto;
  align-items: center;
  gap: 1rem;
}

.continue-card__cover {
  width: 106px;
  padding: 0;
  border: 0;
  background: transparent;
}

.continue-card__copy {
  min-width: 0;
}

.continue-card__title {
  overflow: hidden;
  max-width: 100%;
  padding: 0;
  border: 0;
  color: var(--text);
  background: transparent;
  font-family: var(--font-display);
  font-size: 1.7rem;
  font-weight: 600;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.continue-card__copy > p {
  margin: 0.25rem 0 0;
  color: var(--text-secondary);
}

blockquote {
  overflow: hidden;
  margin: 0.7rem 0;
  color: var(--text-secondary);
  font-family: var(--font-display);
  font-size: 1.05rem;
  font-style: italic;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.continue-card__progress {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.continue-card__progress > div {
  display: grid;
}

.continue-card__progress strong {
  font-size: 0.8rem;
}

.continue-card__progress span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.continue-card__action {
  align-self: end;
}

.recent-books {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0.65rem;
}

.recent-book {
  min-width: 0;
}

.recent-book > button:first-child {
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
}

.recent-book__title {
  display: block;
  overflow: hidden;
  width: 100%;
  padding: 0;
  border: 0;
  margin-top: 0.45rem;
  color: var(--text);
  background: transparent;
  font-size: 0.76rem;
  font-weight: 650;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-book > span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.data-list .note-row {
  width: 100%;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
}

.note-row__icon {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 10px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.note-row time {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.stats-mini {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.stats-mini__hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.stats-mini__hero > div {
  display: grid;
}

.stats-mini__hero span {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.stats-mini__hero strong {
  margin-top: 0.25rem;
  font-family: var(--font-display);
  font-size: 1.75rem;
  font-weight: 600;
}

.stats-mini__hero svg {
  color: var(--accent);
}

.mini-chart {
  display: flex;
  height: 78px;
  align-items: flex-end;
  gap: 5px;
  padding: 0.8rem 0 0.5rem;
  border-bottom: 1px solid var(--border);
}

.mini-chart__bar {
  flex: 1;
  min-width: 4px;
  border-radius: 4px 4px 1px 1px;
  background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 35%, transparent));
  transition: height var(--motion-slow) var(--ease-out);
}

.mini-chart-empty {
  display: flex;
  min-height: 78px;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.stats-mini__facts {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
  padding-top: 0.8rem;
}

.stats-mini__facts div {
  display: grid;
  gap: 0.12rem;
}

.stats-mini__facts strong {
  font-size: 0.92rem;
}

.stats-mini__facts span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.stats-mini__link {
  display: inline-flex;
  align-self: flex-end;
  align-items: center;
  gap: 0.3rem;
  padding: 0;
  border: 0;
  margin-top: auto;
  color: var(--accent-strong);
  background: transparent;
  font-size: 0.75rem;
  font-weight: 650;
}

.goal-card__main {
  display: flex;
  min-height: 145px;
  align-items: center;
  justify-content: center;
  gap: 1.15rem;
}

.goal-card__main :deep(.progress-ring__content) {
  display: grid;
  place-items: center;
}

.goal-card__main :deep(.progress-ring__content strong) {
  color: var(--text);
  font-size: 1.6rem;
}

.goal-card__main :deep(.progress-ring__content small) {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.goal-card__copy {
  display: grid;
  gap: 0.12rem;
}

.goal-card__copy span {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.goal-card__copy strong {
  font-family: var(--font-display);
  font-size: 1.6rem;
  font-weight: 600;
}

.goal-card__copy p {
  margin: 0.35rem 0 0;
  color: var(--accent-strong);
  font-size: 0.75rem;
}

.tags-strip {
  padding: 1.2rem 1.35rem;
}

.home-plugin-slot {
  display: grid;
  gap: 1rem;
}

.home-plugin-slot:empty {
  display: none;
}

.tags-strip__items {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
}

.home-tag {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 0.42rem;
  padding: 0.35rem 0.65rem;
  border: 1px solid color-mix(in srgb, var(--tag-color) 25%, var(--border));
  border-radius: 999px;
  color: var(--text);
  background: color-mix(in srgb, var(--tag-color) 8%, var(--surface-elevated));
  font-size: 0.75rem;
}

.home-tag__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tag-color);
}

.home-tag strong {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.home-footnote {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0 0.4rem;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.home-footnote span:last-child {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-left: auto;
}

@media (max-width: 1180px) {
  .home-module--continue,
  .home-module--recent-books {
    grid-column: 1 / -1;
  }

  .home-module--recent-notes,
  .home-module--statistics {
    grid-column: span 6;
  }

  .home-module--goal {
    grid-column: 1 / -1;
  }
}

@media (max-width: 760px) {
  .home-view {
    gap: 0.8rem;
  }

  .home-hero {
    min-height: 178px;
    align-items: flex-end;
    border-radius: 22px;
  }

  .home-hero h1 {
    font-size: clamp(2.1rem, 9vw, 3.2rem);
  }

  .home-hero__import {
    position: absolute;
    top: 1rem;
    right: 1rem;
  }

  .home-layout {
    grid-template-columns: 1fr;
  }

  .home-module--continue,
  .home-module--recent-books,
  .home-module--recent-notes,
  .home-module--statistics,
  .home-module--goal,
  .home-module--tags {
    grid-column: 1;
  }

  .home-first-run {
    grid-template-columns: 1fr;
  }

  .home-first-run__shelf {
    height: 110px;
  }

  .continue-card__body {
    grid-template-columns: 82px minmax(0, 1fr);
  }

  .continue-card__cover {
    width: 82px;
  }

  .continue-card__action {
    grid-column: 1 / -1;
  }

  .recent-books {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .recent-book:nth-child(5) {
    display: none;
  }
}

@media (max-width: 430px) {
  .home-hero {
    min-height: 164px;
  }

  .home-hero__import {
    font-size: 0;
  }

  .home-hero__import :deep(svg) {
    margin: 0;
  }

  .recent-books {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .recent-book:nth-child(4) {
    display: none;
  }
}
</style>

