<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  AlertCircle,
  CheckCircle2,
  FilePlus2,
  FolderOpen,
  Import,
  RotateCcw,
  UploadCloud,
  X,
  XCircle,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import ProgressRing from '../components/ProgressRing.vue';
import { fileSize, formatOf } from '../components/utils';

const app = useApp();
const fileInput = ref<HTMLInputElement>();
const files = ref<File[]>([]);
const dragging = ref(false);
const selectedRootId = ref(app.defaultRoot?.id || '');
const localErrors = ref<string[]>([]);

const supported = computed(() => files.value.filter((file) => Boolean(formatOf(file.name)) && file.size > 0));
const unsupported = computed(() => files.value.filter((file) => !formatOf(file.name) || file.size === 0));
const FILE_PREVIEW_LIMIT = 48;
const RESULT_PREVIEW_LIMIT = 48;
const importBusy = computed(() => app.busy && app.route.name === 'import');
const visibleFiles = computed(() => files.value.slice(0, FILE_PREVIEW_LIMIT));
const fileHiddenCount = computed(() => Math.max(0, files.value.length - visibleFiles.value.length));
const resultCounts = computed(() => {
  const counts = { success: 0, duplicate: 0, error: 0, cancelled: 0 };
  for (const result of app.importResults) counts[result.status] += 1;
  return counts;
});
const visibleResults = computed(() => {
  const entries = app.importResults.map((result, index) => ({ result, index }));
  const failures = entries.filter(({ result }) => result.status === 'error').slice(0, RESULT_PREVIEW_LIMIT);
  const recent = entries
    .filter(({ result }) => result.status !== 'error')
    .slice(-Math.max(0, RESULT_PREVIEW_LIMIT - failures.length));
  return [...failures, ...recent];
});
const resultHiddenCount = computed(() => Math.max(0, app.importResults.length - visibleResults.value.length));
const fileByName = computed(() => new Map(files.value.map((file) => [file.name, file])));
const failedFiles = computed(() =>
  app.importResults
    .filter((result) => result.status === 'error')
    .map((result) => fileByName.value.get(result.filename))
    .filter((file): file is File => Boolean(file)),
);

function chooseFiles() {
  if (!selectedRootId.value) return;
  fileInput.value?.click();
}

function addFiles(next: FileList | File[]) {
  const incoming = Array.from(next);
  const merged = new Map(files.value.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]));
  for (const file of incoming) merged.set(`${file.name}:${file.size}:${file.lastModified}`, file);
  files.value = [...merged.values()];
  localErrors.value = [];
}

function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files) addFiles(input.files);
  input.value = '';
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  if (event.dataTransfer?.files) addFiles(event.dataTransfer.files);
}

function removeFile(file: File) {
  files.value = files.value.filter((item) => item !== file);
}

async function selectRoot(id: string) {
  selectedRootId.value = id;
  await setDefaultRoot();
}

async function setDefaultRoot() {
  const root = app.roots.find((item) => item.id === selectedRootId.value);
  if (!root) return;
  await app.updateRoot({ ...root, isDefault: true, enabled: true });
}

async function startImport() {
  localErrors.value = [];
  if (!selectedRootId.value) {
    localErrors.value.push('请先选择导入目标书库。');
    return;
  }
  const root = app.roots.find((item) => item.id === selectedRootId.value);
  if (!root || root.readonly || root.permission !== 'granted') {
    localErrors.value.push('所选书库当前不可写，请重新授权或选择其他书库。');
    return;
  }
  if (root.id !== app.defaultRoot?.id) await setDefaultRoot();
  if (!supported.value.length) {
    localErrors.value.push('没有可以导入的 EPUB、PDF、TXT 或 MOBI 文件。');
    return;
  }
  await app.importFiles(supported.value);
}

async function retryFailed() {
  if (!failedFiles.value.length) return;
  await app.importFiles(failedFiles.value);
}

function statusLabel(status: string) {
  return {
    success: '已导入',
    duplicate: '内容重复，已跳过',
    error: '导入失败',
    cancelled: '已取消',
  }[status] || status;
}
</script>

