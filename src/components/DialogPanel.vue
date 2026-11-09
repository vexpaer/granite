<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from 'lucide-vue-next';
import { isTopOverlay, registerOverlay } from './overlayStack';

const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    width?: 'small' | 'medium' | 'large';
  }>(),
  { description: '', width: 'medium' },
);

const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
let previousFocus: HTMLElement | null = null;
let overlay: ReturnType<typeof registerOverlay> | undefined;

function onKeydown(event: KeyboardEvent) {
  if (!isTopOverlay(overlay?.token)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key !== 'Tab' || !panel.value) return;
  const focusable = Array.from(
    panel.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function onSystemBack(event: Event) {
  if (!isTopOverlay(overlay?.token)) return;
  event.preventDefault();
  emit('close');
}

onMounted(async () => {
  overlay = registerOverlay();
  previousFocus = document.activeElement as HTMLElement | null;
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('granite:back', onSystemBack);
  await nextTick();
  panel.value?.querySelector<HTMLElement>('[autofocus], button, input, select, textarea')?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('granite:back', onSystemBack);
  overlay?.dispose();
  previousFocus?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="dialog-backdrop" role="presentation" @mousedown.self="$emit('close')">
      <section
        ref="panel"
        class="dialog-panel"
        :class="`dialog-panel--${width}`"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="`dialog-title-${title}`"
      >
        <header class="dialog-panel__header">
          <div>
            <h2 :id="`dialog-title-${title}`">{{ title }}</h2>
            <p v-if="description">{{ description }}</p>
          </div>
          <button class="icon-button" type="button" aria-label="关闭对话框" @click="$emit('close')">
            <X :size="18" />
          </button>
        </header>
        <div class="dialog-panel__body"><slot /></div>
        <footer v-if="$slots.footer" class="dialog-panel__footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  overflow: auto;
  padding: min(8vh, 5rem) 1rem;
  place-items: start center;
  background: rgba(22, 18, 31, 0.38);
  backdrop-filter: blur(10px);
}

.dialog-panel {
  width: min(100%, 620px);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: var(--surface-elevated);
  box-shadow: var(--shadow-modal);
  animation: dialog-in var(--motion-base) var(--ease-out);
}

.dialog-panel--small {
  width: min(100%, 430px);
}

.dialog-panel--large {
  width: min(100%, 900px);
}

.dialog-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.4rem 1.5rem 1rem;
}

.dialog-panel__header h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.65rem;
  font-weight: 600;
}

.dialog-panel__header p {
  margin: 0.35rem 0 0;
  color: var(--text-secondary);
  line-height: 1.55;
}

.dialog-panel__body {
  padding: 0.5rem 1.5rem 1.5rem;
}

.dialog-panel__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--border);
  background: var(--surface-muted);
}

@keyframes dialog-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.985);
  }
}
</style>

