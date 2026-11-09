<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  BookOpen,
  Folder,
  Import,
  NotebookPen,
  Search,
  Tag as TagIcon,
  X,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import BookCover from '../components/BookCover.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import { authorsLabel, formatDate, plainText, progressLabel } from '../components/utils';
import type { Book, Collection, Note, Tag } from '../types';

const app = useApp();
const input = ref<HTMLInputElement>();
const query = ref(String(app.route.id || app.search || ''));
const type = ref<'all' | 'books' | 'notes' | 'tags' | 'collections'>('all');

watch(query, (value) => {
  app.search = value;
});

const needle = computed(() => query.value.trim().toLocaleLowerCase('zh-CN'));
const books = computed<Book[]>(() => {
  if (!needle.value) return [];
  return app.books.filter((book) =>
    [
      book.title,
      ...book.authors,
      book.description || '',
      book.publisher || '',
      book.series || '',
      book.isbn || '',
      book.doi || '',
      book.format,
    ]
      .join(' ')
      .toLocaleLowerCase('zh-CN')
      .includes(needle.value),
  );
});
const notes = computed<Note[]>(() => {
  if (!needle.value) return [];
  return app.notes.filter((note) =>
    `${note.title} ${note.body} ${note.folder}`
      .toLocaleLowerCase('zh-CN')
      .includes(needle.value),
  );
});
const tags = computed<Tag[]>(() => {
  if (!needle.value) return [];
  return app.tags.filter((tag) => tag.name.toLocaleLowerCase('zh-CN').includes(needle.value));
});
const collections = computed<Collection[]>(() => {
  if (!needle.value) return [];
  return app.collections.filter((collection) =>
    collection.name.toLocaleLowerCase('zh-CN').includes(needle.value),
  );
});
const resultCount = computed(
  () => books.value.length + notes.value.length + tags.value.length + collections.value.length,
);
const showBooks = computed(() => type.value === 'all' || type.value === 'books');
const showNotes = computed(() => type.value === 'all' || type.value === 'notes');
const showTags = computed(() => type.value === 'all' || type.value === 'tags');
const showCollections = computed(() => type.value === 'all' || type.value === 'collections');

function bookExcerpt(book: Book) {
  const values = [authorsLabel(book), book.publisher, book.series, book.format.toUpperCase()].filter(Boolean);
  return values.join(' · ');
}

function tagUsage(id: string) {
  return (
    app.books.filter((book) => book.tagIds.includes(id)).length +
    app.notes.filter((note) => note.tagIds.includes(id)).length
  );
}

function clear() {
  query.value = '';
  type.value = 'all';
  nextTick(() => input.value?.focus());
}

onMounted(() => {
  input.value?.focus();
  input.value?.select();
});
</script>

<template>
  <div class="search-view page-view">
    <PageHeader title="全局搜索" description="在书籍、作者、元数据、笔记正文、标签和集合中查找。" />

    <section class="search-hero surface-card">
      <Search :size="22" />
      <label>
        <span class="sr-only">搜索全部内容</span>
        <input ref="input" v-model="query" type="search" placeholder="输入书名、作者、笔记内容或标签" autocomplete="off" />
      </label>
      <button v-if="query" class="icon-button" type="button" aria-label="清空搜索" @click="clear"><X :size="17" /></button>
    </section>

    <div v-if="query.trim()" class="search-summary">
      <div class="segmented" role="group" aria-label="搜索结果类型">
        <button type="button" :class="{ 'is-active': type === 'all' }" @click="type = 'all'">全部 {{ resultCount }}</button>
        <button type="button" :class="{ 'is-active': type === 'books' }" @click="type = 'books'">书籍 {{ books.length }}</button>
        <button type="button" :class="{ 'is-active': type === 'notes' }" @click="type = 'notes'">笔记 {{ notes.length }}</button>
        <button type="button" :class="{ 'is-active': type === 'tags' }" @click="type = 'tags'">标签 {{ tags.length }}</button>
        <button type="button" :class="{ 'is-active': type === 'collections' }" @click="type = 'collections'">集合 {{ collections.length }}</button>
      </div>
      <span>“{{ query.trim() }}”的结果</span>
    </div>

    <section v-if="query.trim() && showBooks && books.length" class="search-group surface-card">
      <div class="search-group__heading"><BookOpen :size="18" /><h2>书籍</h2><span>{{ books.length }}</span></div>
      <div>
        <button v-for="book in books" :key="book.id" type="button" @click="app.navigate('book-detail', book.id)">
          <BookCover :book="book" compact />
          <span class="search-result__copy">
            <strong>{{ book.title }}</strong>
            <span>{{ bookExcerpt(book) }}</span>
          </span>
          <span class="search-result__meta">{{ progressLabel(book) }}</span>
        </button>
      </div>
    </section>

    <section v-if="query.trim() && showNotes && notes.length" class="search-group surface-card">
      <div class="search-group__heading"><NotebookPen :size="18" /><h2>笔记</h2><span>{{ notes.length }}</span></div>
      <div>
        <button v-for="note in notes" :key="note.id" type="button" @click="app.navigate('notebook', note.id)">
          <span class="search-result__icon"><NotebookPen :size="17" /></span>
          <span class="search-result__copy">
            <strong>{{ note.title || '未命名笔记' }}</strong>
            <span>{{ plainText(note.body) || '空白笔记' }}</span>
          </span>
          <span class="search-result__meta">{{ note.folder || '根目录' }} · {{ formatDate(note.updatedAt) }}</span>
        </button>
      </div>
    </section>

    <section v-if="query.trim() && showTags && tags.length" class="search-group surface-card">
      <div class="search-group__heading"><TagIcon :size="18" /><h2>标签</h2><span>{{ tags.length }}</span></div>
      <div class="search-tag-grid">
        <button v-for="tag in tags" :key="tag.id" type="button" @click="app.navigate('tag-results', tag.id)">
          <span :style="{ background: tag.color }"></span>
          <strong>{{ tag.name }}</strong>
          <small>{{ tagUsage(tag.id) }} 个关联对象</small>
        </button>
      </div>
    </section>

    <section v-if="query.trim() && showCollections && collections.length" class="search-group surface-card">
      <div class="search-group__heading"><Folder :size="18" /><h2>集合</h2><span>{{ collections.length }}</span></div>
      <div class="search-tag-grid">
        <button v-for="collection in collections" :key="collection.id" type="button" @click="app.navigate('bookshelf', 'all')">
          <Folder :size="16" />
          <strong>{{ collection.name }}</strong>
          <small>{{ app.books.filter((book) => book.collectionIds.includes(collection.id)).length }} 本书</small>
        </button>
      </div>
    </section>

    <EmptyState
      v-if="query.trim() && resultCount === 0"
      title="没有搜索结果"
      description="尝试书名、作者、笔记正文中的词或标签名称，也可以直接导入书籍。"
      action-label="导入书籍"
      secondary-label="清除搜索"
      @action="app.navigate('import')"
      @secondary="clear"
    />
    <div v-else-if="!query.trim()" class="search-idle">
      <span class="search-idle__mark"><Search :size="25" /></span>
      <h2>搜索整个书房</h2>
      <p>结果会按书籍、笔记、标签和集合分组。打开结果后返回，搜索词与筛选会保留。</p>
      <button v-if="app.books.length || app.notes.length === 0" class="button button--secondary" type="button" @click="app.navigate('import')">
        <Import :size="16" />导入书籍
      </button>
    </div>
  </div>
