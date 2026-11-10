<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import {
  AlertCircle,
  ArrowLeft,
  LoaderCircle,
  RefreshCw,
} from 'lucide-vue-next';
import {
  AnnotationType,
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import ReaderToolbar from '../components/ReaderToolbar.vue';
import ReaderStatus from '../components/ReaderStatus.vue';
import ReaderContents from '../components/ReaderContents.vue';
import ReaderSearchPanel from '../components/ReaderSearchPanel.vue';
import ReaderAnnotationsPanel from '../components/ReaderAnnotationsPanel.vue';
import ReaderSettingsPanel from '../components/ReaderSettingsPanel.vue';
import ReaderSelectionMenu from '../components/ReaderSelectionMenu.vue';
import ReaderReflowSurface from '../components/ReaderReflowSurface.vue';
import ReaderPdfSurface from '../components/ReaderPdfSurface.vue';
import { useApp } from '../stores/app';
import type {
  Annotation,
  Book,
  ReaderLocation,
  ReaderSettings,
} from '../types';
import type {
  PdfAnnotationRecord,
  PdfFitMode,
  ReaderPanelName,
  ReaderPdfInkInput,
  ReaderPdfTool,
  ReaderSearchResult,
  ReaderTextSelection,
  ReaderTocItem,
  ReflowBook,
} from '../reader/types';
import {
  annotationsForBook,
  clamp,
  clamp01,
  copyText,
  createId,
  describeReaderError,
  isAbortError,
  mergeReaderSettings,
  normalizeBookProgress,
  readerLocationKey,
  sameReaderSpot,
  shareText,
  withTimestamp,
} from '../reader/utils';
import { assertFormat, parseReflowBook, sniffFormat } from '../reader/format';
import { searchReflowChapters } from '../reader/text';
import { matchesShortcut } from '../services/shortcuts';
import { nativeHost } from '../services/host';
import {
  NATIVE_PDF_INITIAL_CHUNK_BYTES,
  openNativePdfRange,
  type NativePdfDataRangeTransport,
} from '../reader/native-range';
import {
  readPdfAnnotations,
  writePdfAnnotations,
} from '../reader/pdf-annotations';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PDF_WHOLE_FILE_WRITEBACK_LIMIT = 512 * 1024 * 1024;
const PDF_ANNOTATION_PAGE_RADIUS = 2;

interface ReflowSurfaceApi {
  jumpTo(location: ReaderLocation, smooth?: boolean): Promise<void>;
  jumpToLink(href: string, sourceChapter?: number): Promise<void>;
  goNextPage(): void;
  goPreviousPage(): void;
  goStart(): void;
  goEnd(): void;
  clearSelection(): void;
}

interface PdfRegionLocation extends ReaderLocation {
  rects?: number[][];
}

interface PdfSurfaceApi {
  search(query: string, limit?: number): Promise<ReaderSearchResult[]>;
  jumpTo(location: PdfRegionLocation): Promise<void>;
  goToPage(page: number, smooth?: boolean, announce?: boolean): void;
  goPreviousPage(): void;
  goNextPage(): void;
  goStart(): void;
  goEnd(): void;
  fitWidth(): void;
  fitPage(): void;
  actualSize(): void;
  zoomBy(factor: number, point?: { x: number; y: number }): void;
  rotateView(): void;
  clearSelection(): void;
}

interface PdfJsAnnotationData {
  annotationType?: number;
  annotationFlags?: number;
  id?: string;
  rect?: ArrayLike<number>;
  quadPoints?: ArrayLike<number>;
  inkLists?: ArrayLike<ArrayLike<number>>;
  color?: ArrayLike<number>;
  contentsObj?: { str?: string };
  titleObj?: { str?: string };
  creationDate?: string;
  modificationDate?: string;
}

const props = defineProps<{ book: Book }>();
const emit = defineEmits<{ close: [] }>();
const app = useApp();
const loading = ref(true);
const loadingMessage = ref('正在打开书籍');
const error = ref('');
const sourceBytes = shallowRef<Uint8Array>();
const pdfBytes = shallowRef<Uint8Array>();
const pdfJsAnnotations = shallowRef<Annotation[]>([]);
const hydratedPdfAnnotationPages = new Set<number>();
const hydratedPdfAnnotationsByPage = new Map<number, Annotation[]>();
const pdfAnnotationHydrationTasks = new Map<number, Promise<void>>();
const failedPdfAnnotationPages = new Set<number>();
const reflowBook = shallowRef<ReflowBook>();
const pdfDocument = shallowRef<PDFDocumentProxy>();
const reflowSurface = ref<ReflowSurfaceApi>();
const pdfSurface = ref<PdfSurfaceApi>();
const panel = ref<ReaderPanelName | null>(null);
const chromeVisible = ref(true);
const chromeFullscreen = ref(false);
const selection = ref<ReaderTextSelection | null>(null);
const selectionBusy = ref(false);
const pdfTool = ref<ReaderPdfTool>('pan');
const annotationColor = ref('#8067ce');
const pdfToc = ref<ReaderTocItem[]>([]);
const reflowToc = ref<ReaderTocItem[]>([]);
const searchQuery = ref('');
const searchResults = ref<ReaderSearchResult[]>([]);
const searchLoading = ref(false);
const searchActiveIndex = ref(-1);
const textAvailable = ref<boolean | null>(null);
const textUnavailableReason = ref('');
const pdfView = ref({
  page: 1,
  totalPages: 0,
  scale: 1,
  rotation: 0,
  x: 0,
  y: 0,
  fitMode: 'width' as PdfFitMode,
});
const initialLocation = ref<ReaderLocation>({
  format: props.book.format,
  progress: normalizeProgress(props.book.location?.progress),
});
const currentLocation = ref<ReaderLocation>({ ...initialLocation.value });
const navigationHistory = ref<ReaderLocation[]>([]);
const saveState = ref<'saved' | 'pending' | 'saving' | 'error'>('saved');
const pdfSaveStatus = ref<'idle' | 'saving' | 'error'>('idle');
const pdfSaveError = ref('');
let disposed = false;
let pdfLoadTask: ReturnType<typeof getDocument> | undefined;
let nativePdfRange: NativePdfDataRangeTransport | undefined;
let nativePdfSize: number | undefined;
let locationTimer: ReturnType<typeof setTimeout> | undefined;
let searchGeneration = 0;
let bookSaveTimer: ReturnType<typeof setTimeout> | undefined;
let globalSaveTimer: ReturnType<typeof setTimeout> | undefined;
let encodingTimer: ReturnType<typeof setTimeout> | undefined;
let toolbarTimer: ReturnType<typeof setTimeout> | undefined;
let pdfWriteRunning = false;
let pdfWritePending = false;

const isAndroid = computed(() =>
  /Android/i.test(navigator.userAgent) ||
  Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ &&
    /Android/i.test(navigator.platform),
  ),
);
const effectiveSettings = computed(() =>
  mergeReaderSettings(app.settings.reader, props.book.readerSettings),
);
const isPdf = computed(() => props.book.format === 'pdf');
const bookAnnotations = computed(() => annotationsForBook(app.annotations, props.book));
const pdfDisplayAnnotations = computed(() => {
  const stored = bookAnnotations.value;
  return [
    ...stored,
    ...pdfJsAnnotations.value.filter(
      (annotation) => !stored.some((existing) => samePdfAnnotationGeometry(existing, annotation)),
    ),
  ];
});
const tocItems = computed(() => (isPdf.value ? pdfToc.value : reflowToc.value));
const activeSearchResult = computed(() =>
  searchActiveIndex.value >= 0 ? searchResults.value[searchActiveIndex.value] || null : null,
);
const progressPercent = computed(() => clamp(currentLocation.value.progress * 100, 0, 100));
const currentChapter = computed(() =>
  clamp(Math.round(currentLocation.value.chapter || 0), 0, Math.max(0, (reflowBook.value?.chapters.length || 1) - 1)),
);
const currentChapterTitle = computed(() => {
  if (isPdf.value) {
    return pdfView.value.totalPages
      ? `第 ${pdfView.value.page} / ${pdfView.value.totalPages} 页`
      : 'PDF 连续画布';
  }
  return reflowBook.value?.chapters[currentChapter.value]?.title || '';
});
const currentBookmark = computed(() =>
  bookAnnotations.value.find(
    (annotation) =>
      annotation.type === 'bookmark' && sameReaderSpot(annotation.location, currentLocation.value),
  ),
);
const canGoBack = computed(() => navigationHistory.value.length > 0);
const activeSaveState = computed(() => {
  if (pdfSaveStatus.value === 'saving') return 'saving' as const;
  if (pdfSaveStatus.value === 'error') return 'error' as const;
  return saveState.value;
});

