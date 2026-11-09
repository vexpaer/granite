<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from 'vue';
import {
  AlertTriangle,
  LoaderCircle,
} from 'lucide-vue-next';
import {
  Util,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
import type { Annotation, ReaderLocation } from '../types';
import type {
  PdfFitMode,
  PdfPageLayout,
  ReaderPdfInkInput,
  ReaderPdfTool,
  ReaderSearchResult,
  ReaderTextSelection,
  ReaderTocItem,
} from '../reader/types';
import {
  PDF_BASE_SCALE,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
} from '../reader/types';
import {
  clamp,
  clamp01,
  isAbortError,
} from '../reader/utils';
import {
  clampToOverscroll,
  documentBounds,
  fitPageScale,
  fitWidthScale,
  nearestLegalTransform,
  pageAtViewportCenter,
  translatePageToTop,
  zoomAndPanBetweenPoints,
  zoomAroundPoint,
  type DocumentTransform,
} from '../reader/pdf-geometry';
import ReaderPdfPage from './ReaderPdfPage.vue';

type Viewport = ReturnType<PDFPageProxy['getViewport']>;
type PdfRegionLocation = ReaderLocation & { rects?: number[][] };

const props = withDefaults(
  defineProps<{
    pdfDocument: PDFDocumentProxy;
    initialLocation?: ReaderLocation;
    annotations: Annotation[];
    activeSearchResult?: ReaderSearchResult | null;
    activeSearchQuery?: string;
    tool?: ReaderPdfTool;
    annotationColor?: string;
  }>(),
  {
    tool: 'pan',
    annotationColor: '#8067ce',
  },
);

const emit = defineEmits<{
  'location-change': [location: ReaderLocation];
  'view-change': [view: {
    page: number;
    totalPages: number;
    scale: number;
    rotation: number;
    x: number;
    y: number;
    fitMode: PdfFitMode;
  }];
  toc: [items: ReaderTocItem[]];
  'text-available': [available: boolean];
  selection: [selection: ReaderTextSelection | null];
  ink: [input: ReaderPdfInkInput];
  'center-tap': [];
  interaction: [];
  'request-tool-select': [];
  ready: [];
}>();

const viewport = ref<HTMLElement>();
const layouts = ref<PdfPageLayout[]>([]);
const pageViewports = new Map<number, Viewport>();
const docWidth = ref(0);
const docHeight = ref(0);
const x = ref(0);
const y = ref(0);
const scale = ref(1);
const rotation = ref(normalizeRotation(props.initialLocation?.rotation || 0));
const currentPage = ref(1);
const fitMode = ref<PdfFitMode>('width');
const loading = ref(true);
const loadingPage = ref(0);
const loadError = ref('');
const textAvailable = ref<boolean | null>(null);
const activePages = shallowRef<Set<number>>(new Set());
const activePageStart = ref(1);
const activePageEnd = ref(1);
const drawing = ref<{ page: number; points: number[] } | null>(null);
const viewportSize = ref({ width: window.innerWidth, height: window.innerHeight });

const pageGap = 18;
const totalPages = computed(() => props.pdfDocument.numPages);
const transform = computed<DocumentTransform>(() => ({
  x: x.value,
  y: y.value,
  scale: scale.value,
}));
const pageLayouts = computed(() =>
  layouts.value.map((layout) => ({
    ...layout,
    screenTop: y.value + layout.y * scale.value,
    screenBottom: y.value + (layout.y + layout.height) * scale.value,
  })),
);
const currentSearchRects = computed(() =>
  props.activeSearchResult?.page === currentPage.value
    ? props.activeSearchResult.rects || []
    : [],
);
const drawingPageLayout = computed(() =>
  drawing.value ? layouts.value.find((layout) => layout.page === drawing.value?.page) : undefined,
);
const drawingPoints = computed(() => {
  if (!drawing.value || !drawingPageLayout.value) return '';
  const values = drawing.value.points;
  const points: string[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    points.push(
      `${drawingPageLayout.value.x + values[index]},${drawingPageLayout.value.y + values[index + 1]}`,
    );
  }
  return points.join(' ');
});

let resizeObserver: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let layoutGeneration = 0;
let springFrame = 0;
let momentumFrame = 0;
let viewEmitFrame = 0;
let lastViewEmit = 0;
let wheelSpringTimer: ReturnType<typeof setTimeout> | undefined;
let initialized = false;
let suppressClickUntil = 0;
let longPressTimer: ReturnType<typeof setTimeout> | undefined;
let pointerStart = { x: 0, y: 0 };
let pointerMoved = false;
let inkPage = 0;
let inkPoints: number[] = [];
let lastMomentum = { x: 0, y: 0, at: 0 };
const pointers = new Map<number, { x: number; y: number }>();
let gestureBase: DocumentTransform = { x: 0, y: 0, scale: 1 };
let gestureStartCenter = { x: 0, y: 0 };
let gestureStartDistance = 0;
let gestureMaxPointers = 0;

function normalizeRotation(value: number): number {
  const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return normalized;
}

function viewportRect(): DOMRect | null {
  return viewport.value?.getBoundingClientRect() || null;
}

function setTransform(next: DocumentTransform, emitChange = true): void {
  const size = viewportSize.value;
  const clamped = clampToOverscroll(next, docWidth.value, docHeight.value, size);
  x.value = clamped.x;
  y.value = clamped.y;
  scale.value = clamped.scale;
  updateVisiblePages();
  if (emitChange) scheduleViewEmit();
}

function setLegalTransform(next: DocumentTransform): void {
  const legal = nearestLegalTransform(next, docWidth.value, docHeight.value, viewportSize.value);
  x.value = legal.x;
  y.value = legal.y;
  scale.value = legal.scale;
  updateVisiblePages();
  scheduleViewEmit();
}

function scheduleViewEmit(): void {
  const now = performance.now();
  if (viewEmitFrame) return;
  viewEmitFrame = requestAnimationFrame(() => {
    viewEmitFrame = 0;
    if (now - lastViewEmit < 60) return;
    lastViewEmit = now;
    emitView();
  });
}

function pageProgress(page: number, pageCenterFraction = 0.5): number {
  return clamp01((page - 1 + pageCenterFraction) / Math.max(1, totalPages.value));
}

function currentLocation(): ReaderLocation {
  const size = viewportSize.value;
  const contentBottom = (size.height - y.value) / Math.max(0.001, scale.value);
  const progress = docHeight.value > 0 ? clamp01(contentBottom / docHeight.value) : pageProgress(currentPage.value);
  return {
    format: 'pdf',
    progress,
    page: currentPage.value,
    x: Math.round(x.value * 100) / 100,
    y: Math.round(y.value * 100) / 100,
    scale: Math.round(scale.value * 10000) / 10000,
    rotation: rotation.value,
  };
}

function emitView(): void {
  const location = currentLocation();
  emit('view-change', {
    page: currentPage.value,
    totalPages: totalPages.value,
    scale: scale.value,
    rotation: rotation.value,
    x: x.value,
    y: y.value,
    fitMode: fitMode.value,
  });
  emit('location-change', location);
}

function updateCurrentPage(): void {
  if (!layouts.value.length) return;
  const page = pageAtViewportCenter(layouts.value, transform.value, viewportSize.value.height);
  if (page !== currentPage.value) currentPage.value = page;
}

function updateVisiblePages(): void {
  updateCurrentPage();
  if (!layouts.value.length) return;
  const margin = viewportSize.value.height * 1.15;
  const active = new Set<number>();
  let first = totalPages.value;
  let last = 1;
  for (const layout of layouts.value) {
    const top = y.value + layout.y * scale.value;
    const bottom = y.value + (layout.y + layout.height) * scale.value;
    if (bottom >= -margin && top <= viewportSize.value.height + margin) {
      active.add(layout.page);
      first = Math.min(first, layout.page);
      last = Math.max(last, layout.page);
    }
  }
  activePages.value = active;
  activePageStart.value = first === totalPages.value ? currentPage.value : first;
  activePageEnd.value = last === 1 ? currentPage.value : last;
}

function stopAnimations(): void {
  if (springFrame) cancelAnimationFrame(springFrame);
  if (momentumFrame) cancelAnimationFrame(momentumFrame);
  springFrame = 0;
  momentumFrame = 0;
}

function springToLegal(duration = 330): void {
  stopAnimations();
  const from = { ...transform.value };
  const to = nearestLegalTransform(from, docWidth.value, docHeight.value, viewportSize.value);
  const started = performance.now();
  const step = (now: number) => {
    const progress = clamp01((now - started) / duration);
    const eased = 1 - (1 - progress) ** 3;
    setTransform({
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      scale: from.scale + (to.scale - from.scale) * eased,
    });
    if (progress < 1) springFrame = requestAnimationFrame(step);
    else {
      springFrame = 0;
      setLegalTransform(to);
    }
  };
  springFrame = requestAnimationFrame(step);
}

function outsideLegalBounds(value = transform.value): boolean {
  const bounds = documentBounds(docWidth.value, docHeight.value, viewportSize.value, value.scale);
  return (
    Math.abs(value.x - clamp(value.x, bounds.x.min, bounds.x.max)) > 0.5 ||
    Math.abs(value.y - clamp(value.y, bounds.y.min, bounds.y.max)) > 0.5
  );
}

function startMomentum(vx: number, vy: number): void {
  if (Math.hypot(vx, vy) < 0.035) {
    if (outsideLegalBounds()) springToLegal();
    return;
  }
  let velocityX = vx;
  let velocityY = vy;
  let previous = performance.now();
  const step = (now: number) => {
    const delta = Math.min(34, now - previous);
    previous = now;
    if (delta <= 0) {
      momentumFrame = requestAnimationFrame(step);
      return;
    }
    velocityX *= 0.985 ** (delta / 8.33);
    velocityY *= 0.985 ** (delta / 8.33);
    setTransform({
      x: x.value + velocityX * delta,
      y: y.value + velocityY * delta,
      scale: scale.value,
    });
    if (Math.hypot(velocityX, velocityY) > 0.012) {
      momentumFrame = requestAnimationFrame(step);
    } else {
      momentumFrame = 0;
      springToLegal();
    }
  };
  momentumFrame = requestAnimationFrame(step);
}

async function loadLayouts(): Promise<void> {
  const generation = ++layoutGeneration;
  loading.value = true;
  loadError.value = '';
  layouts.value = [];
  pageViewports.clear();
  const nextLayouts: Array<Pick<PdfPageLayout, 'page' | 'width' | 'height'>> = [];
  for (let start = 1; start <= totalPages.value; start += 8) {
    const batch = Array.from(
      { length: Math.min(8, totalPages.value - start + 1) },
      (_, index) => start + index,
    );
    const pages = await Promise.all(batch.map(async (pageNumber) => {
      const page = await props.pdfDocument.getPage(pageNumber);
      const viewportValue = page.getViewport({ scale: PDF_BASE_SCALE, rotation: rotation.value });
      pageViewports.set(pageNumber, viewportValue);
      page.cleanup();
      return {
        page: pageNumber,
        width: viewportValue.width,
        height: viewportValue.height,
      };
    }));
    if (generation !== layoutGeneration) return;
    nextLayouts.push(...pages);
    loadingPage.value = Math.min(totalPages.value, start + batch.length - 1);
  }
  const width = Math.max(...nextLayouts.map((layout) => layout.width), 1);
  let top = 0;
  const positioned = nextLayouts.map((page) => {
    const positionedPage: PdfPageLayout = {
      ...page,
      x: (width - page.width) / 2,
      y: top,
      rotate: rotation.value,
    };
    top += page.height + pageGap;
    return positionedPage;
  });
  docWidth.value = width;
  docHeight.value = Math.max(1, top - pageGap);
  layouts.value = positioned;
  loading.value = false;
  await nextTick();
  if (!initialized) restoreInitial();
  else goToPage(currentPage.value, false);
  await probeTextLayer();
  emit('ready');
}

function resizeViewport(): void {
  const rect = viewportRect();
  if (!rect) return;
  viewportSize.value = { width: rect.width, height: rect.height };
}

function restoreInitial(): void {
  const location = props.initialLocation;
  resizeViewport();
  const savedScale =
    Number.isFinite(location?.scale) && (location?.scale || 0) >= PDF_MIN_SCALE && (location?.scale || 0) <= PDF_MAX_SCALE
      ? location!.scale!
      : fitWidthScale(docWidth.value, viewportSize.value.width);
  scale.value = savedScale;
  currentPage.value = clamp(Math.round(location?.page || 1), 1, totalPages.value);
  if (Number.isFinite(location?.x) && Number.isFinite(location?.y)) {
    x.value = location?.x || 0;
    y.value = location?.y || 0;
    fitMode.value = 'custom';
  } else {
    fitMode.value = location?.scale ? 'custom' : 'width';
    goToPage(currentPage.value, false, false);
  }
  setLegalTransform(transform.value);
  initialized = true;
  updateVisiblePages();
  emitView();
}

async function probeTextLayer(): Promise<void> {
  for (let page = 1; page <= Math.min(totalPages.value, 4); page += 1) {
    try {
      const proxy = await props.pdfDocument.getPage(page);
      const content = await proxy.getTextContent({ includeMarkedContent: false });
      const textLength = content.items.reduce(
        (total, item) => total + ('str' in item ? item.str.trim().length : 0),
        0,
      );
      proxy.cleanup();
      if (textLength >= 4) {
        textAvailable.value = true;
        emit('text-available', true);
        return;
      }
    } catch {
      // Continue probing; a damaged page should not make the whole file opaque.
    }
  }
  textAvailable.value = false;
  emit('text-available', false);
}

async function loadOutline(): Promise<void> {
  try {
    const outline = await props.pdfDocument.getOutline();
    if (!outline?.length) {
      emit('toc', []);
      return;
    }
    const convert = async (
      items: typeof outline,
      level = 0,
    ): Promise<ReaderTocItem[]> => {
      const result: ReaderTocItem[] = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        let page: number | undefined;
        try {
          let destination = item.dest;
          if (typeof destination === 'string') destination = await props.pdfDocument.getDestination(destination);
          if (Array.isArray(destination) && destination.length) {
            const reference = destination[0];
            if (typeof reference === 'number') page = clamp(Math.round(reference) + 1, 1, totalPages.value);
            else if (reference && typeof reference === 'object') {
              page = (await props.pdfDocument.getPageIndex(reference as never)) + 1;
            }
          }
        } catch {
          page = undefined;
        }
        const children = item.items?.length ? await convert(item.items, level + 1) : undefined;
        result.push({
          id: `pdf-toc-${level}-${index}-${item.title}`,
          label: item.title || `第 ${page || result.length + 1} 页`,
          page,
          level,
          ...(children?.length ? { children } : {}),
        });
      }
      return result;
    };
    emit('toc', await convert(outline));
  } catch {
    emit('toc', []);
  }
}

