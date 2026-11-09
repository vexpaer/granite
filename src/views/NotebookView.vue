<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Download,
  FileDown,
  FileText,
  Files,
  Folder,
  FolderPlus,
  Import,
  Link2,
  LoaderCircle,
  NotebookPen,
  Paperclip,
  PanelLeftClose,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import DialogPanel from '../components/DialogPanel.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import { formatDateTime, plainText, relativeTime } from '../components/utils';
import type { Note } from '../types';

const app = useApp();
const query = ref('');
const folderFilter = ref('');
const tagFilter = ref('');
const mode = ref<'source' | 'preview'>('source');
const mobileEditorOpen = ref(false);
const explorerOpen = ref(true);
const saveStatus = ref<'saved' | 'dirty' | 'saving' | 'error'>('saved');
const templateOpen = ref(false);
const folderOpen = ref(false);
const folderName = ref('');
const deleteOpen = ref(false);
const attachmentInput = ref<HTMLInputElement>();
const markdownInput = ref<HTMLInputElement>();
const previewEl = ref<HTMLElement>();
const draft = ref<Note | null>(null);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let suppressWatch = false;
const pendingDrafts = new Map<string, Note>();
const saveQueues = new Map<string, Promise<void>>();

const templates = [
  {
    id: 'blank',
    name: '空白笔记',
    description: '从标题与正文开始。',
    title: '未命名笔记',
    body: '# 未命名笔记\n\n',
    folder: '',
  },
  {
    id: 'literature',
    name: '文献笔记',
    description: '记录问题、方法与结论。',
    title: '文献笔记',
    body: '# 文献笔记\n\n## 核心问题\n\n## 方法\n\n## 结论\n\n## 我的判断\n',
    folder: '',
  },
  {
    id: 'reading',
    name: '阅读摘录',
    description: '保留引用并连接相关笔记。',
    title: '阅读摘录',
    body: '# 阅读摘录\n\n> 引用原文\n\n## 想法\n\n相关：[[索引]]\n',
    folder: '摘录',
  },
];

const folders = computed(() => {
  const values = new Map<string, number>();
  for (const note of app.notes) {
    if (!note.folder) continue;
    values.set(note.folder, (values.get(note.folder) || 0) + 1);
  }
  return [...values.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
    .map(([name, count]) => ({ name, count }));
});

const filteredNotes = computed(() => {
  const value = query.value.trim().toLocaleLowerCase('zh-CN');
  return [...app.notes]
    .filter((note) => {
      if (!folderFilter.value && tagFilter.value === '') return true;
      if (folderFilter.value === '__root__' && note.folder) return false;
      if (folderFilter.value && folderFilter.value !== '__root__' && note.folder !== folderFilter.value) return false;
      if (tagFilter.value && !note.tagIds.includes(tagFilter.value)) return false;
      return true;
    })
    .filter((note) => {
      if (!value) return true;
      return `${note.title} ${plainText(note.body)}`.toLocaleLowerCase('zh-CN').includes(value);
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
});

const selectedId = computed(() => {
  const routeId = app.route.id;
  if (routeId && app.notes.some((note) => note.id === routeId)) return routeId;
  return filteredNotes.value[0]?.id || '';
});
const selectedNote = computed(() => app.notes.find((note) => note.id === selectedId.value));
const selectedBook = computed(() => app.books.find((book) => book.id === draft.value?.bookId));
const noteTags = computed(() => app.tags.filter((tag) => draft.value?.tagIds.includes(tag.id)));

const wikiLinks = computed(() => {
  const body = draft.value?.body || '';
  return [...body.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)].map((match) => ({
    title: match[1].trim(),
    label: match[2]?.trim() || match[1].trim(),
  }));
});

const backlinks = computed(() => {
  if (!selectedNote.value) return [];
  const titlePattern = selectedNote.value.title.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!titlePattern) return [];
  const regex = new RegExp(`\\[\\[${titlePattern}(?:\\|[^\\]]+)?\\]\\]`, 'i');
  return app.notes.filter((note) => note.id !== selectedNote.value?.id && regex.test(note.body));
});

const renderedNote = computed(() => {
  if (!draft.value) return '';
  const source = draft.value.body.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, label?: string) =>
      `[${label || target}](#wikilink:${encodeURIComponent(target.trim())})`,
  );
  return DOMPurify.sanitize(marked.parse(source) as string, {
    ADD_ATTR: ['target', 'rel'],
  });
});

watch(
  selectedId,
  async (id, oldId) => {
    if (oldId && draft.value?.id === oldId) await flushDraft();
    clearTimeout(saveTimer);
    const source = id ? pendingDrafts.get(id) || app.notes.find((note) => note.id === id) : null;
    suppressWatch = true;
    draft.value = source ? JSON.parse(JSON.stringify(source)) : null;
    saveStatus.value = id && pendingDrafts.has(id) ? 'dirty' : 'saved';
    await nextTick();
    suppressWatch = false;
  },
  { immediate: true },
);

