<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  h,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
} from 'vue';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  CloudCog,
  CloudOff,
  RefreshCw,
  Search,
  X,
} from 'lucide-vue-next';
import { useApp } from './stores/app';
import AppSidebar from './components/AppSidebar.vue';
import AndroidNav from './components/AndroidNav.vue';
import HomeView from './views/HomeView.vue';
import LibraryView from './views/LibraryView.vue';
import BookDetailView from './views/BookDetailView.vue';
import NotebookView from './views/NotebookView.vue';
import StatisticsView from './views/StatisticsView.vue';
import MeView from './views/MeView.vue';
import SettingsView from './views/SettingsView.vue';
import SyncView from './views/SyncView.vue';
import PluginsView from './views/PluginsView.vue';
import TagsView from './views/TagsView.vue';
import TagResultsView from './views/TagResultsView.vue';
import SearchView from './views/SearchView.vue';
import ImportView from './views/ImportView.vue';
import ConflictsView from './views/ConflictsView.vue';
import DiagnosticsView from './views/DiagnosticsView.vue';
import PluginSlots from './components/PluginSlots.vue';
import PluginSurface from './components/PluginSurface.vue';
import type { PluginUiEntry } from './services/plugin-manager';
import { matchesShortcut } from './services/shortcuts';
import './styles/global.css';
import './styles/app.css';

const app = useApp();
const ReaderView = defineAsyncComponent({
  loader: () => import('./views/ReaderView.vue'),
  loadingComponent: () => h('div', { class: 'app-loading', role: 'status' }, '正在加载阅读器…'),
  errorComponent: () => h('div', { class: 'app-loading', role: 'alert' }, [
    h('span', '阅读器加载失败，请重新打开书籍。'),
    h('button', { class: 'button button--secondary', onClick: () => app.back() }, '返回'),
  ]),
  timeout: 30000,
});
const viewport = reactive({ width: window.innerWidth, height: window.innerHeight });
const searchInput = ref<HTMLInputElement>();
const searchText = ref(String(app.search || ''));
const scrollPositions = reactive<Record<string, number>>({});
const scrollArea = ref<HTMLElement>();
const pluginPageEntries = shallowRef<PluginUiEntry[]>([]);
const pluginRegistryReady = ref(false);
let previousRouteKey = '';
let initialized = false;
let stopPluginRegistryWatch: (() => void) | undefined;

const android = computed(
  () =>
    /Android/i.test(navigator.userAgent) ||
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ && /Android/i.test(navigator.platform)),
);
const androidPortrait = computed(() => android.value && viewport.width < 700 && viewport.height >= viewport.width);
const androidLandscape = computed(() => android.value && !androidPortrait.value);
const desktopCollapsed = computed(
  () => !android.value && (!app.settings.sidebarExpanded || viewport.width < 1100),
);
const readerActive = computed(() => app.route.name === 'reader');
const currentBook = computed(() => app.currentBook);
const routeKey = computed(() => `${app.route.name}:${app.route.id || ''}`);
const pluginRoute = computed(() => {
  const match = /^plugin:([^/]+)\/(.+)$/.exec(app.route.name);
  return match ? { pluginId: match[1], routeId: match[2] } : null;
});
const pluginPageEntry = computed(() => {
  const current = pluginRoute.value;
  if (!current) return null;
  return (
    pluginPageEntries.value.find(
      (entry) =>
        entry.type === 'page' &&
        entry.pluginId === current.pluginId &&
        contributionRouteId(entry) === current.routeId,
    ) || null
  );
});
const pluginPageTitle = computed(() => {
  if (!pluginRegistryReady.value) return '正在加载插件';
  return pluginPageEntry.value?.title || '插件页面';
});
const searchShortcutLabel = computed(() =>
  String(app.settings.shortcuts.search || 'Control+k')
    .replace(/\bControl\b/gi, 'Ctrl')
    .replace(/\bMeta\b/gi, 'Cmd')
    .replace(/\+/g, ' + ')
    .toUpperCase(),
);
const fallback = { template: '<div />' };
const views = {
  home: HomeView,
  bookshelf: LibraryView,
  'book-detail': BookDetailView,
  notebook: NotebookView,
  statistics: StatisticsView,
  me: MeView,
  settings: SettingsView,
  sync: SyncView,
  plugins: PluginsView,
  tags: TagsView,
  'tag-results': TagResultsView,
  search: SearchView,
  import: ImportView,
  conflicts: ConflictsView,
  diagnostics: DiagnosticsView,
} as const;
const currentView = computed(() =>
  pluginRoute.value
    ? PluginSurface
    : views[app.route.name as keyof typeof views] || fallback,
);
const currentViewProps = computed(() =>
  pluginPageEntry.value ? { entry: pluginPageEntry.value } : {},
);
const backAvailable = computed(
  () =>
    app.history.length > 0 &&
    !['home', 'bookshelf', 'notebook', 'statistics', 'me', 'book-detail', 'import'].includes(app.route.name),
);