function goToPage(page: number, smooth = true, announce = true): void {
  const targetPage = clamp(Math.round(page), 1, totalPages.value);
  const layout = layouts.value.find((item) => item.page === targetPage);
  if (!layout) return;
  currentPage.value = targetPage;
  const next: DocumentTransform = {
    x: nearestLegalTransform(
      { x: -layout.x * scale.value + (viewportSize.value.width - layout.width * scale.value) / 2, y: 0, scale: scale.value },
      docWidth.value,
      docHeight.value,
      viewportSize.value,
    ).x,
    y: translatePageToTop(layout.y, layout.height, scale.value, viewportSize.value.height),
    scale: scale.value,
  };
  if (smooth) {
    const from = { ...transform.value };
    stopAnimations();
    const target = nearestLegalTransform(next, docWidth.value, docHeight.value, viewportSize.value);
    const started = performance.now();
    const step = (now: number) => {
      const progress = clamp01((now - started) / 320);
      const eased = 1 - (1 - progress) ** 3;
      setTransform({
        x: from.x + (target.x - from.x) * eased,
        y: from.y + (target.y - from.y) * eased,
        scale: scale.value,
      });
      if (progress < 1) springFrame = requestAnimationFrame(step);
      else {
        springFrame = 0;
        setLegalTransform(target);
        if (announce) emitView();
      }
    };
    springFrame = requestAnimationFrame(step);
  } else {
    setLegalTransform(next);
    if (announce) emitView();
  }
  updateVisiblePages();
}