watch(
  draft,
  () => {
    if (!draft.value || suppressWatch) return;
    saveStatus.value = 'dirty';
    pendingDrafts.set(draft.value.id, JSON.parse(JSON.stringify(draft.value)));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveDraft(), 700);
  },
  { deep: true },
);

onBeforeUnmount(() => {
  clearTimeout(saveTimer);
  if (draft.value && pendingDrafts.has(draft.value.id)) void saveDraft(draft.value.id);
});

async function saveDraft(noteId = draft.value?.id) {
  if (!noteId || !pendingDrafts.has(noteId)) return;
  clearTimeout(saveTimer);
  const queued = saveQueues.get(noteId);
  if (queued) {
    await queued;
    if (pendingDrafts.has(noteId)) return saveDraft(noteId);
    return;
  }

  const queue = (async () => {
    while (pendingDrafts.has(noteId)) {
      const pending = pendingDrafts.get(noteId);
      if (!pending) break;
      const snapshot = JSON.parse(JSON.stringify(pending)) as Note;
      if (draft.value?.id === noteId) saveStatus.value = 'saving';
      await app.saveNote(snapshot);
      if (pendingDrafts.get(noteId) === pending) pendingDrafts.delete(noteId);
      if (draft.value?.id === noteId) {
        saveStatus.value = pendingDrafts.has(noteId) ? 'dirty' : 'saved';
      }
    }
  })()
    .catch((error) => {
      if (draft.value?.id === noteId) saveStatus.value = 'error';
      throw error;
    })
    .finally(() => {
      saveQueues.delete(noteId);
    });

  saveQueues.set(noteId, queue);
  await queue;
  if (pendingDrafts.has(noteId)) await saveDraft(noteId);
}

async function flushDraft() {
  if (!draft.value) return;
  const noteId = draft.value.id;
  if (saveStatus.value === 'dirty' || saveStatus.value === 'saving') {
    pendingDrafts.set(noteId, JSON.parse(JSON.stringify(draft.value)));
  }
  if (pendingDrafts.has(noteId)) await saveDraft(noteId);
}

async function selectNote(note: Note) {
  await flushDraft();
  mobileEditorOpen.value = true;
  app.navigate('notebook', note.id);
}

async function newBlankNote() {
  await flushDraft();
  const note = app.newNote();
  mobileEditorOpen.value = true;
  app.navigate('notebook', note.id);
}

async function createFromTemplate(template: (typeof templates)[number]) {
  await flushDraft();
  const note = app.newNote();
  note.title = template.title;
  note.body = template.body;
  note.folder = folderFilter.value !== '__root__' ? template.folder || folderFilter.value : template.folder;
  await app.saveNote(note);
  templateOpen.value = false;
  mobileEditorOpen.value = true;
  app.navigate('notebook', note.id);
}

async function createFolder() {
  const name = folderName.value.trim();
  if (!name) return;
  await flushDraft();
  const note = app.newNote();
  note.folder = name;
  note.title = `${name}索引`;
  note.body = `# ${name}\n\n`;
  await app.saveNote(note);
  folderName.value = '';
  folderOpen.value = false;
  folderFilter.value = name;
  app.navigate('notebook', note.id);
  mobileEditorOpen.value = true;
}

async function deleteSelectedNote() {
  if (!draft.value) return;
  clearTimeout(saveTimer);
  const noteId = draft.value.id;
  const queued = saveQueues.get(noteId);
  if (queued) await queued;
  pendingDrafts.delete(noteId);
  await app.deleteNote(noteId);
  deleteOpen.value = false;
  mobileEditorOpen.value = false;
  app.navigate('notebook');
}

function toggleTag(id: string) {
  if (!draft.value) return;
  draft.value.tagIds = draft.value.tagIds.includes(id)
    ? draft.value.tagIds.filter((value) => value !== id)
    : [...draft.value.tagIds, id];
}

function openAttachment(name: string, path: string, data?: string) {
  if (!data) {
    app.notify(`附件“${name}”只有相对路径 ${path}，当前未嵌入可预览内容。`);
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = data;
  anchor.download = name;
  anchor.click();
}

async function addAttachment(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !draft.value) return;
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  draft.value.attachments = [
    ...(draft.value.attachments || []),
    {
      name: file.name,
      path: `attachments/${file.name}`,
      data,
    },
  ];
  input.value = '';
  await saveDraft();
}

function removeAttachment(index: number) {
  if (!draft.value?.attachments) return;
  draft.value.attachments.splice(index, 1);
}

