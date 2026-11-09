<script setup lang="ts">
import { computed, ref } from 'vue';
import { Combine, Edit3, Pin, Plus, Search, Tag as TagIcon, Trash2 } from 'lucide-vue-next';
import { useApp } from '../stores/app';
import DialogPanel from '../components/DialogPanel.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import { formatDate } from '../components/utils';
import type { Tag } from '../types';

const app = useApp();
const query = ref('');
const sort = ref<'name' | 'usage' | 'recent'>('usage');
const editorOpen = ref(false);
const deleteOpen = ref(false);
const mergeOpen = ref(false);
const editing = ref<Tag | null>(null);
const deleting = ref<Tag | null>(null);
const mergeSource = ref('');
const mergeTarget = ref('');
const form = ref({
  name: '',
  color: '#8067ce',
  pinned: false,
});

const palette = ['#8067ce', '#9f82d9', '#bd8ea9', '#879c91', '#b68864', '#7c8db3', '#ab7d89', '#718f9f'];

const rows = computed(() => {
  const value = query.value.trim().toLocaleLowerCase('zh-CN');
  return [...app.tags]
    .filter((tag) => !value || tag.name.toLocaleLowerCase('zh-CN').includes(value))
    .map((tag) => ({
      tag,
      books: app.books.filter((book) => book.tagIds.includes(tag.id)).length,
      notes: app.notes.filter((note) => note.tagIds.includes(tag.id)).length,
    }))
    .sort((a, b) => {
      if (sort.value === 'name') return a.tag.name.localeCompare(b.tag.name, 'zh-CN');
      if (sort.value === 'recent') return Date.parse(b.tag.updatedAt) - Date.parse(a.tag.updatedAt);
      return Number(b.tag.pinned) - Number(a.tag.pinned) || b.books + b.notes - a.books - a.notes;
    });
});

function openCreate() {
  editing.value = null;
  form.value = { name: '', color: palette[app.tags.length % palette.length], pinned: false };
  editorOpen.value = true;
}

function openEdit(tag: Tag) {
  editing.value = tag;
  form.value = { name: tag.name, color: tag.color, pinned: tag.pinned };
  editorOpen.value = true;
}

async function save() {
  const now = new Date().toISOString();
  const tag: Tag = editing.value
    ? { ...editing.value, ...form.value, name: form.value.name.trim(), updatedAt: now }
    : {
        id: crypto.randomUUID(),
        ...form.value,
        name: form.value.name.trim(),
        createdAt: now,
        updatedAt: now,
      };
  if (!tag.name) return;
  await app.saveTag(tag);
  editorOpen.value = false;
}

async function togglePin(tag: Tag) {
  await app.saveTag({ ...tag, pinned: !tag.pinned });
}

function requestDelete(tag: Tag) {
  deleting.value = tag;
  deleteOpen.value = true;
}

async function confirmDelete() {
  if (!deleting.value) return;
  await app.deleteTag(deleting.value.id);
  deleteOpen.value = false;
}

function openMerge(tag: Tag) {
  mergeSource.value = tag.id;
  mergeTarget.value = '';
  mergeOpen.value = true;
}

function pinIf(tag: Tag) {
  return tag.pinned ? '置顶 · ' : '';
}

async function confirmMerge() {
  if (!mergeSource.value || !mergeTarget.value) return;
  await app.mergeTags(mergeSource.value, mergeTarget.value);
  mergeOpen.value = false;
}
</script>

