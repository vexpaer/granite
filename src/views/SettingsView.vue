<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  AlertTriangle,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  FolderCog,
  FolderPlus,
  House,
  ImagePlus,
  Keyboard,
  MonitorCog,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
} from 'lucide-vue-next';
import { defaultSettings, useApp } from '../stores/app';
import DialogPanel from '../components/DialogPanel.vue';
import PageHeader from '../components/PageHeader.vue';
import PluginSlots from '../components/PluginSlots.vue';
import ProgressRing from '../components/ProgressRing.vue';
import {
  DEFAULT_HOME_COUNTS,
  DEFAULT_HOME_HIDDEN,
  DEFAULT_HOME_ORDER,
  HOME_MODULES,
  resolveHomeLayout,
  type HomeModuleDefinition,
  type HomeModuleId,
} from '../components/homeLayout';
import { formatDateTime, initials } from '../components/utils';
import type { LibraryRoot } from '../types';

const app = useApp();
const categories = [
  { id: 'general', label: '通用', icon: Settings2 },
  { id: 'appearance', label: '外观与布局', icon: MonitorCog },
  { id: 'library', label: '书库与文件夹', icon: FolderCog },
  { id: 'reader', label: '阅读器', icon: BookOpen },
  { id: 'shortcuts', label: '快捷键与输入', icon: Keyboard },
  { id: 'data', label: '数据与备份', icon: Database },
];
const category = ref(categories.some((item) => item.id === app.route.id) ? String(app.route.id) : 'general');
const draft = ref(JSON.parse(JSON.stringify(app.settings)));
const dirty = ref(false);
const saving = ref(false);
const profileBusy = ref(false);
const savedAt = ref('');
const removeRootTarget = ref<LibraryRoot | null>(null);
const migrationOpen = ref(false);
const migrationRunning = ref(false);
const migrationFrom = ref('');
const migrationTo = ref('');
const migrationCurrent = ref(0);
const migrationTotal = ref(0);
const migrationPhase = ref('');
const migrationPath = ref('');
const backupFile = ref<File | null>(null);
const backupPreview = ref<{ books: number; notes: number; duplicates: number } | null>(null);
const backupPreviewOpen = ref(false);
const migrationResult = ref<{ completed: boolean; message: string } | null>(null);
const backupInput = ref<HTMLInputElement>();
const backgroundInput = ref<HTMLInputElement>();
let suppressDirty = false;
let stopMigrationProgress: (() => void) | undefined;

watch(
  draft,
  () => {
    if (!suppressDirty) dirty.value = true;
  },
  { deep: true },
);

watch(
  () => app.route.id,
  (id) => {
    if (id && categories.some((item) => item.id === id)) category.value = id;
  },
);

const migrationSources = computed(() => app.roots.filter((root) => root.enabled));
const shortcutEntries = computed(() => Object.entries(draft.value.shortcuts || {}));
const disabled = computed(() => saving.value || !dirty.value);
const homeLayout = computed(() => resolveHomeLayout(draft.value.layout || {}));
const configurableHomeModules = computed(() =>
  homeLayout.value.order
    .map((id) => HOME_MODULES.find((module) => module.id === id))
    .filter((module): module is HomeModuleDefinition => Boolean(module)),
);
const fixedHomeModule = HOME_MODULES.find((module) => module.id === 'hero')!;
const sidebarWidth = computed({
  get() {
    const value = Number(draft.value.layout?.sidebarWidth);
    return Number.isFinite(value) ? Math.min(320, Math.max(220, value)) : 256;
  },
  set(value: number) {
    ensureDraftLayout();
    draft.value.layout.sidebarWidth = Math.min(320, Math.max(220, Math.round(value)));
  },
});
const migrationPhaseLabel = computed(() => {
  if (migrationPhase.value === 'verifying') return '正在校验目标副本';
  if (migrationPhase.value === 'cancelled') return '正在停止迁移';
  if (migrationPhase.value === 'completed') return '迁移完成';
  return '正在复制书籍';
});

async function save() {
  saving.value = true;
  try {
    ensureDraftLayout();
    app.settings = JSON.parse(JSON.stringify(draft.value));
    await app.saveSettings();
    dirty.value = false;
    savedAt.value = new Date().toISOString();
  } finally {
    saving.value = false;
  }
}

function ensureDraftLayout() {
  if (!draft.value.layout) draft.value.layout = {};
  const resolved = resolveHomeLayout(draft.value.layout);
  draft.value.layout.homeOrder = [...resolved.order];
  draft.value.layout.homeHidden = [...resolved.hidden];
  draft.value.layout.homeCounts = { ...resolved.counts };
}

function moveHomeModule(id: HomeModuleId, direction: -1 | 1) {
  ensureDraftLayout();
  const order = [...homeLayout.value.order];
  const index = order.indexOf(id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= order.length) return;
  [order[index], order[next]] = [order[next], order[index]];
  draft.value.layout.homeOrder = order;
}

function toggleHomeModule(id: HomeModuleId) {
  ensureDraftLayout();
  const hidden = [...homeLayout.value.hidden];
  const index = hidden.indexOf(id);
  if (index >= 0) hidden.splice(index, 1);
  else hidden.push(id);
  draft.value.layout.homeHidden = hidden;
}

function setHomeModuleCount(module: HomeModuleDefinition, value: number) {
  if (!module.minCount || !module.maxCount) return;
  ensureDraftLayout();
  draft.value.layout.homeCounts = {
    ...homeLayout.value.counts,
    [module.id]: Math.min(module.maxCount, Math.max(module.minCount, Math.round(value))),
  };
}

