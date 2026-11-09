<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Cloud as CloudBadge,
  Copy,
  FileText,
  HardDrive,
  Layers3,
  RefreshCw,
  ShieldCheck,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import { formatDateTime } from '../components/utils';
import type { Book, Note, Tag, SyncConflict } from '../types';

const app = useApp();
const selectedId = ref(app.conflicts[0]?.id || '');
const resolving = ref<'local' | 'remote' | 'both' | ''>('');
const resolved = ref('');

const selected = computed(
  () => app.conflicts.find((conflict) => conflict.id === selectedId.value) || app.conflicts[0],
);
const selectedIsNote = computed(() =>
  ['note', 'note-conflict'].includes(String(selected.value?.type || '')),
);
const canKeepBoth = computed(() =>
  ['note', 'note-conflict', 'plugin-data'].includes(String(selected.value?.type || '')),
);
const diffRows = computed(() => {
  if (!selected.value) return [];
  const local = asRecord(selected.value.local);
  const remote = asRecord(selected.value.remote);
  const keys = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort();
  return keys
    .filter((key) => canonical(local[key]) !== canonical(remote[key]))
    .map((key) => ({
      key,
      local: displayValue(local[key]),
      remote: displayValue(remote[key]),
    }));
});

watch(
  () => app.conflicts.map((conflict) => conflict.id).join('\u0000'),
  () => {
    if (!app.conflicts.some((conflict) => conflict.id === selectedId.value)) {
      selectedId.value = app.conflicts[0]?.id || '';
    }
  },
);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonical(value: unknown) {
  return JSON.stringify(value ?? null);
}

function displayValue(value: unknown) {
  if (value === undefined) return '未设置';
  if (value === null) return 'null';
  if (typeof value === 'string') return value || '空字符串';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function conflictKind(type: string) {
  return {
    'note-conflict': '笔记并发编辑',
    note: '笔记版本冲突',
    'plugin-data': '插件数据冲突',
    settings: '设置冲突',
  }[type] || type;
}

function entityTitle(conflict: SyncConflict) {
  const local = asRecord(conflict.local);
  const remote = asRecord(conflict.remote);
  const value = local.title || remote.title || local.name || remote.name;
  if (value) return String(value);
  const note = app.notes.find((item) => item.id === conflict.entityId);
  const book = app.books.find((item) => item.id === conflict.entityId);
  const tag = app.tags.find((item) => item.id === conflict.entityId);
  return note?.title || book?.title || tag?.name || conflict.entityId;
}

function canOpenEntity(conflict: SyncConflict) {
  return (
    ['note', 'note-conflict'].includes(conflict.type) &&
    app.notes.some((note) => note.id === conflict.entityId)
  );
}

function openEntity(conflict: SyncConflict) {
  if (canOpenEntity(conflict)) app.navigate('notebook', conflict.entityId);
}

function isNote(value: unknown): value is Note {
  const item = asRecord(value);
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.body === 'string' &&
    typeof item.folder === 'string' &&
    Array.isArray(item.tagIds)
  );
}

function conflictCopyFor(conflict: SyncConflict) {
  const remote = asRecord(conflict.remote);
  return app.notes.find(
    (note) =>
      note.conflictOf === conflict.entityId &&
      note.body === remote.body &&
      (!remote.updatedAt || note.updatedAt === remote.updatedAt),
  );
}

async function removeConflictRecord(conflict: SyncConflict) {
  app.conflicts = app.conflicts.filter((item) => item.id !== conflict.id);
  await app.persist();
}

async function replaceConflictEntity(conflict: SyncConflict, value: unknown) {
  if (conflict.type === 'plugin-data') {
    app.pluginData[conflict.entityId] = JSON.parse(JSON.stringify(value ?? null));
    for (const key of Object.keys(app.pluginData)) {
      if (key.startsWith(`${conflict.entityId}#conflict-${conflict.deviceId}`)) {
        delete app.pluginData[key];
      }
    }
    await app.persist();
    return;
  }

  if (['note', 'note-conflict'].includes(conflict.type)) {
    if (!isNote(value)) throw new Error('冲突中的笔记对象格式不完整，无法安全写回。');
    const copy = conflictCopyFor(conflict);
    await app.saveNote({ ...JSON.parse(JSON.stringify(value)), id: conflict.entityId } as Note);
    if (copy) {
      app.notes = app.notes.filter((note) => note.id !== copy.id);
      await app.persist();
    }
    return;
  }

  const record = asRecord(value);
  if (conflict.type === 'book' && typeof record.id === 'string') {
    await app.saveBook(JSON.parse(JSON.stringify(value)) as Book);
    return;
  }
  if (conflict.type === 'tag' && typeof record.id === 'string') {
    await app.saveTag(JSON.parse(JSON.stringify(value)) as Tag);
    return;
  }
  throw new Error(`暂不支持将 ${conflict.type} 冲突直接写回当前对象。`);
}