async function jumpTo(location: PdfRegionLocation): Promise<void> {
  if (location.rotation != null) {
    const nextRotation = normalizeRotation(location.rotation);
    if (nextRotation !== rotation.value) {
      rotation.value = nextRotation;
      await loadLayouts();
    }
  }
  if (location.scale && Number.isFinite(location.scale)) {
    scale.value = clamp(location.scale, PDF_MIN_SCALE, PDF_MAX_SCALE);
    fitMode.value = 'custom';
  }
  const page = clamp(Math.round(location.page || currentPage.value), 1, totalPages.value);
  if (location.x != null && location.y != null && location.rects?.length === 0) {
    x.value = location.x;
    y.value = location.y;
    currentPage.value = page;
    setLegalTransform(transform.value);
    emitView();
    return;
  }
  const rect = location.rects?.[0];
  const layout = layouts.value.find((item) => item.page === page);
  const pageViewport = pageViewports.get(page);
  if (rect && layout && pageViewport) {
    const converted = pageViewport.convertToViewportRectangle(rect as [number, number, number, number]);
    const centerX = (Math.min(converted[0], converted[2]) + Math.max(converted[0], converted[2])) / 2;
    const centerY = (Math.min(converted[1], converted[3]) + Math.max(converted[1], converted[3])) / 2;
    setLegalTransform({
      x: viewportSize.value.width / 2 - (layout.x + centerX) * scale.value,
      y: viewportSize.value.height * 0.34 - (layout.y + centerY) * scale.value,
      scale: scale.value,
    });
    currentPage.value = page;
    emitView();
    return;
  }
  goToPage(page, true, true);
}

