<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import {
  CheckSquare2,
  Edit3,
  Filter,
  FolderPlus,
  Grid2X2,
  Import,
  LayoutList,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import BookCard from '../components/BookCard.vue';
import BookListItem from '../components/BookListItem.vue';
import DialogPanel from '../components/DialogPanel.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import type { Book, Format } from '../types';

const app = useApp();
const VIRTUAL_OVERSCAN_ROWS = 3;
const GRID_COLUMN_GAP = 16;
const GRID_ROW_GAP = 18;
const LIST_ROW_HEIGHT = 86;
const LIST_ROW_GAP = 4;

const statusOptions = [
  { id: 'all', label: '全部' },
  { id: 'reading', label: '阅读中' },
  { id: 'unread', label: '未读' },
  { id: 'finished', label: '已读' },
  { id: 'favorite', label: '收藏' },
];

const status = ref(String(app.shelfFilter || app.route.id || 'all'));
const search = ref('');
const viewMode = ref<'grid' | 'list'>('grid');
const sort = ref('recent');
const filtersOpen = ref(false);
const selectionMode = ref(false);
const selectedIds = ref(new Set<string>());
const tagFilters = ref<string[]>([]);
const collectionFilter = ref('');
const rootFilter = ref('');
const formatFilter = ref<'' | Format>('');
const matchAll = ref(false);
const deleteOpen = ref(false);
const bulkTagId = ref('');
const bulkCollectionId = ref('');
const collectionManagerOpen = ref(false);
const collectionName = ref('');
const editingCollectionId = ref('');
const collectionDeleteId = ref('');
const savingCollection = ref(false);
const libraryViewport = ref<HTMLElement>();
const viewportWidth = ref(900);
const viewportHeight = ref(560);
const virtualScrollTop = ref(0);
let viewportObserver: ResizeObserver | undefined;
let scrollFrame = 0;

const filters = reactive({ author: '', missingOnly: false });

watch(
  () => [app.route.id, app.shelfFilter],
  () => {
    status.value = String(app.shelfFilter || app.route.id || 'all');
  },
);

watch(
  libraryViewport,
  (element, previous) => {
    if (previous) viewportObserver?.unobserve(previous);
    if (!element) return;
    viewportObserver?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      viewportObserver = new ResizeObserver(() => measureViewport());
      viewportObserver.observe(element);
    }
    measureViewport();
  },
  { flush: 'post' },
);

watch(viewMode, () => {
  virtualScrollTop.value = 0;
  if (libraryViewport.value) libraryViewport.value.scrollTop = 0;
});

watch(
  () =>
    [
      status.value,
      search.value,
      sort.value,
      collectionFilter.value,
      rootFilter.value,
      formatFilter.value,
      filters.author,
      filters.missingOnly,
      matchAll.value,
      tagFilters.value.join('\u0000'),
    ].join('\u0001'),
  () => {
    virtualScrollTop.value = 0;
    if (libraryViewport.value) libraryViewport.value.scrollTop = 0;
  },
);