function normalizeProgress(value: unknown): number {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric > 1) return clamp01(numeric / 100);
  return clamp01(numeric);
}

function samePdfAnnotationGeometry(left: Annotation, right: Annotation): boolean {
  if (
    left.type !== right.type ||
    left.location.page !== right.location.page
  ) {
    return false;
  }
  return (left.rects || []).some((leftRect) =>
    (right.rects || []).some(
      (rightRect) =>
        leftRect.length >= 4 &&
        rightRect.length >= 4 &&
        leftRect.slice(0, 4).every(
          (value, index) => Math.abs(value - rightRect[index]) < 0.5,
        ),
    ),
  );
}

function normalizeLocation(location: ReaderLocation | undefined, format = props.book.format): ReaderLocation {
  const normalized: ReaderLocation = {
    ...(location || {}),
    format,
    progress: normalizeProgress(location?.progress),
  };
  if (format === 'pdf') {
    normalized.page = Math.max(1, Math.round(location?.page || 1));
    normalized.chapter = undefined;
    normalized.offset = undefined;
    normalized.cfi = undefined;
  } else {
    normalized.chapter = Math.max(0, Math.round(location?.chapter || 0));
    normalized.offset = Math.max(0, Math.round(location?.offset || 0));
    normalized.page = undefined;
    normalized.x = undefined;
    normalized.y = undefined;
    normalized.scale = undefined;
    normalized.rotation = undefined;
  }
  return normalized;
}

function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches('input, textarea, select, [contenteditable="true"]') ||
      Boolean(target.closest('[contenteditable="true"]')))
  );
}

function showChrome(scheduleHide = true): void {
  chromeVisible.value = true;
  if (toolbarTimer) clearTimeout(toolbarTimer);
  if (scheduleHide && !panel.value) {
    toolbarTimer = setTimeout(() => {
      if (!panel.value && !selection.value) chromeVisible.value = false;
    }, 5200);
  }
}

function toggleChrome(): void {
  if (chromeVisible.value) {
    chromeVisible.value = false;
    if (toolbarTimer) clearTimeout(toolbarTimer);
  } else {
    showChrome();
  }
}

function onReaderInteraction(): void {
  if (chromeVisible.value) showChrome();
}

function togglePanel(name: ReaderPanelName): void {
  closeSelection(false);
  panel.value = panel.value === name ? null : name;
  if (panel.value) showChrome(false);
  else showChrome();
}

function closePanel(): void {
  panel.value = null;
  showChrome();
}

async function loadBook(): Promise<void> {
  loading.value = true;
  error.value = '';
  panel.value = null;
  closeSelection(false);
  navigationHistory.value = [];
  textAvailable.value = null;
  textUnavailableReason.value = '';
  pdfToc.value = [];
  reflowToc.value = [];
  cleanupDocuments();
  sourceBytes.value = undefined;
  pdfBytes.value = undefined;
  pdfJsAnnotations.value = [];
  nativePdfSize = undefined;
  try {
    initialLocation.value = normalizeLocation(props.book.location, props.book.format);
    currentLocation.value = { ...initialLocation.value };

    if (props.book.format === 'pdf' && nativeHost) {
      await loadNativePdf();
    } else {
      loadingMessage.value = '正在读取本地文件';
      const bytes = await app.readBook(props.book);
      if (disposed) return;
      assertFormat(props.book, bytes);
      const sniffed = sniffFormat(bytes, props.book.relativePath || props.book.title);
      if (!sniffed) throw new Error('无法识别此文件的实际格式');
      if (props.book.format === 'pdf') {
        loadingMessage.value = '正在解析 PDF 与文本层';
        pdfBytes.value = bytes.slice();
        await openPdfDocument({
          data: bytes.slice(),
          useWorkerFetch: true,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          wasmUrl: '/pdfjs/wasm/',
        });
        if (disposed || !pdfDocument.value) return;
        await importAnnotationsFromPdf(pdfDocument.value.numPages);
      } else {
        sourceBytes.value = bytes;
        loadingMessage.value = '正在解析章节、目录与资源';
        reflowBook.value = await parseReflowBook(
          props.book,
          bytes,
          effectiveSettings.value,
        );
        reflowToc.value = reflowBook.value.toc;
        if (reflowBook.value.warnings.length) {
          app.notify(reflowBook.value.warnings[0] || '文件包含降级处理的内容');
        }
      }
    }
    if (disposed) return;
    loading.value = false;
    chromeVisible.value = !isAndroid.value;
    await nextTick();
    if (!isAndroid.value) showChrome();
  } catch (cause) {
    if (isAbortError(cause) || disposed) return;
    loading.value = false;
    error.value = describeReaderError(cause);
  }
}

