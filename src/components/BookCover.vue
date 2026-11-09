<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { BookOpen, FileQuestion } from 'lucide-vue-next';
import type { Book } from '../types';

const props = withDefaults(
  defineProps<{
    book: Pick<Book, 'title' | 'authors' | 'format' | 'cover' | 'available'>;
    compact?: boolean;
  }>(),
  { compact: false },
);

const failed = ref(false);
watch(
  () => props.book.cover,
  () => {
    failed.value = false;
  },
);

const tone = computed(() => {
  const value = [...props.book.title].reduce((total, char) => total + char.charCodeAt(0), 0);
  return value % 5;
});
const author = computed(() => props.book.authors.filter(Boolean).join(' · '));
</script>

<template>
  <div
    class="book-cover"
    :class="[`book-cover--tone-${tone}`, { 'book-cover--compact': compact }]"
  >
    <img
      v-if="book.cover && !failed"
      :src="book.cover"
      :alt="`${book.title}封面`"
      loading="lazy"
      @error="failed = true"
    />
    <div v-else class="book-cover__fallback">
      <BookOpen v-if="book.available" :size="compact ? 20 : 28" aria-hidden="true" />
      <FileQuestion v-else :size="compact ? 20 : 28" aria-hidden="true" />
      <strong>{{ book.title }}</strong>
      <span v-if="author">{{ author }}</span>
      <small>{{ book.format.toUpperCase() }}</small>
    </div>
    <span v-if="!book.available" class="book-cover__flag">文件不可访问</span>
  </div>
</template>

<style scoped>
.book-cover {
  position: relative;
  overflow: hidden;
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: 5px 12px 12px 5px;
  background: var(--surface-3);
  box-shadow:
    -2px 0 0 color-mix(in srgb, var(--text) 12%, transparent) inset,
    0 16px 28px -20px rgba(30, 25, 43, 0.75);
  isolation: isolate;
}

.book-cover::after {
  position: absolute;
  inset: 0 auto 0 0;
  width: 7%;
  content: '';
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.24), transparent 70%);
  opacity: 0.8;
  pointer-events: none;
}

img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.book-cover__fallback {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  padding: 16%;
  color: #fffaf7;
  text-align: center;
}

.book-cover__fallback strong {
  display: -webkit-box;
  overflow: hidden;
  max-width: 100%;
  font-family: var(--font-display);
  font-size: clamp(1rem, 3vw, 1.7rem);
  font-style: italic;
  font-weight: 600;
  line-height: 1.15;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.book-cover__fallback span {
  display: -webkit-box;
  overflow: hidden;
  max-width: 100%;
  opacity: 0.78;
  font-size: 0.72rem;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.book-cover__fallback small {
  margin-top: auto;
  opacity: 0.7;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.16em;
}

.book-cover--compact .book-cover__fallback {
  gap: 0.25rem;
  padding: 12%;
}

.book-cover--compact .book-cover__fallback strong {
  font-size: 0.8rem;
}

.book-cover--compact .book-cover__fallback span,
.book-cover--compact .book-cover__fallback small {
  display: none;
}

.book-cover--tone-0 {
  background: linear-gradient(150deg, #31365d, #7e6aa7 55%, #d2a3a9);
}

.book-cover--tone-1 {
  background: linear-gradient(150deg, #3f514d, #789485 55%, #d9cba0);
}

.book-cover--tone-2 {
  background: linear-gradient(150deg, #703f45, #bb6e74 55%, #e6b995);
}

.book-cover--tone-3 {
  background: linear-gradient(150deg, #2d4d66, #5c86a4 55%, #a7cfcb);
}

.book-cover--tone-4 {
  background: linear-gradient(150deg, #51433d, #8b6c5d 55%, #c9ad89);
}

.book-cover__flag {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 0.25rem 0.45rem;
  border-radius: 999px;
  color: #fff;
  background: rgba(52, 39, 51, 0.82);
  font-size: 0.62rem;
}
</style>