function fitWidth(): void {
  resizeViewport();
  const nextScale = fitWidthScale(docWidth.value, viewportSize.value.width);
  const center = { x: viewportSize.value.width / 2, y: viewportSize.value.height / 2 };
  fitMode.value = 'width';
  setLegalTransform(zoomAroundPoint(transform.value, nextScale, center));
  springToLegal();
}

function fitPage(): void {
  resizeViewport();
  const layout = layouts.value.find((item) => item.page === currentPage.value);
  if (!layout) return;
  const nextScale = fitPageScale(layout.width, layout.height, viewportSize.value);
  fitMode.value = 'page';
  scale.value = nextScale;
  goToPage(currentPage.value, true, true);
}

function actualSize(): void {
  resizeViewport();
  fitMode.value = 'actual';
  setLegalTransform(zoomAroundPoint(
    transform.value,
    1,
    { x: viewportSize.value.width / 2, y: viewportSize.value.height / 2 },
  ));
  springToLegal();
}

function zoomBy(factor: number, point?: { x: number; y: number }): void {
  fitMode.value = 'custom';
  const anchor = point || { x: viewportSize.value.width / 2, y: viewportSize.value.height / 2 };
  setTransform(zoomAroundPoint(transform.value, scale.value * factor, anchor));
  springToLegal();
}

function rotateView(): void {
  rotation.value = (rotation.value + 90) % 360;
  void loadLayouts();
}

function pointInViewport(clientX: number, clientY: number): { x: number; y: number } {
  const rect = viewportRect();
  return {
    x: clientX - (rect?.left || 0),
    y: clientY - (rect?.top || 0),
  };
}

function pointerCenter(): { x: number; y: number } {
  const values = [...pointers.values()];
  if (!values.length) return { x: 0, y: 0 };
  return {
    x: values.reduce((sum, point) => sum + point.x, 0) / values.length,
    y: values.reduce((sum, point) => sum + point.y, 0) / values.length,
  };
}