const filteredBooks = computed(() => {
  const query = search.value.trim().toLocaleLowerCase('zh-CN');
  const result = app.books.filter((book) => {
    if (status.value === 'reading' && book.status !== 'reading') return false;
    if (status.value === 'unread' && book.status !== 'unread') return false;
    if (status.value === 'finished' && book.status !== 'finished') return false;
    if (status.value === 'favorite' && !book.favorite) return false;
    if (rootFilter.value && book.rootId !== rootFilter.value) return false;
    if (formatFilter.value && book.format !== formatFilter.value) return false;
    if (collectionFilter.value && !book.collectionIds.includes(collectionFilter.value)) return false;
    if (filters.missingOnly && book.available) return false;
    if (filters.author && !book.authors.join(' ').toLocaleLowerCase('zh-CN').includes(filters.author.toLocaleLowerCase('zh-CN'))) return false;
    if (tagFilters.value.length) {
      const matches = tagFilters.value.filter((tagId) => book.tagIds.includes(tagId));
      if (matchAll.value ? matches.length !== tagFilters.value.length : matches.length === 0) return false;
    }
    if (query) {
      const haystack = [
        book.title,
        ...book.authors,
        book.description || '',
        book.publisher || '',
        book.series || '',
        book.isbn || '',
        book.doi || '',
      ]
        .join(' ')
        .toLocaleLowerCase('zh-CN');
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  return result.sort((a, b) => {
    if (sort.value === 'title') return a.title.localeCompare(b.title, 'zh-CN');
    if (sort.value === 'author') return a.authors.join(' ').localeCompare(b.authors.join(' '), 'zh-CN');
    if (sort.value === 'added') return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (sort.value === 'progress') {
      return (b.location?.progress || 0) - (a.location?.progress || 0);
    }
    return Date.parse(b.lastReadAt || b.updatedAt) - Date.parse(a.lastReadAt || a.updatedAt);
  });
});

const virtualColumnCount = computed(() => {
  if (viewMode.value === 'list') return 1;
  if (window.innerWidth <= 390) return 2;
  if (viewportWidth.value < 500) return 2;
  if (viewportWidth.value < 720) return 3;
  return Math.max(
    3,
    Math.min(8, Math.floor((viewportWidth.value + GRID_COLUMN_GAP) / (142 + GRID_COLUMN_GAP))),
  );
});
const virtualCardWidth = computed(() =>
  Math.max(
    80,
    (viewportWidth.value - (virtualColumnCount.value - 1) * GRID_COLUMN_GAP) /
      virtualColumnCount.value,
  ),
);
const virtualRowHeight = computed(() => {
  if (viewMode.value === 'list') return LIST_ROW_HEIGHT;
  return Math.ceil(virtualCardWidth.value * 1.5 + 96);
});
const virtualRowPitch = computed(
  () =>
    virtualRowHeight.value +
    (viewMode.value === 'list' ? LIST_ROW_GAP : GRID_ROW_GAP),
);
const virtualTotalRows = computed(() =>
  Math.ceil(filteredBooks.value.length / virtualColumnCount.value),
);
const virtualStartRow = computed(() =>
  Math.max(
    0,
    Math.floor(virtualScrollTop.value / virtualRowPitch.value) - VIRTUAL_OVERSCAN_ROWS,
  ),
);
const virtualEndRow = computed(() =>
  Math.min(
    virtualTotalRows.value,
    Math.ceil(
      (virtualScrollTop.value + viewportHeight.value) / virtualRowPitch.value,
    ) + VIRTUAL_OVERSCAN_ROWS,
  ),
);
const virtualItems = computed(() => {
  const start = virtualStartRow.value * virtualColumnCount.value;
  const end = virtualEndRow.value * virtualColumnCount.value;
  return filteredBooks.value.slice(start, end);
});
const virtualOffsetTop = computed(() => virtualStartRow.value * virtualRowPitch.value);
const virtualContentHeight = computed(() =>
  Math.max(0, virtualTotalRows.value * virtualRowPitch.value - (viewMode.value === 'list' ? LIST_ROW_GAP : GRID_ROW_GAP)),
);

const selectedBooks = computed(() => app.books.filter((book) => selectedIds.value.has(book.id)));
const activeFilterCount = computed(
  () =>
    tagFilters.value.length +
    Number(Boolean(collectionFilter.value)) +
    Number(Boolean(rootFilter.value)) +
    Number(Boolean(formatFilter.value)) +
    Number(Boolean(filters.author)) +
    Number(filters.missingOnly),
);
const allVisibleSelected = computed(
  () => filteredBooks.value.length > 0 && filteredBooks.value.every((book) => selectedIds.value.has(book.id)),
);

function hasActiveFilters() {
  return Boolean(
    search.value ||
      activeFilterCount.value ||
      status.value !== 'all' ||
      sort.value !== 'recent',
  );
}

function clearFilters() {
  search.value = '';
  status.value = 'all';
  sort.value = 'recent';
  tagFilters.value = [];
  collectionFilter.value = '';
  rootFilter.value = '';
  formatFilter.value = '';
  filters.author = '';
  filters.missingOnly = false;
}

function setStatus(id: string) {
  status.value = id;
  app.navigate('bookshelf', id);
}

function setStatusAndSelection(id: string) {
  setStatus(id);
}

function toggleTag(id: string) {
  tagFilters.value = tagFilters.value.includes(id)
    ? tagFilters.value.filter((value) => value !== id)
    : [...tagFilters.value, id];
}

function toggleSelection(book: Book) {
  const next = new Set(selectedIds.value);
  if (next.has(book.id)) next.delete(book.id);
  else next.add(book.id);
  selectedIds.value = next;
  selectionMode.value = next.size > 0;
}

function toggleAllVisible() {
  const next = new Set(selectedIds.value);
  if (allVisibleSelected.value) filteredBooks.value.forEach((book) => next.delete(book.id));
  else filteredBooks.value.forEach((book) => next.add(book.id));
  selectedIds.value = next;
  selectionMode.value = next.size > 0;
}

function exitSelectionMode() {
  selectedIds.value = new Set();
  selectionMode.value = false;
}

function openDetail(book: Book) {
  app.navigate('book-detail', book.id);
}

function readBook(book: Book) {
  app.openReader(book.id, book.location);
}

async function toggleFavorite(book: Book) {
  await app.saveBook({ ...book, favorite: !book.favorite, updatedAt: new Date().toISOString() });
}

async function setBulkStatus(value: string) {
  if (!value) return;
  for (const book of selectedBooks.value) {
    await app.saveBook({
      ...book,
      status: value as Book['status'],
      updatedAt: new Date().toISOString(),
    });
  }
  app.notify(`已更新 ${selectedBooks.value.length} 本书的状态`);
}

async function applyBulkTag(remove = false) {
  if (!bulkTagId.value) return;
  for (const book of selectedBooks.value) {
    const tagIds = remove
      ? book.tagIds.filter((id) => id !== bulkTagId.value)
      : Array.from(new Set([...book.tagIds, bulkTagId.value]));
    await app.saveBook({ ...book, tagIds, updatedAt: new Date().toISOString() });
  }
  app.notify(`${remove ? '移除' : '添加'}标签成功`);
}

async function applyBulkCollection() {
  if (!bulkCollectionId.value) return;
  for (const book of selectedBooks.value) {
    await app.saveBook({
      ...book,
      collectionIds: Array.from(new Set([...book.collectionIds, bulkCollectionId.value])),
      updatedAt: new Date().toISOString(),
    });
  }
  app.notify('已加入集合');
}

function openCollectionManager() {
  collectionName.value = '';
  editingCollectionId.value = '';
  collectionDeleteId.value = '';
  collectionManagerOpen.value = true;
}

function editCollection(id: string, name: string) {
  editingCollectionId.value = id;
  collectionName.value = name;
}

function resetCollectionEditor() {
  editingCollectionId.value = '';
  collectionName.value = '';
}

async function saveCollectionDraft() {
  const name = collectionName.value.trim();
  if (!name) return;
  savingCollection.value = true;
  try {
    await app.saveCollection({
      id: editingCollectionId.value || crypto.randomUUID(),
      name,
    });
    resetCollectionEditor();
  } finally {
    savingCollection.value = false;
  }
}

async function confirmDeleteCollection() {
  if (!collectionDeleteId.value) return;
  await app.deleteCollection(collectionDeleteId.value);
  if (collectionFilter.value === collectionDeleteId.value) collectionFilter.value = '';
  if (bulkCollectionId.value === collectionDeleteId.value) bulkCollectionId.value = '';
  collectionDeleteId.value = '';
}

async function bulkFavorite() {
  for (const book of selectedBooks.value) {
    await app.saveBook({ ...book, favorite: true, updatedAt: new Date().toISOString() });
  }
  app.notify(`已收藏 ${selectedBooks.value.length} 本书`);
}

async function confirmDelete() {
  const ids = [...selectedIds.value];
  await app.deleteBooks(ids);
  deleteOpen.value = false;
  exitSelectionMode();
}

function measureViewport() {
  const element = libraryViewport.value;
  if (!element) return;
  viewportWidth.value = Math.max(320, element.clientWidth || 320);
  viewportHeight.value = Math.max(240, element.clientHeight || 400);
}

function onVirtualScroll(event: Event) {
  const target = event.currentTarget as HTMLElement;
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    virtualScrollTop.value = target.scrollTop;
    scrollFrame = 0;
  });
}

onBeforeUnmount(() => {
  viewportObserver?.disconnect();
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
});
</script>

<template>
  <div class="library-view page-view">
    <PageHeader
      title="书架"
      eyebrow=""
      :description="app.books.length ? `${app.books.length} 本书聚合自 ${app.roots.filter((root) => root.enabled).length} 个已启用书库文件夹。` : '把本地书籍聚合到一个安静、可整理的书架。'"
    >
      <template #actions>
        <button class="button button--primary" type="button" @click="app.navigate('import')">
          <Import :size="16" />导入书籍
        </button>
        <button class="button button--secondary" type="button" @click="openCollectionManager">
          <FolderPlus :size="16" />集合
        </button>
        <button
          class="button button--secondary"
          type="button"
          :aria-pressed="selectionMode"
          @click="selectionMode ? exitSelectionMode() : (selectionMode = true)"
        >
          <CheckSquare2 :size="16" />{{ selectionMode ? '结束选择' : '批量管理' }}
        </button>
      </template>
    </PageHeader>

    <section class="library-toolbar surface-card">
      <div class="library-toolbar__top">
        <label class="library-search">
          <Search :size="17" aria-hidden="true" />
          <span class="sr-only">搜索书架</span>
          <input v-model="search" type="search" placeholder="搜索书名、作者、ISBN 或 DOI" />
          <button v-if="search" type="button" aria-label="清空搜索" @click="search = ''"><X :size="15" /></button>
        </label>
        <div class="library-toolbar__actions">
          <button
            class="button button--secondary library-filter-toggle"
            type="button"
            :aria-expanded="filtersOpen"
            @click="filtersOpen = !filtersOpen"
          >
            <SlidersHorizontal :size="16" />筛选
            <span v-if="activeFilterCount" class="count-badge">{{ activeFilterCount }}</span>
          </button>
          <select v-model="sort" class="select sort-select" aria-label="排序方式">
            <option value="recent">最近阅读</option>
            <option value="added">最近添加</option>
            <option value="title">书名</option>
            <option value="author">作者</option>
            <option value="progress">阅读进度</option>
          </select>
          <div class="segmented view-segment" role="group" aria-label="书架视图">
            <button type="button" :class="{ 'is-active': viewMode === 'grid' }" aria-label="网格视图" @click="viewMode = 'grid'">
              <Grid2X2 :size="16" />
            </button>
            <button type="button" :class="{ 'is-active': viewMode === 'list' }" aria-label="列表视图" @click="viewMode = 'list'">
              <LayoutList :size="17" />
            </button>
          </div>
        </div>
      </div>

      <div class="status-tabs" role="tablist" aria-label="阅读状态">
        <button
          v-for="item in statusOptions"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="status === item.id"
          :class="{ 'is-active': status === item.id }"
          @click="setStatusAndSelection(item.id)"
        >
          {{ item.label }}
          <span v-if="item.id !== 'all'">{{ app.books.filter((book) => item.id === 'favorite' ? book.favorite : book.status === item.id).length }}</span>
          <span v-else>{{ app.books.length }}</span>
        </button>
      </div>

      <div v-if="filtersOpen" class="advanced-filters">
        <div class="advanced-filters__group">
          <span class="field-label">标签</span>
          <div v-if="app.tags.length" class="filter-chips">
            <button
              v-for="tag in app.tags"
              :key="tag.id"
              type="button"
              class="filter-chip"
              :class="{ 'is-active': tagFilters.includes(tag.id) }"
              :style="{ '--chip-color': tag.color }"
              @click="toggleTag(tag.id)"
            >
              <span></span>{{ tag.name }}
            </button>
          </div>
          <span v-else class="muted filter-empty">尚无标签</span>
          <label v-if="tagFilters.length > 1" class="checkbox-line">
            <input v-model="matchAll" type="checkbox" />必须同时匹配所有已选标签
          </label>
        </div>
        <div class="advanced-filters__grid">
          <label class="form-field">
            <span class="field-label filter-label-row">
              <span>集合</span>
              <button type="button" @click="openCollectionManager">管理集合</button>
            </span>
            <select v-model="collectionFilter" class="select">
              <option value="">全部集合</option>
              <option v-for="collection in app.collections" :key="collection.id" :value="collection.id">{{ collection.name }}</option>
            </select>
          </label>
          <label class="form-field">
            <span class="field-label">来源文件夹</span>
            <select v-model="rootFilter" class="select">
              <option value="">全部来源</option>
              <option v-for="root in app.roots" :key="root.id" :value="root.id">{{ root.displayName }}</option>
            </select>
          </label>
          <label class="form-field">
            <span class="field-label">格式</span>
            <select v-model="formatFilter" class="select">
              <option value="">全部格式</option>
              <option value="epub">EPUB</option>
              <option value="pdf">PDF</option>
              <option value="txt">TXT</option>
              <option value="mobi">MOBI</option>
            </select>
          </label>
          <label class="form-field">
            <span class="field-label">作者</span>
            <input v-model="filters.author" class="field" type="text" placeholder="输入作者名" />
          </label>
        </div>
        <div class="advanced-filters__footer">
          <label class="checkbox-line">
            <input v-model="filters.missingOnly" type="checkbox" />仅显示文件不可访问的书籍
          </label>
          <button v-if="hasActiveFilters()" class="button button--ghost button--small" type="button" @click="clearFilters">
            清除全部条件
          </button>
        </div>
      </div>
    </section>

    <div v-if="selectionMode" class="selection-toolbar surface-card">
      <div class="selection-toolbar__summary">
        <button class="icon-button" type="button" aria-label="退出批量选择" @click="exitSelectionMode"><X :size="17" /></button>
        <strong>已选 {{ selectedIds.size }} 本</strong>
        <button type="button" class="text-action" @click="toggleAllVisible">
          {{ allVisibleSelected ? '取消全选' : `选择当前 ${filteredBooks.length} 本` }}
        </button>
      </div>
      <div class="selection-toolbar__actions">
        <select class="select select--compact" aria-label="批量修改阅读状态" @change="setBulkStatus(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
          <option value="">阅读状态</option>
          <option value="unread">未读</option>
          <option value="reading">阅读中</option>
          <option value="finished">已读</option>
        </select>
        <select v-model="bulkTagId" class="select select--compact" aria-label="选择要批量应用的标签">
          <option value="">选择标签</option>
          <option v-for="tag in app.tags" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
        </select>
        <button class="button button--small button--secondary" type="button" :disabled="!bulkTagId" @click="applyBulkTag(false)">添加标签</button>
        <button class="button button--small button--ghost" type="button" :disabled="!bulkTagId" @click="applyBulkTag(true)">移除标签</button>
        <select v-if="app.collections.length" v-model="bulkCollectionId" class="select select--compact" aria-label="选择集合">
          <option value="">选择集合</option>
          <option v-for="collection in app.collections" :key="collection.id" :value="collection.id">{{ collection.name }}</option>
        </select>
        <button v-if="app.collections.length" class="button button--small button--secondary" type="button" :disabled="!bulkCollectionId" @click="applyBulkCollection">加入集合</button>
        <button class="button button--small button--secondary" type="button" @click="bulkFavorite">收藏</button>
        <button class="button button--small button--danger" type="button" @click="deleteOpen = true"><Trash2 :size="14" />删除</button>
      </div>
    </div>

    <div class="library-results-heading">
      <p>
        <Filter :size="14" />
        <span>{{ filteredBooks.length }} 本</span>
        <span v-if="hasActiveFilters()">符合当前条件</span>
        <span v-else>全部书籍</span>
      </p>
      <p v-if="selectionMode" class="muted">
        <component :is="allVisibleSelected ? CheckSquare2 : Square" :size="14" />
        点击封面上的圆圈选择书籍
      </p>
    </div>

    <EmptyState
      v-if="!app.books.length"
      title="书架还是空的"
      description="导入本地书籍，或先选择一个书库文件夹。Granite 不会自动生成示例书。"
      action-label="导入书籍"
      secondary-label="选择书库文件夹"
      @action="app.navigate('import')"
      @secondary="app.navigate('settings', 'library')"
    />
    <EmptyState
      v-else-if="!filteredBooks.length"
      title="没有符合条件的书籍"
      description="调整阅读状态、标签或来源文件夹，或清除所有筛选条件。"
      action-label="清除筛选"
      @action="clearFilters"
    />
    <div
      v-else
      ref="libraryViewport"
      class="library-virtual-viewport"
      :class="`library-virtual-viewport--${viewMode}`"
      @scroll.passive="onVirtualScroll"
    >
      <div
        class="library-virtual-spacer"
        :style="{ height: `${virtualContentHeight}px` }"
      >
        <div
          class="library-virtual-window"
          :style="{ transform: `translateY(${virtualOffsetTop}px)` }"
        >
          <div
            v-if="viewMode === 'grid'"
            class="book-grid"
            role="list"
            aria-label="书籍网格"
            :style="{
              gridTemplateColumns: `repeat(${virtualColumnCount}, minmax(0, 1fr))`,
              gridAutoRows: `${virtualRowHeight}px`,
            }"
          >
            <div
              v-for="(book, index) in virtualItems"
              :key="book.id"
              class="library-virtual-cell"
              role="listitem"
              :aria-posinset="virtualStartRow * virtualColumnCount + index + 1"
              :aria-setsize="filteredBooks.length"
            >
              <BookCard
                :book="book"
                :selected="selectedIds.has(book.id)"
                :selectable="selectionMode"
                @detail="openDetail"
                @read="readBook"
                @select="toggleSelection"
                @favorite="toggleFavorite"
              />
            </div>
          </div>
          <div v-else class="book-list" role="list" aria-label="书籍列表">
            <div
              v-for="(book, index) in virtualItems"
              :key="book.id"
              class="library-virtual-cell"
              role="listitem"
              :aria-posinset="virtualStartRow * virtualColumnCount + index + 1"
              :aria-setsize="filteredBooks.length"
            >
              <BookListItem
                :book="book"
                :selected="selectedIds.has(book.id)"
                :selectable="selectionMode"
                :tags="app.tags"
                :collections="app.collections"
                :roots="app.roots"
                @detail="openDetail"
                @read="readBook"
                @select="toggleSelection"
                @favorite="toggleFavorite"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <DialogPanel
      v-if="collectionManagerOpen"
      title="管理集合"
      description="集合可跨来源组织书籍。删除集合只会移除分组关系，书籍、标签和文件都会保留。"
      @close="collectionManagerOpen = false"
    >
      <form class="collection-editor" @submit.prevent="saveCollectionDraft">
        <label class="form-field">
          <span>{{ editingCollectionId ? '重命名集合' : '新建集合' }}</span>
          <input
            v-model="collectionName"
            class="field"
            maxlength="80"
            autofocus
            placeholder="例如：认知科学"
          />
        </label>
        <button class="button button--primary" type="submit" :disabled="!collectionName.trim() || savingCollection">
          {{ savingCollection ? '保存中' : editingCollectionId ? '保存名称' : '创建集合' }}
        </button>
        <button v-if="editingCollectionId" class="button button--ghost" type="button" @click="resetCollectionEditor">取消编辑</button>
      </form>

      <div v-if="app.collections.length" class="collection-manager-list">
        <article v-for="collection in app.collections" :key="collection.id">
          <span class="collection-manager-list__mark"><FolderPlus :size="16" /></span>
          <span>
            <strong>{{ collection.name }}</strong>
            <small>{{ app.books.filter((book) => book.collectionIds.includes(collection.id)).length }} 本书</small>
          </span>
          <button class="icon-button icon-button--small" type="button" :aria-label="`重命名集合 ${collection.name}`" @click="editCollection(collection.id, collection.name)">
            <Edit3 :size="14" />
          </button>
          <button class="icon-button icon-button--small danger" type="button" :aria-label="`删除集合 ${collection.name}`" @click="collectionDeleteId = collection.id">
            <Trash2 :size="14" />
          </button>
        </article>
      </div>
      <div v-else class="collection-manager-empty">
        <FolderPlus :size="22" />
        <span>还没有集合。创建后可在筛选、批量整理和书籍详情中使用。</span>
      </div>
      <template #footer>
        <button class="button button--secondary" type="button" @click="collectionManagerOpen = false">完成</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="collectionDeleteId"
      title="删除集合？"
      :description="`将删除“${app.collections.find((collection) => collection.id === collectionDeleteId)?.name || '这个集合'}”及其分组关系。书籍、标签和文件都会保留。`"
      width="small"
      @close="collectionDeleteId = ''"
    >
      <div class="delete-warning">
        <Trash2 :size="20" />
        <span>会生成集合删除墓碑，并在下次同步时传播到其他设备。</span>
      </div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="collectionDeleteId = ''">取消</button>
        <button class="button button--danger" type="button" @click="confirmDeleteCollection">删除集合</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="deleteOpen"
      title="删除所选书籍？"
      :description="`将删除 ${selectedIds.size} 本书籍记录和 Granite 管理的同步对象。外部书库中的原文件不会在未单独确认时被物理删除。`"
      width="small"
      @close="deleteOpen = false"
    >
      <div class="delete-warning">
        <Trash2 :size="20" />
        <span>此操作会生成删除墓碑，并同步到其他设备。请确认所选书籍无误。</span>
      </div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="deleteOpen = false">取消</button>
        <button class="button button--danger" type="button" @click="confirmDelete">删除 {{ selectedIds.size }} 本</button>
      </template>
    </DialogPanel>
  </div>
