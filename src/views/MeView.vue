<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ChevronRight,
  Info,
  Cloud,
  FolderOpen,
  LibraryBig,
  Palette,
  PlugZap,
  Settings2,
  Tags,
  UserRound,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import PageHeader from '../components/PageHeader.vue';
import { initials, relativeTime } from '../components/utils';

const app = useApp();
const editingName = ref(false);
const nameDraft = ref(app.settings.username || '读者');
const username = computed(() => app.settings.username?.trim() || '本地读者');
const providerName = computed(() => app.settings.provider?.name || '未配置');
const enabledRoots = computed(() => app.roots.filter((root) => root.enabled));
const enabledPlugins = computed(() => app.plugins.filter((plugin) => plugin.enabled));
const latestSync = computed(() => app.syncHistory[0]);

const groups = computed(() => [
  {
    label: '阅读与内容',
    items: [
      {
        title: '书库文件夹',
        detail: enabledRoots.value.length ? `${enabledRoots.value.length} 个已启用来源 · ${app.defaultRoot?.displayName || '未设默认'}` : '尚未关联书库文件夹',
        icon: FolderOpen,
        route: 'settings',
        id: 'library',
      },
      {
        title: '阅读偏好',
        detail: `${app.settings.reader.fontSize}px · ${app.settings.reader.theme} · ${app.settings.reader.mode === 'scroll' ? '滚动阅读' : '分页阅读'}`,
        icon: LibraryBig,
        route: 'settings',
        id: 'reader',
      },
      {
        title: '标签管理',
        detail: `${app.tags.length} 个标签，跨书籍与笔记共享`,
        icon: Tags,
        route: 'tags',
      },
    ],
  },
  {
    label: '应用与扩展',
    items: [
      {
        title: '同步与存储',
        detail: app.settings.provider ? `${providerName.value} · ${app.syncStatus}` : '配置 WebDAV 或 S3-compatible Provider',
        icon: Cloud,
        route: 'sync',
      },
      {
        title: '插件中心',
        detail: `${app.plugins.length} 个已安装 · ${enabledPlugins.value.length} 个已启用`,
        icon: PlugZap,
        route: 'plugins',
      },
      {
        title: '外观与布局',
        detail: `${app.settings.theme === 'system' ? '跟随系统' : app.settings.theme === 'light' ? '浅色' : '深色'} · ${app.settings.density === 'compact' ? '紧凑' : '舒适'}`,
        icon: Palette,
        route: 'settings',
        id: 'appearance',
      },
      {
        title: '应用设置',
        detail: '快捷键、备份与数据',
        icon: Settings2,
        route: 'settings',
      },
    ],
  },
  {
    label: '信息',
    items: [
      {
        title: '关于 Granite',
        detail: '版本信息与软件更新',
        icon: Info,
        route: 'settings',
        id: 'about',
      },
    ],
  },
]);

async function saveName() {
  const value = nameDraft.value.trim();
  if (!value) return;
  app.settings.username = value;
  await app.saveSettings();
  editingName.value = false;
}

function openItem(route: string, id?: string) {
  app.navigate(route, id);
}
</script>

