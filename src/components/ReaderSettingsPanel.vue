<script setup lang="ts">
import { computed, ref } from 'vue';
import { RotateCcw } from 'lucide-vue-next';
import ReaderPanel from './ReaderPanel.vue';
import type { ReaderSettings } from '../types';

type SettingsScope = 'book' | 'global';

const props = withDefaults(
  defineProps<{
    settings: ReaderSettings;
    globalSettings: ReaderSettings;
    bookOverrides?: Partial<ReaderSettings>;
    isTxt?: boolean;
    isPdf?: boolean;
  }>(),
  {
    bookOverrides: () => ({}),
    isTxt: false,
    isPdf: false,
  },
);

const emit = defineEmits<{
  close: [];
  change: [scope: SettingsScope, patch: Partial<ReaderSettings>];
  'reset-book': [];
}>();

const scope = ref<SettingsScope>('book');
const displaySettings = computed(() =>
  scope.value === 'global' ? props.globalSettings : props.settings,
);
const hasOverrides = computed(() => Object.keys(props.bookOverrides || {}).length > 0);

function numberFromEvent(event: Event): number {
  return Number((event.target as HTMLInputElement).value);
}

function stringFromEvent(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value;
}

function set<K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]): void {
  emit('change', scope.value, { [key]: value } as Pick<ReaderSettings, K>);
}
</script>

<template>
  <ReaderPanel title="阅读外观" subtitle="设置会即时预览，本书覆盖不会影响其他书" @close="$emit('close')">
    <div class="reader-settings">
      <div class="reader-settings__scope" role="group" aria-label="设置范围">
        <button
          type="button"
          :class="{ 'is-active': scope === 'book' }"
          @click="scope = 'book'"
        >
          当前书籍
        </button>
        <button
          type="button"
          :class="{ 'is-active': scope === 'global' }"
          @click="scope = 'global'"
        >
          全局默认
        </button>
      </div>

      <p class="reader-settings__hint">
        {{
          scope === 'book'
            ? '只保存到当前书籍。未改动的值继续跟随全局默认。'
            : '作为所有书籍的默认外观，已有本书覆盖仍优先。'
        }}
      </p>

      <template v-if="!isPdf">
        <label class="reader-setting">
          <span><strong>字体</strong><small>{{ displaySettings.fontFamily }}</small></span>
          <select :value="displaySettings.fontFamily" @change="set('fontFamily', stringFromEvent($event))">
            <option value="serif">衬线 / Serif</option>
            <option value="sans-serif">无衬线 / Sans</option>
            <option value="monospace">等宽 / Mono</option>
            <option value="'Noto Serif CJK SC', 'Songti SC', STSong, serif">宋体 / CJK Serif</option>
            <option value="'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif">黑体 / CJK Sans</option>
          </select>
        </label>

        <label class="reader-setting reader-setting--range">
          <span><strong>字号</strong><small>{{ displaySettings.fontSize }} px</small></span>
          <input
            type="range"
            min="13"
            max="38"
            step="1"
            :value="displaySettings.fontSize"
            @input="set('fontSize', numberFromEvent($event))"
          />
        </label>

        <label class="reader-setting reader-setting--range">
          <span><strong>行距</strong><small>{{ displaySettings.lineHeight.toFixed(2) }}</small></span>
          <input
            type="range"
            min="1.2"
            max="2.5"
            step="0.05"
            :value="displaySettings.lineHeight"
            @input="set('lineHeight', numberFromEvent($event))"
          />
        </label>

        <label class="reader-setting reader-setting--range">
          <span><strong>段距</strong><small>{{ displaySettings.paragraphSpacing }} px</small></span>
          <input
            type="range"
            min="0"
            max="44"
            step="1"
            :value="displaySettings.paragraphSpacing"
            @input="set('paragraphSpacing', numberFromEvent($event))"
          />
        </label>

        <label class="reader-setting reader-setting--range">
          <span><strong>左右边距</strong><small>{{ displaySettings.margin }} px</small></span>
          <input
            type="range"
            min="12"
            max="100"
            step="2"
            :value="displaySettings.margin"
            @input="set('margin', numberFromEvent($event))"
          />
        </label>

        <label class="reader-setting reader-setting--range">
          <span><strong>阅读宽度</strong><small>{{ displaySettings.width }} px</small></span>
          <input
            type="range"
            min="480"
            max="1080"
            step="20"
            :value="displaySettings.width"
            @input="set('width', numberFromEvent($event))"
          />
        </label>

        <div class="reader-setting">
          <span><strong>纸张主题</strong><small>PDF 始终保留原文档颜色</small></span>
          <div class="reader-settings__themes" role="group" aria-label="纸张主题">
            <button
              v-for="theme in (['paper', 'sepia', 'dark'] as const)"
              :key="theme"
              type="button"
              class="reader-settings__theme"
              :class="[`is-${theme}`, { 'is-active': displaySettings.theme === theme }]"
              @click="set('theme', theme)"
            >
              {{ { paper: '纸白', sepia: '米黄', dark: '夜读' }[theme] }}
            </button>
          </div>
        </div>

        <div class="reader-setting">
          <span><strong>阅读方式</strong><small>分页按章节组织，滚动保持连续</small></span>
          <div class="reader-settings__segmented" role="group" aria-label="阅读方式">
            <button
              type="button"
              :class="{ 'is-active': displaySettings.mode === 'scroll' }"
              @click="set('mode', 'scroll')"
            >
              连续滚动
            </button>
            <button
              type="button"
              :class="{ 'is-active': displaySettings.mode === 'paginated' }"
              @click="set('mode', 'paginated')"
            >
              分页阅读
            </button>
          </div>
        </div>

        <label v-if="isTxt" class="reader-setting">
          <span><strong>文字编码</strong><small>自动检测失败时可手动选择</small></span>
          <select :value="displaySettings.encoding" @change="set('encoding', stringFromEvent($event))">
            <option value="auto">自动检测</option>
            <option value="utf-8">UTF-8</option>
            <option value="utf-16le">UTF-16 LE</option>
            <option value="utf-16be">UTF-16 BE</option>
            <option value="gb18030">GB18030 / 简体中文</option>
            <option value="big5">Big5 / 繁体中文</option>
            <option value="shift_jis">Shift-JIS / 日文</option>
            <option value="windows-1252">Windows-1252</option>
          </select>
        </label>

        <label class="reader-setting reader-setting--range">
          <span><strong>滚轮翻页阈值</strong><small>{{ displaySettings.wheelThreshold }}</small></span>
          <input
            type="range"
            min="20"
            max="240"
            step="10"
            :value="displaySettings.wheelThreshold"
            @input="set('wheelThreshold', numberFromEvent($event))"
          />
        </label>
      </template>

      <div v-else class="reader-settings__pdf-note">
        PDF 使用原始页面、文本层和自由缩放画布。纸色、字体与重排设置不适用于 PDF。
      </div>

      <label class="reader-setting reader-setting--toggle">
        <span><strong>屏幕常亮</strong><small>阅读时在系统允许的情况下保持唤醒</small></span>
        <input
          type="checkbox"
          :checked="displaySettings.keepAwake"
          @change="set('keepAwake', ($event.target as HTMLInputElement).checked)"
        />
      </label>
    </div>

    <template #footer>
      <button
        class="button button--secondary button--small button--wide"
        type="button"
        :disabled="!hasOverrides"
        @click="$emit('reset-book')"
      >
        <RotateCcw :size="15" />
        恢复当前书籍的默认值
      </button>
    </template>
  </ReaderPanel>
