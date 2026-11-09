<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Bookmark,
  BookmarkPlus,
  Highlighter,
  MessageSquareText,
  PenLine,
  Trash2,
  Underline,
} from 'lucide-vue-next';
import ReaderPanel from './ReaderPanel.vue';
import { ANNOTATION_COLORS } from '../reader/defaults';
import type { Annotation } from '../types';

const props = defineProps<{
  annotations: Annotation[];
  currentLabel?: string;
  bookmarkActive?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  jump: [annotation: Annotation];
  delete: [annotation: Annotation];
  update: [annotation: Annotation, patch: Partial<Pick<Annotation, 'note' | 'color'>>];
  bookmark: [];
}>();

type Filter = 'all' | 'bookmark' | 'highlight' | 'underline' | 'note' | 'ink';
const filter = ref<Filter>('all');
const editingId = ref('');
const editNote = ref('');
const editColor = ref<string>(ANNOTATION_COLORS[0]);

const filterOptions: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'bookmark', label: '书签' },
  { value: 'highlight', label: '高亮' },
  { value: 'underline', label: '下划线' },
  { value: 'note', label: '批注' },
  { value: 'ink', label: '墨迹' },
];

const visibleAnnotations = computed(() =>
  props.annotations
    .filter((annotation) => filter.value === 'all' || annotation.type === filter.value)
    .sort((a, b) => {
      if (a.type === 'bookmark' && b.type !== 'bookmark') return 1;
      if (a.type !== 'bookmark' && b.type === 'bookmark') return -1;
      return (a.location.page || 0) - (b.location.page || 0) ||
        (a.location.chapter || 0) - (b.location.chapter || 0) ||
        (a.location.offset || 0) - (b.location.offset || 0);
    }),
);

watch(
  () => props.annotations,
  (items) => {
    if (editingId.value && !items.some((item) => item.id === editingId.value)) editingId.value = '';
  },
);

function iconFor(type: Annotation['type']) {
  return {
    bookmark: Bookmark,
    highlight: Highlighter,
    underline: Underline,
    note: MessageSquareText,
    ink: PenLine,
  }[type];
}

function labelFor(annotation: Annotation): string {
  if (annotation.location.page) return `第 ${annotation.location.page} 页`;
  if (annotation.location.chapter != null) return `第 ${annotation.location.chapter + 1} 章`;
  return '当前阅读位置';
}

function beginEdit(annotation: Annotation): void {
  editingId.value = annotation.id;
  editNote.value = annotation.note || '';
  editColor.value = annotation.color || ANNOTATION_COLORS[0];
}

function saveEdit(annotation: Annotation): void {
  emit('update', annotation, {
    note: editNote.value.trim(),
    color: editColor.value,
  });
  editingId.value = '';
}
</script>

<template>
  <ReaderPanel title="书签与标注" :subtitle="currentLabel" @close="$emit('close')">
    <div class="reader-annotations">
      <div class="reader-annotations__toolbar">
        <div class="reader-annotations__filters" role="group" aria-label="筛选标注">
          <button
            v-for="option in filterOptions"
            :key="option.value"
            type="button"
            :class="{ 'is-active': filter === option.value }"
            @click="filter = option.value"
          >
            {{ option.label }}
          </button>
        </div>
        <button
          class="button button--secondary button--small"
          type="button"
          :disabled="bookmarkActive"
          @click="$emit('bookmark')"
        >
          <BookmarkPlus :size="15" />
          {{ bookmarkActive ? '已在此页' : '加书签' }}
        </button>
      </div>

      <div v-if="!visibleAnnotations.length" class="reader-annotations__empty">
        <BookmarkPlus :size="25" />
        <strong>还没有{{ filter === 'all' ? '书签或标注' : filterOptions.find((item) => item.value === filter)?.label }}</strong>
        <span>选择正文即可添加高亮、下划线或批注。</span>
      </div>

      <div v-else class="reader-annotations__list">
        <article
          v-for="annotation in visibleAnnotations"
          :key="annotation.id"
          class="reader-annotation-card"
          :class="`reader-annotation-card--${annotation.type}`"
        >
          <button type="button" class="reader-annotation-card__main" @click="$emit('jump', annotation)">
            <span
              class="reader-annotation-card__icon"
              :style="{ '--annotation-color': annotation.color || ANNOTATION_COLORS[0] }"
            >
              <component :is="iconFor(annotation.type)" :size="16" />
            </span>
            <span class="reader-annotation-card__body">
              <span class="reader-annotation-card__meta">
                {{ labelFor(annotation) }}
                <span>·</span>
                {{ new Date(annotation.updatedAt || annotation.createdAt).toLocaleDateString('zh-CN') }}
              </span>
              <strong v-if="annotation.text">{{ annotation.text }}</strong>
              <strong v-else>{{ annotation.type === 'bookmark' ? '阅读位置书签' : '墨迹标注' }}</strong>
              <span v-if="annotation.note && editingId !== annotation.id" class="reader-annotation-card__note">
                {{ annotation.note }}
              </span>
            </span>
          </button>

          <div v-if="editingId === annotation.id" class="reader-annotation-card__editor">
            <textarea v-model="editNote" rows="3" placeholder="添加备注"></textarea>
            <div class="reader-annotation-card__palette">
              <button
                v-for="item in ANNOTATION_COLORS"
                :key="item"
                type="button"
                :style="{ background: item }"
                :class="{ 'is-active': editColor === item }"
                :aria-label="`颜色 ${item}`"
                @click="editColor = item"
              ></button>
            </div>
            <div class="reader-annotation-card__edit-actions">
              <button type="button" class="button button--ghost button--small" @click="editingId = ''">取消</button>
              <button type="button" class="button button--primary button--small" @click="saveEdit(annotation)">保存</button>
            </div>
          </div>

          <div v-else class="reader-annotation-card__actions">
            <button type="button" aria-label="编辑标注" @click="beginEdit(annotation)">编辑</button>
            <button type="button" aria-label="删除标注" @click="$emit('delete', annotation)">
              <Trash2 :size="13" />删除
            </button>
          </div>
        </article>
      </div>
    </div>
  </ReaderPanel>
