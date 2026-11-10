<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  Maximize2,
  MessageSquareText,
  Minimize2,
  MousePointer2,
  PenLine,
  RotateCw,
  Search,
  SlidersHorizontal,
  Type,
  ZoomIn,
  ZoomOut,
} from 'lucide-vue-next';
import type { Format } from '../types';
import ProgressRing from './ProgressRing.vue';
import type {
  PdfFitMode,
  ReaderPanelName,
  ReaderPdfTool,
  ReaderSurfaceMode,
} from '../reader/types';

const props = withDefaults(
  defineProps<{
    visible?: boolean;
    format: Format;
    title: string;
    chapterLabel?: string;
    progress: number;
    page?: number;
    totalPages?: number;
    scale?: number;
    rotation?: number;
    bookmarkActive?: boolean;
    tocAvailable?: boolean;
    activePanel?: ReaderPanelName | null;
    mode?: ReaderSurfaceMode;
    pdfTool?: ReaderPdfTool;
    fitMode?: PdfFitMode;
    fullscreen?: boolean;
    canGoBack?: boolean;
    pdfSaving?: 'idle' | 'saving' | 'error';
  }>(),
  {
    visible: true,
    chapterLabel: '',
    page: 1,
    totalPages: 0,
    scale: 1,
    rotation: 0,
    bookmarkActive: false,
    tocAvailable: true,
    activePanel: null,
    mode: 'scroll',
    pdfTool: 'pan',
    fitMode: 'custom',
    fullscreen: false,
    canGoBack: false,
    pdfSaving: 'idle',
  },
);

const emit = defineEmits<{
  close: [];
  panel: [panel: ReaderPanelName];
  bookmark: [];
  'go-back': [];
  rotate: [];
  'fit-width': [];
  'fit-page': [];
  'actual-size': [];
  'zoom-in': [];
  'zoom-out': [];
  'page-change': [page: number];
  'progress-jump': [fraction: number];
  'mode-change': [mode: ReaderSurfaceMode];
  'pdf-tool': [tool: ReaderPdfTool];
  fullscreen: [];
  'retry-pdf-save': [];
}>();

const pageInput = ref(String(props.page || 1));
const zoomPercent = computed(() => Math.round((props.scale || 1) * 100));
const progressPercent = computed(() => Math.round(Math.min(100, Math.max(0, props.progress || 0))));
const isPdf = computed(() => props.format === 'pdf');

watch(
  () => props.page,
  (page) => {
    pageInput.value = String(page || 1);
  },
);

function submitPage(): void {
  const page = Math.round(Number(pageInput.value));
  if (!Number.isFinite(page) || !props.totalPages) {
    pageInput.value = String(props.page || 1);
    return;
  }
  const clamped = Math.min(props.totalPages, Math.max(1, page));
  pageInput.value = String(clamped);
  emit('page-change', clamped);
}

