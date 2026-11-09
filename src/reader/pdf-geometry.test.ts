import { describe, expect, it } from 'vitest';
import {
  clampToOverscroll,
  documentBounds,
  fitPageScale,
  fitWidthScale,
  nearestLegalTransform,
  pageAtViewportCenter,
  zoomAroundPoint,
} from './pdf-geometry';
import { PDF_OVERSCROLL_RATIO } from './types';

describe('PDF free canvas geometry', () => {
  const viewport = { width: 400, height: 800 };

  it('uses Fit Width and Fit Page without violating scale limits', () => {
    expect(fitWidthScale(600, 400)).toBeCloseTo(2 / 3);
    expect(fitPageScale(600, 1200, viewport)).toBeCloseTo(2 / 3);
    expect(fitPageScale(0, 0, viewport)).toBe(1);
  });

  it('keeps the pinch anchor fixed while scale changes', () => {
    const initial = { x: -120, y: -300, scale: 1.25 };
    const point = { x: 210, y: 390 };
    const contentBefore = {
      x: (point.x - initial.x) / initial.scale,
      y: (point.y - initial.y) / initial.scale,
    };
    const zoomed = zoomAroundPoint(initial, 2.4, point);
    expect((point.x - zoomed.x) / zoomed.scale).toBeCloseTo(contentBefore.x);
    expect((point.y - zoomed.y) / zoomed.scale).toBeCloseTo(contentBefore.y);
  });

  it('centers a document smaller than the viewport and bounds a larger one', () => {
    const centered = documentBounds(200, 500, viewport, 1);
    expect(centered.x.min).toBe(100);
    expect(centered.x.max).toBe(100);
    expect(centered.y.min).toBe(150);

    const large = documentBounds(1000, 1600, viewport, 1);
    expect(large.x).toEqual({ min: -600, max: 0, center: -300, bounded: true });
    expect(large.y).toEqual({ min: -800, max: 0, center: -400, bounded: true });
  });

  it('allows exactly 50% viewport overscroll and springs to the nearest legal edge', () => {
    const dragged = clampToOverscroll(
      { x: 2_000, y: 2_000, scale: 1 },
      1_000,
      1_600,
      viewport,
    );
    expect(dragged.x).toBe(viewport.width * PDF_OVERSCROLL_RATIO);
    expect(dragged.y).toBe(viewport.height * PDF_OVERSCROLL_RATIO);

    const legal = nearestLegalTransform(dragged, 1_000, 1_600, viewport);
    expect(legal.x).toBe(0);
    expect(legal.y).toBe(0);
  });

  it('derives the current page from the transformed viewport center', () => {
    const pages = [
      { page: 1, y: 0, height: 600 },
      { page: 2, y: 618, height: 600 },
      { page: 3, y: 1_236, height: 600 },
    ];
    expect(pageAtViewportCenter(pages, { x: 0, y: -400, scale: 1 }, 800)).toBe(2);
    expect(pageAtViewportCenter(pages, { x: 0, y: -1_000, scale: 1 }, 800)).toBe(3);
  });
});