function pointerDistance(): number {
  const values = [...pointers.values()];
  if (values.length < 2) return 0;
  return Math.hypot(values[1].x - values[0].x, values[1].y - values[0].y);
}

function resetGestureBase(): void {
  const center = pointerCenter();
  gestureBase = { ...transform.value };
  gestureStartCenter = center;
  gestureStartDistance = pointerDistance();
  lastMomentum = { x: center.x, y: center.y, at: performance.now() };
}

function onPointerDown(event: PointerEvent): void {
  emit('interaction');
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const local = pointInViewport(event.clientX, event.clientY);
  pointerStart = local;
  pointerMoved = false;
  if (props.tool === 'ink') {
    beginInk(event, local);
    return;
  }
  if (props.tool === 'select') return;
  stopAnimations();
  pointers.set(event.pointerId, local);
  viewport.value?.setPointerCapture(event.pointerId);
  gestureMaxPointers = Math.max(gestureMaxPointers, pointers.size);
  if (pointers.size <= 2) resetGestureBase();
  if (event.pointerType === 'touch' && pointers.size === 1) {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      if (!pointerMoved) emit('request-tool-select');
    }, 560);
  }
}

function onPointerMove(event: PointerEvent): void {
  emit('interaction');
  if (props.tool === 'ink') {
    moveInk(event);
    return;
  }
  if (!pointers.has(event.pointerId) || props.tool !== 'pan') return;
  const local = pointInViewport(event.clientX, event.clientY);
  pointers.set(event.pointerId, local);
  const center = pointerCenter();
  if (Math.hypot(center.x - pointerStart.x, center.y - pointerStart.y) > 4) {
    pointerMoved = true;
    if (longPressTimer) clearTimeout(longPressTimer);
  }
  if (pointers.size === 1) {
    setTransform({
      x: gestureBase.x + center.x - gestureStartCenter.x,
      y: gestureBase.y + center.y - gestureStartCenter.y,
      scale: gestureBase.scale,
    });
  } else if (pointers.size >= 2) {
    const distance = Math.max(1, pointerDistance());
    const ratio = gestureStartDistance > 0 ? distance / gestureStartDistance : 1;
    const zoomed = zoomAndPanBetweenPoints(
      gestureBase,
      gestureBase.scale * ratio,
      gestureStartCenter,
      center,
    );
    setTransform(zoomed);
  }
  lastMomentum = { x: center.x, y: center.y, at: performance.now() };
  event.preventDefault();
}

function onPointerUp(event: PointerEvent): void {
  if (longPressTimer) clearTimeout(longPressTimer);
  if (props.tool === 'ink') {
    finishInk(event);
    return;
  }
  if (props.tool === 'select') {
    window.setTimeout(inspectSelection, 25);
    return;
  }
  pointers.delete(event.pointerId);
  try {
    viewport.value?.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture may already be released by the browser.
  }
  if (pointers.size) {
    resetGestureBase();
    return;
  }
  const now = performance.now();
  const elapsed = Math.max(8, now - lastMomentum.at);
  const vx = pointerMoved ? (lastMomentum.x - pointerStart.x) / elapsed : 0;
  const vy = pointerMoved ? (lastMomentum.y - pointerStart.y) / elapsed : 0;
  if (pointerMoved) {
    suppressClickUntil = now + 80;
    startMomentum(vx, vy);
  } else {
    springToLegal(280);
  }
  gestureMaxPointers = 0;
}

function onPointerCancel(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  if (!pointers.size) springToLegal();
}

