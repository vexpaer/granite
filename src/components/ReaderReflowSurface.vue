<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import type { Book, ReaderLocation, ReaderSettings } from '../types';
import type {
  ReaderSearchResult,
  ReaderTextSelection,
  ReflowBook,
} from '../reader/types';
import { READER_THEME_COLORS } from '../reader/defaults';
import { clamp, clamp01 } from '../reader/utils';
import type { Annotation } from '../types';

const props = defineProps<{
  book: Book;
  reflow: ReflowBook;
  settings: ReaderSettings;
  initialLocation?: ReaderLocation;
  annotations: Annotation[];
  activeSearchResult?: ReaderSearchResult | null;
  activeSearchQuery?: string;
}>();

const emit = defineEmits<{
  'location-change': [location: ReaderLocation];
  'chapter-change': [index: number];
  selection: [selection: ReaderTextSelection | null];
  'center-tap': [];
  'internal-link': [href: string, sourceChapter: number];
  'annotation-open': [id: string];
  interaction: [];
  ready: [];
}>();

const viewport = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const chapterElements = reactive<HTMLElement[]>([]);
const currentChapter = ref(clamp(Math.round(props.initialLocation?.chapter || 0), 0, props.reflow.chapters.length - 1));
const currentOffset = ref(Math.max(0, props.initialLocation?.offset || 0));
const pageScrollLeft = ref(0);
const pageScrollWidth = ref(0);
const located = ref(false);
let scrollFrame = 0;
let wheelAccumulator = 0;
let wheelTimer: ReturnType<typeof setTimeout> | undefined;
let suppressClick = false;
let lastPointerAt = 0;

const mode = computed(() => props.settings.mode || 'scroll');
const currentChapterData = computed(() => props.reflow.chapters[currentChapter.value]);
const pageGap = 48;
const safeTop = 82;
const safeBottom = 64;
const pageWidth = computed(() =>
  Math.max(260, Math.min(props.settings.width, (viewport.value?.clientWidth || window.innerWidth) - props.settings.margin * 2)),
);
const pageMetrics = computed(() => {
  const step = pageWidth.value + pageGap;
  return {
    step,
    count: Math.max(1, Math.ceil((pageScrollWidth.value + pageGap) / step)),
  };
});
const theme = computed(() => READER_THEME_COLORS[props.settings.theme] || READER_THEME_COLORS.paper);
const surfaceStyle = computed(() => ({
  '--reader-paper': theme.value.surface,
  '--reader-paper-edge': theme.value.background,
  '--reader-ink': theme.value.text,
  '--reader-muted': theme.value.secondary,
  '--reader-border': theme.value.border,
  '--reader-font-size': `${props.settings.fontSize}px`,
  '--reader-line-height': String(props.settings.lineHeight),
  '--reader-paragraph-spacing': `${props.settings.paragraphSpacing}px`,
  '--reader-reading-width': `${props.settings.width}px`,
  '--reader-page-width': `${pageWidth.value}px`,
  '--reader-page-gap': `${pageGap}px`,
  '--reader-safe-top': `${safeTop}px`,
  '--reader-safe-bottom': `${safeBottom}px`,
}));
const currentLabel = computed(() => {
  const chapter = currentChapterData.value;
  if (!chapter) return '';
  if (mode.value === 'paginated') {
    return `${chapter.title} · 第 ${Math.min(pageMetrics.value.count, Math.floor(pageScrollLeft.value / pageMetrics.value.step) + 1)} 页`;
  }
  return chapter.title;
});

function setChapterRef(index: number, element: unknown): void {
  if (element instanceof HTMLElement) {
    chapterElements[index] = element;
  } else {
    delete chapterElements[index];
  }
}

function chapterShadow(index: number): ShadowRoot | undefined {
  return chapterElements[index]?.shadowRoot || undefined;
}

function escapeCssSelectorText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\bhtml\b/gi, '.chapter-body')
    .replace(/\bbody\b/gi, '.chapter-body');
}