</template>

<style scoped>
.reader-settings {
  display: grid;
  gap: 1rem;
}

.reader-settings__scope,
.reader-settings__segmented {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.2rem;
  padding: 0.2rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-muted);
}

.reader-settings__scope button,
.reader-settings__segmented button {
  min-height: 32px;
  padding: 0.3rem 0.55rem;
  border: 0;
  border-radius: 7px;
  color: var(--text-secondary);
  background: transparent;
  font-size: 0.72rem;
  font-weight: 640;
}

.reader-settings__scope button.is-active,
.reader-settings__segmented button.is-active {
  color: var(--accent-strong);
  background: var(--surface-elevated);
  box-shadow: 0 2px 8px rgba(43, 35, 56, 0.08);
}

.reader-settings__hint {
  margin: -0.55rem 0 0;
  color: var(--text-tertiary);
  font-size: 0.67rem;
  line-height: 1.5;
}

.reader-setting {
  display: grid;
  gap: 0.55rem;
  padding-bottom: 0.82rem;
  border-bottom: 1px solid var(--border);
}

.reader-setting:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.reader-setting > span {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.8rem;
}

.reader-setting strong {
  color: var(--text-secondary);
  font-size: 0.73rem;
  font-weight: 680;
}

.reader-setting small {
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 0.65rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reader-setting select {
  width: 100%;
  min-height: 38px;
  padding: 0.3rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: 0;
  color: var(--text);
  background: var(--surface-elevated);
  font-size: 0.72rem;
}

.reader-setting input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}

.reader-setting--toggle {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.reader-setting--toggle > span {
  display: grid;
  justify-content: initial;
  gap: 0.18rem;
}

.reader-setting--toggle input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}

.reader-settings__themes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.4rem;
}

.reader-settings__theme {
  min-height: 54px;
  padding: 0.35rem;
  border: 2px solid transparent;
  border-radius: 9px;
  font-size: 0.67rem;
  font-weight: 650;
}

.reader-settings__theme.is-paper {
  color: #27231f;
  background: #fbfaf6;
}

.reader-settings__theme.is-sepia {
  color: #3d3020;
  background: #f4e7c9;
}

.reader-settings__theme.is-dark {
  color: #e8e4dc;
  background: #222326;
}

.reader-settings__theme.is-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--surface-elevated);
}

.reader-settings__pdf-note {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-secondary);
  background: var(--surface-muted);
  font-size: 0.72rem;
  line-height: 1.6;
}
</style>