function beginInk(event: PointerEvent, point: { x: number; y: number }): void {
  const localDocument = {
    x: (point.x - x.value) / scale.value,
    y: (point.y - y.value) / scale.value,
  };
  const layout = layouts.value.find(
    (candidate) =>
      localDocument.x >= candidate.x &&
      localDocument.x <= candidate.x + candidate.width &&
      localDocument.y >= candidate.y &&
      localDocument.y <= candidate.y + candidate.height,
  );
  if (!layout) return;
  inkPage = layout.page;
  inkPoints = [localDocument.x - layout.x, localDocument.y - layout.y];
  drawing.value = { page: layout.page, points: [...inkPoints] };
  pointerMoved = false;
  viewport.value?.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveInk(event: PointerEvent): void {
  if (!drawing.value || !inkPage) return;
  const viewportPoint = pointInViewport(event.clientX, event.clientY);
  const documentPoint = {
    x: (viewportPoint.x - x.value) / scale.value,
    y: (viewportPoint.y - y.value) / scale.value,
  };
  const layout = layouts.value.find((item) => item.page === inkPage);
  if (!layout) return;
  const localX = documentPoint.x - layout.x;
  const localY = documentPoint.y - layout.y;
  const previousX = inkPoints[inkPoints.length - 2];
  const previousY = inkPoints[inkPoints.length - 1];
  if (Math.hypot(localX - previousX, localY - previousY) < 1.2) return;
  inkPoints.push(localX, localY);
  drawing.value = { page: inkPage, points: [...inkPoints] };
  pointerMoved = true;
  event.preventDefault();
}

function finishInk(event: PointerEvent): void {
  try {
    viewport.value?.releasePointerCapture(event.pointerId);
  } catch {
    // Ignore a release race.
  }
  const points = [...inkPoints];
  const page = inkPage;
  inkPage = 0;
  inkPoints = [];
  drawing.value = null;
  if (!page || points.length < 4) return;
  const pageViewport = pageViewports.get(page);
  const layout = layouts.value.find((item) => item.page === page);
  if (!pageViewport || !layout) return;
  const pdfPoints: number[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 1 < points.length; index += 2) {
    const [pdfX, pdfY] = pageViewport.convertToPdfPoint(points[index], points[index + 1]);
    pdfPoints.push(pdfX, pdfY);
    minX = Math.min(minX, pdfX);
    minY = Math.min(minY, pdfY);
    maxX = Math.max(maxX, pdfX);
    maxY = Math.max(maxY, pdfY);
  }
  const progress = pageProgress(page);
  emit('ink', {
    page,
    rects: [[minX - 2, minY - 2, maxX + 2, maxY + 2]],
    ink: [pdfPoints],
    color: props.annotationColor,
    location: {
      format: 'pdf',
      progress,
      page,
      scale: scale.value,
      rotation: rotation.value,
      x: x.value,
      y: y.value,
    },
  });
  suppressClickUntil = performance.now() + 80;
}

function onWheel(event: WheelEvent): void {
  emit('interaction');
  event.preventDefault();
  stopAnimations();
  if (event.ctrlKey || event.metaKey) {
    const local = pointInViewport(event.clientX, event.clientY);
    const factor = Math.exp(-event.deltaY * 0.0018);
    fitMode.value = 'custom';
    setTransform(zoomAroundPoint(transform.value, scale.value * factor, local));
    if (wheelSpringTimer) clearTimeout(wheelSpringTimer);
    wheelSpringTimer = setTimeout(() => {
      if (outsideLegalBounds()) springToLegal(260);
    }, 170);
    return;
  }
  const deltaX = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
  const deltaY = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
  setTransform({
    x: x.value - deltaX,
    y: y.value - deltaY,
    scale: scale.value,
  });
  if (wheelSpringTimer) clearTimeout(wheelSpringTimer);
  wheelSpringTimer = setTimeout(() => {
    if (outsideLegalBounds()) springToLegal(300);
  }, 150);
}

function inspectSelection(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    emit('selection', null);
    return;
  }
  const range = selection.getRangeAt(0);
  const startElement =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
  const pageElement = startElement?.closest<HTMLElement>('.reader-pdf-page');
  const page = Number(pageElement?.dataset.pageNumber);
  const pageViewport = pageViewports.get(page);
  const pageRect = pageElement?.getBoundingClientRect();
  const text = selection.toString().replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!page || !pageViewport || !pageRect || !text) return;
  const pdfRects: number[][] = [];
  for (const rect of [...range.getClientRects()]) {
    if (rect.width < 0.5 || rect.height < 0.5) continue;
    const left = clamp((rect.left - pageRect.left) / scale.value, 0, pageRect.width / scale.value);
    const right = clamp((rect.right - pageRect.left) / scale.value, 0, pageRect.width / scale.value);
    const top = clamp((rect.top - pageRect.top) / scale.value, 0, pageRect.height / scale.value);
    const bottom = clamp((rect.bottom - pageRect.top) / scale.value, 0, pageRect.height / scale.value);
    const [x1, y1] = pageViewport.convertToPdfPoint(left, top);
    const [x2, y2] = pageViewport.convertToPdfPoint(right, bottom);
    pdfRects.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
  }
  const bounds = range.getBoundingClientRect();
  emit('selection', {
    text,
    page,
    rects: pdfRects,
    anchor: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    location: {
      format: 'pdf',
      progress: pageProgress(page),
      page,
      x: x.value,
      y: y.value,
      scale: scale.value,
      rotation: rotation.value,
      quote: text.slice(0, 600),
    },
  });
}

function onContextMenu(event: MouseEvent): void {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    event.preventDefault();
    inspectSelection();
  }
}

function onClick(event: MouseEvent): void {
  if (performance.now() < suppressClickUntil) return;
  if (window.getSelection()?.toString().trim()) return;
  const rect = viewportRect();
  if (!rect) return;
  const centralX =
    event.clientX > rect.left + rect.width * 0.22 &&
    event.clientX < rect.right - rect.width * 0.22;
  const centralY =
    event.clientY > rect.top + rect.height * 0.2 &&
    event.clientY < rect.bottom - rect.height * 0.18;
  if (centralX && centralY) emit('center-tap');
}