async function loadNativePdf(): Promise<void> {
  const root = app.roots.find((candidate) => candidate.id === props.book.rootId);
  if (!root) throw new Error('本机未关联此书库，请重新关联或下载书籍。');

  loadingMessage.value = '正在建立 PDF 分块读取';
  const range = await openNativePdfRange(root, props.book.relativePath, {
    onError: onNativePdfRangeError,
  });
  if (disposed) {
    range.transport.dispose();
    return;
  }
  assertFormat(props.book, range.initialData);
  nativePdfRange = range.transport;
  nativePdfSize = range.stat.size;
  props.book.available = true;

  loadingMessage.value = '正在解析 PDF 与文本层';
  await openPdfDocument({
    range: range.transport,
    rangeChunkSize: NATIVE_PDF_INITIAL_CHUNK_BYTES,
    disableStream: true,
    disableAutoFetch: true,
    useWorkerFetch: true,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
  });
}

async function openPdfDocument(
  source: NonNullable<Parameters<typeof getDocument>[0]>,
): Promise<void> {
  pdfLoadTask = getDocument(source);
  const document = await pdfLoadTask.promise;
  if (disposed) {
    await document.destroy();
    return;
  }
  pdfDocument.value = document;
  currentLocation.value.page = clamp(
    currentLocation.value.page || 1,
    1,
    document.numPages,
  );
  await hydratePdfJsAnnotations(document, currentLocation.value.page || 1);
}

function onNativePdfRangeError(cause: Error): void {
  if (disposed) return;
  loading.value = false;
  error.value = `PDF 分块读取失败：${describeReaderError(cause)}`;
  app.notify(error.value);
  void pdfLoadTask?.destroy();
}

function cleanupDocuments(): void {
  reflowBook.value?.destroy?.();
  reflowBook.value = undefined;
  hydratedPdfAnnotationPages.clear();
  hydratedPdfAnnotationsByPage.clear();
  pdfAnnotationHydrationTasks.clear();
  failedPdfAnnotationPages.clear();
  pdfJsAnnotations.value = [];
  const document = pdfDocument.value;
  pdfDocument.value = undefined;
  if (document) void document.destroy();
  if (pdfLoadTask) {
    void pdfLoadTask.destroy();
    pdfLoadTask = undefined;
  }
  nativePdfRange?.dispose();
  nativePdfRange = undefined;
}

async function hydratePdfJsAnnotations(
  document: PDFDocumentProxy,
  centerPage = 1,
): Promise<void> {
  const first = Math.max(1, centerPage - PDF_ANNOTATION_PAGE_RADIUS);
  const last = Math.min(document.numPages, centerPage + PDF_ANNOTATION_PAGE_RADIUS);
  const pages = Array.from(
    { length: Math.max(0, last - first + 1) },
    (_, index) => first + index,
  );
  await Promise.all(pages.map((page) => hydratePdfJsAnnotationPage(document, page)));
}

async function hydratePdfJsAnnotationPage(
  document: PDFDocumentProxy,
  pageNumber: number,
): Promise<void> {
  if (
    hydratedPdfAnnotationPages.has(pageNumber) ||
    failedPdfAnnotationPages.has(pageNumber)
  ) {
    return;
  }
  const existing = pdfAnnotationHydrationTasks.get(pageNumber);
  if (existing) return existing;

  const task = (async () => {
    try {
      const page = await document.getPage(pageNumber);
      const annotations = await page.getAnnotations({ intent: 'display' });
      if (disposed || pdfDocument.value !== document) return;
      const hydrated: Annotation[] = [];
      for (const entry of annotations as Array<{ data?: PdfJsAnnotationData }>) {
        if (!entry.data) continue;
        const annotation = annotationFromPdfJsData(
          entry.data,
          pageNumber,
          document.numPages,
        );
        if (annotation) hydrated.push(annotation);
      }
      hydratedPdfAnnotationsByPage.set(pageNumber, hydrated);
      hydratedPdfAnnotationPages.add(pageNumber);
      pdfJsAnnotations.value = Array.from(hydratedPdfAnnotationsByPage.values())
        .flat()
        .sort(
          (left, right) =>
            (left.location.page || 0) - (right.location.page || 0) ||
            left.id.localeCompare(right.id),
        );
    } catch {
      if (disposed || pdfDocument.value !== document) return;
      failedPdfAnnotationPages.add(pageNumber);
    } finally {
      pdfAnnotationHydrationTasks.delete(pageNumber);
    }
  })();
  pdfAnnotationHydrationTasks.set(pageNumber, task);
  return task;
}

function annotationFromPdfJsData(
  data: PdfJsAnnotationData,
  page: number,
  pageCount: number,
): Annotation | null {
  if ((data.annotationFlags || 0) & 0x22) return null;
  let type: Annotation['type'] | undefined;
  if (data.annotationType === AnnotationType.HIGHLIGHT) type = 'highlight';
  else if (
    data.annotationType === AnnotationType.UNDERLINE ||
    data.annotationType === AnnotationType.SQUIGGLY ||
    data.annotationType === AnnotationType.STRIKEOUT
  ) {
    type = 'underline';
  } else if (data.annotationType === AnnotationType.TEXT) type = 'note';
  else if (data.annotationType === AnnotationType.INK) type = 'ink';
  if (!type) return null;

  const rects = pdfJsRects(data);
  if (!rects.length) return null;
  const text = typeof data.contentsObj?.str === 'string' ? data.contentsObj.str : '';
  const ink = data.inkLists
    ? Array.from(data.inkLists)
      .map((stroke) => Array.from(stroke).filter(Number.isFinite))
      .filter((stroke) => stroke.length >= 2)
    : undefined;
  const id = typeof data.id === 'string' && data.id
    ? `pdfjs-${page}-${data.id}`
    : `pdfjs-${page}-${data.annotationType}-${rects[0].join('-')}`;
  return {
    id,
    bookId: props.book.id,
    type,
    text,
    note: type === 'note' ? text : '',
    color: pdfJsColor(data.color),
    rects,
    ...(type === 'ink' && ink?.length ? { ink } : {}),
    location: {
      format: 'pdf',
      progress: clamp01(page / Math.max(1, pageCount)),
      page,
    },
    createdAt: typeof data.creationDate === 'string' ? data.creationDate : '',
    updatedAt: typeof data.modificationDate === 'string' ? data.modificationDate : '',
  };
}