function resetHomeLayout() {
  ensureDraftLayout();
  draft.value.layout.homeOrder = [...DEFAULT_HOME_ORDER];
  draft.value.layout.homeHidden = [...DEFAULT_HOME_HIDDEN];
  draft.value.layout.homeCounts = { ...DEFAULT_HOME_COUNTS };
}

function homeModuleCountOptions(module: HomeModuleDefinition) {
  if (!module.minCount || !module.maxCount) return [];
  return Array.from(
    { length: module.maxCount - module.minCount + 1 },
    (_, index) => module.minCount! + index,
  );
}

function refreshDraftFromApp() {
  suppressDirty = true;
  draft.value = JSON.parse(JSON.stringify(app.settings));
  dirty.value = false;
  requestAnimationFrame(() => {
    suppressDirty = false;
  });
}

async function saveCurrentProfile() {
  const name = draft.value.profile.trim();
  if (!name) {
    app.error = '请选择或输入配置名称。';
    return;
  }
  profileBusy.value = true;
  try {
    ensureDraftLayout();
    app.settings = JSON.parse(JSON.stringify(draft.value));
    if (dirty.value || !savedAt.value) await app.saveSettings();
    await app.saveProfile(name);
    refreshDraftFromApp();
    savedAt.value = new Date().toISOString();
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error);
  } finally {
    profileBusy.value = false;
  }
}

async function applySelectedProfile() {
  const name = draft.value.profile.trim();
  if (!name) return;
  profileBusy.value = true;
  try {
    if (dirty.value) await save();
    await app.applyProfile(name);
    refreshDraftFromApp();
    savedAt.value = new Date().toISOString();
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error);
  } finally {
    profileBusy.value = false;
  }
}

function resetDefaults() {
  suppressDirty = true;
  draft.value = defaultSettings();
  requestAnimationFrame(() => {
    suppressDirty = false;
    dirty.value = true;
  });
}

function chooseCategory(id: string) {
  category.value = id;
  app.navigate('settings', id);
}

async function onBackgroundFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const data = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
  draft.value.background = data;
}

function clearBackground() {
  draft.value.background = undefined;
}

async function patchRoot(root: LibraryRoot, patch: Partial<LibraryRoot>) {
  await app.updateRoot({ ...root, ...patch });
}

function makeDefault(root: LibraryRoot) {
  void patchRoot(root, { isDefault: true, enabled: true });
}

async function confirmRemoveRoot() {
  if (!removeRootTarget.value) return;
  await app.removeRoot(removeRootTarget.value.id);
  removeRootTarget.value = null;
}

async function migrate() {
  if (!migrationFrom.value || !migrationTo.value || migrationFrom.value === migrationTo.value) return;
  migrationCurrent.value = 0;
  migrationTotal.value = 0;
  migrationPhase.value = '';
  migrationPath.value = '';
  migrationRunning.value = true;
  try {
    const report = (await app.migrateRoot(migrationFrom.value, migrationTo.value)) as {
      completed?: boolean;
      message?: string;
    };
    if (report.completed === true) {
      migrationResult.value = {
        completed: true,
        message: report.message || '迁移副本已校验，源文件夹仍保留。',
      };
      migrationOpen.value = false;
    } else {
      migrationResult.value = {
        completed: false,
        message: report.message || '迁移未完成。源文件夹和原始记录已保留。',
      };
      app.notify(migrationResult.value.message);
    }
  } finally {
    migrationRunning.value = false;
  }
}

function closeMigrationDialog() {
  if (migrationRunning.value) return;
  migrationOpen.value = false;
}

async function startMigrationProgress() {
  if (!app.native || stopMigrationProgress) return;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    stopMigrationProgress = await listen<{
      phase?: string;
      current?: number;
      total?: number;
      relativePath?: string;
    }>('root.migrate-progress', ({ payload }) => {
      migrationPhase.value = payload.phase || '';
      migrationCurrent.value = Math.max(0, Number(payload.current) || 0);
      migrationTotal.value = Math.max(0, Number(payload.total) || 0);
      migrationPath.value = payload.relativePath || '';
    });
  } catch (error) {
    app.notify(`无法读取迁移进度：${error instanceof Error ? error.message : String(error)}`);
  }
}

function stopMigrationProgressListener() {
  stopMigrationProgress?.();
  stopMigrationProgress = undefined;
}

watch([migrationOpen, migrationRunning], ([open, running]) => {
  if (open) void startMigrationProgress();
  else if (!running) stopMigrationProgressListener();
});

function addShortcut() {
  let name = '新快捷键';
  let index = 2;
  while (name in draft.value.shortcuts) name = `新快捷键 ${index++}`;
  draft.value.shortcuts[name] = '';
}

function removeShortcut(name: string) {
  delete draft.value.shortcuts[name];
}

async function exportBackup() {
  await app.exportBackup();
}

async function inspectBackup(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  backupFile.value = file;
  try {
    backupPreview.value = await app.previewBackup(file);
    backupPreviewOpen.value = true;
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (backupInput.value) backupInput.value.value = '';
  }
}

async function restoreBackup() {
  if (!backupFile.value) return;
  await app.importBackup(backupFile.value);
  backupPreviewOpen.value = false;
  backupFile.value = null;
  backupPreview.value = null;
}

onBeforeUnmount(() => {
  stopMigrationProgressListener();
  if (dirty.value) draft.value = JSON.parse(JSON.stringify(app.settings));
});
</script>