<template>
  <div class="tags-view page-view">
    <PageHeader title="标签管理" description="标签同时关联书籍与笔记；删除标签不会删除任何对象。">
      <template #actions>
        <button class="button button--primary" type="button" @click="openCreate"><Plus :size="16" />新建标签</button>
      </template>
    </PageHeader>

    <section class="tag-toolbar surface-card">
      <label>
        <Search :size="16" />
        <span class="sr-only">搜索标签</span>
        <input v-model="query" type="search" placeholder="搜索标签" />
      </label>
      <select v-model="sort" class="select" aria-label="标签排序">
        <option value="usage">使用频率</option>
        <option value="recent">最近更新</option>
        <option value="name">名称</option>
      </select>
    </section>

    <section v-if="rows.length" class="tag-table surface-card">
      <div class="tag-table__head">
        <span>标签</span><span>关联书籍</span><span>关联笔记</span><span>最近更新</span><span>操作</span>
      </div>
      <article v-for="{ tag, books, notes } in rows" :key="tag.id" class="tag-row">
        <button class="tag-row__identity" type="button" @click="app.navigate('tag-results', tag.id)">
          <span class="tag-row__color" :style="{ background: tag.color }"></span>
          <span><strong>{{ pinIf(tag) }}{{ tag.name }}</strong><small>{{ tag.id.slice(0, 8) }}</small></span>
        </button>
        <button type="button" @click="app.navigate('tag-results', tag.id)">{{ books }}</button>
        <button type="button" @click="app.navigate('tag-results', tag.id)">{{ notes }}</button>
        <span>{{ formatDate(tag.updatedAt) }}</span>
        <div class="tag-row__actions">
          <button class="icon-button icon-button--small" type="button" :aria-label="tag.pinned ? '取消置顶' : '置顶标签'" @click="togglePin(tag)"><Pin :size="14" :fill="tag.pinned ? 'currentColor' : 'none'" /></button>
          <button class="icon-button icon-button--small" type="button" aria-label="编辑标签" @click="openEdit(tag)"><Edit3 :size="14" /></button>
          <button class="icon-button icon-button--small" type="button" aria-label="合并标签" :disabled="app.tags.length < 2" @click="openMerge(tag)"><Combine :size="14" /></button>
          <button class="icon-button icon-button--small danger" type="button" aria-label="删除标签" @click="requestDelete(tag)"><Trash2 :size="14" /></button>
        </div>
      </article>
    </section>

    <EmptyState
      v-else-if="app.tags.length"
      title="没有匹配标签"
      description="清除搜索词后查看全部标签。"
      action-label="清除搜索"
      @action="query = ''"
    />
    <EmptyState
      v-else
      title="还没有标签"
      description="创建标签，把相关书籍、摘录和知识笔记放在同一个主题下。"
      action-label="创建第一个标签"
      @action="openCreate"
    >
      <template #icon><TagIcon :size="24" /></template>
    </EmptyState>

    <DialogPanel v-if="editorOpen" :title="editing ? '编辑标签' : '新建标签'" description="标签名称在书籍和笔记之间必须唯一。" width="small" @close="editorOpen = false">
      <form class="tag-form" @submit.prevent="save">
        <label class="form-field">
          <span>标签名称</span>
          <input v-model="form.name" class="field" autofocus maxlength="40" placeholder="例如：认知科学" />
        </label>
        <div class="form-field">
          <span class="field-label">颜色</span>
          <div class="color-palette">
            <button v-for="color in palette" :key="color" type="button" :class="{ 'is-active': form.color === color }" :style="{ background: color }" :aria-label="`选择颜色 ${color}`" @click="form.color = color"></button>
          </div>
        </div>
        <label class="checkbox-line"><input v-model="form.pinned" type="checkbox" />在首页和标签列表中置顶</label>
      </form>
      <template #footer>
        <button class="button button--ghost" type="button" @click="editorOpen = false">取消</button>
        <button class="button button--primary" type="button" :disabled="!form.name.trim()" @click="save">{{ editing ? '保存修改' : '创建标签' }}</button>
      </template>
    </DialogPanel>

    <DialogPanel v-if="deleteOpen && deleting" title="删除标签？" :description="`将从所有书籍和笔记中移除“${deleting.name}”。对象本身不会被删除。`" width="small" @close="deleteOpen = false">
      <div class="tag-danger"><Trash2 :size="18" /><span>此操作会生成同步墓碑，并同步到其他设备。</span></div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="deleteOpen = false">取消</button>
        <button class="button button--danger" type="button" @click="confirmDelete">删除标签</button>
      </template>
    </DialogPanel>

    <DialogPanel v-if="mergeOpen" title="合并标签" description="源标签的所有书籍与笔记关联会迁移到目标标签，然后删除源标签。" @close="mergeOpen = false">
      <div class="form-grid">
        <label class="form-field">
          <span>源标签</span>
          <select v-model="mergeSource" class="select">
            <option v-for="tag in app.tags" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
          </select>
        </label>
        <label class="form-field">
          <span>合并到</span>
          <select v-model="mergeTarget" class="select">
            <option value="">选择目标标签</option>
            <option v-for="tag in app.tags" :key="tag.id" :value="tag.id" :disabled="tag.id === mergeSource">{{ tag.name }}</option>
          </select>
        </label>
      </div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="mergeOpen = false">取消</button>
        <button class="button button--primary" type="button" :disabled="!mergeSource || !mergeTarget" @click="confirmMerge">合并标签</button>
      </template>
    </DialogPanel>
  </div>
</template>

<style scoped>
.tags-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.tag-toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem;
}

.tag-toolbar label {
  display: flex;
  min-height: 38px;
  flex: 1;
  align-items: center;
  gap: 0.45rem;
  padding: 0 0.65rem;
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--text-tertiary);
  background: var(--surface-elevated);
}

.tag-toolbar input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
}

.tag-toolbar .select {
  width: 135px;
}

.tag-table {
  overflow: hidden;
}

.tag-table__head,
.tag-row {
  display: grid;
  grid-template-columns: minmax(200px, 1fr) 100px 100px 110px 150px;
  align-items: center;
  gap: 0.6rem;
  padding: 0.65rem 1rem;
}

.tag-table__head {
  border-bottom: 1px solid var(--border);
  color: var(--text-tertiary);
  background: var(--surface-muted);
  font-size: 0.75rem;
}

.tag-row {
  border-bottom: 1px solid var(--border);
}

.tag-row:last-child {
  border-bottom: 0;
}

.tag-row__identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.65rem;
  padding: 0;
  border: 0;
  color: var(--text);
  background: transparent;
  text-align: left;
}

.tag-row__color {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 9px;
}

.tag-row__identity > span:last-child {
  display: grid;
  min-width: 0;
}

.tag-row__identity strong {
  overflow: hidden;
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-row__identity small,
.tag-row > span {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.tag-row > button:not(.tag-row__identity) {
  justify-self: start;
  padding: 0.2rem 0.5rem;
  border: 0;
  border-radius: 6px;
  color: var(--accent-strong);
  background: var(--accent-wash);
  font-size: 0.75rem;
}

.tag-row__actions {
  display: flex;
  gap: 0.15rem;
}

.tag-form {
  display: grid;
  gap: 0.9rem;
}

.color-palette {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.color-palette button {
  width: 30px;
  height: 30px;
  border: 3px solid transparent;
  border-radius: 50%;
}

.color-palette button.is-active {
  border-color: var(--surface-elevated);
  outline: 2px solid var(--text);
}

.tag-danger {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.75rem;
  border-radius: 10px;
  color: var(--danger);
  background: var(--danger-soft);
}

@media (max-width: 760px) {
  .tag-table__head {
    display: none;
  }

  .tag-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .tag-row > button:not(.tag-row__identity),
  .tag-row > span {
    display: none;
  }
}

@media (max-width: 450px) {
  .tag-row__actions .icon-button:nth-child(1),
  .tag-row__actions .icon-button:nth-child(3) {
    display: none;
  }
}
</style>

