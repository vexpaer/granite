import { clamp } from './utils';
import {
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  PDF_OVERSCROLL_RATIO,
} from './types';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface DocumentTransform {
  x: number;
  y: number;
  scale: number;
}

export interface AxisBounds {
  min: number;
  max: number;
  center: number;
  bounded: boolean;
}

export interface DocumentBounds {
  x: AxisBounds;
  y: AxisBounds;
}

export function axisBounds(documentSize: number, viewportSize: number): AxisBounds {
  if (documentSize <= viewportSize) {
    const center = (viewportSize - documentSize) / 2;
    return { min: center, max: center, center, bounded: false };
  }
  return {
    min: viewportSize - documentSize,
    max: 0,
    center: (viewportSize - documentSize) / 2,
    bounded: true,
  };
}

export function documentBounds(
  documentWidth: number,
  documentHeight: number,
  viewport: ViewportSize,
  scale: number,
): DocumentBounds {
  return {
    x: axisBounds(documentWidth * scale, viewport.width),
    y: axisBounds(documentHeight * scale, viewport.height),
  };
}

export function clampToOverscroll(
  transform: DocumentTransform,
  width: number,
  height: number,
  viewport: ViewportSize,
): DocumentTransform {
  const bounds = documentBounds(width, height, viewport, transform.scale);
  const xMargin = viewport.width * PDF_OVERSCROLL_RATIO;
  const yMargin = viewport.height * PDF_OVERSCROLL_RATIO;
  return {
    x: clamp(transform.x, bounds.x.min - xMargin, bounds.x.max + xMargin),
    y: clamp(transform.y, bounds.y.min - yMargin, bounds.y.max + yMargin),
    scale: clamp(transform.scale, PDF_MIN_SCALE, PDF_MAX_SCALE),
  };
}

export function nearestLegalTransform(
  transform: DocumentTransform,
  width: number,
  height: number,
  viewport: ViewportSize,
): DocumentTransform {
  const bounds = documentBounds(width, height, viewport, transform.scale);
  return {
    x: clamp(transform.x, bounds.x.min, bounds.x.max),
    y: clamp(transform.y, bounds.y.min, bounds.y.max),
    scale: clamp(transform.scale, PDF_MIN_SCALE, PDF_MAX_SCALE),
  };
}

export function zoomAroundPoint(
  transform: DocumentTransform,
  nextScale: number,
  point: { x: number; y: number },
): DocumentTransform {
  const scale = clamp(nextScale, PDF_MIN_SCALE, PDF_MAX_SCALE);
  const contentX = (point.x - transform.x) / transform.scale;
  const contentY = (point.y - transform.y) / transform.scale;
  return {
    x: point.x - contentX * scale,
    y: point.y - contentY * scale,
    scale,
  };
}

export function fitWidthScale(
  documentWidth: number,
  viewportWidth: number,
): number {
  if (documentWidth <= 0 || viewportWidth <= 0) return 1;
  return clamp(viewportWidth / documentWidth, PDF_MIN_SCALE, PDF_MAX_SCALE);
}

export function fitPageScale(
  documentWidth: number,
  documentHeight: number,
  viewport: ViewportSize,
): number {
  if (documentWidth <= 0 || documentHeight <= 0) return 1;
  return clamp(
    Math.min(viewport.width / documentWidth, viewport.height / documentHeight),
    PDF_MIN_SCALE,
    PDF_MAX_SCALE,
  );
}

export function pageAtViewportCenter(
  pages: Array<{ page: number; y: number; height: number }>,
  transform: DocumentTransform,
  viewportHeight: number,
): number {
  if (!pages.length) return 1;
  const contentY = (viewportHeight / 2 - transform.y) / transform.scale;
  const found = pages.find(
    (page) => contentY >= page.y && contentY <= page.y + page.height,
  );
  if (found) return found.page;
  return contentY < pages[0].y ? pages[0].page : pages[pages.length - 1].page;
}

export function translatePageToTop(
  pageY: number,
  pageHeight: number,
  scale: number,
  viewportHeight: number,
): number {
  const topPadding = Math.min(viewportHeight * 0.08, 64);
  return topPadding - pageY * scale;
}