<template>
  <div class="settings-view page-view">
    <PageHeader title="设置" description="外观与阅读偏好可同步；书库路径与凭证保留在当前设备。">
      <template #actions>
        <span v-if="savedAt" class="saved-note">已于 {{ new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }} 保存</span>
        <button class="button button--ghost" type="button" @click="resetDefaults"><RotateCcw :size="15" />恢复默认</button>
        <button class="button button--primary" type="button" :disabled="disabled" @click="save">
          <Save :size="16" />{{ saving ? '保存中' : dirty ? '保存设置' : '已保存' }}
        </button>
      </template>
    </PageHeader>

    <div class="settings-layout">
      <nav class="settings-nav surface-card" aria-label="设置分类">
        <button
          v-for="item in categories"
          :key="item.id"
          type="button"
          :class="{ 'is-active': category === item.id }"
          :aria-current="category === item.id ? 'page' : undefined"
          @click="chooseCategory(item.id)"
        >
          <component :is="item.icon" :size="17" /><span>{{ item.label }}</span><ChevronRight :size="14" />
        </button>
        <div class="settings-nav__shortcuts">
          <button type="button" @click="app.navigate('plugins')"><Boxes :size="17" /><span>插件中心</span><ChevronRight :size="14" /></button>
          <button type="button" @click="app.navigate('tags')"><ArchiveRestore :size="17" /><span>标签管理</span><ChevronRight :size="14" /></button>
          <button type="button" @click="app.navigate('sync')"><Database :size="17" /><span>同步与存储</span><ChevronRight :size="14" /></button>
        </div>
      </nav>

      <section class="settings-content surface-card">
        <template v-if="category === 'general'">
          <div class="settings-section-heading"><h2>通用</h2><p>本地资料、语言和阅读行为。</p></div>
          <div class="settings-avatar">
            <span class="settings-avatar__mark">{{ initials(draft.username) }}</span>
            <label class="form-field">
              <span>显示名称</span>
              <input v-model="draft.username" class="field" maxlength="40" />
            </label>
          </div>
          <div class="form-grid settings-form">
            <div class="form-field">
              <span>界面语言</span>
              <div class="read-only-field">简体中文</div>
              <small class="field-hint">首版界面以简体中文提供。</small>
            </div>
            <label class="form-field">
              <span>每日阅读目标（分钟）</span>
              <input v-model.number="draft.dailyGoal" class="field" type="number" min="1" max="1440" />
            </label>
            <label class="form-field">
              <span>空闲暂停阈值（分钟）</span>
              <input v-model.number="draft.idleMinutes" class="field" type="number" min="1" max="120" />
              <small class="field-hint">超过阈值没有输入时，不计入有效阅读时间。</small>
            </label>
            <div class="form-field form-field--full profile-setting">
              <span>工作区 Profile</span>
              <div class="profile-setting__controls">
                <select v-model="draft.profile" class="select" aria-label="选择工作区 Profile">
                  <option value="Minimal">Minimal · 简洁</option>
                  <option value="Research">Research · 研究</option>
                  <option value="Knowledge">Knowledge · 知识</option>
                  <option value="Dashboard">Dashboard · 仪表盘</option>
                  <option value="Custom">Custom · 自定义</option>
                </select>
                <button class="button button--secondary" type="button" :disabled="profileBusy || saving" @click="saveCurrentProfile">
                  <Save :size="15" />{{ profileBusy ? '处理中' : '保存当前配置' }}
                </button>
                <button class="button button--primary" type="button" :disabled="profileBusy || saving" @click="applySelectedProfile">
                  应用 Profile
                </button>
              </div>
              <small class="field-hint">保存会记录当前主题、布局、插件启用状态与阅读器默认宽度；应用时会保留本机同步 Provider 和凭证。</small>
            </div>
          </div>
        </template>

        <template v-else-if="category === 'appearance'">
          <div class="settings-section-heading"><h2>外观与布局</h2><p>应用主题与阅读主题相互独立。</p></div>
          <div class="theme-options" role="radiogroup" aria-label="应用主题">
            <button v-for="theme in [{ id: 'light', label: '浅色', sample: 'light' }, { id: 'dark', label: '深色', sample: 'dark' }, { id: 'system', label: '跟随系统', sample: 'system' }]" :key="theme.id" type="button" role="radio" :aria-checked="draft.theme === theme.id" :class="{ 'is-active': draft.theme === theme.id }" @click="draft.theme = theme.id">
              <span class="theme-swatch" :class="`theme-swatch--${theme.sample}`"><i></i><b></b></span>
              <span>{{ theme.label }}</span>
            </button>
          </div>
          <div class="form-grid settings-form">
            <label class="form-field">
              <span>界面密度</span>
              <select v-model="draft.density" class="select">
                <option value="comfortable">舒适</option>
                <option value="compact">紧凑</option>
              </select>
            </label>
            <div class="form-field">
              <span>侧栏</span>
              <label class="checkbox-line"><input v-model="draft.sidebarExpanded" type="checkbox" />在桌面端默认展开侧栏</label>
            </div>
            <label class="form-field form-field--full sidebar-width-setting">
              <span>桌面侧栏宽度 <strong>{{ sidebarWidth }} px</strong></span>
              <input
                v-model.number="sidebarWidth"
                type="range"
                min="220"
                max="320"
                step="4"
                aria-label="桌面侧栏宽度"
              />
              <small class="field-hint">窄窗口仍会自动收起侧栏，避免挤压正文。</small>
            </label>
          </div>
          <div class="background-setting">
            <div>
              <ImagePlus :size="20" />
              <span><strong>首页背景</strong><small>默认使用 Granite 雪山图；也可选择本地图片。</small></span>
            </div>
            <div class="inline-actions">
              <button class="button button--secondary" type="button" @click="backgroundInput?.click()">选择图片</button>
              <button v-if="draft.background" class="button button--ghost" type="button" @click="clearBackground">恢复默认</button>
            </div>
            <input ref="backgroundInput" class="sr-only" type="file" accept="image/*" @change="onBackgroundFile" />
          </div>
          <div class="profile-preview">
            <strong>{{ draft.profile }}</strong>
            <p>当前配置保存应用主题、布局密度和导航状态。阅读主题在“阅读器”分类中独立设置。</p>
          </div>
          <section class="home-layout-settings" aria-labelledby="home-layout-heading">
            <div class="settings-section-heading settings-section-heading--action">
              <div>
                <h3 id="home-layout-heading">首页模块</h3>
                <p>欢迎区域固定显示；其余六项可调整顺序、显示数量或隐藏。</p>
              </div>
              <button class="button button--ghost button--small" type="button" @click="resetHomeLayout">恢复默认</button>
            </div>
            <div class="home-layout-row home-layout-row--fixed">
              <span class="home-layout-row__icon"><House :size="17" /></span>
              <span class="home-layout-row__copy">
                <strong>{{ fixedHomeModule.label }}</strong>
                <small>{{ fixedHomeModule.description }}</small>
              </span>
              <span class="home-layout-row__fixed">固定显示</span>
            </div>
            <div
              v-for="(module, index) in configurableHomeModules"
              :key="module.id"
              class="home-layout-row"
              :class="{ 'is-hidden': homeLayout.hidden.includes(module.id) }"
            >
              <span class="home-layout-row__index">{{ index + 1 }}</span>
              <span class="home-layout-row__copy">
                <strong>{{ module.label }}</strong>
                <small>{{ module.description }}</small>
              </span>
              <label v-if="module.countLabel" class="home-layout-row__count">
                <span class="sr-only">{{ module.countLabel }}</span>
                <select
                  class="select"
                  :value="homeLayout.counts[module.id]"
                  :disabled="homeLayout.hidden.includes(module.id)"
                  @change="setHomeModuleCount(module, Number(($event.target as HTMLSelectElement).value))"
                >
                  <option v-for="count in homeModuleCountOptions(module)" :key="count" :value="count">{{ count }}</option>
                </select>
              </label>
              <div class="home-layout-row__actions">
                <button class="icon-button icon-button--small" type="button" :aria-label="`上移 ${module.label}`" :disabled="index === 0" @click="moveHomeModule(module.id, -1)">
                  <ArrowUp :size="15" />
                </button>
                <button class="icon-button icon-button--small" type="button" :aria-label="`下移 ${module.label}`" :disabled="index === configurableHomeModules.length - 1" @click="moveHomeModule(module.id, 1)">
                  <ArrowDown :size="15" />
                </button>
                <button class="icon-button icon-button--small" type="button" :aria-label="homeLayout.hidden.includes(module.id) ? `显示 ${module.label}` : `隐藏 ${module.label}`" @click="toggleHomeModule(module.id)">
                  <Eye v-if="homeLayout.hidden.includes(module.id)" :size="15" />
                  <EyeOff v-else :size="15" />
                </button>
              </div>
            </div>
          </section>
        </template>

        <template v-else-if="category === 'library'">
          <div class="settings-section-heading settings-section-heading--action">
            <div><h2>书库与文件夹</h2><p>同一设备可关联多个独立书库根目录；移除关联不会删除磁盘原文件。</p></div>
            <button class="button button--primary" type="button" @click="app.addRoot()"><FolderPlus :size="16" />添加文件夹</button>
          </div>
          <div v-if="app.roots.length" class="root-list">
            <article v-for="root in app.roots" :key="root.id" class="root-card" :class="`root-card--${root.permission}`">
              <div class="root-card__icon"><FolderCog :size="20" /></div>
              <div class="root-card__main">
                <div class="root-card__title">
                  <input
                    :value="root.displayName"
                    :aria-label="`重命名书库 ${root.displayName}`"
                    @change="patchRoot(root, { displayName: ($event.target as HTMLInputElement).value.trim() || root.displayName })"
                  />
                  <span v-if="root.isDefault" class="root-badge">默认导入</span>
                  <span v-if="root.readonly" class="root-badge">只读</span>
                </div>
                <code>{{ root.path }}</code>
                <div class="root-card__status">
                  <span class="status-dot" :class="root.permission === 'granted' ? 'status-dot--success' : root.permission === 'unavailable' ? 'status-dot--danger' : 'status-dot--warning'"></span>
                  <span>{{ root.permission === 'granted' ? '可访问' : root.permission === 'readonly' ? '只读' : root.permission === 'denied' ? '权限被拒绝' : '位置不可访问' }}</span>
                  <span>{{ root.kind.toUpperCase() }}</span>
                  <span v-if="root.lastValidatedAt">校验于 {{ formatDateTime(root.lastValidatedAt) }}</span>
                </div>
              </div>
              <div class="root-card__controls">
                <label class="checkbox-line"><input type="checkbox" :checked="root.enabled" @change="patchRoot(root, { enabled: ($event.target as HTMLInputElement).checked })" />启用扫描</label>
                <label class="checkbox-line"><input type="checkbox" :checked="root.readonly" @change="patchRoot(root, { readonly: ($event.target as HTMLInputElement).checked })" />只读</label>
                <div class="inline-actions">
                  <button v-if="!root.isDefault" class="button button--small button--secondary" type="button" @click="makeDefault(root)">设为默认</button>
                  <button class="button button--small button--secondary" type="button" :disabled="app.busy" @click="app.reauthorizeRoot(root.id)">重新授权</button>
                  <button class="button button--small button--secondary" type="button" :disabled="root.scanState === 'scanning' || root.permission === 'denied' || root.permission === 'unavailable'" @click="app.rescanRoot(root.id)">{{ root.scanState === 'scanning' ? '扫描中' : '重新扫描' }}</button>
                  <button class="icon-button icon-button--small danger" type="button" aria-label="移除文件夹关联" @click="removeRootTarget = root"><Trash2 :size="15" /></button>
                </div>
              </div>
            </article>
          </div>
          <div v-else class="root-empty">
            <FolderCog :size="24" />
            <h3>尚未关联本地书库</h3>
            <p>添加一个可写文件夹后才能导入书籍与备份。</p>
            <button class="button button--primary" type="button" @click="app.addRoot()">选择书库文件夹</button>
          </div>
          <div class="migration-card">
            <div><strong>迁移受管书籍</strong><p>校验目标副本后才完成迁移；源目录始终保留。</p></div>
            <button class="button button--secondary" type="button" :disabled="migrationSources.length < 2" @click="migrationOpen = true">迁移书库</button>
          </div>
          <div
            v-if="migrationResult"
            class="migration-result"
            :class="{ 'migration-result--success': migrationResult.completed }"
            role="status"
          >
            <CheckCircle2 v-if="migrationResult.completed" :size="18" />
            <AlertTriangle v-else :size="18" />
            <span>{{ migrationResult.message }}</span>
          </div>
        </template>

        <template v-else-if="category === 'reader'">
          <div class="settings-section-heading"><h2>阅读器</h2><p>这些值作为新书籍的默认排版；单本覆盖值在阅读器中管理。</p></div>
          <div class="reader-preview" :class="`reader-preview--${draft.reader.theme}`">
            <p :style="{ fontFamily: draft.reader.fontFamily, fontSize: `${Math.min(24, draft.reader.fontSize)}px`, lineHeight: draft.reader.lineHeight }">阅读应当让文字成为空间里唯一清晰的事物。</p>
          </div>
          <div class="form-grid settings-form">
            <label class="form-field">
              <span>字体</span>
              <select v-model="draft.reader.fontFamily" class="select">
                <option value="serif">衬线体</option>
                <option value="sans-serif">无衬线体</option>
                <option value="Georgia">Georgia</option>
                <option value="STSong">宋体</option>
              </select>
            </label>
            <label class="form-field">
              <span>字号</span>
              <input v-model.number="draft.reader.fontSize" class="field" type="number" min="10" max="48" />
            </label>
            <label class="form-field">
              <span>行高</span>
              <input v-model.number="draft.reader.lineHeight" class="field" type="number" min="1" max="3" step="0.1" />
            </label>
            <label class="form-field">
              <span>段间距</span>
              <input v-model.number="draft.reader.paragraphSpacing" class="field" type="number" min="0" max="64" />
            </label>
            <label class="form-field">
              <span>页边距</span>
              <input v-model.number="draft.reader.margin" class="field" type="number" min="8" max="160" />
            </label>
            <label class="form-field">
              <span>阅读宽度</span>
              <input v-model.number="draft.reader.width" class="field" type="number" min="320" max="1600" />
            </label>
            <label class="form-field">
              <span>阅读主题</span>
              <select v-model="draft.reader.theme" class="select">
                <option value="paper">纸张</option>
                <option value="sepia">米色</option>
                <option value="dark">深色</option>
              </select>
            </label>
            <label class="form-field">
              <span>阅读模式</span>
              <select v-model="draft.reader.mode" class="select">
                <option value="scroll">连续滚动</option>
                <option value="paginated">分页</option>
              </select>
            </label>
            <label class="form-field">
              <span>TXT 默认编码</span>
              <select v-model="draft.reader.encoding" class="select">
                <option value="auto">自动检测</option>
                <option value="utf-8">UTF-8</option>
                <option value="gb18030">GB18030</option>
                <option value="utf-16le">UTF-16 LE</option>
              </select>
            </label>
            <label class="checkbox-line"><input v-model="draft.reader.keepAwake" type="checkbox" />阅读时保持屏幕唤醒</label>
          </div>
        </template>

        <template v-else-if="category === 'shortcuts'">
          <div class="settings-section-heading settings-section-heading--action">
            <div><h2>快捷键与输入</h2><p>应用快捷键可修改；系统返回和阅读核心手势具有更高优先级。</p></div>
            <button class="button button--secondary" type="button" @click="addShortcut">添加快捷键</button>
          </div>
          <div class="shortcut-list">
            <div v-for="([name, value]) in shortcutEntries" :key="name" class="shortcut-row">
              <input v-model="draft.shortcuts[name]" class="field" :aria-label="`${name} 快捷键`" placeholder="输入组合键" />
              <span>{{ name }}</span>
              <button class="icon-button icon-button--small danger" type="button" :aria-label="`删除 ${name} 快捷键`" @click="removeShortcut(name)"><Trash2 :size="15" /></button>
            </div>
          </div>
          <div class="reserved-shortcuts">
            <strong>全局输入</strong>
            <span><kbd>{{ draft.shortcuts.search || 'Control+k' }}</kbd> 全局搜索</span>
            <span><kbd>Alt</kbd> + <kbd>←</kbd> 返回上一页</span>
            <span><kbd>Esc</kbd> 关闭最上层对话框或面板</span>
          </div>
        </template>

        <template v-else-if="category === 'data'">
          <div class="settings-section-heading"><h2>数据与备份</h2><p>完整备份包含书籍原文件、Markdown、元数据、标注、会话和插件数据；凭证及本机路径不导出。</p></div>
          <div class="data-actions">
            <article>
              <Database :size="21" />
              <div><strong>导出完整开放备份</strong><p>生成 ZIP 与可独立读取的 Markdown 笔记。</p></div>
              <button class="button button--primary" type="button" :disabled="app.busy" @click="exportBackup">导出备份</button>
            </article>
            <article>
              <ArchiveRestore :size="21" />
              <div><strong>从备份恢复</strong><p>恢复前显示书籍、笔记与重复内容预览；已有内容会保留。</p></div>
              <button class="button button--secondary" type="button" @click="backupInput?.click()">选择备份</button>
              <input ref="backupInput" class="sr-only" type="file" accept=".zip,application/zip" @change="inspectBackup" />
            </article>
          </div>
          <div class="storage-summary">
            <span>当前数据</span>
            <strong>{{ app.books.length }} 本书 · {{ app.notes.length }} 篇笔记 · {{ app.sessions.length }} 个会话</strong>
            <p>应用数据库和设置保存在本机可靠存储；书库原文件由用户选择的根目录管理。</p>
          </div>
        </template>

        <div class="settings-plugin-pages">
          <PluginSlots slot="settings.pages" />
        </div>
      </section>
    </div>

    <DialogPanel
      v-if="removeRootTarget"
      title="移除书库文件夹关联？"
      :description="`将解除“${removeRootTarget.displayName}”与当前设备的访问关系。磁盘文件、云端对象和其他设备记录都会保留。`"
      width="small"
      @close="removeRootTarget = null"
    >
      <div class="danger-note"><Trash2 :size="18" /><span>相关联的不可访问书籍不会触发跨设备删除墓碑。</span></div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="removeRootTarget = null">取消</button>
        <button class="button button--danger" type="button" @click="confirmRemoveRoot">解除关联</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="migrationOpen"
      title="迁移受管书籍"
      description="源目录中的文件会保留。Granite 仅在校验目标副本成功后更新受管书籍的来源。"
      @close="closeMigrationDialog"
    >
      <div class="form-grid">
        <label class="form-field">
          <span>源书库</span>
          <select v-model="migrationFrom" class="select">
            <option value="">选择源书库</option>
            <option v-for="root in migrationSources" :key="root.id" :value="root.id">{{ root.displayName }}</option>
          </select>
        </label>
        <label class="form-field">
          <span>目标书库</span>
          <select v-model="migrationTo" class="select">
            <option value="">选择目标书库</option>
            <option v-for="root in migrationSources" :key="root.id" :value="root.id" :disabled="root.id === migrationFrom">{{ root.displayName }}</option>
          </select>
        </label>
      </div>
      <div v-if="migrationRunning" class="migration-running" role="status" aria-live="polite">
        <ProgressRing v-if="migrationTotal" :value="migrationCurrent / migrationTotal * 100" :size="48" label="书库迁移进度"><span>{{ Math.round(migrationCurrent / migrationTotal * 100) }}%</span></ProgressRing>
        <span v-else class="loading-spinner"></span>
        <div>
          <strong>{{ migrationPhaseLabel }}</strong>
          <p v-if="migrationTotal">
            {{ migrationCurrent }} / {{ migrationTotal }}
            <template v-if="migrationPath"> · {{ migrationPath }}</template>
          </p>
          <p v-else>原书库在确认完成前不会被移除。</p>
        </div>
        <button class="button button--danger button--small" type="button" @click="app.cancelMigration()">取消迁移</button>
      </div>
      <template #footer>
        <button class="button button--ghost" type="button" :disabled="migrationRunning" @click="closeMigrationDialog">关闭</button>
        <button v-if="migrationRunning" class="button button--danger" type="button" @click="app.cancelMigration()">取消迁移</button>
        <button v-else class="button button--primary" type="button" :disabled="!migrationFrom || !migrationTo || migrationFrom === migrationTo" @click="migrate">开始迁移</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="backupPreviewOpen && backupPreview"
      title="确认恢复备份"
      description="恢复会合并备份并保留已有内容；恢复前请核对书籍、笔记与重复项目。"
      @close="backupPreviewOpen = false"
    >
      <div class="backup-preview">
        <div><strong>{{ backupPreview.books }}</strong><span>书籍</span></div>
        <div><strong>{{ backupPreview.notes }}</strong><span>笔记</span></div>
        <div><strong>{{ backupPreview.duplicates }}</strong><span>重复书籍（跳过）</span></div>
      </div>
      <p class="backup-warning">恢复目标：{{ app.defaultRoot?.displayName || '未设置默认书库' }}。原始备份文件不会被修改。</p>
      <template #footer>
        <button class="button button--ghost" type="button" @click="backupPreviewOpen = false">取消</button>
        <button class="button button--primary" type="button" :disabled="!app.defaultRoot || app.busy" @click="restoreBackup">合并恢复</button>
      </template>
    </DialogPanel>
  </div>