<template>
  <div class="import-view page-view">
    <PageHeader title="导入书籍" description="先选择本机书库目标，再添加文件。重复内容会保留现有书籍和阅读记录。" back-label="返回书架" @back="app.back()" />

    <div class="import-steps" aria-label="导入步骤">
      <div class="is-active"><span>1</span><strong>选择目标书库</strong></div>
      <div :class="{ 'is-active': selectedRootId }"><span>2</span><strong>添加书籍文件</strong></div>
      <div :class="{ 'is-active': files.length }"><span>3</span><strong>确认导入结果</strong></div>
    </div>

    <section class="surface-card section-card root-picker-card">
      <div class="section-heading">
        <div><h2>导入到</h2><p>目标根目录只写入本机，不会改变其他设备路径。</p></div>
        <button class="button button--secondary button--small" type="button" @click="app.addRoot()">添加文件夹</button>
      </div>
      <div v-if="app.roots.length" class="root-options" role="radiogroup" aria-label="导入目标书库">
        <label
          v-for="root in app.roots"
          :key="root.id"
          :class="{ 'is-active': selectedRootId === root.id, 'is-disabled': root.readonly || root.permission !== 'granted' }"
        >
          <input
            type="radio"
            name="import-root"
            :value="root.id"
            :checked="selectedRootId === root.id"
            :disabled="root.readonly || root.permission !== 'granted'"
            @change="selectRoot(root.id)"
          />
          <span class="root-option__icon"><FolderOpen :size="19" /></span>
          <span class="root-option__copy">
            <strong>{{ root.displayName }}</strong>
            <small>{{ root.path }}</small>
            <span><span class="status-dot" :class="root.permission === 'granted' ? 'status-dot--success' : 'status-dot--danger'"></span>{{ root.permission === 'granted' ? '可写' : root.readonly ? '只读' : '需要重新授权' }}</span>
          </span>
          <span v-if="root.isDefault" class="tag-chip tag-chip--soft">默认</span>
        </label>
      </div>
      <EmptyState
        v-else
        compact
        title="先添加本地书库文件夹"
        description="导入前需要选择一个可写目录。系统原生选择器不会把外部导入来源自动变成书库。"
        action-label="选择书库文件夹"
        @action="app.addRoot()"
      />
    </section>

    <section
      class="drop-zone surface-card"
      :class="{ 'is-dragging': dragging, 'is-disabled': !selectedRootId }"
      @dragenter.prevent="selectedRootId && (dragging = true)"
      @dragover.prevent
      @dragleave.prevent="dragging = false"
      @drop.prevent="selectedRootId && onDrop($event)"
    >
      <UploadCloud :size="31" />
      <h2>{{ selectedRootId ? '拖入书籍，或选择文件' : '请先选择导入目标书库' }}</h2>
      <p>支持 EPUB、PDF、TXT、MOBI；可批量选择混合格式。</p>
      <button class="button button--primary" type="button" :disabled="!selectedRootId" @click="chooseFiles">
        <FilePlus2 :size="16" />选择书籍文件
      </button>
      <input ref="fileInput" class="sr-only" type="file" accept=".epub,.pdf,.txt,.mobi" multiple @change="onFiles" />
    </section>

    <section v-if="files.length" class="surface-card section-card file-review">
      <div class="section-heading">
        <h2>待导入文件</h2>
        <span>{{ supported.length }} 个有效 · {{ unsupported.length }} 个需处理<template v-if="fileHiddenCount"> · 预览 {{ visibleFiles.length }} 个</template></span>
      </div>
      <div class="import-file-list">
        <div v-for="file in visibleFiles" :key="`${file.name}-${file.size}-${file.lastModified}`" class="import-file-row" :class="{ 'has-error': !formatOf(file.name) || !file.size }">
          <span class="file-type">{{ formatOf(file.name)?.toUpperCase() || '?' }}</span>
          <span class="file-copy"><strong>{{ file.name }}</strong><small>{{ fileSize(file.size) }}<template v-if="!formatOf(file.name)"> · 不支持的格式</template></small></span>
          <span v-if="app.books.some((book) => book.title.includes(file.name.replace(/\.[^.]+$/, '')) && book.size === file.size)" class="tag-chip">可能重复</span>
          <button class="icon-button icon-button--small" type="button" aria-label="移除文件" @click="removeFile(file)"><X :size="15" /></button>
        </div>
      </div>
      <p v-if="fileHiddenCount" class="import-list-note">
        已选择 {{ files.length }} 个文件；列表仅预览前 {{ visibleFiles.length }} 个，全部有效文件仍会逐本处理。
      </p>
      <div v-if="localErrors.length" class="import-errors" role="alert">
        <AlertCircle :size="17" />
        <span v-for="error in localErrors" :key="error">{{ error }}</span>
      </div>
      <div class="import-actions">
        <span>目标：<strong>{{ app.roots.find((root) => root.id === selectedRootId)?.displayName || '未选择' }}</strong></span>
        <button class="button button--primary" type="button" :disabled="!supported.length || importBusy" @click="startImport">
          <Import :size="16" />导入 {{ supported.length }} 个文件
        </button>
      </div>
    </section>

    <section v-if="importBusy || app.importResults.length" class="surface-card section-card import-results">
      <div class="section-heading">
        <div>
          <h2>{{ importBusy ? '正在导入' : '导入结果' }}</h2>
          <p v-if="app.importResults.length" class="import-result-summary">
            {{ resultCounts.success }} 成功 · {{ resultCounts.duplicate }} 重复 · {{ resultCounts.error }} 失败
          </p>
        </div>
        <button v-if="importBusy" class="button button--danger button--small" type="button" @click="app.cancelImport = true">取消剩余导入</button>
      </div>
      <div v-if="importBusy" class="import-progress">
        <ProgressRing :value="app.importProgress * 100" :size="90" :stroke="7" :label="`导入进度 ${Math.round(app.importProgress * 100)}%`">
          <strong>{{ Math.round(app.importProgress * 100) }}%</strong>
        </ProgressRing>
        <div><strong>正在解析、校验并写入书籍</strong><p>每个成功文件都会立即保存在目标书库；取消不会删除已经完成的项目。</p></div>
      </div>
      <div v-if="app.importResults.length" class="result-list">
        <div v-for="entry in visibleResults" :key="`${entry.result.filename}-${entry.index}`" class="result-row">
          <CheckCircle2 v-if="entry.result.status === 'success'" :size="17" />
          <RotateCcw v-else-if="entry.result.status === 'duplicate'" :size="17" />
          <XCircle v-else :size="17" />
          <span><strong>{{ entry.result.filename }}</strong><small>{{ entry.result.message || statusLabel(entry.result.status) }}</small></span>
          <button v-if="entry.result.status === 'success' && entry.result.bookId" class="button button--ghost button--small" type="button" @click="app.navigate('book-detail', entry.result.bookId)">查看书籍</button>
        </div>
        <p v-if="resultHiddenCount" class="import-list-note">
          共处理 {{ app.importResults.length }} 项；显示全部失败项与最近处理结果。
        </p>
      </div>
      <div v-if="!importBusy && failedFiles.length" class="retry-row">
        <span>{{ failedFiles.length }} 个文件失败，成功文件不会重复导入。</span>
        <button class="button button--secondary button--small" type="button" @click="retryFailed"><RotateCcw :size="14" />重试失败文件</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.import-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.import-steps {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.6rem;
}

