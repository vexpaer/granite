<script setup lang="ts">
import { computed, ref } from 'vue';
import { BookOpen, NotebookPen, Search } from 'lucide-vue-next';
import { useApp } from '../stores/app';
import BookCard from '../components/BookCard.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import { plainText, relativeTime } from '../components/utils';

const app = useApp();
const type = ref<'all' | 'books' | 'notes'>('all');
const query = ref('');
const status = ref('');
const tag = computed(() => app.tags.find((item) => item.id === app.route.id));
const books = computed(() => {
  const value = query.value.trim().toLocaleLowerCase('zh-CN');
  return app.books
    .filter((book) => tag.value && book.tagIds.includes(tag.value.id))
    .filter((book) => !status.value || book.status === status.value)
    .filter((book) => !value || `${book.title} ${book.authors.join(' ')}`.toLocaleLowerCase('zh-CN').includes(value));
});
const notes = computed(() => {
  const value = query.value.trim().toLocaleLowerCase('zh-CN');
  return app.notes
    .filter((note) => tag.value && note.tagIds.includes(tag.value.id))
    .filter((note) => !value || `${note.title} ${plainText(note.body)}`.toLocaleLowerCase('zh-CN').includes(value));
});

function readBook(bookId: string) {
  const book = app.books.find((item) => item.id === bookId);
  if (book) app.openReader(book.id, book.location);
}

async function favorite(bookId: string) {
  const book = app.books.find((item) => item.id === bookId);
  if (book) await app.saveBook({ ...book, favorite: !book.favorite, updatedAt: new Date().toISOString() });
}
</script>

<template>
  <div class="tag-results-view page-view">
    <PageHeader
      :title="tag ? `# ${tag.name}` : '标签不存在'"
      :description="tag ? `${books.length} 本书与 ${notes.length} 篇笔记使用此标签。` : '该标签可能已合并或删除。'"
      back-label="返回标签管理"
      @back="app.back()"
    />

    <section v-if="tag" class="tag-result-toolbar surface-card">
      <div class="segmented">
        <button type="button" :class="{ 'is-active': type === 'all' }" @click="type = 'all'">全部 {{ books.length + notes.length }}</button>
        <button type="button" :class="{ 'is-active': type === 'books' }" @click="type = 'books'">书籍 {{ books.length }}</button>
        <button type="button" :class="{ 'is-active': type === 'notes' }" @click="type = 'notes'">笔记 {{ notes.length }}</button>
      </div>
      <label class="tag-search"><Search :size="15" /><span class="sr-only">搜索标签结果</span><input v-model="query" type="search" placeholder="搜索结果" /></label>
      <select v-if="type !== 'notes'" v-model="status" class="select" aria-label="书籍状态">
        <option value="">全部状态</option>
        <option value="reading">阅读中</option>
        <option value="unread">未读</option>
        <option value="finished">已读</option>
      </select>
    </section>

    <template v-if="tag && (type === 'all' || type === 'books') && books.length">
      <div class="result-heading"><h2>书籍</h2><span>{{ books.length }}</span></div>
      <div class="tag-book-grid">
        <BookCard v-for="book in books" :key="book.id" :book="book" @detail="app.navigate('book-detail', book.id)" @read="readBook(book.id)" @favorite="favorite(book.id)" @select="undefined" />
      </div>
    </template>

    <template v-if="tag && (type === 'all' || type === 'notes') && notes.length">
      <div class="result-heading"><h2>笔记</h2><span>{{ notes.length }}</span></div>
      <div class="tag-note-list surface-card">
        <button v-for="note in notes" :key="note.id" type="button" @click="app.navigate('notebook', note.id)">
          <span class="tag-note-icon"><NotebookPen :size="17" /></span>
          <span><strong>{{ note.title }}</strong><small>{{ plainText(note.body) || '空白笔记' }}</small></span>
          <time>{{ relativeTime(note.updatedAt) }}</time>
        </button>
      </div>
    </template>

    <EmptyState
      v-if="tag && !books.length && !notes.length"
      title="此标签还没有关联内容"
      description="从书籍详情或笔记编辑器中应用这个标签。"
      action-label="前往书架"
      @action="app.navigate('bookshelf')"
    >
      <template #icon><BookOpen :size="24" /></template>
    </EmptyState>
    <EmptyState
      v-else-if="!tag"
      title="标签不存在"
      description="标签可能已合并或删除。返回标签管理查看当前标签。"
      action-label="返回标签管理"
      @action="app.navigate('tags')"
    />
  </div>
</template>

<style scoped>
.tag-results-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.tag-result-toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem;
}

.tag-result-toolbar .select {
  width: 120px;
}

.tag-search {
  display: flex;
  min-height: 38px;
  flex: 1;
  align-items: center;
  gap: 0.4rem;
  padding: 0 0.6rem;
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--text-tertiary);
  background: var(--surface-elevated);
}

.tag-search input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
}

.result-heading {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin-top: 0.25rem;
}

.result-heading h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.65rem;
  font-weight: 600;
}

.result-heading span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.tag-book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(145px, 1fr));
  gap: 1rem;
}

.tag-note-list {
  display: grid;
  padding: 0.5rem;
}

.tag-note-list > button {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.7rem;
  border: 0;
  border-radius: 10px;
  color: var(--text);
  background: transparent;
  text-align: left;
}

.tag-note-list > button:hover {
  background: var(--surface-muted);
}

.tag-note-icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 10px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.tag-note-list button > span:nth-child(2) {
  display: grid;
  min-width: 0;
}

.tag-note-list strong,
.tag-note-list small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-note-list small,
.tag-note-list time {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

@media (max-width: 580px) {
  .tag-result-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .tag-result-toolbar .select {
    width: 100%;
  }

  .tag-book-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.6rem;
  }
}

@media (max-width: 390px) {
  .tag-book-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