</template>

<style scoped>
.settings-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.saved-note {
  align-self: center;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.settings-layout {
  display: grid;
  grid-template-columns: 225px minmax(0, 1fr);
  align-items: start;
  gap: 1rem;
}

.settings-nav {
  position: sticky;
  top: 1rem;
  padding: 0.55rem;
}

.settings-nav button {
  display: flex;
  width: 100%;
  min-height: 40px;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.6rem;
  border: 0;
  border-radius: 8px;
  color: var(--text-secondary);
  background: transparent;
  text-align: left;
}

.settings-nav button:hover,
.settings-nav button.is-active {
  color: var(--text);
  background: var(--surface-muted);
}

.settings-nav button.is-active {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.settings-nav button span {
  flex: 1;
  font-size: 0.76rem;
}

.settings-nav button > svg:last-child {
  opacity: 0.55;
}

.settings-nav__shortcuts {
  padding-top: 0.45rem;
  border-top: 1px solid var(--border);
  margin-top: 0.45rem;
}

.settings-content {
  min-height: 600px;
  padding: clamp(1.2rem, 3vw, 2rem);
}

.settings-plugin-pages {
  display: grid;
  gap: 1rem;
}

.settings-plugin-pages:empty {
  display: none;
}

.settings-section-heading {
  padding-bottom: 1.2rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1.3rem;
}

.settings-section-heading--action {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.settings-section-heading h2,
.settings-section-heading h3 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.9rem;
  font-weight: 600;
}

.settings-section-heading p {
  max-width: 70ch;
  margin: 0.35rem 0 0;
  color: var(--text-secondary);
  line-height: 1.65;
}

.settings-avatar {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.2rem;
}

.settings-avatar__mark {
  display: grid;
  width: 62px;
  height: 62px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  color: var(--accent-contrast);
  background: linear-gradient(145deg, var(--lavender), var(--accent-strong));
  font-family: var(--font-display);
  font-size: 1.35rem;
  font-weight: 600;
}

.settings-avatar .form-field {
  width: min(420px, 100%);
}

.settings-form {
  margin-top: 1.2rem;
}

.read-only-field {
  display: flex;
  min-height: 40px;
  align-items: center;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-secondary);
  background: var(--surface-muted);
}

.profile-setting__controls {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto auto;
  align-items: center;
  gap: 0.55rem;
}

.sidebar-width-setting > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-width-setting > span strong {
  color: var(--accent-strong);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.sidebar-width-setting input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}

.theme-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.7rem;
}