async function importMarkdown(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  await flushDraft();
  for (const file of files) {
    const body = await file.text();
    const note = app.newNote();
    note.title = file.name.replace(/\.md$/i, '') || '导入笔记';
    note.body = body;
    note.folder = folderFilter.value !== '__root__' ? folderFilter.value : '';
    await app.saveNote(note);
  }
  input.value = '';
  if (files.length) app.notify(`已导入 ${files.length} 篇 Markdown 笔记`);
}

function onPreviewClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement).closest('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href') || '';
  if (!href.startsWith('#wikilink:')) return;
  event.preventDefault();
  const title = decodeURIComponent(href.slice('#wikilink:'.length));
  const target = app.notes.find((note) => note.title.toLocaleLowerCase('zh-CN') === title.toLocaleLowerCase('zh-CN'));
  if (target) {
    selectNote(target);
    return;
  }
  app.notify(`未找到“${title}”。新建同名笔记后，这条链接会自动生效。`);
}

function statusText() {
  return {
    saved: '已保存',
    dirty: '等待保存',
    saving: '正在保存',
    error: '保存失败',
  }[saveStatus.value];
}

function addWikiLink(title: string) {
  if (!draft.value) return;
  const insertion = `[[${title}]]`;
  draft.value.body = `${draft.value.body}${draft.value.body && !draft.value.body.endsWith('\n') ? '\n' : ''}${insertion}`;
  if (selectedNote.value && selectedNote.value.id !== selectedId.value) {
    selectNote(selectedNote.value);
  }
}

function openWikiLink(title: string) {
  const target = app.notes.find(
    (note) => note.title.toLocaleLowerCase('zh-CN') === title.toLocaleLowerCase('zh-CN'),
  );
  if (target) selectNote(target);
  else app.notify(`尚未创建“${title}”笔记。`);
}
</script>

