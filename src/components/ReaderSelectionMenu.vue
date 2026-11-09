<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  BookmarkPlus,
  Check,
  Copy,
  Highlighter,
  MessageSquarePlus,
  Share2,
  Underline,
  X,
} from 'lucide-vue-next';
import { ANNOTATION_COLORS } from '../reader/defaults';
import type { ReaderTextSelection } from '../reader/types';

const props = defineProps<{
  selection: ReaderTextSelection;
  busy?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  copy: [];
  share: [];
  annotate: [type: 'highlight' | 'underline' | 'note', color: string, note: string];
  notebook: [];
}>();

const color = ref<string>(ANNOTATION_COLORS[0]);
const noteMode = ref(false);
const note = ref('');
const noteInput = ref<HTMLTextAreaElement>();

const position = computed(() => {
  const anchor = props.selection.anchor;
  if (!anchor) return { left: 16, top: 80 };
  const width = Math.min(390, window.innerWidth - 24);
  return {
    left: Math.min(window.innerWidth - width - 12, Math.max(12, (anchor.left + anchor.right) / 2 - width / 2)),
    top: Math.max(68, anchor.top - (noteMode.value ? 174 : 70)),
  };
});

watch(noteMode, async (enabled) => {
  if (!enabled) return;
  await nextTick();
  noteInput.value?.focus();
});

function submitNote(): void {
  emit('annotate', 'note', color.value, note.value.trim());
}
</script>

<template>
  <div
    class="reader-selection-menu"
    :style="{ left: `${position.left}px`, top: `${position.top}px` }"
    role="dialog"
    aria-label="选中文字操作"
  >
    <div class="reader-selection-menu__quote">{{ selection.text }}</div>
    <div v-if="!noteMode" class="reader-selection-menu__actions">
      <button type="button" title="复制" @click="$emit('copy')"><Copy :size="17" /><span>复制</span></button>
      <button type="button" title="分享" @click="$emit('share')"><Share2 :size="17" /><span>分享</span></button>
      <span class="reader-selection-menu__divider"></span>
      <button type="button" title="高亮" @click="$emit('annotate', 'highlight', color, '')">
        <Highlighter :size="17" /><span>高亮</span>
      </button>
      <button type="button" title="下划线" @click="$emit('annotate', 'underline', color, '')">
        <Underline :size="17" /><span>下划线</span>
      </button>
      <button type="button" title="添加批注" @click="noteMode = true">
        <MessageSquarePlus :size="17" /><span>批注</span>
      </button>
      <button type="button" title="创建 Notebook 笔记" @click="$emit('notebook')">
        <BookmarkPlus :size="17" /><span>笔记</span>
      </button>
      <button class="reader-selection-menu__close" type="button" aria-label="关闭菜单" @click="$emit('close')">
        <X :size="16" />
      </button>
    </div>
    <div class="reader-selection-menu__palette" aria-label="标注颜色">
      <button
        v-for="item in ANNOTATION_COLORS"
        :key="item"
        type="button"
        :style="{ background: item }"
        :class="{ 'is-active': color === item }"
        :aria-label="`使用颜色 ${item}`"
        @click="color = item"
      >
        <Check v-if="color === item" :size="12" />
      </button>
    </div>
    <div v-if="noteMode" class="reader-selection-menu__note">
      <textarea
        ref="noteInput"
        v-model="note"
        rows="3"
        placeholder="写下批注；也可以留空，稍后补充"
        @keydown.ctrl.enter.prevent="submitNote"
        @keydown.meta.enter.prevent="submitNote"
      ></textarea>
      <div>
        <button type="button" class="button button--ghost button--small" @click="noteMode = false">返回</button>
        <button type="button" class="button button--primary button--small" :disabled="busy" @click="submitNote">
          {{ busy ? '保存中…' : '添加批注' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reader-selection-menu {
  position: fixed;
  z-index: 85;
  width: min(390px, calc(100vw - 24px));
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  color: var(--text);
  background: color-mix(in srgb, var(--surface-elevated) 96%, transparent);
  box-shadow: var(--shadow-modal);
  animation: selection-in 150ms var(--ease-out);
  backdrop-filter: blur(20px);
}

.reader-selection-menu__quote {
  overflow: hidden;
  max-height: 3.6em;
  padding: 0.62rem 0.75rem 0.48rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  font-family: var(--font-display);
  font-size: 0.78rem;
  line-height: 1.5;
}

.reader-selection-menu__actions {
  display: flex;
  align-items: center;
  gap: 0.08rem;
  padding: 0.34rem;
}

.reader-selection-menu__actions button {
  display: inline-flex;
  min-width: 47px;
  min-height: 42px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.16rem;
  padding: 0.25rem 0.38rem;
  border: 0;
  border-radius: 8px;
  color: var(--text-secondary);
  background: transparent;
  font-size: 0.61rem;
}

.reader-selection-menu__actions button:hover {
  color: var(--accent-strong);
  background: var(--accent-wash);
}

.reader-selection-menu__actions .reader-selection-menu__close {
  min-width: 31px;
  width: 31px;
  margin-left: auto;
}

.reader-selection-menu__divider {
  width: 1px;
  height: 27px;
  margin: 0 0.16rem;
  background: var(--border);
}

.reader-selection-menu__palette {
  display: flex;
  align-items: center;
  gap: 0.42rem;
  padding: 0.46rem 0.7rem;
  border-top: 1px solid var(--border);
}

.reader-selection-menu__palette button {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  color: #312b20;
}

.reader-selection-menu__palette button.is-active {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--surface-elevated);
}

.reader-selection-menu__note {
  display: grid;
  gap: 0.45rem;
  padding: 0 0.7rem 0.7rem;
}

.reader-selection-menu__note textarea {
  width: 100%;
  min-height: 74px;
  resize: none;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 9px;
  outline: 0;
  color: var(--text);
  background: var(--surface-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.reader-selection-menu__note textarea:focus {
  border-color: var(--accent);
}

.reader-selection-menu__note > div {
  display: flex;
  justify-content: flex-end;
  gap: 0.35rem;
}

@media (max-width: 600px) {
  .reader-selection-menu__actions button {
    flex: 1;
  }

  .reader-selection-menu__actions button span {
    display: none;
  }

  .reader-selection-menu__actions .reader-selection-menu__close {
    display: grid;
    flex: 0 0 34px;
  }
}

@keyframes selection-in {
  from {
    opacity: 0;
    transform: translateY(5px) scale(0.98);
  }
}
</style>