</template>

<style scoped>
.library-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.library-toolbar {
  padding: 1rem;
}

.library-toolbar__top {
  display: flex;
  align-items: center;
  gap: 0.8rem;
}

.library-search {
  display: flex;
  height: 42px;
  min-width: 260px;
  flex: 1;
  align-items: center;
  gap: 0.55rem;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: 11px;
  color: var(--text-tertiary);
  background: var(--surface-elevated);
}

.library-search:focus-within {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 10%, transparent);
}

.library-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
}

.library-search button {
  display: grid;
  width: 25px;
  height: 25px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--text-tertiary);
  background: transparent;
}

.library-toolbar__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.count-badge {
  display: grid;
  min-width: 18px;
  height: 18px;
  place-items: center;
  padding-inline: 0.25rem;
  border-radius: 999px;
  color: var(--accent-contrast);
  background: var(--accent);
  font-size: 0.63rem;
}

.sort-select {
  width: 125px;
}

.view-segment button {
  display: grid;
  width: 34px;
  place-items: center;
  padding: 0;
}

.status-tabs {
  display: flex;
  overflow-x: auto;
  gap: 0.3rem;
  margin-top: 0.85rem;
  padding-bottom: 0.1rem;
}

.status-tabs button {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.7rem;
  border: 0;
  border-radius: 8px;
  color: var(--text-secondary);
  background: transparent;
  font-size: 0.78rem;
  font-weight: 620;
  white-space: nowrap;
}