function jumpProgress(event: MouseEvent): void {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const dx = event.clientX - rect.left - rect.width / 2;
  const dy = event.clientY - rect.top - rect.height / 2;
  const fraction = ((Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
  emit('progress-jump', fraction);
}

function beginProgress(event: PointerEvent): void {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  jumpProgress(event);
}

function stepProgress(delta: number): void {
  emit('progress-jump', Math.min(1, Math.max(0, (progressPercent.value + delta) / 100)));
}
</script>

<template>
  <header
    class="reader-toolbar"
    :class="{ 'reader-toolbar--hidden': !visible }"
    aria-label="阅读器工具栏"
  >
    <div class="reader-toolbar__identity">
      <button class="reader-action" type="button" aria-label="退出阅读器" title="退出阅读器" @click="$emit('close')">
        <ArrowLeft :size="19" />
      </button>
      <button
        v-if="canGoBack"
        class="reader-action"
        type="button"
        aria-label="返回跳转前的位置"
        title="返回跳转前的位置"
        @click="$emit('go-back')"
      >
        <ChevronLeft :size="19" />
      </button>
      <div class="reader-toolbar__title">
        <strong>{{ title }}</strong>
        <span v-if="chapterLabel">{{ chapterLabel }}</span>
      </div>
    </div>

    <div class="reader-toolbar__primary">
      <button
        class="reader-action"
        :class="{ 'is-active': activePanel === 'contents' }"
        type="button"
        :disabled="!tocAvailable"
        aria-label="目录"
        :title="tocAvailable ? '目录' : '此文件没有目录'"
        @click="$emit('panel', 'contents')"
      >
        <ChevronRight :size="19" class="reader-toolbar__toc-icon" />
      </button>
      <button
        class="reader-action"
        :class="{ 'is-active': activePanel === 'search' }"
        type="button"
        aria-label="书内搜索"
        title="书内搜索"
        @click="$emit('panel', 'search')"
      >
        <Search :size="19" />
      </button>
      <button
        class="reader-action"
        :class="{ 'is-active': bookmarkActive }"
        type="button"
        :aria-label="bookmarkActive ? '删除当前位置书签' : '在当前位置添加书签'"
        :title="bookmarkActive ? '删除书签' : '添加书签'"
        @click="$emit('bookmark')"
      >
        <BookmarkCheck v-if="bookmarkActive" :size="19" />
        <Bookmark v-else :size="19" />
      </button>
      <button
        class="reader-action"
        :class="{ 'is-active': activePanel === 'annotations' }"
        type="button"
        aria-label="标注和书签"
        title="标注和书签"
        @click="$emit('panel', 'annotations')"
      >
        <MessageSquareText :size="19" />
      </button>
      <button
        class="reader-action"
        :class="{ 'is-active': activePanel === 'settings' }"
        type="button"
        aria-label="阅读外观和布局"
        title="阅读外观"
        @click="$emit('panel', 'settings')"
      >
        <Type :size="19" />
      </button>
    </div>

    <div v-if="isPdf" class="reader-toolbar__pdf-controls" aria-label="PDF 视图控制">
      <div class="reader-toolbar__segmented" role="group" aria-label="PDF 工具">
        <button
          type="button"
          :class="{ 'is-active': pdfTool === 'pan' }"
          aria-label="平移工具"
          title="平移"
          @click="$emit('pdf-tool', 'pan')"
        >
          <MousePointer2 :size="17" />
        </button>
        <button
          type="button"
          :class="{ 'is-active': pdfTool === 'select' }"
          aria-label="文本选择工具"
          title="选择文本"
          @click="$emit('pdf-tool', 'select')"
        >
          <Highlighter :size="17" />
        </button>
        <button
          type="button"
          :class="{ 'is-active': pdfTool === 'ink' }"
          aria-label="墨迹工具"
          title="墨迹"
          @click="$emit('pdf-tool', 'ink')"
        >
          <PenLine :size="17" />
        </button>
      </div>

      <div class="reader-toolbar__segmented reader-toolbar__fit" role="group" aria-label="缩放预设">
        <button
          type="button"
          :class="{ 'is-active': fitMode === 'width' }"
          aria-label="适合宽度"
          title="适合宽度"
          @click="$emit('fit-width')"
        >
          宽
        </button>
        <button
          type="button"
          :class="{ 'is-active': fitMode === 'page' }"
          aria-label="适合页面"
          title="适合页面"
          @click="$emit('fit-page')"
        >
          页
        </button>
        <button
          type="button"
          :class="{ 'is-active': fitMode === 'actual' }"
          aria-label="实际大小"
          title="实际大小"
          @click="$emit('actual-size')"
        >
          1:1
        </button>
      </div>

      <div class="reader-toolbar__zoom">
        <button class="reader-action" type="button" aria-label="缩小" title="缩小" @click="$emit('zoom-out')">
          <ZoomOut :size="18" />
        </button>
        <span class="reader-toolbar__value">{{ zoomPercent }}%</span>
        <button class="reader-action" type="button" aria-label="放大" title="放大" @click="$emit('zoom-in')">
          <ZoomIn :size="18" />
        </button>
      </div>

      <form class="reader-toolbar__page" @submit.prevent="submitPage">
        <input
          v-model="pageInput"
          inputmode="numeric"
          aria-label="当前页码"
          @blur="submitPage"
        />
        <span>/ {{ totalPages || '—' }}</span>
      </form>

      <button class="reader-action" type="button" aria-label="顺时针旋转视图" title="旋转视图" @click="$emit('rotate')">
        <RotateCw :size="18" />
      </button>
    </div>

    <div v-else class="reader-toolbar__text-controls">
      <button
        class="reader-toolbar__mode"
        type="button"
        :aria-label="mode === 'scroll' ? '切换为分页阅读' : '切换为连续滚动'"
        @click="$emit('mode-change', mode === 'scroll' ? 'paginated' : 'scroll')"
      >
        <SlidersHorizontal :size="16" />
        <span>{{ mode === 'scroll' ? '分页' : '滚动' }}</span>
      </button>
    </div>

    <div class="reader-toolbar__end">
      <button
        v-if="pdfSaving === 'error'"
        class="reader-toolbar__save-error"
        type="button"
        aria-label="PDF 标注写回失败，点击重试"
        @click="$emit('retry-pdf-save')"
      >
        写回失败
      </button>
      <span v-else-if="pdfSaving === 'saving'" class="reader-toolbar__saving" role="status">写回中</span>
      <button
        class="reader-action"
        type="button"
        :aria-label="fullscreen ? '退出全屏' : '进入全屏'"
        :title="fullscreen ? '退出全屏' : '全屏'"
        @click="$emit('fullscreen')"
      >
        <Minimize2 v-if="fullscreen" :size="18" />
        <Maximize2 v-else :size="18" />
      </button>
      <button
        class="reader-toolbar__progress"
        type="button"
        role="slider"
        aria-label="阅读进度，拖动圆环跳转"
        :aria-valuenow="progressPercent"
        aria-valuemin="0"
        aria-valuemax="100"
        @pointerdown="beginProgress"
        @pointermove="($event.buttons & 1) && jumpProgress($event)"
        @keydown.left.prevent="stepProgress(-1)"
        @keydown.down.prevent="stepProgress(-1)"
        @keydown.right.prevent="stepProgress(1)"
        @keydown.up.prevent="stepProgress(1)"
        @keydown.page-up.prevent="stepProgress(-10)"
        @keydown.page-down.prevent="stepProgress(10)"
        @keydown.home.prevent="emit('progress-jump', 0)"
        @keydown.end.prevent="emit('progress-jump', 1)"
      >
        <ProgressRing :value="progressPercent" :size="34" :stroke="2.5" aria-hidden="true"><span>{{ progressPercent }}%</span></ProgressRing>
      </button>
    </div>
  </header>
</template>

<style scoped>
.reader-toolbar {
  position: absolute;
  z-index: 40;
  top: max(12px, env(safe-area-inset-top));
  right: max(14px, env(safe-area-inset-right));
  left: max(14px, env(safe-area-inset-left));
  display: grid;
  min-height: 54px;
  grid-template-columns: minmax(150px, 1fr) auto minmax(0, 2.4fr) auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.42rem 0.52rem;
  border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface-elevated) 88%, transparent);
  box-shadow: var(--shadow-float);
  backdrop-filter: blur(22px) saturate(1.16);
  transition:
    opacity var(--motion-base) var(--ease-out),
    transform var(--motion-base) var(--ease-out);
}

