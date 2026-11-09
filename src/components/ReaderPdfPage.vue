<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { AlertCircle, LoaderCircle } from 'lucide-vue-next';
import {
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import type { Annotation } from '../types';
import { PDF_BASE_SCALE } from '../reader/types';
import { isAbortError } from '../reader/utils';

interface PdfRect {
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  id: string;
  type: Annotation['type'] | 'search';
}

const props = defineProps<{
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  baseWidth: number;
  baseHeight: number;
  rotation: number;
  zoom: number;
  active: boolean;
  tool: 'pan' | 'select' | 'ink';
  annotations: Annotation[];
  searchRects?: number[][];
}>();

const emit = defineEmits<{
  'render-state': [state: { loading: boolean; error: string; textAvailable: boolean | null }];
}>();

const canvas = ref<HTMLCanvasElement>();
const textLayer = ref<HTMLElement>();
const host = ref<HTMLElement>();
const error = ref('');
const loading = ref(false);
const textAvailable = ref<boolean | null>(null);
const pageProxy = shallowRef<PDFPageProxy>();
let renderTask: RenderTask | undefined;
let currentTextLayer: TextLayer | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let renderGeneration = 0;

const pageAnnotations = computed(() =>
  props.annotations.filter(
    (annotation) =>
      annotation.type !== 'bookmark' &&
      annotation.location.page === props.pageNumber,
  ),
);

function toBox(rect: number[], viewport: ReturnType<PDFPageProxy['getViewport']>): PdfRect | null {
  if (!rect || rect.length < 4) return null;
  try {
    const converted = viewport.convertToViewportRectangle(rect as [number, number, number, number]);
    const left = Math.min(converted[0], converted[2]);
    const top = Math.min(converted[1], converted[3]);
    return {
      left,
      top,
      width: Math.max(1, Math.abs(converted[2] - converted[0])),
      height: Math.max(1, Math.abs(converted[3] - converted[1])),
      color: '#f4c542',
      id: '',
      type: 'highlight',
    };
  } catch {
    return null;
  }
}

const annotationBoxes = computed<PdfRect[]>(() => {
  if (!pageProxy.value) return [];
  const viewport = pageProxy.value.getViewport({ scale: PDF_BASE_SCALE, rotation: props.rotation });
  const boxes: PdfRect[] = [];
  for (const annotation of pageAnnotations.value) {
    for (const rect of annotation.rects || []) {
      const box = toBox(rect, viewport);
      if (!box) continue;
      boxes.push({
        ...box,
        color: annotation.color || '#f4c542',
        id: annotation.id,
        type: annotation.type,
      });
    }
  }
  return boxes;
});

const searchBoxes = computed<PdfRect[]>(() => {
  if (!pageProxy.value) return [];
  const viewport = pageProxy.value.getViewport({ scale: PDF_BASE_SCALE, rotation: props.rotation });
  return (props.searchRects || [])
    .map((rect) => toBox(rect, viewport))
    .filter((box): box is PdfRect => Boolean(box))
    .map((box, index) => ({
      ...box,
      color: '#f4c542',
      id: `search-${index}`,
      type: 'search',
    }));
});

const inkAnnotations = computed(() => {
  if (!pageProxy.value) return [];
  const viewport = pageProxy.value.getViewport({ scale: PDF_BASE_SCALE, rotation: props.rotation });
  return pageAnnotations.value
    .filter((annotation) => annotation.type === 'ink' && Boolean(annotation.ink?.length))
    .map((annotation) => {
      const strokes = annotation.ink || [];
      const points = strokes
        .flatMap((stroke) => {
          if (stroke.length === 2) return [stroke];
          const result: number[][] = [];
          for (let index = 0; index + 1 < stroke.length; index += 2) {
            result.push([stroke[index], stroke[index + 1]]);
          }
          return result;
        })
        .map(([x, y]) => viewport.convertToViewportPoint(x, y));
      return {
        id: annotation.id,
        color: annotation.color || '#8067ce',
        points: points.map(([x, y]) => `${x},${y}`).join(' '),
      };
    });
});

function disposeTextLayer(): void {
  try {
    currentTextLayer?.cancel();
  } catch {
    // Cancellation can race a completed layer.
  }
  currentTextLayer = undefined;
  if (textLayer.value) textLayer.value.replaceChildren();
}

function release(): void {
  renderGeneration += 1;
  renderTask?.cancel();
  renderTask = undefined;
  disposeTextLayer();
  if (canvas.value) {
    canvas.value.width = 1;
    canvas.value.height = 1;
  }
  pageProxy.value?.cleanup();
}

async function renderPage(): Promise<void> {
  if (!props.active) return;
  const generation = ++renderGeneration;
  loading.value = true;
  error.value = '';
  emit('render-state', { loading: true, error: '', textAvailable: textAvailable.value });
  try {
    const page = pageProxy.value || await props.pdfDocument.getPage(props.pageNumber);
    pageProxy.value = page;
    if (generation !== renderGeneration) return;
    const outputScale = Math.min(2.2, Math.max(1, window.devicePixelRatio || 1));
    const desiredQuality = Math.max(0.35, Math.min(2.5, props.zoom * outputScale));
    const maxBackingPixels = 8_000_000;
    const basePixels = Math.max(1, props.baseWidth * props.baseHeight);
    const memoryCappedQuality = Math.min(desiredQuality, Math.sqrt(maxBackingPixels / basePixels));
    const renderScale = PDF_BASE_SCALE * memoryCappedQuality;
    const renderViewport = page.getViewport({ scale: renderScale, rotation: props.rotation });
    const element = canvas.value;
    const context = element?.getContext('2d', { alpha: false });
    if (!element || !context || generation !== renderGeneration) return;

    renderTask?.cancel();
    element.width = Math.max(1, Math.floor(renderViewport.width));
    element.height = Math.max(1, Math.floor(renderViewport.height));
    element.style.width = `${props.baseWidth}px`;
    element.style.height = `${props.baseHeight}px`;
    renderTask = page.render({
      canvas: element,
      canvasContext: context,
      viewport: renderViewport,
      intent: 'display',
      annotationMode: 1,
      background: '#ffffff',
    });
    await renderTask.promise;
    if (generation !== renderGeneration) return;

    await renderNativeText(generation);
    loading.value = false;
    emit('render-state', { loading: false, error: '', textAvailable: textAvailable.value });
  } catch (cause) {
    if (generation !== renderGeneration || isAbortError(cause)) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
    loading.value = false;
    emit('render-state', { loading: false, error: error.value, textAvailable: textAvailable.value });
  }
}

async function renderNativeText(generation: number): Promise<void> {
  const page = pageProxy.value;
  const container = textLayer.value;
  if (!page || !container || generation !== renderGeneration) return;
  disposeTextLayer();
  container.replaceChildren();
  container.style.setProperty('--total-scale-factor', String(PDF_BASE_SCALE));
  container.style.setProperty('--scale-round-x', '1px');
  container.style.setProperty('--scale-round-y', '1px');
  const viewport = page.getViewport({ scale: PDF_BASE_SCALE, rotation: props.rotation });
  const content = await page.getTextContent({
    includeMarkedContent: true,
    disableNormalization: false,
  });
  if (generation !== renderGeneration) return;
  const hasText = content.items.some(
    (item) => 'str' in item && Boolean(item.str.trim()),
  );
  textAvailable.value = hasText;
  currentTextLayer = new TextLayer({
    textContentSource: content,
    container,
    viewport,
  });
  await currentTextLayer.render();
  if (generation !== renderGeneration) return;
  const end = document.createElement('div');
  end.className = 'endOfContent';
  container.append(end);
}

function scheduleRender(delay = 80): void {
  if (!props.active) return;
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => void renderPage(), delay);
}