.status-tabs button span {
  color: var(--text-tertiary);
  font-size: 0.66rem;
}

.status-tabs button.is-active {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.advanced-filters {
  display: grid;
  gap: 1rem;
  padding: 1rem 0.25rem 0.25rem;
  border-top: 1px solid var(--border);
  margin-top: 0.75rem;
  animation: reveal var(--motion-base) var(--ease-out);
}

.advanced-filters__group {
  display: grid;
  gap: 0.5rem;
}

.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.filter-chip {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--surface-elevated);
  font-size: 0.72rem;
}

.filter-chip span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--chip-color);
}

.filter-chip.is-active {
  border-color: color-mix(in srgb, var(--chip-color) 55%, var(--border));
  color: var(--text);
  background: color-mix(in srgb, var(--chip-color) 12%, var(--surface-elevated));
}

.filter-empty {
  font-size: 0.74rem;
}

.advanced-filters__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.7rem;
}

.filter-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.filter-label-row button {
  padding: 0;
  border: 0;
  color: var(--accent-strong);
  background: transparent;
  font-size: 0.66rem;
}

.advanced-filters__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.selection-toolbar {
  position: sticky;
  z-index: 20;
  top: 74px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 0.6rem;
  border-color: color-mix(in srgb, var(--accent) 25%, var(--border));
  box-shadow: var(--shadow-float);
}

