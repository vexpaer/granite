<script setup lang="ts">
import { BarChart3, BookOpen, House, NotebookPen, UserRound } from 'lucide-vue-next';
import { useApp } from '../stores/app';

withDefaults(defineProps<{ rail?: boolean }>(), { rail: false });
const app = useApp();
const items = [
  { route: 'home', label: '主页', icon: House },
  { route: 'bookshelf', label: '书架', icon: BookOpen },
  { route: 'notebook', label: '笔记', icon: NotebookPen },
  { route: 'statistics', label: '统计', icon: BarChart3 },
  { route: 'me', label: '我的', icon: UserRound },
];

function active(route: string) {
  if (route === 'bookshelf' && app.route.name === 'book-detail') return true;
  return app.route.name === route;
}
</script>

<template>
  <nav class="android-nav" :class="{ 'android-nav--rail': rail }" aria-label="Android 主导航">
    <button
      v-for="item in items"
      :key="item.route"
      type="button"
      :class="{ 'is-active': active(item.route) }"
      :aria-current="active(item.route) ? 'page' : undefined"
      @click="app.navigate(item.route)"
    >
      <component :is="item.icon" :size="21" :stroke-width="1.8" aria-hidden="true" />
      <span>{{ item.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.android-nav {
  z-index: 50;
  display: grid;
  height: calc(64px + env(safe-area-inset-bottom));
  grid-template-columns: repeat(5, minmax(0, 1fr));
  padding: 0.35rem 0.35rem env(safe-area-inset-bottom);
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-elevated) 92%, transparent);
  box-shadow: 0 -8px 24px rgba(40, 31, 53, 0.05);
  backdrop-filter: blur(20px) saturate(1.2);
}

.android-nav button {
  display: flex;
  min-width: 0;
  min-height: 52px;
  align-items: center;
  flex-direction: column;
  justify-content: center;
  gap: 0.18rem;
  padding: 0.15rem;
  border: 0;
  border-radius: 12px;
  color: var(--text-secondary);
  background: transparent;
  font-size: 0.68rem;
  font-weight: 620;
}

.android-nav button.is-active {
  color: var(--accent-strong);
  background: color-mix(in srgb, var(--accent-soft) 66%, transparent);
}

.android-nav--rail {
  width: 82px;
  height: auto;
  grid-template-columns: 1fr;
  grid-template-rows: repeat(5, minmax(64px, auto));
  align-content: start;
  padding: max(0.65rem, env(safe-area-inset-top)) 0.4rem 0.65rem;
  border-top: 0;
  border-right: 1px solid var(--border);
  box-shadow: 8px 0 24px rgba(40, 31, 53, 0.04);
}

.android-nav--rail button {
  min-height: 64px;
}
</style>

