<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  BarChart3,
  BookOpen,
  ChevronDown,
  House,
  NotebookPen,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import AppAvatarMenu from './AppAvatarMenu.vue';
import PluginSlots from './PluginSlots.vue';

const props = withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false });
const app = useApp();
const libraryOpen = ref(true);

const libraryItems = [
  { id: 'all', label: '全部' },
  { id: 'reading', label: '阅读中' },
  { id: 'unread', label: '未读' },
  { id: 'finished', label: '已读' },
  { id: 'favorite', label: '收藏' },
];

const topRoutes = [
  { route: 'home', label: '主页', icon: House },
  { route: 'bookshelf', label: '书架', icon: BookOpen },
  { route: 'notebook', label: '笔记', icon: NotebookPen },
  { route: 'statistics', label: '统计', icon: BarChart3 },
];

const activeRoute = computed(() => {
  if (app.route.name === 'book-detail') return 'bookshelf';
  if (app.route.name === 'tag-results') return app.history.at(-2)?.name || app.route.name;
  return app.route.name;
});

const activeShelf = computed(() => String(app.shelfFilter || app.route.id || 'all'));
const collapsedFinal = computed(() => props.collapsed);
const sidebarStyle = computed(() => {
  const requested = Number(app.settings.layout?.sidebarWidth);
  const width = Number.isFinite(requested) ? Math.min(320, Math.max(220, requested)) : 256;
  return { '--sidebar-width': `${width}px` };
});

function selectTop(route: string) {
  if (route === 'bookshelf') {
    app.navigate('bookshelf', activeShelf.value === 'collections' ? 'all' : activeShelf.value);
    return;
  }
  app.navigate(route);
}

function selectShelf(id: string) {
  app.navigate('bookshelf', id);
}
</script>

<template>
  <aside class="app-sidebar" :class="{ 'app-sidebar--collapsed': collapsedFinal }" :style="sidebarStyle">
    <div class="app-sidebar__mountain" aria-hidden="true"></div>
    <div class="app-sidebar__wash" aria-hidden="true"></div>
    <div class="app-sidebar__content">
      <button class="brand" type="button" aria-label="前往 Granite 主页" @click="app.navigate('home')">
        <span>Granite</span>
      </button>

      <nav class="primary-nav" aria-label="主导航">
        <template v-for="item in topRoutes" :key="item.route">
          <div class="primary-nav__row">
            <button
              class="primary-nav__item"
              :class="{ 'is-active': activeRoute === item.route }"
              type="button"
              :aria-current="activeRoute === item.route ? 'page' : undefined"
              :aria-label="collapsedFinal ? item.label : undefined"
              @click="selectTop(item.route)"
            >
              <component :is="item.icon" :size="20" :stroke-width="1.7" aria-hidden="true" />
              <span v-if="!collapsedFinal">{{ item.label }}</span>
            </button>
            <button
              v-if="item.route === 'bookshelf' && !collapsedFinal"
              class="primary-nav__toggle"
              type="button"
              :aria-label="libraryOpen ? '收起书架分类' : '展开书架分类'"
              :aria-expanded="libraryOpen"
              @click="libraryOpen = !libraryOpen"
            >
              <ChevronDown :size="16" :class="{ 'is-open': libraryOpen }" />
            </button>
          </div>
          <div
            v-if="item.route === 'bookshelf' && libraryOpen && !collapsedFinal"
            class="primary-nav__sub"
          >
            <button
              v-for="shelf in libraryItems"
              :key="shelf.id"
              type="button"
              :class="{ 'is-active': app.route.name === 'bookshelf' && activeShelf === shelf.id }"
              :aria-current="app.route.name === 'bookshelf' && activeShelf === shelf.id ? 'page' : undefined"
              @click="selectShelf(shelf.id)"
            >
              <span aria-hidden="true"></span>{{ shelf.label }}
            </button>
          </div>
        </template>
      </nav>

      <div class="app-sidebar__plugin-slot">
        <PluginSlots slot="app.sidebar" />
      </div>

      <div class="app-sidebar__spacer"></div>
      <div class="app-sidebar__account">
        <AppAvatarMenu :compact="collapsedFinal" />
      </div>
    </div>
  </aside>
</template>

<style scoped>
.app-sidebar {
  position: relative;
  display: flex;
  width: var(--sidebar-width);
  min-width: 0;
  overflow: hidden;
  flex: 0 0 auto;
  color: var(--sidebar-text);
  background: #726c9c;
  transition:
    width var(--motion-slow) var(--ease-out),
    background var(--motion-base);
}