<template>
  <div class="notebook-view page-view" :class="{ 'notebook-view--editor-open': mobileEditorOpen }">
    <PageHeader
      title="笔记"
      description="用 Markdown 记录想法，并通过文件夹、WikiLink、反向链接和附件整理。"
    >
      <template #actions>
        <button class="button button--secondary" type="button" @click="templateOpen = true"><Sparkles :size="16" />从模板新建</button>
        <button class="button button--secondary" type="button" @click="markdownInput?.click()"><Import :size="16" />导入 Markdown</button>
        <button class="button button--primary" type="button" @click="newBlankNote"><Plus :size="16" />新建笔记</button>
      </template>
    </PageHeader>

    <input ref="markdownInput" class="sr-only" type="file" accept=".md,.markdown,text/markdown,text/plain" multiple @change="importMarkdown" />

    <div v-if="!app.notes.length" class="surface-card notebook-empty">
      <EmptyState
        title="开始你的知识空间"
        description="新建一篇独立笔记，也可以从阅读摘录开始。"
        action-label="新建笔记"
        secondary-label="从模板开始"
        @action="newBlankNote"
        @secondary="templateOpen = true"
      >
        <template #icon><NotebookPen :size="25" /></template>
      </EmptyState>
    </div>

    <div v-else class="notebook-shell surface-card" :class="{ 'notebook-shell--explorer-hidden': !explorerOpen }">
      <aside class="notebook-explorer" aria-label="笔记浏览器">
        <div class="notebook-explorer__header">
          <strong>笔记库</strong>
          <div class="inline-actions">
            <button class="icon-button icon-button--small" type="button" aria-label="新建文件夹" @click="folderOpen = true"><FolderPlus :size="16" /></button>
            <button class="icon-button icon-button--small explorer-collapse" type="button" aria-label="收起文件夹" @click="explorerOpen = false"><PanelLeftClose :size="16" /></button>
          </div>
        </div>
        <label class="explorer-search">
          <Search :size="15" />
          <span class="sr-only">在笔记库中搜索</span>
          <input v-model="query" type="search" placeholder="搜索笔记" />
        </label>
        <nav class="folder-tree">
          <button type="button" :class="{ 'is-active': !folderFilter }" @click="folderFilter = ''">
            <Files :size="16" /><span>全部笔记</span><small>{{ app.notes.length }}</small>
          </button>
          <button type="button" :class="{ 'is-active': folderFilter === '__root__' }" @click="folderFilter = '__root__'">
            <NotebookPen :size="16" /><span>根目录</span><small>{{ app.notes.filter((note) => !note.folder).length }}</small>
          </button>
          <button
            v-for="folder in folders"
            :key="folder.name"
            type="button"
            :class="{ 'is-active': folderFilter === folder.name }"
            @click="folderFilter = folder.name"
          >
            <Folder :size="16" /><span>{{ folder.name }}</span><small>{{ folder.count }}</small>
          </button>
        </nav>
        <div class="explorer-tags">
          <span class="field-label">标签</span>
          <div v-if="app.tags.length" class="explorer-tag-list">
            <button
              v-for="tag in app.tags"
              :key="tag.id"
              type="button"
              :class="{ 'is-active': tagFilter === tag.id }"
              @click="tagFilter = tagFilter === tag.id ? '' : tag.id"
            >
              <span :style="{ background: tag.color }"></span>{{ tag.name }}
            </button>
          </div>
          <span v-else class="muted">尚无标签</span>
        </div>
        <button class="button button--ghost button--small button--wide explorer-import" type="button" @click="markdownInput?.click()">
          <FileDown :size="15" />导入 Markdown
        </button>
      </aside>

      <section class="note-list" aria-label="笔记列表">
        <div class="note-list__header">
          <button v-if="!explorerOpen" class="icon-button icon-button--small" type="button" aria-label="展开文件夹" @click="explorerOpen = true"><ChevronRight :size="17" /></button>
          <div>
            <strong>{{ folderFilter === '__root__' ? '根目录' : folderFilter || '全部笔记' }}</strong>
            <span>{{ filteredNotes.length }} 篇</span>
          </div>
          <button class="icon-button icon-button--small" type="button" aria-label="新建空白笔记" @click="newBlankNote"><Plus :size="17" /></button>
        </div>
        <div v-if="filteredNotes.length" class="note-list__items">
          <button
            v-for="note in filteredNotes"
            :key="note.id"
            type="button"
            class="note-list__item"
            :class="{ 'is-active': selectedId === note.id }"
            @click="selectNote(note)"
          >
            <span class="note-list__icon"><FileText :size="17" /></span>
            <span class="note-list__body">
              <strong>{{ note.title || '未命名笔记' }}</strong>
              <span>{{ plainText(note.body) || '空白笔记' }}</span>
              <small>
                {{ relativeTime(note.updatedAt) }}
                <template v-if="note.bookId"> · {{ app.books.find((book) => book.id === note.bookId)?.title || '关联书籍' }}</template>
              </small>
            </span>
          </button>
        </div>
        <EmptyState
          v-else
          compact
          title="没有匹配笔记"
          description="清除搜索、文件夹或标签筛选后再试。"
          action-label="清除筛选"
          @action="query = ''; folderFilter = ''; tagFilter = ''"
        />
      </section>

      <section v-if="draft" class="note-editor" aria-label="笔记编辑器">
        <header class="note-editor__top">
          <button class="icon-button icon-button--small mobile-back" type="button" aria-label="返回笔记列表" @click="mobileEditorOpen = false"><ArrowLeft :size="18" /></button>
          <div class="note-editor__status" :class="`note-editor__status--${saveStatus}`">
            <LoaderCircle v-if="saveStatus === 'saving'" :size="13" class="spinning" />
            <span class="status-dot" :class="{ 'status-dot--success': saveStatus === 'saved', 'status-dot--danger': saveStatus === 'error' }"></span>
            {{ statusText() }}
          </div>
          <div class="segmented note-mode">
            <button type="button" :class="{ 'is-active': mode === 'source' }" @click="mode = 'source'">源码</button>
            <button type="button" :class="{ 'is-active': mode === 'preview' }" @click="mode = 'preview'">预览</button>
          </div>
          <button class="icon-button icon-button--small" type="button" aria-label="导出 Markdown" @click="app.exportNote(draft)"><Download :size="16" /></button>
          <button class="icon-button icon-button--small danger" type="button" aria-label="删除笔记" @click="deleteOpen = true"><Trash2 :size="16" /></button>
        </header>

        <div class="note-editor__meta">
          <input v-model="draft.title" class="note-title" aria-label="笔记标题" placeholder="未命名笔记" />
          <div class="note-meta-fields">
            <label>
              <Folder :size="14" />
              <span class="sr-only">文件夹</span>
              <input v-model="draft.folder" type="text" list="note-folders" placeholder="根目录" />
              <datalist id="note-folders">
                <option v-for="folder in folders" :key="folder.name" :value="folder.name"></option>
              </datalist>
            </label>
            <label>
              <BookOpen :size="14" />
              <span class="sr-only">关联书籍</span>
              <select v-model="draft.bookId">
                <option value="">未关联书籍</option>
                <option v-for="book in app.books" :key="book.id" :value="book.id">{{ book.title }}</option>
              </select>
            </label>
            <span>{{ formatDateTime(draft.updatedAt) }}</span>
          </div>
          <div v-if="noteTags.length" class="note-editor__tags">
            <span v-for="tag in noteTags" :key="tag.id" class="tag-chip tag-chip--soft"><span class="tag-dot" :style="{ background: tag.color }"></span>{{ tag.name }}</span>
          </div>
        </div>

        <div class="note-editor__workspace">
          <div v-show="mode === 'source'" class="markdown-pane">
            <textarea
              v-model="draft.body"
              class="markdown-editor"
              aria-label="Markdown 正文"
              spellcheck="false"
              placeholder="用 Markdown 记录想法。输入 [[笔记标题]] 创建双向链接。"
            ></textarea>
          </div>
          <article
            v-show="mode === 'preview'"
            ref="previewEl"
            class="markdown-preview"
            @click="onPreviewClick"
            v-html="renderedNote"
          ></article>
        </div>

        <footer class="note-editor__footer">
          <div class="note-editor__tools">
            <button type="button" @click="attachmentInput?.click()"><Paperclip :size="15" />附件</button>
            <button type="button" @click="templateOpen = true"><Sparkles :size="15" />模板</button>
            <span v-if="wikiLinks.length"><Link2 :size="14" />{{ wikiLinks.length }} 个链接</span>
          </div>
          <span>{{ draft.body.length }} 字符</span>
        </footer>

        <input ref="attachmentInput" class="sr-only" type="file" @change="addAttachment" />

        <div v-if="draft.attachments?.length" class="attachment-list">
          <div class="attachment-list__heading">
            <Paperclip :size="15" /><strong>附件</strong>
          </div>
          <div v-for="(attachment, index) in draft.attachments" :key="`${attachment.path}-${index}`" class="attachment-row">
            <button type="button" @click="openAttachment(attachment.name, attachment.path, attachment.data)">
              <FileText :size="15" />
              <span>{{ attachment.name }}</span>
              <small>{{ attachment.path }}</small>
            </button>
            <button class="icon-button icon-button--small danger" type="button" :aria-label="`移除附件 ${attachment.name}`" @click="removeAttachment(index)"><Trash2 :size="14" /></button>
          </div>
        </div>
      </section>

      <aside v-if="draft" class="note-context" aria-label="笔记上下文">
        <section>
          <div class="context-heading"><h3>反向链接</h3><span>{{ backlinks.length }}</span></div>
          <div v-if="backlinks.length" class="context-list">
            <button v-for="note in backlinks" :key="note.id" type="button" @click="selectNote(note)">
              <FileText :size="14" /><span>{{ note.title }}</span>
            </button>
          </div>
          <p v-else>还没有笔记链接到这里。</p>
        </section>
        <section>
          <div class="context-heading"><h3>WikiLink</h3><span>{{ wikiLinks.length }}</span></div>
          <div v-if="wikiLinks.length" class="context-list">
            <button
              v-for="link in wikiLinks"
              :key="`${link.title}-${link.label}`"
              type="button"
              @click="openWikiLink(link.title)"
            >
              <Link2 :size="14" /><span>{{ link.label }}</span>
              <small :class="{ 'is-missing': !app.notes.some((note) => note.title.toLowerCase() === link.title.toLowerCase()) }">
                {{ app.notes.some((note) => note.title.toLowerCase() === link.title.toLowerCase()) ? '已连接' : '未创建' }}
              </small>
            </button>
          </div>
          <p v-else>在正文中输入 [[笔记标题]] 创建链接。</p>
        </section>
        <section v-if="selectedBook">
          <div class="context-heading"><h3>关联书籍</h3></div>
          <button class="linked-book" type="button" @click="app.navigate('book-detail', selectedBook.id)">
            <BookOpen :size="16" />
            <span><strong>{{ selectedBook.title }}</strong><small>{{ selectedBook.authors.join(' · ') || selectedBook.format.toUpperCase() }}</small></span>
            <ChevronRight :size="15" />
          </button>
          <button v-if="draft.location" class="button button--secondary button--small button--wide" type="button" @click="app.openReader(selectedBook.id, draft.location)">
            <BookOpen :size="14" />回到引用位置
          </button>
        </section>
        <section>
          <div class="context-heading"><h3>标签</h3></div>
          <div v-if="app.tags.length" class="context-tags">
            <label v-for="tag in app.tags" :key="tag.id" class="checkbox-line">
              <input type="checkbox" :checked="draft.tagIds.includes(tag.id)" @change="toggleTag(tag.id)" />
              <span class="tag-dot" :style="{ background: tag.color }"></span>{{ tag.name }}
            </label>
          </div>
          <button v-else class="button button--ghost button--small" type="button" @click="app.navigate('tags')">创建第一个标签</button>
        </section>
      </aside>
    </div>

    <DialogPanel
      v-if="templateOpen"
      title="从模板新建"
      description="模板只创建新的 Markdown 内容，不会覆盖现有笔记。"
      @close="templateOpen = false"
    >
      <div class="template-grid">
        <button v-for="template in templates" :key="template.id" type="button" @click="createFromTemplate(template)">
          <Sparkles :size="18" />
          <strong>{{ template.name }}</strong>
          <span>{{ template.description }}</span>
        </button>
      </div>
    </DialogPanel>

    <DialogPanel
      v-if="folderOpen"
      title="新建文件夹"
      description="文件夹会成为笔记库中的普通目录；第一篇文章会保存到该目录。"
      width="small"
      @close="folderOpen = false"
    >
      <label class="form-field">
        <span>文件夹名称</span>
        <input v-model="folderName" class="field" autofocus placeholder="例如：研究项目" @keydown.enter.prevent="createFolder" />
        <span class="field-hint">可使用“主题/子主题”形式的相对路径。</span>
      </label>
      <template #footer>
        <button class="button button--ghost" type="button" @click="folderOpen = false">取消</button>
        <button class="button button--primary" type="button" :disabled="!folderName.trim()" @click="createFolder">创建文件夹</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="deleteOpen"
      title="删除这篇笔记？"
      :description="`“${draft?.title || '未命名笔记'}”会被删除，并生成同步墓碑。其他笔记中的 WikiLink 不会自动改写。`"
      width="small"
      @close="deleteOpen = false"
    >
      <div class="delete-note-warning"><Trash2 :size="19" /><span>请先确认 Markdown 已导出，或已有可恢复备份。</span></div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="deleteOpen = false">取消</button>
        <button class="button button--danger" type="button" @click="deleteSelectedNote">删除笔记</button>
      </template>
    </DialogPanel>
  </div>