.reader-toolbar--hidden {
  pointer-events: none;
  opacity: 0;
  transform: translateY(calc(-100% - 18px));
}

.reader-toolbar__identity,
.reader-toolbar__primary,
.reader-toolbar__pdf-controls,
.reader-toolbar__text-controls,
.reader-toolbar__end,
.reader-toolbar__zoom,
.reader-toolbar__page,
.reader-toolbar__segmented {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.2rem;
}

.reader-toolbar__title {
  display: grid;
  min-width: 0;
  margin-left: 0.15rem;
  line-height: 1.1;
}

.reader-toolbar__title strong,
.reader-toolbar__title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reader-toolbar__title strong {
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 700;
}

.reader-toolbar__title span {
  margin-top: 0.2rem;
  color: var(--text-tertiary);
  font-size: 0.66rem;
}

.reader-action,
.reader-toolbar__segmented button,
.reader-toolbar__mode {
  display: inline-grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 9px;
  color: var(--text-secondary);
  background: transparent;
  transition:
    color var(--motion-fast),
    background var(--motion-fast);
}

.reader-action:hover,
.reader-toolbar__segmented button:hover,
.reader-toolbar__mode:hover,
.reader-action.is-active,
.reader-toolbar__segmented button.is-active {
  color: var(--accent-strong);
  background: var(--accent-wash);
}