const syncMeta = computed(() => {
  const status = String(app.syncStatus || '').toLowerCase();
  if (['syncing', 'preparing', 'uploading', 'downloading'].some((value) => status.includes(value))) {
    return { label: '正在同步', icon: CloudCog, tone: 'working' };
  }
  if (status.includes('error') || status.includes('fail') || status.includes('offline')) {
    return { label: '同步失败或离线', icon: CloudOff, tone: 'error' };
  }
  if (status === 'unconfigured' || !app.settings.provider) {
    return { label: '尚未配置同步 Provider', icon: Cloud, tone: 'muted' };
  }
  if (status.includes('success') || status.includes('complete')) {
    return { label: '同步状态正常', icon: CheckCircle2, tone: 'success' };
  }
  if (status === 'idle') {
    return app.syncHistory.some((entry) => entry.status === 'success')
      ? { label: '上次同步成功', icon: CheckCircle2, tone: 'success' }
      : { label: '等待首次同步', icon: Cloud, tone: 'muted' };
  }
  return { label: `同步状态：${app.syncStatus}`, icon: Cloud, tone: 'muted' };
});

watch(
  routeKey,
  (next, previous) => {
    if (previous && scrollArea.value) scrollPositions[previous] = scrollArea.value.scrollTop;
    if (app.route.name !== 'search') searchText.value = '';
    requestAnimationFrame(() => {
      if (scrollArea.value) scrollArea.value.scrollTop = scrollPositions[next] || 0;
    });
    if (app.route.name !== 'reader') document.title = `${routeTitle(app.route.name)} · Granite`;
  },
);

watch(
  () => [app.settings.theme, app.settings.density],
  () => applyAppearance(),
  { immediate: true },
);

function routeTitle(name: string) {
  if (name.startsWith('plugin:')) return pluginPageTitle.value;
  return {
    home: '主页',
    bookshelf: '书架',
    'book-detail': '书籍详情',
    notebook: '笔记',
    statistics: '统计',
    me: '我的',
    settings: '设置',
    sync: '同步与存储',
    plugins: '插件中心',
    tags: '标签管理',
    'tag-results': '标签结果',
    search: '全局搜索',
    import: '导入书籍',
    conflicts: '同步冲突',
    diagnostics: '关于与诊断',
    reader: '阅读',
  }[name] || 'Granite';
}

function contributionRouteId(entry: PluginUiEntry) {
  const colonPrefix = `${entry.pluginId}:`;
  const slashPrefix = `${entry.pluginId}/`;
  if (entry.id.startsWith(colonPrefix)) return entry.id.slice(colonPrefix.length);
  if (entry.id.startsWith(slashPrefix)) return entry.id.slice(slashPrefix.length);
  return entry.id;
}

function effectiveTheme() {
  if (app.settings.theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return app.settings.theme;
}

function applyAppearance() {
  document.documentElement.dataset.theme = effectiveTheme();
  document.documentElement.dataset.density = app.settings.density;
  document.documentElement.dataset.layout = androidPortrait.value ? 'phone' : 'default';
}

function onResize() {
  viewport.width = window.innerWidth;
  viewport.height = window.innerHeight;
  applyAppearance();
}

function submitSearch() {
  const value = searchText.value.trim();
  app.search = value;
  app.navigate('search', value || undefined);
}

function onGlobalKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  const editing =
    target.matches('input, textarea, select, [contenteditable="true"]') ||
    Boolean(target.closest('[contenteditable="true"]'));
  if (
    app.settings.shortcuts.search &&
    matchesShortcut(event, app.settings.shortcuts.search)
  ) {
    event.preventDefault();
    if (app.route.name === 'reader') return;
    searchInput.value?.focus();
    return;
  }
  if (!editing && (event.altKey && event.key === 'ArrowLeft')) {
    event.preventDefault();
    app.back();
    return;
  }
  if (event.key === '/' && !editing && app.route.name !== 'reader') {
    event.preventDefault();
    searchInput.value?.focus();
  }
}

function closeReader() {
  app.endSession();
  app.back();
}

