<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Search,
  X,
} from 'lucide-vue-next';
import ReaderPanel from './ReaderPanel.vue';
import type { ReaderSearchResult } from '../reader/types';

const props = withDefaults(
  defineProps<{
    results: ReaderSearchResult[];
    loading?: boolean;
    activeIndex?: number;
    textAvailable?: boolean;
    textUnavailableReason?: string;
  }>(),
  {
    loading: false,
    activeIndex: -1,
    textAvailable: true,
    textUnavailableReason: '',
  },
);

const emit = defineEmits<{
  close: [];
  search: [query: string];
  select: [result: ReaderSearchResult, index: number];
  previous: [];
  next: [];
}>();

const query = ref('');
const submittedQuery = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

const resultLabel = computed(() => {
  if (!submittedQuery.value) return '输入词语以查找整本书';
  if (props.loading) return '正在搜索';
  if (!props.results.length) return '没有匹配结果';
  return `${props.activeIndex >= 0 ? props.activeIndex + 1 : 1} / ${props.results.length}`;
});

watch(query, (value) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => submit(value), 320);
});

function submit(value = query.value): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  submittedQuery.value = value.trim();
  emit('search', submittedQuery.value);
}

function clear(): void {
  query.value = '';
  submittedQuery.value = '';
  emit('search', '');
}
</script>

<template>
  <ReaderPanel title="书内搜索" :subtitle="resultLabel" @close="$emit('close')">
    <div class="reader-search">
      <form class="reader-search__form" role="search" @submit.prevent="submit()">
        <Search :size="16" aria-hidden="true" />
        <input
          v-model="query"
          type="search"
          autofocus
          :disabled="!textAvailable"
          aria-label="搜索书内文字"
          placeholder="搜索章节、句子或词语"
        />
        <button v-if="query" type="button" aria-label="清空搜索" @click="clear">
          <X :size="15" />
        </button>
      </form>

      <div v-if="loading" class="reader-search__state">
        <LoaderCircle :size="20" class="reader-search__spin" />
        <span>正在检查文本层…</span>
      </div>
      <div v-else-if="!textAvailable" class="reader-search__state">
        <Search :size="23" />
        <strong>文本搜索不可用</strong>
        <span>{{ textUnavailableReason || '此 PDF 没有可提取文本，可能是扫描件。' }}</span>
      </div>
      <div v-else-if="submittedQuery && !results.length" class="reader-search__state">
        <Search :size="23" />
        <strong>没有找到“{{ submittedQuery }}”</strong>
        <span>可尝试更短的词或检查文字是否位于图片中。</span>
      </div>
      <div v-else class="reader-search__results">
        <button
          v-for="(result, index) in results"
          :key="result.id"
          type="button"
          class="reader-search-result"
          :class="{ 'is-active': index === activeIndex }"
          @click="emit('select', result, index)"
        >
          <span class="reader-search-result__meta">
            {{ result.page ? `第 ${result.page} 页` : `第 ${(result.chapterIndex ?? 0) + 1} 章` }}
          </span>
          <span class="reader-search-result__context">
            <span>{{ result.before }}</span><mark>{{ result.text }}</mark><span>{{ result.after }}</span>
          </span>
        </button>
      </div>
    </div>

    <template #footer>
      <div class="reader-search__footer">
        <button
          class="button button--secondary button--small"
          type="button"
          :disabled="!results.length"
          @click="$emit('previous')"
        >
          <ChevronUp :size="15" />上一个
        </button>
        <span>{{ resultLabel }}</span>
        <button
          class="button button--secondary button--small"
          type="button"
          :disabled="!results.length"
          @click="$emit('next')"
        >
          下一个<ChevronDown :size="15" />
        </button>
      </div>
    </template>
  </ReaderPanel>
</template>

<style scoped>
.reader-search {
  display: grid;
  gap: 0.7rem;
}

.reader-search__form {
  position: sticky;
  z-index: 1;
  top: -0.85rem;
  display: flex;
  min-height: 40px;
  align-items: center;
  gap: 0.45rem;
  padding: 0 0.65rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-tertiary);
  background: var(--surface-elevated);
}

.reader-search__form:focus-within {
  border-color: color-mix(in srgb, var(--accent) 54%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 10%, transparent);
}

.reader-search__form input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: 0.78rem;
}

.reader-search__form button {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--text-tertiary);
  background: transparent;
}

.reader-search__state {
  display: grid;
  min-height: 190px;
  place-items: center;
  align-content: center;
  gap: 0.48rem;
  padding: 1.2rem;
  color: var(--text-tertiary);
  text-align: center;
}

.reader-search__state strong {
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.reader-search__state span {
  max-width: 250px;
  font-size: 0.71rem;
  line-height: 1.55;
}

.reader-search__spin {
  animation: spin 0.9s linear infinite;
}

.reader-search__results {
  display: grid;
  gap: 0.22rem;
}

.reader-search-result {
  display: grid;
  width: 100%;
  gap: 0.3rem;
  padding: 0.72rem;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--text-secondary);
  background: transparent;
  text-align: left;
}

.reader-search-result:hover,
.reader-search-result.is-active {
  border-color: var(--border);
  background: var(--surface-muted);
}

.reader-search-result.is-active {
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
  background: var(--accent-wash);
}

.reader-search-result__meta {
  color: var(--text-tertiary);
  font-size: 0.64rem;
  font-weight: 680;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.reader-search-result__context {
  display: -webkit-box;
  overflow: hidden;
  font-family: var(--font-display);
  font-size: 0.83rem;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.reader-search-result mark {
  padding: 0 0.05rem;
  border-radius: 2px;
  color: inherit;
  background: color-mix(in srgb, #f4c542 56%, transparent);
}

.reader-search__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}

.reader-search__footer > span {
  color: var(--text-tertiary);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