.theme-options > button {
  display: grid;
  gap: 0.55rem;
  padding: 0.65rem;
  border: 1px solid var(--border);
  border-radius: 13px;
  color: var(--text-secondary);
  background: var(--surface-elevated);
  font-size: 0.75rem;
  text-align: left;
}

.theme-options > button.is-active {
  border-color: var(--accent);
  color: var(--accent-strong);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 12%, transparent);
}

.theme-swatch {
  display: grid;
  height: 70px;
  grid-template-columns: 28% 1fr;
  overflow: hidden;
  border: 1px solid rgba(30, 25, 38, 0.12);
  border-radius: 8px;
  background: #f6f4f7;
}

.theme-swatch i {
  background: #746c9e;
}

.theme-swatch b {
  display: block;
  width: 70%;
  height: 45%;
  align-self: center;
  justify-self: center;
  border-radius: 5px;
  background: #fff;
  box-shadow: 0 8px 14px -9px rgba(30, 25, 38, 0.3);
}

.theme-swatch--dark {
  background: #19171e;
}

.theme-swatch--dark b {
  background: #342f3d;
}

.theme-swatch--system {
  background: linear-gradient(90deg, #f6f4f7 50%, #19171e 50%);
}

.theme-swatch--system b {
  background: linear-gradient(90deg, #fff 50%, #342f3d 50%);
}

.background-setting,
.migration-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.9rem;
  border: 1px solid var(--border);
  border-radius: 13px;
  margin-top: 1.2rem;
  background: var(--surface-muted);
}

.background-setting > div:first-child,
.migration-card > div {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.background-setting > div:first-child > span {
  display: grid;
  gap: 0.15rem;
}

.background-setting small,
.migration-card p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.migration-result {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--warning) 28%, var(--border));
  border-radius: 11px;
  margin-top: 0.7rem;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 7%, var(--surface-elevated));
  font-size: 0.75rem;
  line-height: 1.55;
}