async function resolve(choice: 'local' | 'remote' | 'both') {
  const conflict = selected.value;
  if (!conflict || resolving.value) return;
  resolving.value = choice;
  resolved.value = '';
  try {
    if (choice === 'local') {
      await replaceConflictEntity(conflict, conflict.local);
    } else if (choice === 'remote') {
      await replaceConflictEntity(conflict, conflict.remote);
    }
    await removeConflictRecord(conflict);
    resolved.value =
      choice === 'both'
        ? '已保留双方版本，并结束此冲突的待确认状态。'
        : `已采用${choice === 'local' ? '本机' : '远端'}版本，并结束此冲突。`;
    app.notify(resolved.value);
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error);
  } finally {
    resolving.value = '';
  }
}
</script>

<template>
  <div class="conflicts-view page-view">
    <PageHeader
      title="同步冲突"
      description="每个冲突都会并列保留本机与远端版本。只有你明确选择后，Granite 才写入解决结果。"
      back-label="返回同步"
      @back="app.back()"
    >
      <template #actions>
        <button class="button button--secondary" type="button" @click="app.navigate('sync')">
          <RefreshCw :size="16" />返回同步
        </button>
      </template>
    </PageHeader>

    <div v-if="app.conflicts.length" class="conflict-summary surface-card">
      <span class="conflict-summary__icon"><AlertTriangle :size="21" /></span>
      <div>
        <strong>{{ app.conflicts.length }} 个对象等待确认</strong>
        <p>冲突处理是本地操作；选择完成后再同步，才会把解决结果发送到其他设备。</p>
      </div>
      <span class="conflict-summary__safe"><ShieldCheck :size="15" />双方数据仍可恢复</span>
    </div>

    <div v-if="app.conflicts.length && selected" class="conflict-workbench">
      <aside class="conflict-list surface-card" aria-label="冲突列表">
        <h2>待处理</h2>
        <button
          v-for="conflict in app.conflicts"
          :key="conflict.id"
          type="button"
          :class="{ 'is-active': conflict.id === selected.id }"
          :aria-current="conflict.id === selected.id ? 'true' : undefined"
          @click="selectedId = conflict.id"
        >
          <span class="conflict-list__type">
            <FileText v-if="['note', 'note-conflict'].includes(conflict.type)" :size="16" />
            <Layers3 v-else :size="16" />
          </span>
          <span class="conflict-list__copy">
            <strong>{{ entityTitle(conflict) }}</strong>
            <small>{{ conflictKind(conflict.type) }} · {{ conflict.deviceId }}</small>
          </span>
          <ChevronRight :size="15" />
        </button>
      </aside>

      <section class="conflict-review surface-card">
        <header class="conflict-review__header">
          <div>
            <span class="conflict-kind">{{ conflictKind(selected.type) }}</span>
            <h2>{{ entityTitle(selected) }}</h2>
            <p>
              来源设备 <code>{{ selected.deviceId }}</code>
              · {{ formatDateTime(selected.at) }}
            </p>
          </div>
          <button
            v-if="canOpenEntity(selected)"
            class="button button--secondary button--small"
            type="button"
            @click="openEntity(selected)"
          >
            <BookOpen :size="14" />打开当前笔记
          </button>
        </header>

        <div v-if="resolved" class="conflict-resolved" role="status">
          <Check :size="17" />{{ resolved }}
        </div>

        <section class="field-differences">
          <div class="difference-head">
            <span>字段</span>
            <span><HardDrive :size="14" />本机版本</span>
            <span><CloudBadge />远端版本</span>
          </div>
          <div v-for="row in diffRows" :key="row.key" class="difference-row">
            <code>{{ row.key }}</code>
            <pre>{{ row.local }}</pre>
            <pre>{{ row.remote }}</pre>
          </div>
          <div v-if="!diffRows.length" class="difference-empty">
            对象顶层字段没有差异；请对照下方完整版本确认嵌套内容。
          </div>
        </section>

        <section class="version-columns">
          <article>
            <h3><HardDrive :size="15" />本机版本</h3>
            <pre>{{ JSON.stringify(selected.local, null, 2) }}</pre>
          </article>
          <article>
            <h3><CloudBadge />远端版本</h3>
            <pre>{{ JSON.stringify(selected.remote, null, 2) }}</pre>
          </article>
        </section>

        <div class="resolution-actions">
          <div>
            <strong>选择解决方式</strong>
            <p v-if="selectedIsNote">采用一版会保留另一版为恢复副本；保留双方则结束冲突标记并继续保留两篇笔记。</p>
            <p v-else>确认后才会更新对象；此前双方值仍完整保留。</p>
          </div>
          <div class="inline-actions">
            <button class="button button--secondary" type="button" :disabled="Boolean(resolving)" @click="resolve('local')">
              <HardDrive :size="15" />{{ resolving === 'local' ? '正在写入' : '采用本机版本' }}
            </button>
            <button class="button button--secondary" type="button" :disabled="Boolean(resolving)" @click="resolve('remote')">
              <CloudBadge />{{ resolving === 'remote' ? '正在写入' : '采用远端版本' }}
            </button>
            <button v-if="canKeepBoth" class="button button--primary" type="button" :disabled="Boolean(resolving)" @click="resolve('both')">
              <Copy :size="15" />{{ resolving === 'both' ? '正在保留' : '保留双方版本' }}
            </button>
          </div>
        </div>
      </section>
    </div>

    <EmptyState
      v-else
      title="没有待处理冲突"
      description="Granite 会在并发编辑无法安全合并时保留双方版本，并在这里等待你明确选择。"
      action-label="返回同步与存储"
      @action="app.navigate('sync')"
    >
      <template #icon><ShieldCheck :size="25" /></template>
    </EmptyState>

    <section class="conflict-rules surface-card">
      <h2>处理原则</h2>
      <div>
        <article><span>01</span><strong>先保留，再解决</strong><p>同步引擎不会用整对象覆盖另一台设备的并发修改。</p></article>
        <ArrowRight :size="18" />
        <article><span>02</span><strong>由你确认</strong><p>界面展示字段差异、设备来源和两个完整版本。</p></article>
        <ArrowRight :size="18" />
        <article><span>03</span><strong>再次同步</strong><p>解决结果保存在本机，下次同步才传播到其他设备。</p></article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.conflicts-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.conflict-summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.8rem;
  padding: 0.9rem 1rem;
}

