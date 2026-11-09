<script setup lang="ts">
import { Heart, MoreHorizontal, Play } from 'lucide-vue-next';
import type { Book } from '../types';
import BookCover from './BookCover.vue';
import ProgressRing from './ProgressRing.vue';
import { authorsLabel, progressFor, progressLabel } from './utils';

withDefaults(
  defineProps<{
    book: Book;
    selected?: boolean;
    selectable?: boolean;
  }>(),
  { selected: false, selectable: false },
);

defineEmits<{
  detail: [book: Book];
  read: [book: Book];
  select: [book: Book];
  favorite: [book: Book];
}>();
</script>

<template>
  <article class="book-card" :class="{ 'book-card--selected': selected }">
    <div class="book-card__cover-wrap">
      <button class="book-card__cover" type="button" :aria-label="`查看《${book.title}》详情`" @click="$emit('detail', book)">
        <BookCover :book="book" />
      </button>
      <button
        v-if="selectable"
        class="book-card__select"
        type="button"
        :aria-label="selected ? `取消选择《${book.title}》` : `选择《${book.title}》`"
        :aria-pressed="selected"
        @click.stop="$emit('select', book)"
      >
        <span aria-hidden="true">{{ selected ? '✓' : '' }}</span>
      </button>
      <button
        v-else
        class="book-card__favorite"
        type="button"
        :aria-label="book.favorite ? `取消收藏《${book.title}》` : `收藏《${book.title}》`"
        :aria-pressed="book.favorite"
        @click.stop="$emit('favorite', book)"
      >
        <Heart :size="16" :fill="book.favorite ? 'currentColor' : 'none'" />
      </button>
      <button class="book-card__read" type="button" :aria-label="`阅读《${book.title}》`" @click.stop="$emit('read', book)">
        <Play :size="17" fill="currentColor" />
      </button>
    </div>
    <button class="book-card__title" type="button" @click="$emit('detail', book)">{{ book.title }}</button>
    <p v-if="authorsLabel(book)" class="book-card__author">{{ authorsLabel(book) }}</p>
    <div class="book-card__meta">
      <span>{{ progressLabel(book) }}</span>
      <ProgressRing
        v-if="book.status === 'reading'"
        :value="progressFor(book)"
        :size="17"
        :stroke="2.5"
        :label="`《${book.title}》阅读进度 ${Math.round(progressFor(book))}%`"
      />
      <Heart v-if="book.favorite" class="book-card__fav-indicator" :size="13" fill="currentColor" aria-label="已收藏" />
      <MoreHorizontal v-else :size="15" aria-hidden="true" />
    </div>
  </article>
</template>

<style scoped>
.book-card {
  position: relative;
  min-width: 0;
  border-radius: var(--radius-lg);
  transition:
    transform var(--motion-base) var(--ease-out),
    background var(--motion-fast);
}

.book-card:hover {
  background: color-mix(in srgb, var(--surface) 74%, transparent);
  transform: translateY(-3px);
}

.book-card--selected {
  background: var(--accent-soft);
  outline: 1px solid color-mix(in srgb, var(--accent) 44%, transparent);
}

.book-card__cover-wrap {
  position: relative;
  padding: 0.35rem;
}

.book-card__cover {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: inherit;
  background: transparent;
  cursor: pointer;
}

.book-card__select,
.book-card__favorite {
  position: absolute;
  z-index: 2;
  top: 0.7rem;
  left: 0.7rem;
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.42);
  border-radius: 50%;
  color: #fff;
  background: rgba(32, 27, 40, 0.35);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  backdrop-filter: blur(8px);
}

.book-card__select[aria-pressed='true'] {
  color: var(--accent-contrast);
  background: var(--accent);
}

.book-card__read {
  position: absolute;
  z-index: 2;
  right: 0.8rem;
  bottom: 0.8rem;
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 50%;
  color: #fff;
  background: color-mix(in srgb, var(--accent) 82%, transparent);
  box-shadow: 0 7px 18px rgba(42, 31, 58, 0.24);
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity var(--motion-fast),
    transform var(--motion-fast);
  backdrop-filter: blur(10px);
}

.book-card:hover .book-card__read,
.book-card:focus-within .book-card__read {
  opacity: 1;
  transform: translateY(0);
}

.book-card__title {
  display: -webkit-box;
  overflow: hidden;
  width: 100%;
  padding: 0.65rem 0.45rem 0;
  border: 0;
  color: var(--text);
  background: transparent;
  font: inherit;
  font-weight: 660;
  line-height: 1.35;
  text-align: left;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.book-card__author {
  overflow: hidden;
  margin: 0.18rem 0 0;
  padding: 0 0.45rem;
  color: var(--text-secondary);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-card__meta {
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.45rem;
  color: var(--accent-strong);
  font-size: 0.75rem;
  font-weight: 650;
}

.book-card__meta > svg:last-child {
  margin-left: auto;
  color: var(--text-tertiary);
}

.book-card__fav-indicator {
  margin-left: auto;
}

@media (hover: none) {
  .book-card__read {
    width: 32px;
    height: 32px;
    opacity: 1;
    transform: none;
  }
}
</style>