.selection-toolbar__summary,
.selection-toolbar__actions {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.selection-toolbar__summary strong {
  white-space: nowrap;
}

.text-action {
  padding: 0;
  border: 0;
  color: var(--accent-strong);
  background: transparent;
  font-size: 0.74rem;
  font-weight: 650;
}

.select--compact {
  width: auto;
  min-height: 33px;
  padding-block: 0.3rem;
  font-size: 0.74rem;
}

.library-results-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.25rem;
}

.library-results-heading p {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.library-results-heading p span:first-of-type {
  color: var(--text);
  font-weight: 680;
}

.library-virtual-viewport {
  position: relative;
  height: clamp(360px, calc(100dvh - 340px), 760px);
  overflow-y: auto;
  overflow-x: hidden;
  border-radius: var(--radius-lg);
  contain: strict;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.library-virtual-spacer {
  position: relative;
  width: 100%;
}

.library-virtual-window {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  will-change: transform;
}

.library-virtual-cell {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.book-grid {
  display: grid;
  gap: 18px 16px;
}

.book-list {
  display: grid;
  gap: 4px;
  grid-auto-rows: 86px;
}

.delete-warning {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  padding: 0.85rem;
  border: 1px solid color-mix(in srgb, var(--danger) 26%, var(--border));
  border-radius: 12px;
  color: var(--danger);
  background: var(--danger-soft);
  line-height: 1.55;
}

.collection-editor {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}

.collection-editor .form-field {
  min-width: 0;
  flex: 1;
}

.collection-manager-list {
  display: grid;
  gap: 0.35rem;
  padding-top: 0.75rem;
}

.collection-manager-list article {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem;
  border-radius: 10px;
  background: var(--surface-muted);
}

.collection-manager-list__mark {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.collection-manager-list article > span:nth-child(2) {
  display: grid;
  min-width: 0;
  gap: 0.1rem;
}

.collection-manager-list strong,
.collection-manager-list small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collection-manager-list strong {
  font-size: 0.73rem;
}

.collection-manager-list small {
  color: var(--text-secondary);
  font-size: 0.64rem;
}

.collection-manager-empty {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 1rem;
  border: 1px dashed var(--border-strong);
  border-radius: 11px;
  margin-top: 0.75rem;
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

@keyframes reveal {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

@media (max-width: 1050px) {
  .advanced-filters__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .selection-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .selection-toolbar__actions {
    overflow-x: auto;
    width: 100%;
    padding-bottom: 0.15rem;
  }
}

@media (max-width: 720px) {
  .library-toolbar__top {
    align-items: stretch;
    flex-direction: column;
  }

  .library-search {
    min-width: 0;
  }

  .library-toolbar__actions {
    justify-content: space-between;
  }

  .advanced-filters__grid {
    grid-template-columns: 1fr;
  }

  .advanced-filters__footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .collection-editor {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (max-width: 390px) {
  .library-filter-toggle {
    font-size: 0;
  }

  .sort-select {
    width: 108px;
  }
}
</style>