</template>

<style scoped>
.search-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.search-hero {
  display: flex;
  min-height: 62px;
  align-items: center;
  gap: 0.7rem;
  padding: 0.65rem 1rem;
  border-color: color-mix(in srgb, var(--accent) 24%, var(--border));
}

.search-hero > svg {
  color: var(--accent);
}

.search-hero label {
  min-width: 0;
  flex: 1;
}

.search-hero input {
  width: 100%;
  border: 0;
  outline: 0;
  color: var(--text);
  background: transparent;
  font-size: clamp(1rem, 2.2vw, 1.2rem);
}

.search-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.search-summary > span {
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-group {
  overflow: hidden;
}

.search-group__heading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface-muted);
}

.search-group__heading > svg {
  color: var(--accent);
}

.search-group__heading h2 {
  margin: 0;
  font-size: 0.84rem;
}

.search-group__heading span {
  color: var(--text-tertiary);
  font-size: 0.65rem;
}

.search-group > div:last-child {
  padding: 0.4rem;
}

.search-group > div > button {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 0.7rem;
  padding: 0.55rem;
  border: 0;
  border-radius: 10px;
  color: var(--text);
  background: transparent;
  text-align: left;
}

.search-group > div > button:hover {
  background: var(--surface-muted);
}

.search-group > div > button :deep(.book-cover) {
  width: 34px;
  flex: 0 0 auto;
}

.search-result__icon {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 10px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.search-result__copy {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 0.15rem;
}

.search-result__copy strong,
.search-result__copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-result__copy strong {
  font-size: 0.78rem;
}

.search-result__copy span,
.search-result__meta {
  color: var(--text-secondary);
  font-size: 0.67rem;
}

.search-result__meta {
  flex: 0 0 auto;
}

.search-tag-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  padding: 0.7rem !important;
}

.search-tag-grid button {
  display: grid !important;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center !important;
  gap: 0.5rem !important;
  padding: 0.7rem !important;
  border: 1px solid var(--border) !important;
  background: var(--surface-elevated) !important;
}

.search-tag-grid button > span,
.search-tag-grid button > svg {
  display: grid;
  width: 10px;
  height: 10px;
  grid-row: 1 / 3;
  place-items: center;
  border-radius: 50%;
  color: var(--accent);
}

.search-tag-grid small {
  color: var(--text-tertiary);
  font-size: 0.63rem;
}

.search-idle {
  display: grid;
  min-height: 320px;
  place-items: center;
  align-content: center;
  gap: 0.6rem;
  text-align: center;
}

.search-idle__mark {
  display: grid;
  width: 65px;
  height: 65px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 20px;
  color: var(--accent);
  background: var(--accent-soft);
}

.search-idle h2 {
  margin: 0.4rem 0 0;
  font-family: var(--font-display);
  font-size: 2rem;
  font-weight: 600;
}

.search-idle p {
  max-width: 55ch;
  margin: 0 0 0.5rem;
  color: var(--text-secondary);
  line-height: 1.6;
}

@media (max-width: 680px) {
  .search-summary {
    align-items: stretch;
    flex-direction: column;
  }

  .search-summary .segmented {
    overflow-x: auto;
  }

  .search-summary .segmented button {
    flex: 0 0 auto;
  }

  .search-result__meta {
    display: none;
  }

  .search-tag-grid {
    grid-template-columns: 1fr;
  }
}
</style>