.app-sidebar--collapsed {
  width: 76px;
}

.app-sidebar__mountain {
  position: absolute;
  inset: 0;
  background-image: url('/assets/mountains.jpg');
  background-position: 18% center;
  background-size: auto 100%;
  filter: saturate(0.72) hue-rotate(4deg);
  opacity: 0.7;
  transform: scale(1.02);
}

.app-sidebar__wash {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(82, 77, 122, 0.58) 0%, rgba(83, 76, 115, 0.34) 45%, rgba(67, 59, 93, 0.55) 100%),
    linear-gradient(90deg, rgba(31, 26, 48, 0.22), transparent 75%);
  backdrop-filter: blur(1.5px);
}

.app-sidebar__content {
  position: relative;
  z-index: 1;
  display: flex;
  min-height: 100%;
  flex: 1;
  flex-direction: column;
  padding: 0.8rem 0.7rem 0.75rem;
}

.brand {
  height: 76px;
  flex: 0 0 auto;
  padding: 0.8rem 0.8rem;
  border: 0;
  color: #fff;
  background: transparent;
  font-family: var(--font-display);
  font-size: 2.15rem;
  font-style: italic;
  font-weight: 600;
  letter-spacing: -0.035em;
  text-align: left;
  text-shadow: 0 2px 14px rgba(30, 23, 50, 0.24);
}

.app-sidebar--collapsed .brand {
  overflow: hidden;
  width: 100%;
  padding-inline: 0;
  font-size: 0;
}

.app-sidebar--collapsed .brand::after {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  margin-inline: auto;
  border: 1px solid rgba(255, 255, 255, 0.42);
  border-radius: 12px;
  content: 'G';
  font-size: 1.7rem;
}

.primary-nav {
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
  margin-top: 1.5rem;
}

.primary-nav__item {
  position: relative;
  display: flex;
  min-width: 0;
  flex: 1;
  height: 42px;
  align-items: center;
  gap: 0.75rem;
  padding: 0 0.75rem;
  border: 1px solid transparent;
  border-radius: 7px;
  color: rgba(255, 255, 255, 0.9);
  background: transparent;
  font-size: 0.96rem;
  font-weight: 580;
  text-align: left;
  transition:
    background var(--motion-fast),
    color var(--motion-fast);
}

.primary-nav__row {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
}

.primary-nav__item:hover {
  background: rgba(255, 255, 255, 0.09);
}

.primary-nav__item.is-active {
  color: #2f2940;
  background: rgba(242, 238, 250, 0.78);
  box-shadow: 0 4px 14px rgba(40, 33, 58, 0.08);
}

.primary-nav__item > span {
  flex: 1;
}

.app-sidebar--collapsed .primary-nav__item {
  justify-content: center;
  padding: 0;
}

.primary-nav__toggle {
  position: absolute;
  right: 0.4rem;
  display: grid;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: currentColor;
  background: transparent;
}

.primary-nav__toggle:hover {
  background: rgba(77, 67, 99, 0.08);
}

.primary-nav__toggle svg {
  transition: transform var(--motion-base);
}

.primary-nav__toggle svg.is-open {
  transform: rotate(180deg);
}

.primary-nav__sub {
  display: grid;
  gap: 0.08rem;
  padding: 0.25rem 0 0.42rem 2.85rem;
}

.primary-nav__sub button {
  display: flex;
  min-height: 34px;
  align-items: center;
  gap: 0.55rem;
  padding: 0 0.65rem;
  border: 0;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.78);
  background: transparent;
  font-size: 0.84rem;
  text-align: left;
}

.primary-nav__sub button:hover,
.primary-nav__sub button.is-active {
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
}

.primary-nav__sub button span {
  width: 4px;
  height: 4px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.72;
}

.app-sidebar__spacer {
  flex: 1;
}

.app-sidebar__plugin-slot {
  display: grid;
  gap: 0.35rem;
  margin-top: 0.7rem;
  color: var(--sidebar-text);
}

.app-sidebar__plugin-slot:empty {
  display: none;
}

.app-sidebar__account {
  padding: 0.35rem;
  border-top: 1px solid rgba(255, 255, 255, 0.14);
}

@media (max-height: 720px) {
  .brand {
    height: 58px;
  }

  .primary-nav {
    margin-top: 0.7rem;
  }
}
</style>

