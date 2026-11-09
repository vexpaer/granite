<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ChevronDown,
  CircleHelp,
  Cloud,
  Settings2,
  UserRound,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import { isTopOverlay, registerOverlay } from './overlayStack';
import { initials } from './utils';

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const app = useApp();
const open = ref(false);
const root = ref<HTMLElement>();
const username = computed(() => app.settings.username?.trim() || '本地读者');
let overlay: ReturnType<typeof registerOverlay> | undefined;

function go(route: string, id?: string) {
  open.value = false;
  app.navigate(route, id);
}

function onPointerDown(event: PointerEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isTopOverlay(overlay?.token)) {
    event.preventDefault();
    open.value = false;
  }
}

function onSystemBack(event: Event) {
  if (!isTopOverlay(overlay?.token)) return;
  event.preventDefault();
  open.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('granite:back', onSystemBack);
});

watch(open, (isOpen) => {
  overlay?.dispose();
  overlay = isOpen ? registerOverlay() : undefined;
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('granite:back', onSystemBack);
  overlay?.dispose();
});
</script>

<template>
  <div ref="root" class="avatar-menu" :class="{ 'avatar-menu--compact': compact }">
    <button
      class="avatar-menu__trigger"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="avatar-menu__avatar" aria-hidden="true">{{ initials(username) }}</span>
      <span v-if="!compact" class="avatar-menu__name">{{ username }}</span>
      <ChevronDown v-if="!compact" :size="15" :class="{ 'is-open': open }" aria-hidden="true" />
    </button>
    <div v-if="open" class="avatar-menu__popover" role="menu">
      <div v-if="!compact" class="avatar-menu__identity">
        <strong>{{ username }}</strong>
        <span>本地配置</span>
      </div>
      <button type="button" role="menuitem" @click="go('me')">
        <UserRound :size="17" /><span>个人资料</span>
      </button>
      <button type="button" role="menuitem" @click="go('settings')">
        <Settings2 :size="17" /><span>设置</span>
      </button>
      <button type="button" role="menuitem" @click="go('sync')">
        <Cloud :size="17" /><span>同步与存储</span>
      </button>
      <button type="button" role="menuitem" @click="go('diagnostics')">
        <CircleHelp :size="17" /><span>关于与诊断</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.avatar-menu {
  position: relative;
}

.avatar-menu__trigger {
  display: flex;
  width: 100%;
  min-height: 44px;
  align-items: center;
  gap: 0.65rem;
  padding: 0.35rem;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--sidebar-text);
  background: transparent;
  text-align: left;
  transition: background var(--motion-fast);
}

.avatar-menu__trigger:hover,
.avatar-menu__trigger[aria-expanded='true'] {
  background: var(--sidebar-hover);
}

.avatar-menu__avatar {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.55);
  border-radius: 50%;
  color: #433957;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.92), rgba(225, 217, 239, 0.82));
  font-size: 0.75rem;
  font-weight: 760;
  box-shadow: 0 2px 8px rgba(24, 18, 36, 0.16);
}

.avatar-menu__name {
  overflow: hidden;
  flex: 1;
  font-size: 0.86rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.avatar-menu__trigger > svg {
  transition: transform var(--motion-fast);
}

.avatar-menu__trigger > svg.is-open {
  transform: rotate(180deg);
}

.avatar-menu__popover {
  position: absolute;
  z-index: 80;
  right: 0;
  bottom: calc(100% + 0.55rem);
  left: 0;
  overflow: hidden;
  min-width: 215px;
  padding: 0.4rem;
  border: 1px solid var(--border);
  border-radius: 15px;
  background: var(--surface-elevated);
  box-shadow: var(--shadow-float);
  animation: menu-in var(--motion-fast) var(--ease-out);
}

.avatar-menu__identity {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.55rem 0.65rem 0.65rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.3rem;
}

.avatar-menu__identity strong {
  overflow: hidden;
  color: var(--text);
  font-size: 0.85rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.avatar-menu__identity span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.avatar-menu__popover button {
  display: flex;
  width: 100%;
  min-height: 40px;
  align-items: center;
  gap: 0.65rem;
  padding: 0.55rem 0.65rem;
  border: 0;
  border-radius: 9px;
  color: var(--text);
  background: transparent;
  text-align: left;
}

.avatar-menu__popover button:hover,
.avatar-menu__popover button:focus-visible {
  background: var(--surface-muted);
}

.avatar-menu--compact .avatar-menu__trigger {
  justify-content: center;
}

.avatar-menu--compact .avatar-menu__popover {
  right: auto;
  bottom: 0;
  left: calc(100% + 0.6rem);
  width: 215px;
}

@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
</style>