<template>
  <div class="me-view page-view">
    <PageHeader title="我的" description="本地配置、书库位置、同步、插件与阅读偏好集中在这里。" />

    <section class="profile-card surface-card">
      <div class="profile-card__avatar" aria-hidden="true">{{ initials(username) }}</div>
      <div class="profile-card__identity">
        <template v-if="editingName">
          <form class="profile-card__edit" @submit.prevent="saveName">
            <label class="sr-only" for="profile-name">显示名称</label>
            <input id="profile-name" v-model="nameDraft" class="field" autofocus maxlength="40" />
            <button class="button button--primary button--small" type="submit">保存</button>
            <button class="button button--ghost button--small" type="button" @click="editingName = false">取消</button>
          </form>
        </template>
        <template v-else>
          <h1>{{ username }}</h1>
          <p>本地读者配置，不需要 Granite 官方账户。</p>
        </template>
      </div>
      <button class="button button--secondary" type="button" @click="nameDraft = username; editingName = true">
        <UserRound :size="16" />编辑资料
      </button>
    </section>

    <section class="me-status-grid">
      <button class="surface-card me-status" type="button" @click="app.navigate('settings', 'library')">
        <FolderOpen :size="19" />
        <span><strong>{{ enabledRoots.length }}</strong>个书库来源</span>
        <ChevronRight :size="16" />
      </button>
      <button class="surface-card me-status" type="button" @click="app.navigate('sync')">
        <Cloud :size="19" />
        <span><strong>{{ providerName }}</strong>{{ app.syncStatus }}</span>
        <ChevronRight :size="16" />
      </button>
      <button class="surface-card me-status" type="button" @click="app.navigate('plugins')">
        <PlugZap :size="19" />
        <span><strong>{{ enabledPlugins.length }} / {{ app.plugins.length }}</strong>插件已启用</span>
        <ChevronRight :size="16" />
      </button>
      <button class="surface-card me-status" type="button" @click="app.navigate('sync')">
        <Cloud :size="19" />
        <span><strong>{{ latestSync ? latestSync.status : '无记录' }}</strong>{{ latestSync ? relativeTime(latestSync.at) : '尚未同步' }}</span>
        <ChevronRight :size="16" />
      </button>
    </section>

    <section v-for="group in groups" :key="group.label" class="surface-card me-group">
      <h2>{{ group.label }}</h2>
      <div class="me-group__items">
        <button v-for="item in group.items" :key="item.title" type="button" @click="openItem(item.route, item.id)">
          <span class="me-group__icon"><component :is="item.icon" :size="18" /></span>
          <span class="me-group__copy"><strong>{{ item.title }}</strong><span>{{ item.detail }}</span></span>
          <ChevronRight :size="17" />
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.me-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.profile-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.4rem;
  background:
    radial-gradient(circle at 100% 0, color-mix(in srgb, var(--accent-soft) 82%, transparent), transparent 34%),
    var(--surface);
}

.profile-card__avatar {
  display: grid;
  width: 66px;
  height: 66px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: 50%;
  color: var(--accent-contrast);
  background: linear-gradient(145deg, var(--lavender), var(--accent-strong));
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 600;
  box-shadow: 0 12px 28px -18px rgba(59, 42, 82, 0.6);
}

.profile-card__identity {
  min-width: 0;
  flex: 1;
}

.profile-card h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 2.2rem;
  font-weight: 600;
}

.profile-card p {
  margin: 0.2rem 0 0;
  color: var(--text-secondary);
}

.profile-card__edit {
  display: flex;
  max-width: 520px;
  align-items: center;
  gap: 0.4rem;
}

.me-status-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.7rem;
}

.me-status {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.95rem;
  color: var(--text);
  text-align: left;
}

.me-status > svg:first-child {
  color: var(--accent);
}

.me-status > span {
  display: grid;
  min-width: 0;
  gap: 0.1rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.me-status strong {
  overflow: hidden;
  color: var(--text);
  font-size: 0.8rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.me-group {
  padding: 0.9rem;
}

.me-group h2 {
  margin: 0;
  padding: 0.35rem 0.55rem 0.7rem;
  font-size: 0.76rem;
}

.me-group__items {
  display: grid;
}

.me-group__items button {
  display: flex;
  width: 100%;
  min-height: 60px;
  align-items: center;
  gap: 0.7rem;
  padding: 0.55rem;
  border: 0;
  border-radius: 11px;
  color: var(--text);
  background: transparent;
  text-align: left;
}

.me-group__items button:hover {
  background: var(--surface-muted);
}

.me-group__icon {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 10px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.me-group__copy {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 0.15rem;
}

.me-group__copy strong {
  font-size: 0.8rem;
}

.me-group__copy span {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.me-group__items > button > svg {
  color: var(--text-tertiary);
}

@media (max-width: 800px) {
  .me-status-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 520px) {
  .profile-card {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .profile-card__identity {
    min-width: calc(100% - 82px);
  }

  .profile-card > .button {
    width: 100%;
  }

  .profile-card__edit {
    flex-wrap: wrap;
  }

  .me-status-grid {
    grid-template-columns: 1fr;
  }
}
</style>