.migration-result--success {
  border-color: color-mix(in srgb, var(--success) 28%, var(--border));
  color: var(--success);
  background: color-mix(in srgb, var(--success) 7%, var(--surface-elevated));
}

.migration-running {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 11px;
  margin-top: 1rem;
  color: var(--accent-strong);
  background: var(--accent-wash);
}

.migration-running > div {
  min-width: 0;
  flex: 1;
}

.migration-running strong {
  color: var(--text);
  font-size: 0.75rem;
}

.migration-running p {
  margin: 0.15rem 0 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.profile-preview {
  display: grid;
  gap: 0.25rem;
  padding: 1.2rem;
  border: 1px dashed var(--border-strong);
  border-radius: 14px;
  margin-top: 1rem;
}

.profile-preview strong {
  font-family: var(--font-display);
  font-size: 1.7rem;
  font-weight: 600;
}

.profile-preview p {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.6;
}

.home-layout-settings {
  margin-top: 1.4rem;
}

.home-layout-settings .settings-section-heading {
  margin-bottom: 0.8rem;
}

.home-layout-settings .settings-section-heading h3 {
  font-size: 1.55rem;
}

.home-layout-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.65rem;
  min-height: 64px;
  padding: 0.65rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-elevated);
}

.home-layout-row + .home-layout-row {
  margin-top: 0.45rem;
}