function pdfJsRects(data: PdfJsAnnotationData): number[][] {
  const quadPoints = data.quadPoints ? Array.from(data.quadPoints) : [];
  const rects: number[][] = [];
  for (let index = 0; index + 7 < quadPoints.length; index += 8) {
    const xs = quadPoints.slice(index, index + 8).filter((_, point) => point % 2 === 0);
    const ys = quadPoints.slice(index, index + 8).filter((_, point) => point % 2 === 1);
    rects.push([
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ]);
  }
  if (rects.length) return rects;
  const rect = data.rect ? Array.from(data.rect) : [];
  if (rect.length >= 4 && rect.slice(0, 4).every(Number.isFinite)) {
    const [left, bottom, right, top] = rect;
    rects.push([
      Math.min(left, right),
      Math.min(bottom, top),
      Math.max(left, right),
      Math.max(bottom, top),
    ]);
  }
  return rects;
}

function pdfJsColor(color: ArrayLike<number> | undefined): string {
  if (!color || color.length < 3) return '#f4c542';
  return `#${[0, 1, 2]
    .map((index) =>
      Math.max(0, Math.min(255, Math.round(Number(color[index]))))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

async function importAnnotationsFromPdf(pageCount: number): Promise<void> {
  if (!pdfBytes.value) return;
  try {
    const records = await readPdfAnnotations(pdfBytes.value);
    for (const record of records) {
      const existing = app.annotations.find(
        (annotation) => annotation.id === record.id && annotation.bookId === props.book.id,
      );
      const incoming = annotationFromPdfRecord(record, pageCount);
      if (!existing) {
        await app.saveAnnotation(incoming);
        continue;
      }
      if (new Date(record.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
        await app.saveAnnotation({
          ...existing,
          ...incoming,
          text: existing.text || incoming.text,
          createdAt: existing.createdAt,
        });
      }
    }
  } catch (cause) {
    app.notify(`PDF 标注读取失败：${describeReaderError(cause)}`);
  }
}

function annotationFromPdfRecord(record: PdfAnnotationRecord, pageCount: number): Annotation {
  return {
    id: record.id,
    bookId: props.book.id,
    type: record.type,
    text: record.text,
    note: record.note,
    color: record.color,
    rects: record.rects,
    ink: record.ink,
    location: {
      format: 'pdf',
      progress: clamp01(record.page / Math.max(1, pageCount)),
      page: record.page,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function pdfRecordFromAnnotation(annotation: Annotation): PdfAnnotationRecord | null {
  if (
    annotation.type === 'bookmark' ||
    !annotation.location.page ||
    annotation.location.page < 1
  ) {
    return null;
  }
  return {
    id: annotation.id,
    page: annotation.location.page,
    type: annotation.type,
    color: annotation.color || '#f4c542',
    text: annotation.text,
    note: annotation.note,
    rects: annotation.rects || [],
    ink: annotation.ink,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
}

function schedulePdfWrite(): void {
  if (props.book.format !== 'pdf') return;
  pdfWritePending = true;
  if (!pdfWriteRunning) void runPdfWriteQueue();
}

async function preparePdfAnnotationEdit(): Promise<void> {
  if (!nativeHost || !isPdf.value || pdfBytes.value) return;
  try {
    await pdfBytesForWriteback();
  } catch (cause) {
    pdfSaveStatus.value = 'error';
    pdfSaveError.value = describeReaderError(cause);
  }
}

async function pdfBytesForWriteback(): Promise<Uint8Array> {
  if (pdfBytes.value) return pdfBytes.value;
  if (nativeHost) {
    if (nativePdfSize === undefined) {
      throw new Error('尚未取得 PDF 文件大小，无法载入完整文件进行标注写回。');
    }
    if (nativePdfSize >= PDF_WHOLE_FILE_WRITEBACK_LIMIT) {
      throw new Error(
        `此 PDF 为 ${Math.ceil(nativePdfSize / 1024 / 1024)} MiB，超过标注写回可安全载入的 512 MiB 上限。标注仍保留在 Granite 中。`,
      );
    }
  }
  loadingMessage.value = '首次写回 PDF 标注，正在载入完整文件';
  const bytes = await app.readBook(props.book);
  assertFormat(props.book, bytes);
  pdfBytes.value = bytes;
  await importAnnotationsFromPdf(pdfDocument.value?.numPages || 0);
  return bytes;
}

async function runPdfWriteQueue(): Promise<void> {
  if (pdfWriteRunning) return;
  pdfWriteRunning = true;
  pdfSaveStatus.value = 'saving';
  pdfSaveError.value = '';
  try {
    while (pdfWritePending && props.book.format === 'pdf') {
      pdfWritePending = false;
      const source = await pdfBytesForWriteback();
      const records = bookAnnotations.value
        .filter((annotation) => annotation.type !== 'bookmark')
        .map(pdfRecordFromAnnotation)
        .filter((record): record is PdfAnnotationRecord => Boolean(record));
      const output = await writePdfAnnotations(source, records, {
        removeMissingGraniteAnnotations: true,
      });
      await app.writeBook(props.book, output);
      pdfBytes.value = output;
      nativePdfSize = output.byteLength;
    }
    pdfSaveStatus.value = 'idle';
  } catch (cause) {
    pdfSaveStatus.value = 'error';
    pdfSaveError.value = describeReaderError(cause);
    app.notify(`PDF 标注写回失败，标注仍保留在 Granite 中。${pdfSaveError.value}`);
  } finally {
    pdfWriteRunning = false;
    if (pdfWritePending && pdfSaveStatus.value !== 'error') void runPdfWriteQueue();
  }
}

function retryPdfWrite(): void {
  if (pdfSaveStatus.value !== 'error') return;
  pdfSaveStatus.value = 'idle';
  schedulePdfWrite();
}

function scheduleLocationSave(location: ReaderLocation): void {
  const normalized = normalizeLocation(location, props.book.format);
  const nextKey = readerLocationKey(normalized);
  if (nextKey === readerLocationKey(currentLocation.value)) return;
  const sameSpotKey =
    normalized.page != null
      ? `${normalized.page}:${Math.round(normalized.x || 0)}:${Math.round(normalized.y || 0)}:${Math.round((normalized.scale || 1) * 1000)}`
      : `${normalized.chapter}:${Math.round(normalized.offset || 0)}`;
  currentLocation.value = { ...normalized, quote: location.quote };
  saveState.value = 'pending';
  if (locationTimer) clearTimeout(locationTimer);
  locationTimer = setTimeout(() => {
    locationTimer = undefined;
    if (sameSpotKey !== readerLocationKey(props.book.location)) {
      app.saveLocation(props.book.id, currentLocation.value);
    }
    saveState.value = 'saved';
  }, 360);
}

function flushLocation(): void {
  if (locationTimer) {
    clearTimeout(locationTimer);
    locationTimer = undefined;
  }
  if (normalizeProgress(currentLocation.value.progress) >= 0) {
    app.saveLocation(props.book.id, normalizeLocation(currentLocation.value, props.book.format));
    saveState.value = 'saved';
  }
}

function pushHistory(): void {
  const location = normalizeLocation(currentLocation.value, props.book.format);
  if (
    navigationHistory.value.length &&
    readerLocationKey(navigationHistory.value[navigationHistory.value.length - 1]) ===
      readerLocationKey(location)
  ) {
    return;
  }
  navigationHistory.value.push(location);
  if (navigationHistory.value.length > 30) navigationHistory.value.shift();
}

async function navigateTo(location: ReaderLocation, rects?: number[][]): Promise<void> {
  pushHistory();
  const normalized = normalizeLocation(location, props.book.format);
  if (isPdf.value) {
    await pdfSurface.value?.jumpTo({ ...normalized, rects });
  } else {
    await reflowSurface.value?.jumpTo(normalized, true);
  }
}

async function goBackToResult(): Promise<void> {
  const previous = navigationHistory.value.pop();
  if (!previous) return;
  if (isPdf.value) await pdfSurface.value?.jumpTo(previous);
  else await reflowSurface.value?.jumpTo(previous, true);
}

function onTocNavigate(item: ReaderTocItem): void {
  panel.value = null;
  if (isPdf.value && item.page) {
    void navigateTo({
      format: 'pdf',
      progress: clamp01(item.page / Math.max(1, pdfView.value.totalPages)),
      page: item.page,
    });
    return;
  }
  if (item.chapterIndex != null) {
    if (item.href?.includes('#')) {
      pushHistory();
      void reflowSurface.value?.jumpToLink(item.href, item.chapterIndex);
      return;
    }
    const chapter = reflowBook.value?.chapters[item.chapterIndex];
    void navigateTo({
      format: props.book.format,
      progress: clamp01(item.chapterIndex / Math.max(1, reflowBook.value?.chapters.length || 1)),
      chapter: item.chapterIndex,
      offset: 0,
      quote: chapter?.title,
    });
  }
}

async function runSearch(query: string): Promise<void> {
  searchQuery.value = query;
  const generation = ++searchGeneration;
  searchActiveIndex.value = -1;
  if (!query.trim()) {
    searchResults.value = [];
    searchLoading.value = false;
    return;
  }
  searchLoading.value = true;
  try {
    const results = isPdf.value
      ? await pdfSurface.value?.search(query)
      : searchReflowChapters(reflowBook.value?.chapters || [], query);
    if (generation !== searchGeneration || disposed) return;
    searchResults.value = results || [];
  } catch (cause) {
    if (generation !== searchGeneration) return;
    searchResults.value = [];
    app.notify(`书内搜索失败：${describeReaderError(cause)}`);
  } finally {
    if (generation === searchGeneration) searchLoading.value = false;
  }
}

async function selectSearchResult(result: ReaderSearchResult, index = -1): Promise<void> {
  searchActiveIndex.value =
    index >= 0 ? index : searchResults.value.findIndex((item) => item.id === result.id);
  if (result.page) {
    await navigateTo({
      format: 'pdf',
      progress: clamp01(result.page / Math.max(1, pdfView.value.totalPages)),
      page: result.page,
    }, result.rects);
  } else if (result.chapterIndex != null) {
    await navigateTo({
      format: props.book.format,
      progress: clamp01(
        (result.chapterIndex + (result.offset || 0) / Math.max(1, reflowBook.value?.chapters[result.chapterIndex]?.text.length || 1)) /
          Math.max(1, reflowBook.value?.chapters.length || 1),
      ),
      chapter: result.chapterIndex,
      offset: result.offset || 0,
      quote: result.text,
    });
  }
}

function nextSearchResult(): void {
  if (!searchResults.value.length) return;
  const next = (searchActiveIndex.value + 1) % searchResults.value.length;
  void selectSearchResult(searchResults.value[next], next);
}

function previousSearchResult(): void {
  if (!searchResults.value.length) return;
  const previous =
    (searchActiveIndex.value <= 0 ? searchResults.value.length : searchActiveIndex.value) - 1;
  void selectSearchResult(searchResults.value[previous], previous);
}

async function jumpToAnnotation(annotation: Annotation): Promise<void> {
  panel.value = null;
  await navigateTo(annotation.location, annotation.rects);
}

async function deleteAnnotation(annotation: Annotation): Promise<void> {
  if (isPdf.value && annotation.type !== 'bookmark') {
    await preparePdfAnnotationEdit();
  }
  await app.deleteAnnotation(annotation.id);
  if (isPdf.value && annotation.type !== 'bookmark') schedulePdfWrite();
}

async function updateAnnotation(
  annotation: Annotation,
  patch: Partial<Pick<Annotation, 'note' | 'color'>>,
): Promise<void> {
  if (isPdf.value && annotation.type !== 'bookmark') {
    await preparePdfAnnotationEdit();
  }
  await app.saveAnnotation({ ...annotation, ...patch });
  if (isPdf.value && annotation.type !== 'bookmark') schedulePdfWrite();
}

async function toggleBookmark(): Promise<void> {
  if (currentBookmark.value) {
    await deleteAnnotation(currentBookmark.value);
    return;
  }
  const at = new Date().toISOString();
  const location = normalizeLocation(currentLocation.value, props.book.format);
  const annotation: Annotation = {
    id: createId('bookmark'),
    bookId: props.book.id,
    type: 'bookmark',
    text: currentChapterTitle.value,
    note: '',
    color: '#8067ce',
    location: { ...location, quote: currentChapterTitle.value },
    createdAt: at,
    updatedAt: at,
  };
  await app.saveAnnotation(annotation);
}

function onTextSelection(next: ReaderTextSelection | null): void {
  selection.value = next;
  if (next) showChrome(false);
}

function closeSelection(clearSurface = true): void {
  selection.value = null;
  selectionBusy.value = false;
  if (clearSurface) {
    reflowSurface.value?.clearSelection();
    pdfSurface.value?.clearSelection();
  }
}

async function createAnnotation(
  type: 'highlight' | 'underline' | 'note',
  color: string,
  note = '',
): Promise<void> {
  const selected = selection.value;
  if (!selected || selectionBusy.value) return;
  selectionBusy.value = true;
  try {
    if (isPdf.value) await preparePdfAnnotationEdit();
    const at = new Date().toISOString();
    const annotation: Annotation = {
      id: createId(type),
      bookId: props.book.id,
      type,
      text: selected.text,
      note,
      color,
      location: {
        ...normalizeLocation(selected.location, props.book.format),
        quote: selected.text.slice(0, 600),
      },
      rects: selected.rects,
      createdAt: at,
      updatedAt: at,
    };
    await app.saveAnnotation(annotation);
    if (isPdf.value) schedulePdfWrite();
    closeSelection();
  } finally {
    selectionBusy.value = false;
  }
}

async function copySelection(): Promise<void> {
  if (!selection.value) return;
  try {
    await copyText(selection.value.text);
    app.notify('所选文字已复制');
    closeSelection();
  } catch (cause) {
    app.notify(describeReaderError(cause));
  }
}

async function shareSelection(): Promise<void> {
  if (!selection.value) return;
  try {
    const result = await shareText(
      `${selection.value.text}\n\n— ${props.book.title}`,
      props.book.title,
    );
    app.notify(result === 'copied' ? '系统分享不可用，文字已复制' : '已调用系统分享');
    closeSelection();
  } catch (cause) {
    app.notify(describeReaderError(cause));
  }
}

async function createNotebookNote(): Promise<void> {
  const selected = selection.value;
  if (!selected) return;
  flushLocation();
  app.newNote(
    props.book.id,
    selected.text,
    {
      ...normalizeLocation(selected.location, props.book.format),
      quote: selected.text.slice(0, 600),
    },
  );
  closeSelection(false);
}

async function createInk(input: ReaderPdfInkInput): Promise<void> {
  await preparePdfAnnotationEdit();
  const at = new Date().toISOString();
  const annotation: Annotation = {
    id: createId('ink'),
    bookId: props.book.id,
    type: 'ink',
    text: '',
    note: '',
    color: input.color,
    location: normalizeLocation(input.location, 'pdf'),
    rects: input.rects,
    ink: input.ink,
    createdAt: at,
    updatedAt: at,
  };
  await app.saveAnnotation(annotation);
  schedulePdfWrite();
}

function applySettings(scope: 'book' | 'global', patch: Partial<ReaderSettings>): void {
  if (scope === 'book') {
    props.book.readerSettings = {
      ...(props.book.readerSettings || {}),
      ...patch,
    };
    if (bookSaveTimer) clearTimeout(bookSaveTimer);
    bookSaveTimer = setTimeout(() => {
      bookSaveTimer = undefined;
      void app.saveBook(props.book).catch((cause) => app.notify(describeReaderError(cause)));
    }, 420);
  } else {
    app.settings.reader = {
      ...app.settings.reader,
      ...patch,
    };
    if (globalSaveTimer) clearTimeout(globalSaveTimer);
    globalSaveTimer = setTimeout(() => {
      globalSaveTimer = undefined;
      void app.saveSettings().catch((cause) => app.notify(describeReaderError(cause)));
    }, 420);
  }
}

async function resetBookSettings(): Promise<void> {
  delete props.book.readerSettings;
  if (bookSaveTimer) clearTimeout(bookSaveTimer);
  await app.saveBook(props.book);
}

async function reloadTextEncoding(): Promise<void> {
  if (
    props.book.format !== 'txt' ||
    !sourceBytes.value ||
    loading.value ||
    effectiveSettings.value.encoding === 'auto'
  ) {
    return;
  }
  try {
    const parsed = await parseReflowBook(
      props.book,
      sourceBytes.value,
      effectiveSettings.value,
    );
    initialLocation.value = { ...currentLocation.value };
    reflowBook.value?.destroy?.();
    reflowBook.value = parsed;
    reflowToc.value = parsed.toc;
  } catch (cause) {
    app.notify(`无法使用此编码重新读取 TXT：${describeReaderError(cause)}`);
  }
}

function onInternalLink(href: string, sourceChapter: number): void {
  pushHistory();
  void reflowSurface.value?.jumpToLink(href, sourceChapter);
}

function onPdfViewChange(view: {
  page: number;
  totalPages: number;
  scale: number;
  rotation: number;
  x: number;
  y: number;
  fitMode: PdfFitMode;
}): void {
  pdfView.value = view;
  // The following location-change event owns persistence. Mutating the same
  // location here made its change detector discard PDF page/zoom changes.
  if (pdfDocument.value) {
    void hydratePdfJsAnnotations(pdfDocument.value, view.page);
  }
}

function onProgressJump(fraction: number): void {
  if (!reflowBook.value && !pdfDocument.value) return;
  if (isPdf.value) {
    const page = clamp(Math.round(fraction * Math.max(1, pdfView.value.totalPages)), 1, pdfView.value.totalPages);
    pdfSurface.value?.goToPage(page);
    return;
  }
  const chapters = reflowBook.value?.chapters || [];
  if (!chapters.length) return;
  const exact = clamp01(fraction) * chapters.length;
  const chapter = Math.min(chapters.length - 1, Math.floor(exact));
  const localFraction = clamp01(exact - chapter);
  void navigateTo({
    format: props.book.format,
    progress: fraction,
    chapter,
    offset: Math.round((chapters[chapter]?.text.length || 0) * localFraction),
  });
}

function pdfPageChange(page: number): void {
  pdfSurface.value?.goToPage(page);
}

function surfaceNext(): void {
  if (isPdf.value) pdfSurface.value?.goNextPage();
  else reflowSurface.value?.goNextPage();
}

function surfacePrevious(): void {
  if (isPdf.value) pdfSurface.value?.goPreviousPage();
  else reflowSurface.value?.goPreviousPage();
}

function surfaceStart(): void {
  if (isPdf.value) pdfSurface.value?.goStart();
  else reflowSurface.value?.goStart();
}

function surfaceEnd(): void {
  if (isPdf.value) pdfSurface.value?.goEnd();
  else reflowSurface.value?.goEnd();
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (cause) {
    app.notify(`无法切换全屏：${describeReaderError(cause)}`);
  }
}

function onFullscreenChange(): void {
  chromeFullscreen.value = Boolean(document.fullscreenElement);
}

function closeReader(): void {
  flushLocation();
  closeSelection();
  emit('close');
}

function handleBack(): void {
  if (selection.value) {
    closeSelection();
    return;
  }
  if (panel.value) {
    closePanel();
    return;
  }
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
    return;
  }
  closeReader();
}

function onAndroidBack(event: Event): void {
  if (event.cancelable) event.preventDefault();
  handleBack();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || isEditingTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if (event.key === 'Escape') {
    event.preventDefault();
    handleBack();
    return;
  }
  const shortcuts = app.settings.shortcuts;
  if (shortcuts.search && matchesShortcut(event, shortcuts.search)) {
    event.preventDefault();
    togglePanel('search');
    return;
  }
  if (isPdf.value && (event.ctrlKey || event.metaKey) && ['+', '=', '-'].includes(event.key)) {
    event.preventDefault();
    pdfSurface.value?.zoomBy(event.key === '-' ? 1 / 1.2 : 1.2);
    return;
  }
  if (panel.value || selection.value) return;
  const plainNavigation = !event.ctrlKey && !event.metaKey && !event.altKey;
  if (shortcuts.bookmark && matchesShortcut(event, shortcuts.bookmark)) {
    event.preventDefault();
    void toggleBookmark();
  } else if (shortcuts.fullscreen && matchesShortcut(event, shortcuts.fullscreen)) {
    event.preventDefault();
    void toggleFullscreen();
  } else if (shortcuts.next && matchesShortcut(event, shortcuts.next)) {
    event.preventDefault();
    surfaceNext();
  } else if (shortcuts.previous && matchesShortcut(event, shortcuts.previous)) {
    event.preventDefault();
    surfacePrevious();
  } else if (plainNavigation && (key === 'pagedown' || (key === ' ' && !event.shiftKey))) {
    event.preventDefault();
    surfaceNext();
  } else if (plainNavigation && (key === 'pageup' || (key === ' ' && event.shiftKey))) {
    event.preventDefault();
    surfacePrevious();
  } else if (plainNavigation && key === 'home') {
    event.preventDefault();
    surfaceStart();
  } else if (plainNavigation && key === 'end') {
    event.preventDefault();
    surfaceEnd();
  }
}

watch(
  () => effectiveSettings.value.encoding,
  () => {
    if (props.book.format !== 'txt' || loading.value) return;
    if (encodingTimer) clearTimeout(encodingTimer);
    encodingTimer = setTimeout(() => void reloadTextEncoding(), 420);
  },
);

onMounted(() => {
  window.addEventListener('granite:back', onAndroidBack);
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  void loadBook();
});

onBeforeUnmount(() => {
  disposed = true;
  flushLocation();
  if (locationTimer) clearTimeout(locationTimer);
  if (bookSaveTimer) {
    clearTimeout(bookSaveTimer);
    void app.saveBook(props.book).catch(() => {});
  }
  if (globalSaveTimer) {
    clearTimeout(globalSaveTimer);
    void app.saveSettings().catch(() => {});
  }
  if (encodingTimer) clearTimeout(encodingTimer);
  if (toolbarTimer) clearTimeout(toolbarTimer);
  window.removeEventListener('granite:back', onAndroidBack);
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  cleanupDocuments();
});
</script>

<template>
  <div class="reader-view" :class="{ 'reader-view--immersive': !chromeVisible }">
    <div v-if="loading" class="reader-loading">
      <span class="reader-loading__mark">G</span>
      <div>
        <strong>{{ book.title }}</strong>
        <span>{{ loadingMessage }}</span>
      </div>
      <LoaderCircle :size="20" class="reader-loading__spinner" />
    </div>

    <div v-else-if="error" class="reader-error" role="alert">
      <AlertCircle :size="30" />
      <h1>无法打开这本书</h1>
      <p>{{ error }}</p>
      <div>
        <button class="button button--secondary" type="button" @click="closeReader">
          <ArrowLeft :size="16" />返回
        </button>
        <button class="button button--primary" type="button" @click="loadBook">
          <RefreshCw :size="16" />重试
        </button>
      </div>
    </div>

    <template v-else>
      <ReaderReflowSurface
        v-if="reflowBook"
        ref="reflowSurface"
        :book="book"
        :reflow="reflowBook"
        :settings="effectiveSettings"
        :initial-location="initialLocation"
        :annotations="bookAnnotations"
        :active-search-result="activeSearchResult"
        :active-search-query="searchQuery"
        @location-change="scheduleLocationSave"
        @selection="onTextSelection"
        @center-tap="toggleChrome"
        @internal-link="onInternalLink"
        @annotation-open="panel = 'annotations'"
        @interaction="onReaderInteraction"
      />

      <ReaderPdfSurface
        v-else-if="pdfDocument"
        ref="pdfSurface"
        :pdf-document="pdfDocument"
        :initial-location="initialLocation"
        :annotations="pdfDisplayAnnotations"
        :active-search-result="activeSearchResult"
        :active-search-query="searchQuery"
        :tool="pdfTool"
        :annotation-color="annotationColor"
        @location-change="scheduleLocationSave"
        @view-change="onPdfViewChange"
        @toc="pdfToc = $event"
        @text-available="textAvailable = $event"
        @selection="onTextSelection"
        @ink="createInk"
        @center-tap="toggleChrome"
        @interaction="onReaderInteraction"
        @request-tool-select="pdfTool = 'select'; showChrome()"
      />

      <ReaderToolbar
        :visible="chromeVisible"
        :format="book.format"
        :title="book.title"
        :chapter-label="currentChapterTitle"
        :progress="progressPercent"
        :page="pdfView.page"
        :total-pages="pdfView.totalPages"
        :scale="pdfView.scale"
        :rotation="pdfView.rotation"
        :bookmark-active="Boolean(currentBookmark)"
        :toc-available="tocItems.length > 0"
        :active-panel="panel"
        :mode="effectiveSettings.mode"
        :pdf-tool="pdfTool"
        :fit-mode="pdfView.fitMode"
        :fullscreen="chromeFullscreen"
        :can-go-back="canGoBack"
        :pdf-saving="pdfSaveStatus"
        @close="closeReader"
        @panel="togglePanel"
        @bookmark="toggleBookmark"
        @go-back="goBackToResult"
        @rotate="pdfSurface?.rotateView()"
        @fit-width="pdfSurface?.fitWidth()"
        @fit-page="pdfSurface?.fitPage()"
        @actual-size="pdfSurface?.actualSize()"
        @zoom-in="pdfSurface?.zoomBy(1.2)"
        @zoom-out="pdfSurface?.zoomBy(1 / 1.2)"
        @page-change="pdfPageChange"
        @progress-jump="onProgressJump"
        @mode-change="applySettings('book', { mode: $event })"
        @pdf-tool="pdfTool = $event"
        @fullscreen="toggleFullscreen"
        @retry-pdf-save="retryPdfWrite"
      />

      <ReaderStatus
        :visible="chromeVisible"
        :format="book.format"
        :progress="progressPercent"
        :current-label="currentChapterTitle"
        :save-state="activeSaveState"
      />

      <Transition name="reader-panel-pop">
        <ReaderContents
          v-if="panel === 'contents'"
          :toc="tocItems"
          :current-chapter="currentChapter"
          :current-page="pdfView.page"
          :format-label="book.format.toUpperCase()"
          @close="closePanel"
          @navigate="onTocNavigate"
        />
      </Transition>

      <Transition name="reader-panel-pop">
        <ReaderSearchPanel
          v-if="panel === 'search'"
          :results="searchResults"
          :loading="searchLoading"
          :active-index="searchActiveIndex"
          :text-available="textAvailable !== false"
          :text-unavailable-reason="textUnavailableReason"
          @close="closePanel"
          @search="runSearch"
          @select="selectSearchResult"
          @previous="previousSearchResult"
          @next="nextSearchResult"
        />
      </Transition>

      <Transition name="reader-panel-pop">
        <ReaderAnnotationsPanel
          v-if="panel === 'annotations'"
          :annotations="bookAnnotations"
          :current-label="currentChapterTitle"
          :bookmark-active="Boolean(currentBookmark)"
          @close="closePanel"
          @jump="jumpToAnnotation"
          @delete="deleteAnnotation"
          @update="updateAnnotation"
          @bookmark="toggleBookmark"
        />
      </Transition>

      <Transition name="reader-panel-pop">
        <ReaderSettingsPanel
          v-if="panel === 'settings'"
          :settings="effectiveSettings"
          :global-settings="app.settings.reader"
          :book-overrides="book.readerSettings || {}"
          :is-txt="book.format === 'txt'"
          :is-pdf="book.format === 'pdf'"
          @close="closePanel"
          @change="applySettings"
          @reset-book="resetBookSettings"
        />
      </Transition>

      <ReaderSelectionMenu
        v-if="selection"
        :selection="selection"
        :busy="selectionBusy"
        @close="closeSelection"
        @copy="copySelection"
        @share="shareSelection"
        @annotate="createAnnotation"
        @notebook="createNotebookNote"
      />

      <div v-if="pdfSaveStatus === 'error' && !chromeVisible" class="reader-pdf-save-error">
        <button type="button" @click="retryPdfWrite">
          PDF 标注写回失败，点击重试
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.reader-view {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--canvas-deep);
}

.reader-loading,
.reader-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.8rem;
  color: var(--text);
  background:
    radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--accent-soft) 55%, transparent), transparent 36%),
    var(--canvas);
}

.reader-loading__mark {
  display: grid;
  width: 46px;
  height: 46px;
  place-items: center;
  border-radius: 14px;
  color: #fff;
  background: linear-gradient(145deg, var(--lavender), var(--accent-strong));
  font-family: var(--font-display);
  font-size: 1.8rem;
  font-style: italic;
  box-shadow: 0 16px 35px -22px var(--accent-strong);
}

.reader-loading > div {
  display: grid;
  min-width: min(360px, 58vw);
  gap: 0.14rem;
}

.reader-loading strong {
  overflow: hidden;
  font-family: var(--font-display);
  font-size: 1.2rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reader-loading span {
  color: var(--text-secondary);
  font-size: 0.7rem;
}

.reader-loading__spinner {
  color: var(--accent);
  animation: reader-spin 0.9s linear infinite;
}

.reader-error {
  flex-direction: column;
  padding: 2rem;
  color: var(--danger);
  text-align: center;
}

.reader-error h1 {
  margin: 0.2rem 0 0;
  color: var(--text);
  font-family: var(--font-display);
  font-size: clamp(1.8rem, 4vw, 2.6rem);
  font-weight: 600;
}

.reader-error p {
  max-width: 560px;
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.65;
}

.reader-error > div {
  display: flex;
  gap: 0.55rem;
  margin-top: 0.5rem;
}

.reader-panel-pop-enter-active,
.reader-panel-pop-leave-active {
  transition:
    opacity var(--motion-fast),
    transform var(--motion-fast) var(--ease-out);
}

.reader-panel-pop-enter-from,
.reader-panel-pop-leave-to {
  opacity: 0;
  transform: translateX(10px) scale(0.985);
}

.reader-pdf-save-error {
  position: absolute;
  z-index: 45;
  right: max(12px, env(safe-area-inset-right));
  bottom: max(54px, calc(env(safe-area-inset-bottom) + 48px));
}

.reader-pdf-save-error button {
  min-height: 34px;
  padding: 0.35rem 0.68rem;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  border-radius: 999px;
  color: #fff1f2;
  background: color-mix(in srgb, var(--danger) 82%, #22191b);
  box-shadow: 0 8px 24px -14px #000;
  font-size: 0.67rem;
}

@keyframes reader-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 620px) {
  .reader-loading {
    padding: 1.2rem;
  }

  .reader-loading > div {
    min-width: 0;
    max-width: 60vw;
  }

  .reader-pdf-save-error {
    right: 8px;
    bottom: calc(52px + env(safe-area-inset-bottom));
  }
}
</style>
