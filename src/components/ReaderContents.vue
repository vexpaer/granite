<script setup lang="ts">
import { computed } from 'vue';
import { BookOpen, ChevronRight } from 'lucide-vue-next';
import ReaderPanel from './ReaderPanel.vue';
import type { ReaderTocItem } from '../reader/types';

const props = withDefaults(
  defineProps<{
    toc: ReaderTocItem[];
    currentChapter?: number;
    currentPage?: number;
    formatLabel?: string;
  }>(),
  {
    currentChapter: 0,
    currentPage: 0,
    formatLabel: '',
  },
);

const emit = defineEmits<{
  close: [];
  navigate: [item: ReaderTocItem];
}>();

interface FlatTocItem {
  item: ReaderTocItem;
  active: boolean;
}

function flatten(items: ReaderTocItem[], result: FlatTocItem[] = []): FlatTocItem[] {
  for (const item of items) {
    const active =
      (item.chapterIndex != null && item.chapterIndex === props.currentChapter) ||
      (item.page != null && item.page === props.currentPage);
    result.push({ item, active });
    if (item.children?.length) flatten(item.children, result);
  }
  return result;
}

const flatItems = computed(() => flatten(props.toc));
</script>

<template>
  <ReaderPanel
    title="目录"
    :subtitle="formatLabel ? `${formatLabel} · 当前在第 ${Math.max(1, currentPage || currentChapter + 1)} 节` : undefined"
    side="left"
    @close="$emit('close')"
  >
    <div v-if="!toc.length" class="reader-toc-empty">
      <BookOpen :size="26" />
      <strong>此文件没有目录</strong>
      <span>仍可使用阅读进度和书内搜索定位内容。</span>
    </div>
    <ol v-else class="reader-toc" aria-label="文档目录">
      <li v-for="{ item, active } in flatItems" :key="item.id">
        <button
          type="button"
          class="reader-toc__item"
          :class="{ 'is-active': active }"
          :style="{ paddingLeft: `${0.72 + item.level * 1.05}rem` }"
          :aria-current="active ? 'location' : undefined"
          @click="emit('navigate', item)"
        >
          <ChevronRight :size="14" :class="{ 'is-open': item.children?.length }" />
          <span>{{ item.label }}</span>
          <span v-if="item.page" class="reader-toc__page">{{ item.page }}</span>
        </button>
      </li>
    </ol>
  </ReaderPanel>
</template>

<style scoped>
.reader-toc {
  display: grid;
  gap: 0.12rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.reader-toc__item {
  display: grid;
  width: 100%;
  min-height: 40px;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.34rem;
  padding: 0.52rem 0.65rem;
  border: 0;
  border-radius: 9px;
  color: var(--text-secondary);
  background: transparent;
  font-size: 0.79rem;
  line-height: 1.35;
  text-align: left;
}

.reader-toc__item:hover {
  color: var(--text);
  background: var(--surface-muted);
}

.reader-toc__item.is-active {
  color: var(--accent-strong);
  background: var(--accent-wash);
  font-weight: 680;
}

.reader-toc__item svg {
  color: var(--text-tertiary);
  transition: transform var(--motion-fast);
}

.reader-toc__item svg.is-open {
  transform: rotate(90deg);
}

.reader-toc__page {
  color: var(--text-tertiary);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}

.reader-toc-empty {
  display: grid;
  min-height: 210px;
  place-items: center;
  align-content: center;
  gap: 0.5rem;
  padding: 1.5rem;
  color: var(--text-tertiary);
  text-align: center;
}

.reader-toc-empty strong {
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.reader-toc-empty span {
  max-width: 220px;
  font-size: 0.72rem;
  line-height: 1.55;
}
</style>