watch(
  () => props.active,
  (active) => {
    if (active) scheduleRender(0);
    else release();
  },
  { immediate: true },
);

watch(
  () => [props.zoom, props.rotation, props.pageNumber, props.baseWidth, props.baseHeight],
  () => scheduleRender(120),
);

onBeforeUnmount(() => {
  if (renderTimer) clearTimeout(renderTimer);
  release();
});
</script>

<template>
  <section
    ref="host"
    class="reader-pdf-page"
    :data-page-number="pageNumber"
    :style="{ width: `${baseWidth}px`, height: `${baseHeight}px` }"
    :aria-label="`PDF 第 ${pageNumber} 页`"
  >
    <canvas ref="canvas" class="reader-pdf-page__canvas"></canvas>

    <div class="reader-pdf-page__annotations" aria-hidden="true">
      <span
        v-for="box in annotationBoxes"
        :key="`${box.id}-${box.left}-${box.top}`"
        class="reader-pdf-page__annotation"
        :class="`is-${box.type}`"
        :style="{
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
          '--pdf-annotation': box.color,
        }"
        :data-annotation-id="box.id"
      ></span>

      <span
        v-for="box in searchBoxes"
        :key="`${box.id}-${box.left}-${box.top}`"
        class="reader-pdf-page__annotation is-search"
        :style="{
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
        }"
      ></span>

      <svg
        class="reader-pdf-page__ink"
        :viewBox="`0 0 ${baseWidth} ${baseHeight}`"
        preserveAspectRatio="none"
      >
        <polyline
          v-for="stroke in inkAnnotations"
          :key="stroke.id"
          :points="stroke.points"
          :stroke="stroke.color"
          fill="none"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </div>

    <div
      ref="textLayer"
      class="textLayer"
      :class="{
        'is-selectable': tool === 'select',
        'is-pan': tool === 'pan',
        'is-ink': tool === 'ink',
      }"
    ></div>

    <div v-if="loading" class="reader-pdf-page__state" role="status">
      <LoaderCircle :size="21" class="reader-pdf-page__spin" />
      <span>正在渲染第 {{ pageNumber }} 页</span>
    </div>
    <div v-else-if="error" class="reader-pdf-page__state reader-pdf-page__state--error" role="alert">
      <AlertCircle :size="20" />
      <span>第 {{ pageNumber }} 页渲染失败</span>
    </div>
  </section>