.home-layout-row.is-hidden {
  opacity: 0.62;
  background: var(--surface-muted);
}

.home-layout-row__icon,
.home-layout-row__index {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
  font-family: var(--font-display);
  font-size: 1rem;
}

.home-layout-row__copy {
  display: grid;
  min-width: 0;
  gap: 0.1rem;
}

.home-layout-row__copy strong {
  font-size: 0.82rem;
}

.home-layout-row__copy small {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.home-layout-row__fixed {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.home-layout-row__count .select {
  width: 66px;
  min-height: 34px;
  padding: 0.3rem 0.5rem;
}

.home-layout-row__actions {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}

.root-list {
  display: grid;
  gap: 0.7rem;
}

.root-card {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) minmax(190px, auto);
  gap: 0.8rem;
  padding: 0.9rem;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface-elevated);
}

.root-card--unavailable,
.root-card--denied {
  border-color: color-mix(in srgb, var(--danger) 28%, var(--border));
}

.root-card__icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 12px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.root-card__main {
  display: grid;
  min-width: 0;
  gap: 0.35rem;
}

.root-card__title {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.root-card__title input {
  min-width: 0;
  padding: 0;
  border: 0;
  border-bottom: 1px solid transparent;
  outline: 0;
  color: var(--text);
  background: transparent;
  font-size: 0.88rem;
  font-weight: 680;
}

.root-card__title input:focus {
  border-color: var(--accent);
}

.root-badge {
  padding: 0.15rem 0.4rem;
  border-radius: 999px;
  color: var(--accent-strong);
  background: var(--accent-soft);
  font-size: 0.75rem;
  white-space: nowrap;
}

.root-card code {
  overflow: hidden;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root-card__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.root-card__controls {
  display: grid;
  align-content: center;
  justify-items: end;
  gap: 0.4rem;
}

.root-card__controls .checkbox-line {
  justify-self: end;
  font-size: 0.75rem;
}

.root-empty {
  display: grid;
  min-height: 210px;
  place-items: center;
  align-content: center;
  gap: 0.5rem;
  padding: 1.5rem;
  border: 1px dashed var(--border-strong);
  border-radius: 14px;
  text-align: center;
}

.root-empty h3 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 600;
}

.root-empty p {
  margin: 0 0 0.5rem;
  color: var(--text-secondary);
}

.reader-preview {
  max-width: 720px;
  padding: 1.7rem 2rem;
  border: 1px solid var(--border);
  border-radius: 14px;
  margin-bottom: 1.2rem;
  background: #fffef9;
}

.reader-preview--sepia {
  background: #f0e4ca;
}

.reader-preview--dark {
  color: #dcd7df;
  background: #252328;
}

.reader-preview p {
  margin: 0;
}

.shortcut-list {
  display: grid;
  gap: 0.45rem;
}

.shortcut-row {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.45rem;
  border: 1px solid var(--border);
  border-radius: 10px;
}

.shortcut-row span {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.shortcut-row .field {
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.reserved-shortcuts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem 1rem;
  padding: 1rem;
  border-radius: 12px;
  margin-top: 1.2rem;
  background: var(--surface-muted);
  color: var(--text-secondary);
  font-size: 0.75rem;
}

kbd {
  padding: 0.1rem 0.3rem;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface-elevated);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.data-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.8rem;
}

.data-actions article {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.65rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface-muted);
}