.conflict-summary__icon {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 12px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, var(--surface-elevated));
}

.conflict-summary div {
  min-width: 0;
}

.conflict-summary strong {
  font-size: 0.82rem;
}

.conflict-summary p {
  margin: 0.15rem 0 0;
  color: var(--text-secondary);
  font-size: 0.7rem;
}

.conflict-summary__safe {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--success);
  font-size: 0.68rem;
}

.conflict-workbench {
  display: grid;
  grid-template-columns: minmax(220px, 0.34fr) minmax(0, 1fr);
  align-items: start;
  gap: 1rem;
}

.conflict-list {
  position: sticky;
  top: 1rem;
  display: grid;
  gap: 0.2rem;
  padding: 0.55rem;
}

.conflict-list h2 {
  padding: 0.45rem 0.55rem 0.6rem;
  margin: 0;
  font-size: 0.76rem;
}

.conflict-list button {
  display: grid;
  width: 100%;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
  padding: 0.65rem 0.55rem;
  border: 0;
  border-radius: 10px;
  color: var(--text);
  background: transparent;
  text-align: left;
}

.conflict-list button:hover,
.conflict-list button.is-active {
  background: var(--surface-muted);
}

.conflict-list button.is-active {
  box-shadow: inset 2px 0 var(--accent);
}

.conflict-list__type {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.conflict-list__copy {
  display: grid;
  min-width: 0;
  gap: 0.12rem;
}

.conflict-list__copy strong,
.conflict-list__copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conflict-list__copy strong {
  font-size: 0.75rem;
}

.conflict-list__copy small {
  color: var(--text-tertiary);
  font-size: 0.61rem;
}

.conflict-list button > svg {
  color: var(--text-tertiary);
}

.conflict-review {
  overflow: hidden;
}

.conflict-review__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.2rem;
  border-bottom: 1px solid var(--border);
  background:
    radial-gradient(circle at 100% 0, var(--accent-wash), transparent 38%),
    var(--surface);
}