function chapterBaseCss(): string {
  const paginatedCss = mode.value === 'paginated'
    ? `
      .chapter-body {
        width: calc(var(--reader-page-width) - max(36px, 6.8vw));
        height: calc(100dvh - var(--reader-safe-top) - var(--reader-safe-bottom) - 4.4rem);
        column-width: calc(var(--reader-page-width) - max(36px, 6.8vw));
        column-gap: var(--reader-page-gap);
        column-fill: auto;
      }
      .chapter-body :is(p,blockquote,figure,pre,table,ul,ol) {
        break-inside: avoid-column;
      }
    `
    : '';
  return `
    :host { color: var(--reader-ink); font-family: ${props.settings.fontFamily}; }
    .chapter-body {
      box-sizing: border-box;
      width: min(100%, var(--reader-reading-width));
      min-height: 100%;
      margin: 0 auto;
      color: var(--reader-ink);
      font-family: inherit;
      font-size: var(--reader-font-size);
      line-height: var(--reader-line-height);
      overflow-wrap: anywhere;
      text-wrap: pretty;
    }
    .chapter-body :is(p, blockquote, li, dd, dt) {
      color: inherit;
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
    }
    .chapter-body p {
      margin-block: 0 var(--reader-paragraph-spacing);
    }
    .chapter-body :is(h1,h2,h3,h4,h5,h6) {
      color: inherit;
      font-family: inherit;
      line-height: 1.28;
      text-wrap: balance;
    }
    .chapter-body img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 1.15em auto;
      object-fit: contain;
    }
    .chapter-body svg { max-width: 100%; height: auto; }
    .chapter-body a { color: color-mix(in srgb, var(--accent) 78%, var(--reader-ink)); }
    .chapter-body table {
      display: block;
      max-width: 100%;
      overflow-x: auto;
      border-collapse: collapse;
    }
    .chapter-body :is(td,th) {
      padding: 0.35em 0.55em;
      border: 1px solid var(--reader-border);
    }
    .chapter-body pre {
      overflow-x: auto;
      padding: 0.75rem;
      border: 1px solid var(--reader-border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--reader-paper) 75%, var(--reader-paper-edge));
      font-family: var(--font-mono);
      font-size: 0.86em;
      white-space: pre-wrap;
    }
    .chapter-body mark.granite-reader-hit {
      padding: 0;
      border-radius: 2px;
      color: inherit;
      background: rgba(244, 197, 66, 0.5);
      box-shadow: 0 0 0 2px rgba(244, 197, 66, 0.24);
    }
    .chapter-body mark.granite-reader-hit.is-current {
      background: rgba(244, 197, 66, 0.8);
      box-shadow: 0 0 0 3px rgba(244, 197, 66, 0.35);
    }
    .chapter-body .granite-reader-annotation--highlight {
      border-radius: 2px;
      color: inherit;
      background: color-mix(in srgb, var(--annotation-color) 44%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--annotation-color) 24%, transparent);
    }
    .chapter-body .granite-reader-annotation--underline {
      border-bottom: 2px solid var(--annotation-color);
      color: inherit;
    }
    .chapter-body .granite-reader-annotation--note {
      border-bottom: 1px dotted color-mix(in srgb, var(--annotation-color) 82%, var(--reader-ink));
      color: inherit;
      cursor: pointer;
    }
    ${paginatedCss}
  `;
}