.data-actions article > svg {
  color: var(--accent);
}

.data-actions article div {
  display: grid;
  gap: 0.2rem;
}

.data-actions article p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.55;
}

.data-actions article > .button {
  grid-column: 1 / -1;
  justify-self: end;
}

.storage-summary {
  display: grid;
  gap: 0.25rem;
  padding: 1rem;
  border-radius: 12px;
  margin-top: 1rem;
}

.storage-summary span,
.storage-summary p {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.storage-summary p {
  margin: 0;
}

.danger-note {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.8rem;
  border-radius: 11px;
  color: var(--danger);
  background: var(--danger-soft);
}

.backup-preview {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.7rem;
}

.backup-preview div {
  display: grid;
  gap: 0.15rem;
  padding: 1rem;
  border-radius: 12px;
  background: var(--surface-muted);
}

.backup-preview strong {
  font-family: var(--font-display);
  font-size: 1.8rem;
  font-weight: 600;
}

.backup-preview span,
.backup-warning {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.backup-warning {
  padding: 0.7rem;
  border-left: 2px solid var(--accent);
  margin: 0.8rem 0 0;
  background: var(--accent-wash);
}

@media (max-width: 900px) {
  .settings-layout {
    grid-template-columns: 1fr;
  }

  .settings-nav {
    position: static;
    display: flex;
    overflow-x: auto;
  }

  .settings-nav button {
    width: auto;
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .settings-nav button > svg:last-child {
    display: none;
  }

  .settings-nav__shortcuts {
    display: flex;
    padding: 0 0 0 0.45rem;
    border-top: 0;
    border-left: 1px solid var(--border);
    margin: 0 0 0 0.45rem;
  }

  .root-card {
    grid-template-columns: 42px minmax(0, 1fr);
  }

  .root-card__controls {
    grid-column: 1 / -1;
    justify-items: start;
  }

  .root-card__controls .checkbox-line {
    justify-self: start;
  }
}

@media (max-width: 600px) {
  .settings-content {
    padding: 1rem;
  }

  .settings-section-heading--action {
    align-items: stretch;
    flex-direction: column;
  }

  .theme-options,
  .data-actions {
    grid-template-columns: 1fr;
  }

  .background-setting {
    align-items: flex-start;
    flex-direction: column;
  }

  .settings-avatar {
    align-items: flex-start;
    flex-direction: column;
  }

  .shortcut-row {
    grid-template-columns: 1fr auto;
  }

  .shortcut-row span {
    grid-row: 2;
    grid-column: 1;
  }

  .backup-preview {
    grid-template-columns: 1fr;
  }

  .profile-setting__controls {
    grid-template-columns: 1fr;
  }

  .home-layout-row {
    grid-template-columns: 30px minmax(0, 1fr) auto;
  }

  .home-layout-row__count {
    grid-row: 2;
    grid-column: 2;
  }

  .home-layout-row__actions {
    grid-row: 1 / 3;
    grid-column: 3;
  }
}
</style>

