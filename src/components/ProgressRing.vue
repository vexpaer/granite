<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    value: number;
    size?: number;
    stroke?: number;
    label?: string;
    tone?: 'accent' | 'success' | 'muted';
  }>(),
  {
    size: 48,
    stroke: 4,
    label: '',
    tone: 'accent',
  },
);

const safeValue = computed(() => Math.min(100, Math.max(0, Number(props.value) || 0)));
const radius = computed(() => (props.size - props.stroke) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
const dashOffset = computed(() => circumference.value * (1 - safeValue.value / 100));
</script>

<template>
  <span
    class="progress-ring"
    :class="`progress-ring--${tone}`"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="label || `完成 ${Math.round(safeValue)}%`"
  >
    <svg :viewBox="`0 0 ${size} ${size}`" aria-hidden="true">
      <circle
        class="progress-ring__track"
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        fill="none"
        :stroke-width="stroke"
      />
      <circle
        class="progress-ring__value"
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        fill="none"
        :stroke-width="stroke"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
    <span v-if="$slots.default" class="progress-ring__content"><slot /></span>
  </span>
</template>

<style scoped>
.progress-ring {
  position: relative;
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
}

svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.progress-ring__track {
  stroke: color-mix(in srgb, var(--border-strong) 72%, transparent);
}

.progress-ring__value {
  stroke: var(--accent);
  stroke-linecap: round;
  transition: stroke-dashoffset var(--motion-slow) var(--ease-out);
}

.progress-ring--success .progress-ring__value {
  stroke: var(--success);
}

.progress-ring--muted .progress-ring__value {
  stroke: var(--text-tertiary);
}

.progress-ring__content {
  position: relative;
  z-index: 1;
  color: inherit;
  font-size: 0.72em;
  font-weight: 700;
  line-height: 1;
}
</style>