onMounted(async () => {
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('keydown', onGlobalKeydown);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);
  previousRouteKey = routeKey.value;
  if (!initialized && !app.ready) {
    initialized = true;
    await app.init();
  }
  document.title = `${routeTitle(app.route.name)} · Granite`;
  try {
    const manager = await import('./services/plugin-manager');
    const syncEntries = () => {
      pluginPageEntries.value = manager.pluginUiContributions
        .filter((entry) => entry.type === 'page')
        .map((entry) => ({ ...entry }));
    };
    syncEntries();
    stopPluginRegistryWatch = watch(
      () => manager.pluginUiContributions.slice(),
      syncEntries,
      { deep: false },
    );
  } catch (error) {
    app.notify(`插件页面目录读取失败：${String(error)}`);
  } finally {
    pluginRegistryReady.value = true;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  window.removeEventListener('keydown', onGlobalKeydown);
  window.matchMedia?.('(prefers-color-scheme: dark)').removeEventListener('change', applyAppearance);
  stopPluginRegistryWatch?.();
});
</script>

<template>
  <div
    class="app-frame"
    :class="{
      'app-frame--android': android,
      'app-frame--android-portrait': androidPortrait,
      'app-frame--android-landscape': androidLandscape,
      'app-frame--reader': readerActive,
    }"
  >
    <AppSidebar v-if="!android && !readerActive" :collapsed="desktopCollapsed" />
    <AndroidNav v-if="androidLandscape && !readerActive" rail />

    <div v-if="!readerActive" class="app-content-shell">
      <header class="app-utility-bar" :class="{ 'app-utility-bar--android': android }">
        <button
          v-if="backAvailable"
          class="icon-button"
          type="button"
          aria-label="返回上一页"
          title="返回（Alt + ←）"
          @click="app.back()"
        >
          <ArrowLeft :size="18" />
        </button>
        <form class="global-search" role="search" @submit.prevent="submitSearch">
          <Search :size="18" aria-hidden="true" />
          <input
            ref="searchInput"
            v-model="searchText"
            type="search"
            aria-label="全局搜索"
            placeholder="搜索书籍、笔记、标签或内容"
          />
          <span v-if="!android" class="search-shortcut" aria-hidden="true">{{ searchShortcutLabel }}</span>
          <button v-if="searchText" type="button" aria-label="清空搜索" @click="searchText = ''">
            <X :size="15" />
          </button>
        </form>
        <button
          class="sync-indicator"
          :class="[`sync-indicator--${syncMeta.tone}`, { 'is-working': syncMeta.tone === 'working' }]"
          type="button"
          :aria-label="syncMeta.label"
          :title="syncMeta.label"
          @click="app.navigate('sync')"
        >
          <component :is="syncMeta.icon" :size="19" />
        </button>
        <div class="app-header-plugin-slot">
          <PluginSlots slot="app.header.actions" />
        </div>
      </header>

      <main ref="scrollArea" class="app-scroll-area">
        <div class="app-content">
          <Transition name="route" mode="out-in">
            <div
              v-if="pluginRoute && !pluginPageEntry"
              :key="routeKey"
              class="plugin-route-state"
            >
              <div v-if="!pluginRegistryReady" class="loading-spinner" aria-hidden="true"></div>
              <template v-else>
                <AlertCircle :size="28" />
                <h1>这个插件页面当前不可用</h1>
                <p>插件可能未安装、已禁用，或没有注册对应的命名空间页面。</p>
                <button class="button button--secondary" type="button" @click="app.back()">返回上一页</button>
              </template>
            </div>
            <component
              :is="currentView"
              v-else
              :key="routeKey"
              v-bind="currentViewProps"
            />
          </Transition>
        </div>
      </main>

      <AndroidNav v-if="androidPortrait" />
    </div>

    <main v-else class="reader-shell">
      <ReaderView v-if="currentBook" :book="currentBook" @close="closeReader" />
      <div v-else class="reader-missing">
        <AlertCircle :size="28" />
        <h1>无法打开阅读器</h1>
        <p>书籍可能已从书架移除，或尚未同步到当前设备。</p>
        <button class="button button--primary" type="button" @click="app.navigate('bookshelf')">返回书架</button>
      </div>
    </main>

    <div v-if="!app.ready" class="app-loading" aria-live="polite">
      <span class="app-loading__mark">G</span>
      <div>
        <strong>Granite</strong>
        <span>正在恢复本地书库</span>
      </div>
      <span class="loading-spinner"></span>
    </div>

    <div v-if="app.error && app.ready" class="global-error" role="alert">
      <AlertCircle :size="18" />
      <span>{{ app.error }}</span>
      <button type="button" aria-label="重新加载" @click="app.init()"><RefreshCw :size="15" />重试</button>
      <button type="button" aria-label="关闭错误提示" @click="app.error = ''"><X :size="15" /></button>
    </div>

    <Transition name="toast">
      <div v-if="app.toast" class="app-toast" role="status" aria-live="polite">
        <CheckCircle2 :size="17" />
        <span>{{ app.toast }}</span>
        <button type="button" aria-label="关闭提示" @click="app.notify('')"><X :size="15" /></button>
      </div>
    </Transition>
  </div>
</template>