function textRect(item: Record<string, unknown>, start: number, end: number): number[] | null {
  const page = props.pdfDocument.numPages;
  if (!page) return null;
  const transformValue = item.transform as number[] | undefined;
  const widthValue = Number(item.width);
  const raw = String(item.str || '');
  if (!transformValue || !Number.isFinite(widthValue) || !raw.length) return null;
  const viewportValue = pageViewports.get(currentPage.value);
  if (!viewportValue) return null;
  const transformed = Util.transform(viewportValue.transform, transformValue);
  const ratioStart = start / raw.length;
  const ratioEnd = end / raw.length;
  const left = transformed[4] + widthValue * ratioStart;
  const right = transformed[4] + widthValue * ratioEnd;
  const top = transformed[5] - Math.max(1, Number(item.height) || 10);
  const bottom = transformed[5];
  const [x1, y1] = viewportValue.convertToPdfPoint(left, top);
  const [x2, y2] = viewportValue.convertToPdfPoint(right, bottom);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

async function search(query: string, limit = 500): Promise<ReaderSearchResult[]> {
  const needle = query.trim();
  if (!needle) return [];
  const foldedNeedle = normalizeSearch(needle);
  const results: ReaderSearchResult[] = [];
  for (let pageNumber = 1; pageNumber <= totalPages.value && results.length < limit; pageNumber += 1) {
    const page = await props.pdfDocument.getPage(pageNumber);
    const viewportValue = page.getViewport({ scale: 1, rotation: 0 });
    const content = await page.getTextContent({ includeMarkedContent: false });
    const textItems = content.items.filter(
      (item): item is Extract<typeof item, { str: string }> => 'str' in item && Boolean(item.str),
    );
    const itemOffsets: number[] = [];
    let pageText = '';
    for (const item of textItems) {
      itemOffsets.push(pageText.length);
      pageText += item.str;
      if (item.hasEOL) pageText += '\n';
      else if (item.str && !/\s$/.test(item.str)) pageText += ' ';
    }
    const foldedPage = normalizeSearch(pageText);
    for (let itemIndex = 0; itemIndex < textItems.length && results.length < limit; itemIndex += 1) {
      const item = textItems[itemIndex];
      const foldedItem = normalizeSearch(item.str);
      let from = 0;
      while (results.length < limit) {
        const localIndex = foldedItem.indexOf(foldedNeedle, from);
        if (localIndex < 0) break;
        const globalIndex = itemOffsets[itemIndex] + localIndex;
        const rectangles: number[][] = [];
        const transformed = Util.transform(viewportValue.transform, item.transform);
        const itemWidth = Number(item.width) || 0;
        const left = transformed[4] + itemWidth * (localIndex / Math.max(1, item.str.length));
        const right = transformed[4] + itemWidth * ((localIndex + needle.length) / Math.max(1, item.str.length));
        const top = transformed[5] - Math.max(1, Number(item.height) || 10);
        const bottom = transformed[5];
        const [x1, y1] = viewportValue.convertToPdfPoint(left, top);
        const [x2, y2] = viewportValue.convertToPdfPoint(right, bottom);
        rectangles.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
        const contextStart = Math.max(0, globalIndex - 75);
        const contextEnd = Math.min(pageText.length, globalIndex + needle.length + 95);
        results.push({
          id: `pdf-search-${pageNumber}-${itemIndex}-${localIndex}`,
          page: pageNumber,
          offset: globalIndex,
          text: item.str.slice(localIndex, localIndex + needle.length),
          before: pageText.slice(contextStart, globalIndex),
          after: pageText.slice(globalIndex + needle.length, contextEnd),
          rects: rectangles,
        });
        from = localIndex + Math.max(1, foldedNeedle.length);
      }
    }
    const hasPageText = foldedPage.replace(/\s/g, '').length >= 4;
    if (hasPageText && textAvailable.value !== true) {
      textAvailable.value = true;
      emit('text-available', true);
    }
    page.cleanup();
  }
  return results;
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
  emit('selection', null);
}

function goPreviousPage(): void {
  goToPage(currentPage.value - 1);
}

function goNextPage(): void {
  goToPage(currentPage.value + 1);
}

function goStart(): void {
  goToPage(1);
}

function goEnd(): void {
  goToPage(totalPages.value);
}

async function onResize(): Promise<void> {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const previousPage = currentPage.value;
    resizeViewport();
    if (fitMode.value === 'width') {
      const nextScale = fitWidthScale(docWidth.value, viewportSize.value.width);
      scale.value = nextScale;
    } else if (fitMode.value === 'page') {
      const layout = layouts.value.find((item) => item.page === previousPage);
      if (layout) scale.value = fitPageScale(layout.width, layout.height, viewportSize.value);
    }
    goToPage(previousPage, false, true);
  }, 120);
}

onMounted(async () => {
  resizeViewport();
  resizeObserver = new ResizeObserver(() => void onResize());
  if (viewport.value) resizeObserver.observe(viewport.value);
  try {
    await loadLayouts();
    void loadOutline();
  } catch (cause) {
    if (!isAbortError(cause)) {
      loadError.value = cause instanceof Error ? cause.message : String(cause);
      loading.value = false;
    }
  }
});

onBeforeUnmount(() => {
  layoutGeneration += 1;
  stopAnimations();
  if (viewEmitFrame) cancelAnimationFrame(viewEmitFrame);
  if (resizeTimer) clearTimeout(resizeTimer);
  if (wheelSpringTimer) clearTimeout(wheelSpringTimer);
  if (longPressTimer) clearTimeout(longPressTimer);
  resizeObserver?.disconnect();
});

