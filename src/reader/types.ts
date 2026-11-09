import type {
  Annotation,
  Book,
  Format,
  ReaderLocation,
  ReaderSettings,
} from '../types';

export type ReaderPanelName = 'contents' | 'search' | 'annotations' | 'settings';
export type ReaderSurfaceMode = 'scroll' | 'paginated';
export type ReaderPdfTool = 'pan' | 'select' | 'ink';

export interface ReaderTocItem {
  id: string;
  label: string;
  href?: string;
  chapterIndex?: number;
  page?: number;
  level: number;
  children?: ReaderTocItem[];
}

export interface ReaderChapter {
  id: string;
  href: string;
  title: string;
  html: string;
  css: string;
  text: string;
  encoding?: string;
}

export interface ReflowBook {
  format: Exclude<Format, 'pdf'>;
  title?: string;
  authors: string[];
  chapters: ReaderChapter[];
  toc: ReaderTocItem[];
  warnings: string[];
  destroy?: () => void;
}

export interface ReaderSearchResult {
  id: string;
  text: string;
  before: string;
  after: string;
  chapterIndex?: number;
  page?: number;
  offset?: number;
  rects?: number[][];
}

export interface ReaderTextSelection {
  text: string;
  location: ReaderLocation;
  rects?: number[][];
  anchor?: { left: number; top: number; right: number; bottom: number };
  page?: number;
}

export interface ReaderPdfInkInput {
  page: number;
  rects: number[][];
  ink: number[][];
  color: string;
  location: ReaderLocation;
}

export interface ReaderPdfViewState {
  page: number;
  totalPages: number;
  scale: number;
  rotation: number;
  x: number;
  y: number;
  fitMode?: PdfFitMode;
}

export type PdfFitMode = 'width' | 'page' | 'actual' | 'custom';

export interface PdfPageLayout {
  page: number;
  width: number;
  height: number;
  x: number;
  y: number;
  rotate: number;
}

export interface ReaderLoadContext {
  book: Book;
  bytes: Uint8Array;
  settings: ReaderSettings;
}

export interface PdfAnnotationRecord {
  id: string;
  page: number;
  type: 'highlight' | 'underline' | 'note' | 'ink';
  color: string;
  text: string;
  note: string;
  rects: number[][];
  ink?: number[][];
  createdAt: string;
  updatedAt: string;
}

export type ReaderAnnotation = Annotation;

export const PDF_BASE_SCALE = 96 / 72;
export const PDF_MIN_SCALE = 0.12;
export const PDF_MAX_SCALE = 8;
export const PDF_OVERSCROLL_RATIO = 0.5;

