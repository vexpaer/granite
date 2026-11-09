<script setup lang="ts">
import { computed } from 'vue';
import { CloudOff, LoaderCircle } from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    visible?: boolean;
    format: string;
    progress: number;
    currentLabel: string;
    saveState?: 'saved' | 'pending' | 'saving' | 'error';
    offline?: boolean;
  }>(),
  {
    visible: true,
    saveState: 'saved',
    offline: false,
  },
);

const progressLabel = computed(() => `${Math.round(Math.min(100, Math.max(0, props.progress || 0)))}%`);
const saveLabel = computed(() => ({
  saved: '位置已保存',
  pending: '位置保存中',
  saving: '正在写入 PDF',
  error: 'PDF 写回失败',
})[props.saveState]);
</script>

<template>
  <footer class="reader-status" :class="{ 'reader-status--hidden': !visible }">
    <span class="reader-status__label">{{ currentLabel }}</span>
    <span class="reader-status__progress">{{ progressLabel }}</span>
    <span class="reader-status__format">{{ format.toUpperCase() }}</span>
    <span class="reader-status__save" :data-state="saveState">
      <LoaderCircle v-if="saveState === 'saving'" :size="13" class="reader-status__spin" />
      <CloudOff v-if="offline" :size="13" aria-label="离线" />
      {{ saveLabel }}
    </span>
  </footer>
</template>

<style scoped>
.reader-status {
  position: absolute;
  z-index: 28;
  right: 50%;
  bottom: max(12px, env(safe-area-inset-bottom));
  display: flex;
  max-width: calc(100% - 32px);
  min-height: 29px;
  align-items: center;
  gap: 0.55rem;
  padding: 0.24rem 0.65rem;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 999px;
  color: var(--text-tertiary);
  background: color-mix(in srgb, var(--surface-elevated) 86%, transparent);
  box-shadow: 0 6px 22px -14px rgba(30, 23, 39, 0.36);
  font-size: 0.66rem;
  transform: translateX(50%);
  transition:
    opacity var(--motion-base),
    transform var(--motion-base);
  backdrop-filter: blur(14px);
}

.reader-status--hidden {
  pointer-events: none;
  opacity: 0;
  transform: translate(50%, 10px);
}

.reader-status__label {
  overflow: hidden;
  max-width: min(44vw, 440px);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reader-status__progress,
.reader-status__format {
  font-variant-numeric: tabular-nums;
}

.reader-status__format {
  padding-left: 0.55rem;
  border-left: 1px solid var(--border);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.reader-status__save {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding-left: 0.55rem;
  border-left: 1px solid var(--border);
}

.reader-status__save[data-state='saving'] {
  color: var(--accent-strong);
}

.reader-status__save[data-state='error'] {
  color: var(--danger);
}

.reader-status__spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .reader-status__format,
  .reader-status__save {
    display: none;
  }
}
</style>