.conflict-kind {
  display: inline-flex;
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, var(--surface-elevated));
  font-size: 0.63rem;
  font-weight: 700;
}

.conflict-review__header h2 {
  margin: 0.45rem 0 0;
  font-family: var(--font-display);
  font-size: 1.7rem;
  font-weight: 600;
}

.conflict-review__header p {
  margin: 0.25rem 0 0;
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.conflict-review__header code {
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

.conflict-resolved {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.7rem 1.2rem;
  color: var(--success);
  background: color-mix(in srgb, var(--success) 8%, var(--surface-elevated));
  font-size: 0.72rem;
}

.field-differences {
  margin: 1.2rem;
  border: 1px solid var(--border);
  border-radius: 13px;
}

.difference-head,
.difference-row {
  display: grid;
  grid-template-columns: minmax(100px, 0.32fr) repeat(2, minmax(0, 1fr));
  gap: 0;
}

.difference-head {
  color: var(--text-secondary);
  background: var(--surface-muted);
  font-size: 0.65rem;
  font-weight: 700;
}

.difference-head > span {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.55rem 0.65rem;
}

.difference-row {
  border-top: 1px solid var(--border);
}

.difference-row > * {
  min-width: 0;
  padding: 0.55rem 0.65rem;
  margin: 0;
  border-left: 1px solid var(--border);
}

.difference-row > :first-child {
  border-left: 0;
}

.difference-row code {
  color: var(--accent-strong);
  background: var(--accent-wash);
  font-family: var(--font-mono);
  font-size: 0.64rem;
}

.difference-row pre {
  overflow: auto;
  max-height: 120px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.64rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.difference-empty {
  padding: 0.8rem;
  color: var(--text-secondary);
  font-size: 0.7rem;
}

.version-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.7rem;
  margin: 0 1.2rem 1.2rem;
}

.version-columns article {
  min-width: 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-elevated);
}

.version-columns h3 {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0 0 0.55rem;
  color: var(--text-secondary);
  font-size: 0.7rem;
}

.version-columns pre {
  overflow: auto;
  max-height: 300px;
  padding: 0.7rem;
  border-radius: 9px;
  margin: 0;
  color: var(--text-secondary);
  background: var(--surface-muted);
  font-family: var(--font-mono);
  font-size: 0.62rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.resolution-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.2rem;
  border-top: 1px solid var(--border);
  background: var(--surface-muted);
}

.resolution-actions > div:first-child {
  max-width: 56ch;
}

.resolution-actions strong {
  font-size: 0.77rem;
}

.resolution-actions p {
  margin: 0.15rem 0 0;
  color: var(--text-secondary);
  font-size: 0.67rem;
  line-height: 1.5;
}

.conflict-rules {
  padding: 1.1rem 1.2rem;
}

.conflict-rules h2 {
  margin: 0 0 0.85rem;
  font-size: 0.8rem;
}

.conflict-rules > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 0.7rem;
}

.conflict-rules article {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.15rem 0.5rem;
}

.conflict-rules article > span {
  grid-row: 1 / 3;
  color: var(--accent);
  font-family: var(--font-display);
  font-size: 1.35rem;
}

.conflict-rules strong {
  font-size: 0.72rem;
}

.conflict-rules p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.66rem;
  line-height: 1.5;
}

.conflict-rules > div > svg {
  color: var(--text-tertiary);
}

@media (max-width: 900px) {
  .conflict-workbench {
    grid-template-columns: 1fr;
  }

  .conflict-list {
    position: static;
  }

  .conflict-list button {
    display: inline-grid;
    width: min(270px, 100%);
    margin-right: 0.35rem;
  }

  .resolution-actions {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (max-width: 650px) {
  .conflict-summary {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .conflict-summary__safe {
    grid-column: 2;
  }

  .conflict-review__header {
    flex-direction: column;
  }

  .difference-head {
    display: none;
  }

  .difference-row {
    grid-template-columns: 1fr;
    padding: 0.55rem;
  }

  .difference-row > * {
    border-left: 0;
  }

  .version-columns {
    grid-template-columns: 1fr;
  }

  .conflict-rules > div {
    grid-template-columns: 1fr;
  }

  .conflict-rules > div > svg {
    display: none;
  }
}
</style>
