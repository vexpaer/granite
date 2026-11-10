<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    title: string;
    eyebrow?: string;
    description?: string;
    backLabel?: string;
  }>(),
  { eyebrow: '', description: '', backLabel: '' },
);

defineEmits<{ back: [] }>();
</script>

<template>
  <header class="page-header">
    <button
      v-if="backLabel"
      class="icon-button page-header__back"
      type="button"
      :aria-label="backLabel"
      @click="$emit('back')"
    >
      <ArrowLeft :size="19" />
    </button>
    <div class="page-header__copy">
      <span v-if="eyebrow" class="eyebrow">{{ eyebrow }}</span>
      <h1 v-if="title">{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="page-header__actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  gap: 0.9rem;
}

.page-header__copy {
  min-width: 0;
}

.page-header__copy h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(2rem, 4vw, 3rem);
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1;
}

.page-header__copy p {
  max-width: 68ch;
  margin: 0.55rem 0 0;
  color: var(--text-secondary);
  line-height: 1.65;
}

.page-header__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-left: auto;
}

.page-header__back {
  margin-bottom: 0.15rem;
}

@media (max-width: 620px) {
  .page-header {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .page-header__actions {
    width: 100%;
    justify-content: flex-start;
    margin-left: 0;
  }
}
</style>

