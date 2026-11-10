import type { Format } from '../types';

export type LibraryStatus = 'all' | 'reading' | 'unread' | 'finished' | 'favorite';
export type LibraryViewMode = 'grid' | 'list';
export type LibrarySort = 'recent' | 'added' | 'title' | 'author' | 'progress';
export type SearchResultType = 'all' | 'books' | 'notes' | 'tags' | 'collections';
export type StatisticsRange = 'day' | 'week' | 'month' | 'year';

export interface LibraryViewState {
  status: LibraryStatus;
  search: string;
  viewMode: LibraryViewMode;
  sort: LibrarySort;
  filtersOpen: boolean;
  tagFilters: string[];
  collectionFilter: string;
  rootFilter: string;
  formatFilter: '' | Format;
  matchAll: boolean;
  author: string;
  missingOnly: boolean;
  virtualScrollTop: number;
}

export interface SearchViewState {
  query: string;
  type: SearchResultType;
}

export interface StatisticsViewState {
  range: StatisticsRange;
}

const STORAGE_KEYS = {
  library: 'granite:view-state:v1:library',
  search: 'granite:view-state:v1:search',
  statistics: 'granite:view-state:v1:statistics',
} as const;

const MAX_QUERY_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_FILTER_COUNT = 64;
const MAX_SCROLL_TOP = 10_000_000;

const LIBRARY_STATUSES = ['all', 'reading', 'unread', 'finished', 'favorite'] as const;
const LIBRARY_VIEW_MODES = ['grid', 'list'] as const;
const LIBRARY_SORTS = ['recent', 'added', 'title', 'author', 'progress'] as const;
const SEARCH_RESULT_TYPES = ['all', 'books', 'notes', 'tags', 'collections'] as const;
const STATISTICS_RANGES = ['day', 'week', 'month', 'year'] as const;
const FORMATS = ['', 'epub', 'pdf', 'txt', 'mobi'] as const;

const DEFAULT_LIBRARY_STATE: LibraryViewState = {
  status: 'all',
  search: '',
  viewMode: 'grid',
  sort: 'recent',
  filtersOpen: false,
  tagFilters: [],
  collectionFilter: '',
  rootFilter: '',
  formatFilter: '',
  matchAll: false,
  author: '',
  missingOnly: false,
  virtualScrollTop: 0,
};

const DEFAULT_SEARCH_STATE: SearchViewState = {
  query: '',
  type: 'all',
};

const DEFAULT_STATISTICS_STATE: StatisticsViewState = {
  range: 'month',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, fallback = '', limit = MAX_QUERY_LENGTH) {
  return typeof value === 'string' ? value.slice(0, limit) : fallback;
}

function boundedBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && values.includes(value as T)
    ? (value as T)
    : fallback;
}

function boundedIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .map((item) => item.slice(0, MAX_ID_LENGTH)),
  )].slice(0, MAX_FILTER_COUNT);
}

function boundedScrollTop(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(MAX_SCROLL_TOP, Math.max(0, Math.round(value)));
}

function readStoredValue(key: string): unknown {
  if (typeof window === 'undefined') return undefined;
  try {
    const value = window.sessionStorage.getItem(key);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredValue(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

export function resolveLibraryViewStatus(
  routeId: string | undefined,
  shelfFilter: string | undefined,
): LibraryStatus {
  if (typeof routeId === 'string' && LIBRARY_STATUSES.includes(routeId as LibraryStatus)) {
    return routeId as LibraryStatus;
  }
  if (
    typeof shelfFilter === 'string' &&
    LIBRARY_STATUSES.includes(shelfFilter as LibraryStatus)
  ) {
    return shelfFilter as LibraryStatus;
  }
  return 'all';
}

export function readLibraryViewState(): LibraryViewState {
  const value = readStoredValue(STORAGE_KEYS.library);
  if (!isRecord(value)) return { ...DEFAULT_LIBRARY_STATE, tagFilters: [] };
  return {
    status: enumValue(value.status, LIBRARY_STATUSES, DEFAULT_LIBRARY_STATE.status),
    search: boundedString(value.search),
    viewMode: enumValue(
      value.viewMode,
      LIBRARY_VIEW_MODES,
      DEFAULT_LIBRARY_STATE.viewMode,
    ),
    sort: enumValue(value.sort, LIBRARY_SORTS, DEFAULT_LIBRARY_STATE.sort),
    filtersOpen: boundedBoolean(value.filtersOpen),
    tagFilters: boundedIds(value.tagFilters),
    collectionFilter: boundedString(value.collectionFilter, '', MAX_ID_LENGTH),
    rootFilter: boundedString(value.rootFilter, '', MAX_ID_LENGTH),
    formatFilter: enumValue(value.formatFilter, FORMATS, ''),
    matchAll: boundedBoolean(value.matchAll),
    author: boundedString(value.author),
    missingOnly: boundedBoolean(value.missingOnly),
    virtualScrollTop: boundedScrollTop(value.virtualScrollTop),
  };
}

export function writeLibraryViewState(value: LibraryViewState) {
  writeStoredValue(STORAGE_KEYS.library, {
    status: enumValue(value.status, LIBRARY_STATUSES, DEFAULT_LIBRARY_STATE.status),
    search: boundedString(value.search),
    viewMode: enumValue(
      value.viewMode,
      LIBRARY_VIEW_MODES,
      DEFAULT_LIBRARY_STATE.viewMode,
    ),
    sort: enumValue(value.sort, LIBRARY_SORTS, DEFAULT_LIBRARY_STATE.sort),
    filtersOpen: boundedBoolean(value.filtersOpen),
    tagFilters: boundedIds(value.tagFilters),
    collectionFilter: boundedString(value.collectionFilter, '', MAX_ID_LENGTH),
    rootFilter: boundedString(value.rootFilter, '', MAX_ID_LENGTH),
    formatFilter: enumValue(value.formatFilter, FORMATS, ''),
    matchAll: boundedBoolean(value.matchAll),
    author: boundedString(value.author),
    missingOnly: boundedBoolean(value.missingOnly),
    virtualScrollTop: boundedScrollTop(value.virtualScrollTop),
  });
}

export function readSearchViewState(): SearchViewState {
  const value = readStoredValue(STORAGE_KEYS.search);
  if (!isRecord(value)) return { ...DEFAULT_SEARCH_STATE };
  return {
    query: boundedString(value.query),
    type: enumValue(value.type, SEARCH_RESULT_TYPES, DEFAULT_SEARCH_STATE.type),
  };
}

export function writeSearchViewState(value: SearchViewState) {
  writeStoredValue(STORAGE_KEYS.search, {
    query: boundedString(value.query),
    type: enumValue(value.type, SEARCH_RESULT_TYPES, DEFAULT_SEARCH_STATE.type),
  });
}

export function readStatisticsViewState(): StatisticsViewState {
  const value = readStoredValue(STORAGE_KEYS.statistics);
  if (!isRecord(value)) return { ...DEFAULT_STATISTICS_STATE };
  return {
    range: enumValue(value.range, STATISTICS_RANGES, DEFAULT_STATISTICS_STATE.range),
  };
}

export function writeStatisticsViewState(value: StatisticsViewState) {
  writeStoredValue(STORAGE_KEYS.statistics, {
    range: enumValue(value.range, STATISTICS_RANGES, DEFAULT_STATISTICS_STATE.range),
  });
}