function buildChapter(index: number): void {
  const host = chapterElements[index];
  const chapter = props.reflow.chapters[index];
  if (!host || !chapter) return;
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  const sanitizedCss = String(chapter.css || '')
    .replace(/@(?:page|font-face)\b[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi, '')
    .replace(/\b(?:html|body)\b/gi, '.chapter-body');
  shadow.innerHTML = `
    <style>${sanitizedCss}\n${chapterBaseCss()}</style>
    <div class="chapter-body">${chapter.html}</div>
  `;
  host.dataset.chapterReady = 'true';
}

async function rebuildChapters(): Promise<void> {
  await nextTick();
  props.reflow.chapters.forEach((_, index) => buildChapter(index));
  await nextTick();
  updatePageMetrics();
  await applyDecorations();
}

function updatePageMetrics(): void {
  if (mode.value !== 'paginated' || !scroller.value) {
    pageScrollWidth.value = 0;
    return;
  }
  pageScrollWidth.value = scroller.value.scrollWidth;
}

function locationFor(index: number, offset: number): ReaderLocation {
  const chapter = props.reflow.chapters[index];
  const length = Math.max(1, chapter?.text.length || 1);
  const fraction = clamp01(offset / length);
  return {
    format: props.reflow.format,
    progress: clamp01((index + fraction) / Math.max(1, props.reflow.chapters.length)),
    chapter: index,
    offset: Math.round(offset),
    cfi: chapter ? `${chapter.id}@${Math.round(offset)}` : undefined,
  };
}

function caretAtPoint(clientX: number, clientY: number): { node: Node; offset: number } | null {
  type CaretDocument = Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const doc = document as CaretDocument;
  const range = doc.caretRangeFromPoint?.(clientX, clientY);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  const position = doc.caretPositionFromPoint?.(clientX, clientY);
  return position ? { node: position.offsetNode, offset: position.offset } : null;
}

function offsetAtPoint(clientX: number, clientY: number): { chapter: number; offset: number } | null {
  type ShadowCaret = ShadowRoot & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const containing = chapterElements.findIndex((element) => {
    const rect = element.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  });
  const indices = containing >= 0
    ? [containing]
    : chapterElements.map((_, index) => index);
  for (const chapter of indices) {
    const root = chapterShadow(chapter) as ShadowCaret | undefined;
    if (!root) continue;
    let caret: { node: Node; offset: number } | null = null;
    const shadowRange = root.caretRangeFromPoint?.(clientX, clientY);
    if (shadowRange) caret = { node: shadowRange.startContainer, offset: shadowRange.startOffset };
    if (!caret) {
      const shadowPosition = root.caretPositionFromPoint?.(clientX, clientY);
      if (shadowPosition) caret = { node: shadowPosition.offsetNode, offset: shadowPosition.offset };
    }
    if (!caret) {
      const documentCaret = caretAtPoint(clientX, clientY);
      if (documentCaret && root.contains(documentCaret.node)) caret = documentCaret;
    }
    if (!caret) continue;
    const body = root.querySelector('.chapter-body');
    if (!body) continue;
    try {
      const range = document.createRange();
      range.selectNodeContents(body);
      range.setEnd(caret.node, caret.offset);
      return { chapter, offset: range.toString().length };
    } catch {
      continue;
    }
  }
  return null;
}

function nearestChapterAtViewport(): number {
  if (!scroller.value) return currentChapter.value;
  const top = scroller.value.getBoundingClientRect().top + safeTop;
  let best = currentChapter.value;
  for (let index = 0; index < chapterElements.length; index += 1) {
    const element = chapterElements[index];
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.top <= top) best = index;
  }
  return best;
}

function emitScrollLocation(): void {
  if (!scroller.value) return;
  let index = currentChapter.value;
  let offset = currentOffset.value;
  if (mode.value === 'scroll') {
    index = nearestChapterAtViewport();
    const point = offsetAtPoint(
      Math.max(20, scroller.value.clientWidth * 0.5),
      Math.max(safeTop, scroller.value.getBoundingClientRect().top + safeTop + 24),
    );
    if (point) {
      index = point.chapter;
      offset = point.offset;
    }
  } else {
    const pageIndex = pageMetrics.value.count
      ? Math.round(pageScrollLeft.value / pageMetrics.value.step)
      : 0;
    const fraction = pageMetrics.value.count <= 1 ? 0 : clamp01(pageIndex / (pageMetrics.value.count - 1));
    offset = Math.round((currentChapterData.value?.text.length || 0) * fraction);
  }
  if (index !== currentChapter.value) {
    currentChapter.value = index;
    emit('chapter-change', index);
  }
  currentOffset.value = offset;
  emit('location-change', locationFor(index, offset));
}

function onScroll(): void {
  if (mode.value === 'paginated' && scroller.value) pageScrollLeft.value = scroller.value.scrollLeft;
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    emitScrollLocation();
  });
}

function pointAtOffset(root: ShadowRoot, offset: number): { node: Node; offset: number } | null {
  const body = root.querySelector('.chapter-body');
  if (!body) return null;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  let last: Text | null = null;
  while (node) {
    const text = node as Text;
    const length = text.data.length;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    last = text;
    node = walker.nextNode();
  }
  return last ? { node: last, offset: last.data.length } : null;
}