</template>

<style scoped>
.reader-annotations {
  display: grid;
  gap: 0.72rem;
}

.reader-annotations__toolbar {
  display: grid;
  gap: 0.55rem;
}

.reader-annotations__filters {
  display: flex;
  gap: 0.18rem;
  overflow-x: auto;
  padding-bottom: 0.12rem;
  scrollbar-width: none;
}

.reader-annotations__filters::-webkit-scrollbar {
  display: none;
}

.reader-annotations__filters button {
  min-height: 29px;
  flex: 0 0 auto;
  padding: 0.24rem 0.58rem;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--text-tertiary);
  background: transparent;
  font-size: 0.68rem;
}

.reader-annotations__filters button:hover {
  color: var(--text);
  background: var(--surface-muted);
}

.reader-annotations__filters button.is-active {
  border-color: var(--border);
  color: var(--accent-strong);
  background: var(--accent-wash);
  font-weight: 670;
}

.reader-annotations__toolbar > .button {
  justify-self: start;
}

.reader-annotations__empty {
  display: grid;
  min-height: 230px;
  place-items: center;
  align-content: center;
  gap: 0.5rem;
  color: var(--text-tertiary);
  text-align: center;
}

.reader-annotations__empty strong {
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.reader-annotations__empty span {
  max-width: 230px;
  font-size: 0.72rem;
  line-height: 1.5;
}

.reader-annotations__list {
  display: grid;
  gap: 0.42rem;
}

.reader-annotation-card {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: color-mix(in srgb, var(--surface-muted) 60%, transparent);
}

.reader-annotation-card__main {
  display: flex;
  width: 100%;
  gap: 0.62rem;
  padding: 0.72rem;
  border: 0;
  color: var(--text);
  background: transparent;
  text-align: left;
}

.reader-annotation-card__main:hover {
  background: var(--surface-muted);
}

.reader-annotation-card__icon {
  display: grid;
  width: 29px;
  height: 29px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: color-mix(in srgb, var(--annotation-color) 78%, var(--text));
  background: color-mix(in srgb, var(--annotation-color) 24%, transparent);
}

.reader-annotation-card__body {
  display: grid;
  min-width: 0;
  gap: 0.25rem;
}

.reader-annotation-card__meta {
  display: flex;
  gap: 0.32rem;
  color: var(--text-tertiary);
  font-size: 0.63rem;
}

.reader-annotation-card__body strong {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-secondary);
  font-family: var(--font-display);
  font-size: 0.82rem;
  font-weight: 570;
  line-height: 1.48;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.reader-annotation-card__note {
  padding-left: 0.5rem;
  border-left: 2px solid color-mix(in srgb, var(--accent) 32%, var(--border));
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

.reader-annotation-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.2rem;
  padding: 0 0.5rem 0.42rem;
}

.reader-annotation-card__actions button {
  display: inline-flex;
  align-items: center;
  gap: 0.22rem;
  padding: 0.22rem 0.4rem;
  border: 0;
  border-radius: 6px;
  color: var(--text-tertiary);
  background: transparent;
  font-size: 0.63rem;
}

.reader-annotation-card__actions button:hover {
  color: var(--text);
  background: var(--surface-muted);
}

.reader-annotation-card__editor {
  display: grid;
  gap: 0.45rem;
  padding: 0 0.72rem 0.72rem;
}

.reader-annotation-card__editor textarea {
  width: 100%;
  resize: vertical;
  padding: 0.52rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: 0;
  background: var(--surface-elevated);
  font-size: 0.72rem;
}

.reader-annotation-card__palette {
  display: flex;
  gap: 0.4rem;
}

.reader-annotation-card__palette button {
  width: 19px;
  height: 19px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
}

.reader-annotation-card__palette button.is-active {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--surface-elevated);
}

.reader-annotation-card__edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.35rem;
}
</style>