.reader-toolbar__toc-icon {
  transform: rotate(180deg);
}

.reader-toolbar__primary {
  padding: 0.12rem;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: color-mix(in srgb, var(--surface-muted) 82%, transparent);
}

.reader-toolbar__pdf-controls {
  justify-content: flex-end;
  overflow-x: auto;
  scrollbar-width: none;
}

.reader-toolbar__pdf-controls::-webkit-scrollbar {
  display: none;
}

.reader-toolbar__segmented {
  padding: 0.12rem;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-muted);
}

.reader-toolbar__segmented button {
  width: 32px;
  height: 30px;
  font-size: 0.7rem;
  font-weight: 700;
}

.reader-toolbar__zoom {
  padding-left: 0.15rem;
}

.reader-toolbar__value {
  width: 45px;
  color: var(--text-secondary);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.reader-toolbar__page {
  gap: 0.3rem;
  color: var(--text-tertiary);
  font-size: 0.7rem;
  white-space: nowrap;
}

.reader-toolbar__page input {
  width: 44px;
  min-height: 32px;
  padding: 0.25rem 0.35rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  background: var(--surface-elevated);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.reader-toolbar__mode {
  display: inline-flex;
  width: auto;
  padding: 0 0.65rem;
  gap: 0.35rem;
  font-size: 0.72rem;
  font-weight: 650;
}

.reader-toolbar__end {
  justify-content: flex-end;
}

.reader-toolbar__save-error {
  min-height: 32px;
  padding: 0.2rem 0.55rem;
  border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent);
  border-radius: 8px;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 0.66rem;
  font-weight: 700;
  white-space: nowrap;
}

.reader-toolbar__saving {
  color: var(--text-tertiary);
  font-size: 0.68rem;
  white-space: nowrap;
}

.reader-toolbar__progress {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--text-secondary);
  background: transparent;
  font-size: 0.54rem;
  font-variant-numeric: tabular-nums;
  touch-action: none;
  cursor: pointer;
}

@media (max-width: 1100px) {
  .reader-toolbar {
    grid-template-columns: minmax(120px, 1fr) auto minmax(0, 2fr) auto;
  }

  .reader-toolbar__title span,
  .reader-toolbar__fit {
    display: none;
  }
}

@media (max-width: 820px) {
  .reader-toolbar {
    top: max(8px, env(safe-area-inset-top));
    right: max(8px, env(safe-area-inset-right));
    left: max(8px, env(safe-area-inset-left));
    min-height: 50px;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    gap: 0.35rem;
    padding: 0.3rem;
    border-radius: 13px;
  }

  .reader-toolbar__title {
    display: none;
  }

  .reader-action,
  .reader-toolbar__segmented button {
    width: 34px;
    height: 34px;
  }

  .reader-toolbar__primary {
    gap: 0;
  }

  .reader-toolbar__pdf-controls {
    gap: 0.12rem;
  }

  .reader-toolbar__zoom .reader-action:first-child,
  .reader-toolbar__zoom .reader-action:last-child,
  .reader-toolbar__segmented[aria-label='PDF 工具'],
  .reader-toolbar__page span,
  .reader-toolbar__mode span,
  .reader-toolbar__saving {
    display: none;
  }

  .reader-toolbar__value {
    width: 38px;
  }

  .reader-toolbar__page input {
    width: 38px;
  }
}

@media (max-width: 520px) {
  .reader-toolbar__primary .reader-action:nth-child(4) {
    display: none;
  }

  .reader-toolbar__end .reader-action {
    display: none;
  }
}
</style>