async function restoreOffset(location: ReaderLocation, smooth = false): Promise<void> {
  const index = clamp(Math.round(location.chapter || 0), 0, Math.max(0, props.reflow.chapters.length - 1));
  currentChapter.value = index;
  currentOffset.value = Math.max(0, location.offset || 0);
  emit('chapter-change', index);
  await nextTick();
  if (mode.value === 'paginated') {
    updatePageMetrics();
    const chapterLength = Math.max(1, props.reflow.chapters[index]?.text.length || 1);
    const fraction = clamp01(currentOffset.value / chapterLength);
    if (scroller.value) {
      scroller.value.scrollTo({
        left: Math.max(0, (pageMetrics.value.count - 1) * pageMetrics.value.step * fraction),
        behavior: smooth ? 'smooth' : 'auto',
      });
      pageScrollLeft.value = scroller.value.scrollLeft;
    }
    located.value = true;
    window.setTimeout(() => (located.value = false), 900);
    return;
  }
  if (!scroller.value) return;
  const root = chapterShadow(index);
  const point = root ? pointAtOffset(root, currentOffset.value) : null;
  let delta = 0;
  if (point) {
    try {
      const range = document.createRange();
      range.setStart(point.node, point.offset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      const viewportRect = scroller.value.getBoundingClientRect();
      delta = rect.top - viewportRect.top - safeTop - 18;
    } catch {
      delta = 0;
    }
  }
  if (delta) {
    scroller.value.scrollTo({
      top: Math.max(0, scroller.value.scrollTop + delta),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }
  located.value = true;
  window.setTimeout(() => (located.value = false), 900);
}

function wrapRange(
  node: Text,
  start: number,
  end: number,
  className: string,
  id: string,
  color = '',
): void {
  if (!node.parentNode || end <= start || end > node.data.length) return;
  try {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const mark = document.createElement('mark');
    mark.className = className;
    mark.dataset.annotationId = id;
    if (color) mark.style.setProperty('--annotation-color', color);
    range.surroundContents(mark);
  } catch {
    // A range crossing markup is intentionally skipped without altering content.
  }
}

function wrapInRoot(root: ShadowRoot, needle: string, className: string, id: string, color = ''): boolean {
  const body = root.querySelector('.chapter-body');
  if (!body || !needle) return false;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const index = text.data.indexOf(needle);
    if (index >= 0) {
      wrapRange(text, index, index + needle.length, className, id, color);
      return true;
    }
    node = walker.nextNode();
  }
  return false;
}

function removeDecorations(root: ShadowRoot): void {
  for (const mark of [...root.querySelectorAll('mark.granite-reader-hit, .granite-reader-annotation')]) {
    mark.replaceWith(...mark.childNodes);
  }
  root.normalize();
}

async function applyDecorations(): Promise<void> {
  await nextTick();
  for (let index = 0; index < chapterElements.length; index += 1) {
    const root = chapterShadow(index);
    if (!root) continue;
    removeDecorations(root);
    const query = props.activeSearchQuery?.trim();
    if (query && props.activeSearchResult?.chapterIndex === index) {
      wrapInRoot(
        root,
        props.activeSearchResult.text || query,
        'granite-reader-hit is-current',
        props.activeSearchResult.id,
      );
    }
    for (const annotation of props.annotations) {
      if (
        annotation.type === 'bookmark' ||
        annotation.type === 'ink' ||
        annotation.location.chapter !== index ||
        !annotation.text
      ) {
        continue;
      }
      const body = root.querySelector('.chapter-body');
      if (!body) continue;
      const full = body.textContent || '';
      if (!full.includes(annotation.text)) continue;
      wrapInRoot(
        root,
        annotation.text.trim().slice(0, 240),
        `granite-reader-annotation granite-reader-annotation--${annotation.type}`,
        annotation.id,
        annotation.color,
      );
    }
  }
}

function selectionFromShadow(root: ShadowRoot): Selection | null {
  const shadowSelection = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
  return shadowSelection || window.getSelection();
}

function inspectSelection(): void {
  let found: { chapter: number; selection: Selection } | null = null;
  for (let index = 0; index < chapterElements.length; index += 1) {
    const root = chapterShadow(index);
    if (!root) continue;
    const selection = selectionFromShadow(root);
    if (
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount &&
      root.contains(selection.getRangeAt(0).commonAncestorContainer)
    ) {
      found = { chapter: index, selection };
      break;
    }
  }
  if (!found) {
    emit('selection', null);
    return;
  }
  const root = chapterShadow(found.chapter);
  const body = root?.querySelector('.chapter-body');
  const range = found.selection.getRangeAt(0);
  const text = found.selection.toString().replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!body || !text) return;
  const prefix = document.createRange();
  prefix.selectNodeContents(body);
  try {
    prefix.setEnd(range.startContainer, range.startOffset);
  } catch {
    emit('selection', null);
    return;
  }
  const offset = prefix.toString().length;
  const bounds = range.getBoundingClientRect();
  emit('selection', {
    text,
    location: locationFor(found.chapter, offset),
    anchor: {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
    },
  });
}

function onPointerUp(event: PointerEvent): void {
  if (event.button > 0) return;
  lastPointerAt = performance.now();
  window.setTimeout(inspectSelection, 20);
}

function onPointerDown(): void {
  suppressClick = false;
}

function onContentClick(event: MouseEvent): void {
  const path = event.composedPath();
  const anchor = path.find(
    (node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement,
  );
  if (anchor) {
    const href = anchor.dataset.graniteHref || anchor.getAttribute('href') || '';
    if (href) {
      if (href.startsWith('#') || !href.includes(':')) {
        event.preventDefault();
        emit('internal-link', anchor.dataset.graniteHref || '', currentChapter.value);
        return;
      }
    }
  }
  const annotation = path.find(
    (node): node is HTMLElement =>
      node instanceof HTMLElement && Boolean(node.dataset.annotationId) && node.matches('.granite-reader-annotation'),
  );
  if (annotation?.dataset.annotationId) {
    event.preventDefault();
    emit('annotation-open', annotation.dataset.annotationId);
    return;
  }
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const rect = viewport.value?.getBoundingClientRect();
  if (!rect) return;
  const centralX = event.clientX > rect.left + rect.width * 0.22 && event.clientX < rect.right - rect.width * 0.22;
  const centralY = event.clientY > rect.top + rect.height * 0.2 && event.clientY < rect.bottom - rect.height * 0.18;
  if (centralX && centralY) emit('center-tap');
}

function onWheel(event: WheelEvent): void {
  if (mode.value !== 'paginated') return;
  event.preventDefault();
  const amount = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  wheelAccumulator += amount;
  if (wheelTimer) clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => (wheelAccumulator = 0), 240);
  if (Math.abs(wheelAccumulator) < props.settings.wheelThreshold) return;
  if (wheelAccumulator > 0) goNextPage();
  else goPreviousPage();
  wheelAccumulator = 0;
}

function goNextPage(): void {
  if (mode.value === 'scroll') {
    scroller.value?.scrollBy({ top: Math.max(220, (scroller.value?.clientHeight || 600) * 0.84), behavior: 'smooth' });
    return;
  }
  const next = pageScrollLeft.value + pageMetrics.value.step;
  if (next >= pageScrollWidth.value - 4) {
    if (currentChapter.value < props.reflow.chapters.length - 1) {
      void jumpTo(locationFor(currentChapter.value + 1, 0), true);
    }
    return;
  }
  scroller.value?.scrollTo({ left: next, behavior: 'smooth' });
}

function goPreviousPage(): void {
  if (mode.value === 'scroll') {
    scroller.value?.scrollBy({ top: -Math.max(220, (scroller.value?.clientHeight || 600) * 0.84), behavior: 'smooth' });
    return;
  }
  const previous = pageScrollLeft.value - pageMetrics.value.step;
  if (previous < 0) {
    if (currentChapter.value > 0) {
      void jumpTo(locationFor(currentChapter.value - 1, props.reflow.chapters[currentChapter.value - 1]?.text.length || 0), true);
    }
    return;
  }
  scroller.value?.scrollTo({ left: previous, behavior: 'smooth' });
}

async function jumpTo(location: ReaderLocation, smooth = true): Promise<void> {
  const index = clamp(Math.round(location.chapter || 0), 0, props.reflow.chapters.length - 1);
  currentChapter.value = index;
  currentOffset.value = Math.max(0, location.offset || 0);
  await restoreOffset(location, smooth);
  await applyDecorations();
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
  emit('selection', null);
}

function goStart(): void {
  void jumpTo({ progress: 0, chapter: 0, offset: 0 }, true);
}

function goEnd(): void {
  const index = props.reflow.chapters.length - 1;
  void jumpTo({ progress: 1, chapter: index, offset: props.reflow.chapters[index]?.text.length || 0 }, true);
}

async function jumpToLink(href: string, sourceChapter = currentChapter.value): Promise<void> {
  const [rawPath, rawFragment = ''] = href.split('#', 2);
  const decodedPath = (() => {
    try {
      return decodeURIComponent(rawPath);
    } catch {
      return rawPath;
    }
  })();
  let index = sourceChapter;
  if (decodedPath) {
    const matched = props.reflow.chapters.findIndex(
      (chapter) =>
        chapter.href === decodedPath ||
        chapter.href.endsWith(`/${decodedPath}`) ||
        decodedPath.endsWith(`/${chapter.href}`),
    );
    if (matched >= 0) index = matched;
  }
  await jumpTo(locationFor(index, 0), true);
  if (!rawFragment) return;
  await nextTick();
  const root = chapterShadow(index);
  let fragment = rawFragment;
  try {
    fragment = decodeURIComponent(rawFragment);
  } catch {
    // Keep the literal fragment when malformed URI escaping is present.
  }
  const target = root?.getElementById(fragment);
  if (!target || !scroller.value) return;
  const rect = target.getBoundingClientRect();
  const hostRect = scroller.value.getBoundingClientRect();
  scroller.value.scrollTo({
    top: Math.max(0, scroller.value.scrollTop + rect.top - hostRect.top - safeTop - 18),
    left: mode.value === 'paginated'
      ? Math.max(0, scroller.value.scrollLeft + rect.left - hostRect.left - 18)
      : scroller.value.scrollLeft,
    behavior: 'smooth',
  });
}

function estimateCurrentPage(): number {
  if (mode.value === 'paginated') {
    return Math.floor(pageScrollLeft.value / pageMetrics.value.step) + 1;
  }
  return currentChapter.value + 1;
}

function estimatedPageCount(): number {
  return mode.value === 'paginated' ? pageMetrics.value.count : props.reflow.chapters.length;
}

watch(
  () => props.reflow,
  async () => {
    chapterElements.length = 0;
    await rebuildChapters();
    if (props.initialLocation) await restoreOffset(props.initialLocation);
  },
);

watch(
  () => props.activeSearchResult,
  () => void applyDecorations(),
);

watch(
  () => props.activeSearchQuery,
  () => void applyDecorations(),
);

watch(
  () => props.annotations,
  () => void applyDecorations(),
  { deep: true },
);

watch(
  () => [props.settings.width, props.settings.margin, props.settings.fontSize, props.settings.lineHeight, props.settings.paragraphSpacing],
  async () => {
    const saved = locationFor(currentChapter.value, currentOffset.value);
    await nextTick();
    updatePageMetrics();
    await restoreOffset(saved);
  },
);

watch(mode, async (next, previous) => {
  if (next === previous) return;
  const saved = locationFor(currentChapter.value, currentOffset.value);
  await nextTick();
  await rebuildChapters();
  await restoreOffset(saved);
});

onMounted(async () => {
  await rebuildChapters();
  if (props.initialLocation) await restoreOffset(props.initialLocation);
  emit('ready');
});

onBeforeUnmount(() => {
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
  if (wheelTimer) clearTimeout(wheelTimer);
});

defineExpose({
  jumpTo,
  goNextPage,
  goPreviousPage,
  goStart,
  goEnd,
  jumpToLink,
  clearSelection,
  currentChapterLabel: currentLabel,
  currentPage: estimateCurrentPage,
  pageCount: estimatedPageCount,
});
</script>

<template>
  <div
    ref="viewport"
    class="reader-reflow"
    :class="[`reader-reflow--${mode}`, `reader-reflow--${settings.theme}`]"
    :style="surfaceStyle"
    @wheel="onWheel"
    @click="onContentClick"
    @pointerdown="onPointerDown"
    @pointermove="emit('interaction')"
    @pointerup="onPointerUp"
  >
    <div
      v-if="mode === 'scroll'"
      ref="scroller"
      class="reader-reflow__scroll"
      @scroll.passive="onScroll"
    >
      <article
        v-for="(chapter, index) in reflow.chapters"
        :key="chapter.id"
        :ref="(element) => setChapterRef(index, element)"
        class="reader-reflow__chapter"
        :class="{ 'is-located': located && index === currentChapter }"
        :data-chapter-index="index"
        :aria-label="chapter.title"
      ></article>
      <footer class="reader-reflow__end">
        <span>读完本章</span>
        <strong>{{ book.title }}</strong>
      </footer>
    </div>

    <div
      v-else
      ref="scroller"
      class="reader-reflow__paginated"
      @scroll.passive="onScroll"
    >
      <article
        v-show="index === currentChapter"
        v-for="(chapter, index) in reflow.chapters"
        :key="chapter.id"
        :ref="(element) => setChapterRef(index, element)"
        class="reader-reflow__chapter reader-reflow__chapter--paginated"
        :class="{ 'is-located': located && index === currentChapter }"
        :data-chapter-index="index"
        :aria-label="chapter.title"
      ></article>
    </div>

    <div class="reader-reflow__edge reader-reflow__edge--left" aria-hidden="true"></div>
    <div class="reader-reflow__edge reader-reflow__edge--right" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
.reader-reflow {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color: var(--reader-ink);
  background:
    radial-gradient(circle at 50% -10%, color-mix(in srgb, var(--reader-paper) 72%, transparent), transparent 45%),
    var(--reader-paper-edge);
  transition:
    color 180ms ease,
    background-color 180ms ease;
  touch-action: pan-y;
}

.reader-reflow__scroll,
.reader-reflow__paginated {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable both-edges;
}

.reader-reflow__scroll {
  padding: var(--reader-safe-top) max(20px, env(safe-area-inset-right)) var(--reader-safe-bottom) max(20px, env(safe-area-inset-left));
}

.reader-reflow__paginated {
  overflow-x: auto;
  overflow-y: hidden;
  padding: var(--reader-safe-top) max(18px, env(safe-area-inset-right)) var(--reader-safe-bottom) max(18px, env(safe-area-inset-left));
  scroll-snap-type: x mandatory;
  overscroll-behavior-x: contain;
}

.reader-reflow__chapter {
  display: block;
  width: 100%;
  min-height: 32vh;
  margin: 0 auto 2.8rem;
  padding: 2.2rem max(22px, 4.8vw);
  border: 1px solid var(--reader-border);
  border-radius: 5px;
  color: var(--reader-ink);
  background: var(--reader-paper);
  box-shadow:
    0 1px 1px rgba(57, 45, 42, 0.06),
    0 18px 45px -42px rgba(42, 34, 31, 0.32);
  scroll-snap-align: start;
  transition: box-shadow 240ms ease;
}

.reader-reflow__chapter.is-located {
  animation: reader-located 850ms ease;
}

.reader-reflow__chapter--paginated {
  width: var(--reader-page-width);
  height: calc(100dvh - var(--reader-safe-top) - var(--reader-safe-bottom));
  min-height: 0;
  margin: 0 var(--reader-page-gap) 0 0;
  padding: 2.2rem max(18px, 3.4vw);
  overflow: visible;
  scroll-snap-align: start;
}

.reader-reflow__chapter--paginated:last-child {
  margin-right: 0;
}

.reader-reflow__end {
  display: grid;
  min-height: 180px;
  place-items: center;
  align-content: center;
  gap: 0.3rem;
  padding: 2rem;
  color: var(--reader-muted);
  text-align: center;
}

.reader-reflow__end span {
  font-size: 0.68rem;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

.reader-reflow__end strong {
  color: var(--reader-ink);
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 600;
}

.reader-reflow__edge {
  position: absolute;
  z-index: 2;
  top: 0;
  bottom: 0;
  width: min(5vw, 42px);
  pointer-events: none;
}

.reader-reflow__edge--left {
  left: 0;
  background: linear-gradient(90deg, var(--reader-paper-edge), transparent);
}

.reader-reflow__edge--right {
  right: 0;
  background: linear-gradient(-90deg, var(--reader-paper-edge), transparent);
}

@keyframes reader-located {
  0%,
  100% {
    box-shadow: 0 1px 1px rgba(57, 45, 42, 0.06), 0 18px 45px -42px rgba(42, 34, 31, 0.32);
  }
  35% {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 42%, transparent), 0 18px 45px -42px rgba(42, 34, 31, 0.32);
  }
}

@media (max-width: 700px) {
  .reader-reflow__scroll {
    padding-inline: max(10px, env(safe-area-inset-left)) max(10px, env(safe-area-inset-right));
  }

  .reader-reflow__chapter {
    margin-bottom: 1rem;
    padding: 1.35rem max(18px, 5vw);
    border-radius: 2px;
  }

  .reader-reflow__chapter--paginated {
    width: min(var(--reader-page-width), calc(100vw - 20px));
    height: calc(100dvh - var(--reader-safe-top) - var(--reader-safe-bottom));
    padding: 1.35rem max(18px, 5vw);
  }
}

@media (prefers-reduced-motion: reduce) {
  .reader-reflow__chapter.is-located {
    animation: none;
  }
}
</style>