defineExpose({
  search,
  jumpTo,
  goToPage,
  goPreviousPage,
  goNextPage,
  goStart,
  goEnd,
  fitWidth,
  fitPage,
  actualSize,
  zoomBy,
  rotateView,
  clearSelection,
  currentPage,
  totalPages,
  scale,
  rotation,
  fitMode,
  visiblePageRange: computed(() => `${activePageStart.value}-${activePageEnd.value}`),
});
</script>

<template>
  <div
    ref="viewport"
    class="reader-pdf"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @wheel="onWheel"
    @click="onClick"
    @contextmenu="onContextMenu"
  >
    <div class="reader-pdf__workspace" :class="`tool-${tool}`">
      <div
        class="reader-pdf__document"
        :style="{
          width: `${docWidth}px`,
          height: `${docHeight}px`,
          transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
          '--total-scale-factor': PDF_BASE_SCALE,
        }"
      >
        <ReaderPdfPage
          v-for="layout in layouts"
          :key="`${layout.page}-${rotation}-${layout.width}-${layout.height}`"
          :pdf-document="pdfDocument"
          :page-number="layout.page"
          :base-width="layout.width"
          :base-height="layout.height"
          :rotation="rotation"
          :zoom="scale"
          :active="activePages.has(layout.page)"
          :tool="tool"
          :annotations="annotations"
          :search-rects="activeSearchResult?.page === layout.page ? activeSearchResult.rects : []"
          :style="{ left: `${layout.x}px`, top: `${layout.y}px` }"
        />

        <svg
          v-if="drawing"
          class="reader-pdf__ink-preview"
          :viewBox="`0 0 ${docWidth} ${docHeight}`"
          preserveAspectRatio="none"
        >
          <polyline
            :points="drawingPoints"
            :stroke="annotationColor"
            fill="none"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
    </div>

    <div v-if="loading" class="reader-pdf__loading" role="status">
      <LoaderCircle :size="24" class="reader-pdf__spin" />
      <strong>正在准备 PDF 画布</strong>
      <span>检查第 {{ loadingPage || 1 }} / {{ totalPages }} 页</span>
    </div>

    <div v-else-if="loadError" class="reader-pdf__loading reader-pdf__loading--error" role="alert">
      <AlertTriangle :size="25" />
      <strong>无法创建 PDF 画布</strong>
      <span>{{ loadError }}</span>
    </div>

    <div v-else-if="textAvailable === false" class="reader-pdf__notice" role="status">
      <AlertTriangle :size="15" />
      扫描型 PDF：文本选择与搜索不可用
    </div>

    <div class="reader-pdf__page-hint" aria-live="polite">
      {{ activePageStart === activePageEnd ? `第 ${activePageStart} 页` : `第 ${activePageStart}–${activePageEnd} 页已加载` }}
    </div>
  </div>
</template>

<style scoped>
.reader-pdf {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color-scheme: only light;
  background:
    radial-gradient(circle at 50% -20%, rgba(255, 255, 255, 0.12), transparent 45%),
    #343238;
  touch-action: none;
  user-select: none;
}

.reader-pdf__workspace {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.reader-pdf__workspace.tool-select {
  cursor: text;
}

.reader-pdf__workspace.tool-ink {
  cursor: crosshair;
}

.reader-pdf__document {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  will-change: transform;
}

.reader-pdf__ink-preview {
  position: absolute;
  z-index: 8;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.reader-pdf__loading {
  position: absolute;
  z-index: 14;
  inset: 0;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 0.55rem;
  color: rgba(255, 255, 255, 0.82);
  background: #343238;
  text-align: center;
}

.reader-pdf__loading strong {
  font-size: 0.82rem;
}

.reader-pdf__loading span {
  max-width: min(420px, 80vw);
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.7rem;
}

.reader-pdf__loading--error {
  color: #f1b1b7;
}

.reader-pdf__spin {
  animation: pdf-spin 0.9s linear infinite;
}

.reader-pdf__notice,
.reader-pdf__page-hint {
  position: absolute;
  z-index: 12;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: 0.38rem;
  padding: 0.34rem 0.65rem;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 999px;
  color: rgba(255, 255, 255, 0.68);
  background: rgba(29, 28, 31, 0.78);
  font-size: 0.66rem;
  transform: translateX(-50%);
  pointer-events: none;
  backdrop-filter: blur(12px);
}

.reader-pdf__notice {
  top: max(78px, calc(env(safe-area-inset-top) + 68px));
  color: #f3d798;
}

.reader-pdf__page-hint {
  right: max(12px, env(safe-area-inset-right));
  bottom: max(54px, calc(env(safe-area-inset-bottom) + 48px));
  left: auto;
  opacity: 0;
  transform: none;
  animation: hint-fade 1.6s ease both;
}

@keyframes pdf-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes hint-fade {
  0%,
  100% {
    opacity: 0;
  }
  18%,
  72% {
    opacity: 1;
  }
}
</style>