.import-steps div {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.65rem;
  border: 1px solid var(--border);
  border-radius: 11px;
  color: var(--text-tertiary);
  background: var(--surface);
}

.import-steps span {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-muted);
  font-size: 0.75rem;
  font-weight: 720;
}

.import-steps div.is-active {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 25%, var(--border));
}

.import-steps div.is-active span {
  color: var(--accent-contrast);
  background: var(--accent);
}

.import-steps strong {
  font-size: 0.75rem;
}

.section-heading p {
  margin: 0.2rem 0 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.root-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}

.root-options > label {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-elevated);
  cursor: pointer;
}

.root-options > label.is-active {
  border-color: var(--accent);
  background: var(--accent-wash);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 10%, transparent);
}

.root-options > label.is-disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.root-options input {
  accent-color: var(--accent);
}

.root-option__icon {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 10px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.root-option__copy {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}

.root-option__copy strong,
.root-option__copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root-option__copy small {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.root-option__copy > span {
  display: flex;
  align-items: center;
  gap: 0.32rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.drop-zone {
  display: grid;
  min-height: 210px;
  place-items: center;
  align-content: center;
  gap: 0.55rem;
  padding: 1.5rem;
  border: 1px dashed var(--border-strong);
  text-align: center;
  transition:
    border-color var(--motion-fast),
    background var(--motion-fast);
}

.drop-zone > svg {
  color: var(--accent);
}

.drop-zone h2 {
  margin: 0.25rem 0 0;
  font-family: var(--font-display);
  font-size: 1.75rem;
  font-weight: 600;
}

.drop-zone p {
  margin: 0 0 0.5rem;
  color: var(--text-secondary);
}

.drop-zone.is-dragging {
  border-color: var(--accent);
  background: var(--accent-wash);
}

.drop-zone.is-disabled {
  opacity: 0.7;
}

.file-review .section-heading > span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.import-file-list {
  display: grid;
  gap: 0.35rem;
}

.import-file-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 10px;
}

.import-file-row.has-error {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
  background: color-mix(in srgb, var(--danger) 4%, var(--surface-elevated));
}

.file-type {
  display: grid;
  width: 42px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: var(--accent-strong);
  background: var(--accent-soft);
  font-size: 0.75rem;
  font-weight: 750;
}

.file-copy {
  display: grid;
  min-width: 0;
  flex: 1;
}

.file-copy strong,
.file-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-copy strong {
  font-size: 0.75rem;
}

.file-copy small {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.import-errors {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.65rem;
  border-radius: 9px;
  margin-top: 0.7rem;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 0.75rem;
}

.import-errors span + span {
  display: none;
}

.import-actions,
.retry-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--border);
  margin-top: 0.9rem;
}

.import-actions > span,
.retry-row > span {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.import-progress {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem;
  border-radius: 12px;
  background: var(--accent-wash);
}

.import-progress :deep(.progress-ring__content strong) {
  color: var(--text);
  font-size: 0.9rem;
}

.import-progress > div {
  display: grid;
  gap: 0.2rem;
}

.import-progress p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.55;
}

.result-list {
  display: grid;
  gap: 0.25rem;
}

.import-list-note,
.import-result-summary {
  margin: 0.35rem 0 0;
  color: var(--text-tertiary);
  font-size: 0.72rem;
  line-height: 1.45;
}

.import-result-summary {
  margin-top: 0.2rem;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--border);
}

.result-row > svg {
  color: var(--success);
}

.result-row > svg:last-of-type {
  color: var(--danger);
}

.result-row > span {
  display: grid;
  min-width: 0;
  flex: 1;
}

.result-row strong,
.result-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-row strong {
  font-size: 0.75rem;
}

.result-row small {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

@media (max-width: 700px) {
  .root-options {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .import-steps {
    grid-template-columns: 1fr;
  }

  .import-actions,
  .retry-row {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>