</template>

<style scoped>
.notebook-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.notebook-empty {
  padding: 1rem;
}

.notebook-shell {
  display: grid;
  min-height: min(760px, calc(100vh - 190px));
  grid-template-columns: 198px 285px minmax(400px, 1fr) 226px;
  overflow: hidden;
  padding: 0;
}

.notebook-shell--explorer-hidden {
  grid-template-columns: 285px minmax(400px, 1fr) 226px;
}

.notebook-shell--explorer-hidden .notebook-explorer {
  display: none;
}

.notebook-explorer,
.note-list {
  border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-muted) 75%, transparent);
}

.notebook-explorer {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 0.85rem 0.65rem;
}

.notebook-explorer__header,
.note-list__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.2rem 0.25rem 0.75rem;
}

.notebook-explorer__header strong,
.note-list__header strong {
  display: block;
  font-size: 0.82rem;
}

.explorer-search {
  display: flex;
  min-height: 34px;
  align-items: center;
  gap: 0.4rem;
  padding: 0 0.5rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-tertiary);
  background: var(--surface-elevated);
}

.explorer-search input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: 0.74rem;
}

.folder-tree {
  display: grid;
  gap: 0.1rem;
  margin-top: 0.55rem;
}

.folder-tree button {
  display: flex;
  width: 100%;
  min-height: 34px;
  align-items: center;
  gap: 0.45rem;
  padding: 0 0.5rem;
  border: 0;
  border-radius: 7px;
  color: var(--text-secondary);
  background: transparent;
  text-align: left;
}

