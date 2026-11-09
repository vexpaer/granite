<script setup lang="ts">
import { FileText, Heart, Play } from 'lucide-vue-next';
import type { Book, Collection, LibraryRoot, Tag } from '../types';
import BookCover from './BookCover.vue';
import ProgressRing from './ProgressRing.vue';
import { authorsLabel, fileSize, formatDate, progressFor, progressLabel } from './utils';

const props = withDefaults(
  defineProps<{
    book: Book;
    selected?: boolean;
    selectable?: boolean;
    tags?: Tag[];
    collections?: Collection[];
    roots?: LibraryRoot[];
  }>(),
  { selected: false, selectable: false, tags: () => [], collections: () => [], roots: () => [] },
);

const emit = defineEmits<{
  detail: [book: Book];
  read: [book: Book];
  select: [book: Book];
  favorite: [book: Book];
}>();

function names(ids: string[], values: { id: string; name: string }[]) {
  return values.filter((item) => ids.includes(item.id)).map((item) => item.name);
}
</script>

<template>
  <article
    class="book-row"
    :class="{ 'book-row--selected': selected }"
    @dblclick="emit('detail', props.book)"
  >
    <label v-if="selectable" class="book-row__check">
      <input
        type="checkbox"
        :checked="selected"
        :aria-label="`选择《${book.title}》`"
        @change="emit('select', book)"
      />
    </label>
    <button class="book-row__cover" type="button" :aria-label="`查看《${book.title}》详情`" @click="emit('detail', book)">
      <BookCover :book="book" compact />
    </button>
    <div class="book-row__identity">
      <button type="button" class="book-row__title" @click="emit('detail', book)">{{ book.title }}</button>
      <p>{{ authorsLabel(book) || '作者信息缺失' }}</p>
      <div class="book-row__names">
        <span v-for="tag in names(book.tagIds, tags)" :key="tag" class="tag-chip tag-chip--soft">{{ tag }}</span>
        <span v-for="collection in names(book.collectionIds, collections)" :key="collection" class="tag-chip tag-chip--outline">{{ collection }}</span>
      </div>
    </div>
    <div class="book-row__file">
      <FileText :size="15" aria-hidden="true" />
      <span>{{ book.format.toUpperCase() }} · {{ fileSize(book.size) }}</span>
      <small>{{ roots.find((root) => root.id === book.rootId)?.displayName || '来源未知' }}</small>
    </div>
    <div class="book-row__progress">
      <span>{{ progressLabel(book) }}</span>
      <ProgressRing
        v-if="book.status === 'reading'"
        :value="progressFor(book)"
        :size="23"
        :stroke="3"
        :label="`阅读进度 ${Math.round(progressFor(book))}%`"
      />
    </div>
    <div class="book-row__updated">{{ formatDate(book.lastReadAt || book.updatedAt) }}</div>
    <div class="book-row__actions">
      <button class="icon-button icon-button--small" type="button" :aria-label="book.favorite ? '取消收藏' : '收藏'" @click="emit('favorite', book)">
        <Heart :size="16" :fill="book.favorite ? 'currentColor' : 'none'" />
      </button>
      <button class="button button--small button--primary" type="button" @click="emit('read', book)">
        <Play :size="14" fill="currentColor" /> 阅读
      </button>
    </div>
  </article>
</template>

<style scoped>
.book-row {
  display: grid;
  grid-template-columns: auto 50px minmax(180px, 1.8fr) minmax(120px, 0.8fr) 82px 80px auto;
  align-items: center;
  gap: 0.9rem;
  padding: 0.75rem;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  transition: background var(--motion-fast);
}

.book-row:hover,
.book-row--selected {
  border-color: var(--border);
  background: var(--surface);
}

.book-row--selected {
  background: var(--accent-soft);
}

.book-row__check {
  display: grid;
  place-items: center;
}

.book-row__check input {
  width: 17px;
  height: 17px;
  accent-color: var(--accent);
}

.book-row__cover {
  width: 50px;
  padding: 0;
  border: 0;
  background: transparent;
}

.book-row__identity {
  min-width: 0;
}

.book-row__title {
  overflow: hidden;
  max-width: 100%;
  padding: 0;
  border: 0;
  color: var(--text);
  background: transparent;
  font: inherit;
  font-weight: 670;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-row__identity p {
  overflow: hidden;
  margin: 0.2rem 0 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-row__names {
  display: flex;
  overflow: hidden;
  gap: 0.3rem;
  margin-top: 0.4rem;
}

.book-row__file {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.4rem;
  color: var(--text-secondary);
  font-size: 0.76rem;
}

.book-row__file small {
  grid-column: 2;
  overflow: hidden;
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-row__progress {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--accent-strong);
  font-size: 0.78rem;
  font-weight: 650;
}

.book-row__updated {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.book-row__actions {
  display: flex;
  gap: 0.4rem;
}

@media (max-width: 1000px) {
  .book-row {
    grid-template-columns: auto 46px minmax(170px, 1fr) 74px auto;
  }

  .book-row__file,
  .book-row__updated {
    display: none;
  }
}

@media (max-width: 560px) {
  .book-row {
    grid-template-columns: 44px minmax(0, 1fr) auto;
    gap: 0.65rem;
  }

  .book-row__check {
    position: absolute;
    margin: -3.6rem 0 0 -0.15rem;
  }

  .book-row__progress {
    display: none;
  }

  .book-row__actions .icon-button {
    display: none;
  }
}
</style>

