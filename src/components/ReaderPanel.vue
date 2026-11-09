<script setup lang="ts">
import { X } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    side?: 'left' | 'right';
  }>(),
  { subtitle: '', side: 'right' },
);

defineEmits<{ close: [] }>();
</script>

<template>
  <aside class="reader-panel" :class="`reader-panel--${side}`" aria-modal="false" role="dialog">
    <header class="reader-panel__header">
      <div>
        <h2>{{ title }}</h2>
        <p v-if="subtitle">{{ subtitle }}</p>
      </div>
      <button class="icon-button icon-button--small" type="button" aria-label="关闭面板" @click="$emit('close')">
        <X :size="17" />
      </button>
    </header>
    <div class="reader-panel__body">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="reader-panel__footer">
      <slot name="footer" />
    </footer>
  </aside>
</template>

<style scoped>
.reader-panel {
  position: absolute;
  z-index: 50;
  top: max(78px, calc(env(safe-area-inset-top) + 72px));
  bottom: max(56px, calc(env(safe-area-inset-bottom) + 52px));
  display: grid;
  width: min(370px, calc(100vw - 28px));
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-elevated) 94%, transparent);
  box-shadow: var(--shadow-modal);
  animation: panel-in var(--motion-base) var(--ease-out);
  backdrop-filter: blur(22px) saturate(1.12);
}

.reader-panel--right {
  right: max(14px, env(safe-area-inset-right));
}

.reader-panel--left {
  left: max(14px, env(safe-area-inset-left));
}

.reader-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1rem 0.8rem;
  border-bottom: 1px solid var(--border);
}

.reader-panel__header h2 {
  margin: 0;
  color: var(--text);
  font-size: 0.94rem;
  font-weight: 720;
}

.reader-panel__header p {
  margin: 0.28rem 0 0;
  color: var(--text-tertiary);
  font-size: 0.7rem;
}

.reader-panel__body {
  overflow: auto;
  min-height: 0;
  padding: 0.85rem;
}

.reader-panel__footer {
  padding: 0.7rem 0.85rem;
  border-top: 1px solid var(--border);
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateX(12px) scale(0.985);
  }
}

@media (max-width: 620px) {
  .reader-panel {
    top: auto;
    right: max(8px, env(safe-area-inset-right));
    bottom: max(8px, env(safe-area-inset-bottom));
    left: max(8px, env(safe-area-inset-left));
    width: auto;
    max-height: min(72vh, 640px);
    border-radius: 20px;
  }
}
</style>

