<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import {
  initializedPlugins,
  type PluginSandboxView,
  type PluginUiEntry,
} from '../services/plugin-manager'

const props = defineProps<{
  entry: PluginUiEntry
}>()

const sandboxHost = ref<HTMLElement>()
let detachSandbox: (() => void) | undefined
let attachedSandbox: PluginSandboxView | undefined

const registeredComponent = computed<Component | undefined>(() =>
  props.entry.trusted && props.entry.component
    ? (props.entry.component as Component)
    : undefined,
)

const initialized = computed(() =>
  initializedPlugins.find((plugin) => plugin.id === props.entry.pluginId),
)

const workerStatus = computed(() => {
  if (initialized.value?.status === 'failed') {
    return props.entry.pluginId + (initialized.value.error ? `: ${initialized.value.error}` : ' 运行失败')
  }
  if (initialized.value?.status === 'active') return `${props.entry.title} · Worker 插件运行中`
  return `${props.entry.title} · Worker 插件未运行`
})

function detachCurrentSandbox(): void {
  detachSandbox?.()
  detachSandbox = undefined
  attachedSandbox = undefined
}

function attachSandbox(): void {
  detachCurrentSandbox()
  const view = props.entry.sandbox
  if (
    registeredComponent.value ||
    view?.kind !== 'iframe' ||
    !view.mount ||
    !sandboxHost.value
  ) {
    return
  }
  attachedSandbox = view
  detachSandbox = view.mount(sandboxHost.value)
}

onMounted(attachSandbox)
watch(
  () => [props.entry.id, props.entry.trusted, props.entry.sandbox] as const,
  attachSandbox,
  { flush: 'post' },
)
onBeforeUnmount(detachCurrentSandbox)
</script>

<template>
  <section
    v-if="registeredComponent"
    class="plugin-surface plugin-surface--trusted"
    :data-plugin-id="entry.pluginId"
    :data-plugin-contribution-id="entry.id"
  >
    <component :is="registeredComponent" v-bind="entry.props ?? {}" />
  </section>

  <section
    v-else-if="entry.sandbox?.kind === 'iframe'"
    ref="sandboxHost"
    class="plugin-surface plugin-surface--iframe"
    :data-plugin-id="entry.pluginId"
    :data-plugin-contribution-id="entry.id"
    :aria-label="`${entry.title} 插件`"
  >
    <p v-if="!entry.sandbox.mount" class="plugin-surface__notice" role="status">
      插件界面当前不可用。
    </p>
  </section>

  <section
    v-else
    class="plugin-surface plugin-surface--worker"
    :data-plugin-id="entry.pluginId"
    :data-plugin-contribution-id="entry.id"
    :aria-label="`${entry.title} 插件`"
  >
    <p class="plugin-surface__notice" role="status">{{ workerStatus }}</p>
  </section>
</template>

<style scoped>
.plugin-surface {
  min-width: 0;
}

.plugin-surface--trusted {
  display: contents;
}

.plugin-surface--iframe {
  min-height: 160px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.plugin-surface--worker {
  padding: 0.75rem 0.9rem;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
}

.plugin-surface__notice {
  margin: 0;
  font-size: 0.83rem;
  line-height: 1.5;
}

.plugin-surface--iframe > .plugin-surface__notice {
  padding: 1rem;
}
</style>
