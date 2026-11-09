<script setup lang="ts">
import { Archive, ArrowRight } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    actionLabel?: string;
    secondaryLabel?: string;
    compact?: boolean;
  }>(),
  {
    description: '',
    actionLabel: '',
    secondaryLabel: '',
    compact: false,
  },
);

defineEmits<{
  action: [];
  secondary: [];
}>();
</script>

<template>
  <div class="empty-state" :class="{ 'empty-state--compact': compact }">
    <span class="empty-state__mark" aria-hidden="true">
      <slot name="icon"><Archive :size="24" /></slot>
    </span>
    <div>
      <h3>{{ title }}</h3>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="actionLabel || secondaryLabel || $slots.default" class="empty-state__actions">
      <slot />
      <button
        v-if="actionLabel"
        class="button button--primary"
        type="button"
        @click="$emit('action')"
      >
        {{ actionLabel }}
        <ArrowRight :size="15" aria-hidden="true" />
      </button>
      <button
        v-if="secondaryLabel"
        class="button button--ghost"
        type="button"
        @click="$emit('secondary')"
      >
        {{ secondaryLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: grid;
  min-height: 260px;
  place-items: center;
  align-content: center;
  gap: 1rem;
  padding: 2.5rem;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(circle at 50% 0, color-mix(in srgb, var(--accent-soft) 70%, transparent), transparent 48%),
    color-mix(in srgb, var(--surface) 86%, transparent);
  text-align: center;
}

.empty-state--compact {
  min-height: 160px;
  padding: 1.5rem;
}

.empty-state__mark {
  display: grid;
  width: 56px;
  height: 56px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  border-radius: 18px;
  color: var(--accent);
  background: var(--accent-soft);
}

h3 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.55rem;
  font-weight: 600;
}

p {
  max-width: 42ch;
  margin: 0.4rem auto 0;
  color: var(--text-secondary);
  line-height: 1.7;
}

.empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.6rem;
}
</style>

