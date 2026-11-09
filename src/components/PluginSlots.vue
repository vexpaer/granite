<script setup lang="ts">
import { computed } from 'vue'
import type { PluginPlatform, PluginUiSlot } from '../../packages/core/index'
import { pluginUiForSlot } from '../services/plugin-manager'
import PluginSurface from './PluginSurface.vue'

const props = defineProps<{
  slot: PluginUiSlot
  hostPlatform?: PluginPlatform
}>()

function detectedPlatform(): PluginPlatform | undefined {
  if (typeof navigator === 'undefined') return undefined
  if (/Android/i.test(navigator.userAgent)) return 'android'
  if (/Windows/i.test(navigator.userAgent)) return 'windows'
  return undefined
}

const platform = computed(() => props.hostPlatform ?? detectedPlatform())

const entries = computed(() => {
  const current = platform.value
  return pluginUiForSlot(props.slot).filter((entry) => {
    if (!current) return !entry.platforms?.length && !entry.platformsAllowed?.length
    if (entry.platforms?.length && !entry.platforms.includes(current)) return false
    if (entry.platformsAllowed?.length && !entry.platformsAllowed.includes(current)) return false
    return true
  })
})
</script>

<template>
  <PluginSurface
    v-for="entry in entries"
    :key="entry.id"
    :entry="entry"
  />
  <slot v-if="entries.length === 0" />
</template>