</template>

<style scoped>
.reader-pdf-page {
  position: absolute;
  overflow: hidden;
  color-scheme: only light;
  background: #fff;
  box-shadow:
    0 1px 2px rgba(31, 28, 24, 0.16),
    0 20px 52px -38px rgba(20, 18, 15, 0.5);
  contain: layout paint style;
}

.reader-pdf-page__canvas {
  position: absolute;
  z-index: 0;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  background: #fff;
}

.reader-pdf-page__annotations {
  position: absolute;
  z-index: 2;
  inset: 0;
  pointer-events: none;
}

.reader-pdf-page__annotation {
  position: absolute;
  border-radius: 1px;
  mix-blend-mode: multiply;
}

.reader-pdf-page__annotation.is-highlight {
  background: color-mix(in srgb, var(--pdf-annotation) 42%, transparent);
}

.reader-pdf-page__annotation.is-underline {
  border-bottom: 2px solid var(--pdf-annotation);
}

.reader-pdf-page__annotation.is-note {
  width: 14px !important;
  height: 14px !important;
  border: 1px solid color-mix(in srgb, var(--pdf-annotation) 65%, #5d5139);
  border-radius: 3px 3px 3px 0;
  background: color-mix(in srgb, var(--pdf-annotation) 72%, white);
  box-shadow: 0 2px 6px rgba(40, 35, 24, 0.2);
  transform: translate(-4px, -10px) rotate(-8deg);
}

.reader-pdf-page__annotation.is-search {
  background: rgba(244, 197, 66, 0.35);
  box-shadow: 0 0 0 1px rgba(181, 135, 17, 0.32);
  animation: search-pulse 1.8s ease-in-out infinite;
}

.reader-pdf-page__ink {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.textLayer {
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
  position: absolute;
  z-index: 3;
  inset: 0;
  overflow: clip;
  color-scheme: only light;
  line-height: 1;
  opacity: 1;
  text-align: initial;
  transform-origin: 0 0;
  user-select: none;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
  forced-color-adjust: none;
}

.textLayer.is-selectable {
  cursor: text;
  user-select: text;
}

.textLayer span,
.textLayer br {
  position: absolute;
  color: transparent;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
}

.textLayer > :not(.markedContent),
.textLayer .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  --scale-x: 1;
  --rotate: 0deg;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}

.textLayer .markedContent {
  display: contents;
}

.textLayer.is-pan,
.textLayer.is-ink {
  pointer-events: none;
}

.textLayer ::selection {
  color: transparent;
  background: color-mix(in srgb, var(--accent) 30%, transparent);
}

.textLayer br::selection {
  background: transparent;
}

.textLayer .endOfContent {
  position: absolute;
  display: block;
  inset: 100% 0 0;
  z-index: 0;
  cursor: default;
  user-select: none;
}

.reader-pdf-page__state {
  position: absolute;
  z-index: 5;
  inset: 0;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 0.5rem;
  color: #77706a;
  background: rgba(249, 248, 246, 0.82);
  font-size: 0.68rem;
}

.reader-pdf-page__state--error {
  color: var(--danger);
}

.reader-pdf-page__spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes search-pulse {
  50% {
    background: rgba(244, 197, 66, 0.58);
  }
}
</style>