.folder-tree button:hover,
.folder-tree button.is-active {
  color: var(--text);
  background: var(--surface-elevated);
}

.folder-tree button.is-active {
  box-shadow: 0 2px 8px rgba(42, 33, 55, 0.07);
}

.folder-tree button span {
  overflow: hidden;
  flex: 1;
  font-size: 0.73rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-tree button small {
  color: var(--text-tertiary);
  font-size: 0.62rem;
}

.explorer-tags {
  display: grid;
  gap: 0.45rem;
  padding: 0.85rem 0.35rem;
  border-top: 1px solid var(--border);
  margin-top: 0.75rem;
}

.explorer-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.explorer-tag-list button {
  display: inline-flex;
  min-height: 25px;
  align-items: center;
  gap: 0.28rem;
  padding: 0.2rem 0.42rem;
  border: 0;
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--surface-elevated);
  font-size: 0.66rem;
}

.explorer-tag-list button.is-active {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.explorer-tag-list span,
.tag-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.explorer-import {
  margin-top: auto;
}

.note-list {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 0.75rem 0.55rem;
}

.note-list__header {
  padding-inline: 0.3rem;
}

.note-list__header > div {
  min-width: 0;
  flex: 1;
}

.note-list__header span {
  color: var(--text-tertiary);
  font-size: 0.66rem;
}

.note-list__items {
  display: grid;
  align-content: start;
  gap: 0.22rem;
  overflow-y: auto;
}

.note-list__item {
  display: flex;
  width: 100%;
  gap: 0.55rem;
  padding: 0.65rem;
  border: 1px solid transparent;
  border-radius: 11px;
  color: var(--text);
  background: transparent;
  text-align: left;
}

.note-list__item:hover,
.note-list__item.is-active {
  border-color: var(--border);
  background: var(--surface-elevated);
}

.note-list__item.is-active {
  border-color: color-mix(in srgb, var(--accent) 22%, var(--border));
  box-shadow: 0 4px 16px -10px rgba(47, 34, 66, 0.25);
}

.note-list__icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.note-list__body {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}

.note-list__body strong,
.note-list__body span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-list__body strong {
  font-size: 0.76rem;
}

.note-list__body span {
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.note-list__body small {
  color: var(--text-tertiary);
  font-size: 0.61rem;
}

.note-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
  background: var(--surface-elevated);
}

.note-editor__top {
  display: flex;
  min-height: 50px;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.7rem;
  border-bottom: 1px solid var(--border);
}

.note-editor__status {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  color: var(--text-tertiary);
  font-size: 0.65rem;
}

.note-editor__status--error {
  color: var(--danger);
}

.spinning {
  animation: spin 1s linear infinite;
}

.note-mode {
  margin-left: auto;
}

.note-mode button {
  min-width: 48px;
}

.note-editor__meta {
  display: grid;
  gap: 0.45rem;
  padding: 1rem 1.2rem 0.7rem;
  border-bottom: 1px solid var(--border);
}

.note-title {
  width: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  color: var(--text);
  background: transparent;
  font-family: var(--font-display);
  font-size: clamp(1.8rem, 3.4vw, 2.6rem);
  font-weight: 600;
  letter-spacing: -0.03em;
}

.note-meta-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.note-meta-fields label {
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: 0.3rem;
  padding: 0 0.45rem;
  border-radius: 7px;
  color: var(--text-tertiary);
  background: var(--surface-muted);
}

.note-meta-fields input,
.note-meta-fields select {
  max-width: 150px;
  border: 0;
  outline: 0;
  color: var(--text-secondary);
  background: transparent;
  font-size: 0.68rem;
}

.note-meta-fields > span {
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 0.64rem;
}

.note-editor__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.note-editor__workspace {
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.markdown-pane {
  height: 100%;
}

.markdown-editor {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 390px;
  resize: none;
  padding: 1.25rem 1.4rem 2rem;
  border: 0;
  outline: 0;
  color: var(--text);
  background:
    linear-gradient(90deg, transparent 0, transparent 39px, color-mix(in srgb, var(--accent) 10%, transparent) 40px, transparent 41px),
    var(--surface-elevated);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  line-height: 1.78;
  tab-size: 2;
}

.markdown-preview {
  overflow-y: auto;
  height: 100%;
  max-width: 860px;
  padding: 1.4rem clamp(1.5rem, 5vw, 4.5rem) 3rem;
  margin: 0 auto;
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 0.93rem;
  line-height: 1.78;
}

.markdown-preview :deep(h1),
.markdown-preview :deep(h2),
.markdown-preview :deep(h3),
.markdown-preview :deep(h4) {
  margin: 1.6em 0 0.5em;
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

.markdown-preview :deep(h1) { font-size: 2.4em; }
.markdown-preview :deep(h2) { font-size: 1.8em; }
.markdown-preview :deep(h3) { font-size: 1.42em; }

.markdown-preview :deep(p),
.markdown-preview :deep(ul),
.markdown-preview :deep(ol),
.markdown-preview :deep(blockquote) {
  margin: 0.75em 0;
}

.markdown-preview :deep(a) {
  color: var(--accent-strong);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
  text-underline-offset: 3px;
}

.markdown-preview :deep(blockquote) {
  padding: 0.5em 1em;
  border-left: 2px solid var(--accent);
  color: var(--text-secondary);
  background: var(--accent-wash);
}

.markdown-preview :deep(code) {
  padding: 0.12em 0.3em;
  border-radius: 4px;
  background: var(--surface-muted);
  font-family: var(--font-mono);
  font-size: 0.88em;
}

.markdown-preview :deep(pre) {
  overflow-x: auto;
  padding: 1em;
  border-radius: 12px;
  background: var(--surface-dark);
  color: #f7f1fa;
}

.markdown-preview :deep(img) {
  height: auto;
  border-radius: 10px;
}

.markdown-preview :deep(table) {
  width: 100%;
  border-collapse: collapse;
}

.markdown-preview :deep(th),
.markdown-preview :deep(td) {
  padding: 0.45rem;
  border: 1px solid var(--border);
  text-align: left;
}

.markdown-preview :deep(input[type='checkbox']) {
  accent-color: var(--accent);
}

.note-editor__footer {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 0.35rem 0.75rem;
  border-top: 1px solid var(--border);
  color: var(--text-tertiary);
  font-size: 0.65rem;
}

.note-editor__tools {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.note-editor__tools button,
.note-editor__tools span {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.45rem;
  border: 0;
  border-radius: 6px;
  color: var(--text-secondary);
  background: transparent;
  font-size: 0.66rem;
}

.note-editor__tools button:hover {
  background: var(--surface-muted);
}

.attachment-list {
  max-height: 150px;
  overflow-y: auto;
  padding: 0.55rem 0.75rem;
  border-top: 1px solid var(--border);
  background: var(--surface-muted);
}

.attachment-list__heading,
.attachment-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.attachment-list__heading {
  margin-bottom: 0.35rem;
  font-size: 0.68rem;
}

.attachment-row > button:first-child {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem;
  border: 0;
  color: var(--text-secondary);
  background: transparent;
  text-align: left;
}

.attachment-row span {
  overflow: hidden;
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-row small {
  overflow: hidden;
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 0.6rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-context {
  overflow-y: auto;
  padding: 0.85rem;
  border-left: 1px solid var(--border);
}

.note-context section {
  display: grid;
  gap: 0.6rem;
  padding: 0 0 1rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1rem;
}

.note-context section:last-child {
  border-bottom: 0;
}

.context-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.context-heading h3 {
  margin: 0;
  font-size: 0.76rem;
}

.context-heading span {
  color: var(--text-tertiary);
  font-size: 0.65rem;
}

.note-context p {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 0.66rem;
  line-height: 1.55;
}

.context-list {
  display: grid;
  gap: 0.25rem;
}

.context-list button {
  display: flex;
  min-width: 0;
  min-height: 31px;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.35rem;
  border: 0;
  border-radius: 6px;
  color: var(--text-secondary);
  background: transparent;
  text-align: left;
}

.context-list button:hover {
  background: var(--surface-muted);
}

.context-list span {
  overflow: hidden;
  flex: 1;
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-list small {
  color: var(--text-tertiary);
  font-size: 0.58rem;
}

.context-list small.is-missing {
  color: var(--warning);
}

.linked-book {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  background: var(--surface-elevated);
  text-align: left;
}

.linked-book > span {
  display: grid;
  min-width: 0;
  flex: 1;
}

.linked-book strong,
.linked-book small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.linked-book strong {
  font-size: 0.7rem;
}

.linked-book small {
  color: var(--text-tertiary);
  font-size: 0.6rem;
}

.context-tags {
  display: grid;
  gap: 0.45rem;
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.7rem;
}

.template-grid button {
  display: grid;
  min-height: 150px;
  align-content: start;
  gap: 0.45rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 14px;
  color: var(--text);
  background: var(--surface-muted);
  text-align: left;
}

.template-grid button:hover {
  border-color: color-mix(in srgb, var(--accent) 32%, var(--border));
  background: var(--accent-wash);
}

.template-grid svg {
  color: var(--accent);
}

.template-grid span {
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.5;
}

.delete-note-warning {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.75rem;
  border-radius: 10px;
  color: var(--danger);
  background: var(--danger-soft);
}

.mobile-back {
  display: none;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 1250px) {
  .notebook-shell,
  .notebook-shell--explorer-hidden {
    grid-template-columns: 190px 265px minmax(390px, 1fr);
  }

  .note-context {
    display: none;
  }
}

@media (max-width: 900px) {
  .notebook-shell,
  .notebook-shell--explorer-hidden {
    min-height: 650px;
    grid-template-columns: 210px minmax(0, 1fr);
  }

  .notebook-shell .notebook-explorer {
    display: flex;
  }

  .notebook-shell--explorer-hidden .notebook-explorer {
    display: none;
  }

  .notebook-shell--explorer-hidden {
    grid-template-columns: minmax(0, 1fr);
  }

  .note-editor {
    grid-column: 2;
  }

  .notebook-shell--explorer-hidden .note-editor {
    grid-column: 1;
  }
}

@media (max-width: 620px) {
  .notebook-shell,
  .notebook-shell--explorer-hidden {
    display: block;
    min-height: 0;
  }

  .notebook-explorer {
    display: none !important;
  }

  .note-list {
    min-height: 480px;
    border-right: 0;
  }

  .note-editor {
    display: none;
  }

  .notebook-view--editor-open .note-list {
    display: none;
  }

  .notebook-view--editor-open .note-editor {
    display: flex;
    min-height: calc(100vh - 205px);
  }

  .mobile-back {
    display: inline-flex;
  }

  .note-title {
    font-size: 1.9rem;
  }

  .note-meta-fields > span {
    margin-left: 0;
  }

  .note-editor__workspace {
    min-height: 430px;
  }

  .markdown-preview {
    padding-inline: 1.1rem;
  }

  .template-grid {
    grid-template-columns: 1fr;
  }
}
</style>

