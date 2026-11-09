<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Bookmark,
  Download,
  Edit3,
  FileText,
  FolderSearch,
  FolderOpen,
  Heart,
  Highlighter,
  Link2,
  MessageSquareText,
  NotebookPen,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import BookCover from '../components/BookCover.vue';
import DialogPanel from '../components/DialogPanel.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import ProgressRing from '../components/ProgressRing.vue';
import {
  authorsLabel,
  fileSize,
  formatDate,
  formatDateTime,
  normalizedProgress,
  plainText,
  progressFor,
  progressLabel,
  statusLabel,
} from '../components/utils';
import type { Book } from '../types';

const app = useApp();
const editing = ref(false);
const deleteOpen = ref(false);
const showAllAnnotations = ref(false);
const draft = ref<Book | null>(null);
const relinking = ref(false);
const locating = ref(false);

const book = computed(() => app.books.find((item) => item.id === app.route.id));
const annotations = computed(() =>
  app.annotations
    .filter((annotation) => annotation.bookId === book.value?.id)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
);
const visibleAnnotations = computed(() =>
  showAllAnnotations.value ? annotations.value : annotations.value.slice(0, 4),
);
const notes = computed(() =>
  app.notes
    .filter((note) => note.bookId === book.value?.id)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
);
const root = computed(() => app.roots.find((item) => item.id === book.value?.rootId));
const bookTags = computed(() => app.tags.filter((tag) => book.value?.tagIds.includes(tag.id)));
const bookCollections = computed(() =>
  app.collections.filter((collection) => book.value?.collectionIds.includes(collection.id)),
);
const annotationTypes = computed(() => ({
  bookmark: annotations.value.filter((item) => item.type === 'bookmark').length,
  highlight: annotations.value.filter((item) => item.type === 'highlight').length,
  note: annotations.value.filter((item) => item.type === 'note').length,
  underline: annotations.value.filter((item) => item.type === 'underline').length,
  ink: annotations.value.filter((item) => item.type === 'ink').length,
}));

watch(
  book,
  (value) => {
    if (value) draft.value = JSON.parse(JSON.stringify(value));
  },
  { immediate: true },
);

function startEdit() {
  if (!book.value) return;
  draft.value = JSON.parse(JSON.stringify(book.value));
  editing.value = true;
}

function cancelEdit() {
  if (book.value) draft.value = JSON.parse(JSON.stringify(book.value));
  editing.value = false;
}

async function saveDraft() {
  if (!draft.value) return;
  await app.saveBook({ ...draft.value, updatedAt: new Date().toISOString() });
  editing.value = false;
}

async function toggleFavorite() {
  if (!book.value) return;
  await app.saveBook({ ...book.value, favorite: !book.value.favorite, updatedAt: new Date().toISOString() });
}

function readBook() {
  if (book.value) app.openReader(book.value.id, book.value.location);
}

async function locateBook() {
  if (!book.value || locating.value) return;
  locating.value = true;
  try {
    await app.revealBook(book.value);
  } finally {
    locating.value = false;
  }
}

async function relinkBook() {
  if (!book.value || relinking.value) return;
  relinking.value = true;
  try {
    await app.relocateBook(book.value.id);
  } finally {
    relinking.value = false;
  }
}

async function createLinkedNote() {
  if (!book.value) return;
  await app.newNote(
    book.value.id,
    book.value.location?.quote,
    book.value.location,
  );
}

async function onCoverFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !draft.value) return;
  const reader = new FileReader();
  reader.onload = () => {
    if (draft.value) draft.value.cover = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function confirmDelete() {
  if (!book.value) return;
  await app.deleteBooks([book.value.id]);
  deleteOpen.value = false;
  app.navigate('bookshelf');
}

function toggleDraftTag(id: string) {
  if (!draft.value) return;
  draft.value.tagIds = draft.value.tagIds.includes(id)
    ? draft.value.tagIds.filter((value) => value !== id)
    : [...draft.value.tagIds, id];
}

function toggleDraftCollection(id: string) {
  if (!draft.value) return;
  draft.value.collectionIds = draft.value.collectionIds.includes(id)
    ? draft.value.collectionIds.filter((value) => value !== id)
    : [...draft.value.collectionIds, id];
}

function annotationIcon(type: string) {
  return type === 'bookmark'
    ? Bookmark
    : type === 'underline'
      ? Highlighter
      : type === 'note'
        ? MessageSquareText
        : Highlighter;
}
</script>

<template>
  <div v-if="book" class="book-detail-view page-view">
    <PageHeader title="" back-label="返回书架" @back="app.back()">
      <template #actions>
        <button class="button button--secondary" type="button" @click="startEdit"><Edit3 :size="16" />编辑信息</button>
        <button class="button button--secondary" type="button" @click="app.exportBook(book)"><Download :size="16" />导出书籍</button>
        <button class="button button--primary" type="button" @click="readBook"><Play :size="16" fill="currentColor" />{{ book.status === 'unread' ? '开始阅读' : '继续阅读' }}</button>
      </template>
    </PageHeader>

    <section class="detail-hero surface-card">
      <div class="detail-hero__cover">
        <BookCover :book="book" />
      </div>
      <div class="detail-hero__copy">
        <div class="detail-hero__kicker">
          <span>{{ book.format.toUpperCase() }}</span>
          <span v-if="book.series">{{ book.series }}</span>
          <span>{{ statusLabel(book.status) }}</span>
        </div>
        <h1>{{ book.title }}</h1>
        <p v-if="authorsLabel(book)" class="detail-hero__authors">{{ authorsLabel(book) }}</p>
        <p v-if="book.description" class="detail-hero__description">{{ book.description }}</p>
        <div class="detail-hero__actions">
          <button class="icon-button icon-button--solid button--favorite" type="button" :aria-pressed="book.favorite" :aria-label="book.favorite ? '取消收藏' : '收藏书籍'" @click="toggleFavorite">
            <Heart :size="18" :fill="book.favorite ? 'currentColor' : 'none'" />
          </button>
          <button class="button button--ghost" type="button" @click="createLinkedNote"><NotebookPen :size="16" />新建关联笔记</button>
          <button class="button button--ghost danger" type="button" @click="deleteOpen = true"><Trash2 :size="16" />删除</button>
        </div>
        <div v-if="bookTags.length || bookCollections.length" class="detail-hero__tags">
          <button
            v-for="tag in bookTags"
            :key="tag.id"
            class="tag-chip tag-chip--soft"
            type="button"
            @click="app.navigate('tag-results', tag.id)"
          >
            <span class="tag-color" :style="{ background: tag.color }"></span>{{ tag.name }}
          </button>
          <span v-for="collection in bookCollections" :key="collection.id" class="tag-chip tag-chip--outline">{{ collection.name }}</span>
        </div>
      </div>
      <div class="detail-progress">
        <ProgressRing :value="progressFor(book)" :size="120" :stroke="10" :label="`阅读进度 ${Math.round(progressFor(book))}%`">
          <strong>{{ progressLabel(book) }}</strong>
        </ProgressRing>
        <span>{{ book.location?.chapter ? `第 ${book.location.chapter} 章` : '当前进度' }}</span>
        <small v-if="book.lastReadAt">上次阅读 {{ formatDateTime(book.lastReadAt) }}</small>
      </div>
    </section>

    <div v-if="!book.available" class="file-alert" role="alert">
      <FolderOpen :size="19" />
      <div>
        <strong>当前书籍文件不可访问</strong>
        <p>重新关联时会校验文件 Hash；只有内容与原书完全一致才会恢复，书籍 ID、阅读位置和标注都会保留。</p>
      </div>
      <div class="inline-actions">
        <button class="button button--primary button--small" type="button" :disabled="relinking" @click="relinkBook">
          <RefreshCw :size="14" />{{ relinking ? '正在校验' : '重新关联文件' }}
        </button>
        <button class="button button--secondary button--small" type="button" @click="app.navigate('settings', 'library')">管理书库</button>
      </div>
    </div>

    <div class="detail-grid">
      <section class="surface-card section-card">
        <div class="section-heading">
          <h2>书籍信息</h2>
          <button v-if="book.available" type="button" :disabled="locating" @click="locateBook">
            <FolderSearch :size="14" />{{ locating ? '正在定位' : '定位原文件' }}
          </button>
        </div>
        <dl class="metadata-grid">
          <div v-if="book.publisher"><dt>出版社</dt><dd>{{ book.publisher }}</dd></div>
          <div v-if="book.publishedAt"><dt>出版时间</dt><dd>{{ book.publishedAt }}</dd></div>
          <div v-if="book.language"><dt>语言</dt><dd>{{ book.language }}</dd></div>
          <div v-if="book.isbn"><dt>ISBN</dt><dd>{{ book.isbn }}</dd></div>
          <div v-if="book.doi"><dt>DOI</dt><dd>{{ book.doi }}</dd></div>
          <div><dt>文件格式</dt><dd>{{ book.format.toUpperCase() }}</dd></div>
          <div><dt>文件大小</dt><dd>{{ fileSize(book.size) }}</dd></div>
          <div><dt>来源文件夹</dt><dd>{{ root?.displayName || '本机未关联' }}</dd></div>
          <div><dt>添加时间</dt><dd>{{ formatDate(book.createdAt) }}</dd></div>
          <div><dt>内容校验</dt><dd class="mono">{{ book.sha256 ? `${book.sha256.slice(0, 12)}…` : '—' }}</dd></div>
          <div><dt>文件状态</dt><dd>{{ book.available ? '可访问' : '需要重新关联' }}</dd></div>
        </dl>
      </section>

      <section class="surface-card section-card location-card">
        <div class="section-heading"><h2>阅读位置</h2></div>
        <div class="location-facts">
          <div>
            <span>整体进度</span>
            <strong>{{ Math.round(normalizedProgress(book.location)) }}%</strong>
          </div>
          <div v-if="book.location?.page">
            <span>页码</span>
            <strong>{{ book.location.page }}</strong>
          </div>
          <div v-if="book.location?.chapter">
            <span>章节</span>
            <strong>{{ book.location.chapter }}</strong>
          </div>
        </div>
        <blockquote v-if="book.location?.quote">{{ book.location.quote }}</blockquote>
        <p v-else class="muted">开始阅读后，章节、页码和阅读位置会显示在这里。</p>
      </section>
    </div>

    <div class="detail-grid detail-grid--activity">
      <section class="surface-card section-card">
        <div class="section-heading">
          <h2>标注与书签</h2>
          <span class="muted">{{ annotations.length }} 项</span>
        </div>
        <div v-if="annotations.length" class="annotation-summary">
          <span v-if="annotationTypes.bookmark">{{ annotationTypes.bookmark }} 书签</span>
          <span v-if="annotationTypes.highlight">{{ annotationTypes.highlight }} 高亮</span>
          <span v-if="annotationTypes.underline">{{ annotationTypes.underline }} 下划线</span>
          <span v-if="annotationTypes.note">{{ annotationTypes.note }} 批注</span>
          <span v-if="annotationTypes.ink">{{ annotationTypes.ink }} 墨迹</span>
        </div>
        <div v-if="visibleAnnotations.length" class="data-list">
          <article v-for="annotation in visibleAnnotations" :key="annotation.id" class="data-row">
            <span class="annotation-icon" :style="{ color: annotation.color }">
              <component :is="annotationIcon(annotation.type)" :size="17" />
            </span>
            <div class="data-row__body">
              <strong>{{ annotation.text || annotation.note || `第 ${annotation.location.page || '—'} 页` }}</strong>
              <span>{{ annotation.note || formatDateTime(annotation.updatedAt) }}</span>
            </div>
          </article>
        </div>
        <EmptyState v-else compact title="还没有标注" description="阅读时选择文本即可创建高亮、下划线或批注。" />
        <button v-if="annotations.length > 4" class="button button--ghost button--small" type="button" @click="showAllAnnotations = !showAllAnnotations">
          {{ showAllAnnotations ? '收起' : `查看全部 ${annotations.length} 项` }}
        </button>
      </section>

      <section class="surface-card section-card">
        <div class="section-heading">
          <h2>关联笔记</h2>
          <button type="button" @click="createLinkedNote"><NotebookPen :size="14" />新建</button>
        </div>
        <div v-if="notes.length" class="data-list">
          <button v-for="note in notes" :key="note.id" class="data-row note-link" type="button" @click="app.navigate('notebook', note.id)">
            <span class="annotation-icon"><NotebookPen :size="17" /></span>
            <span class="data-row__body">
              <strong>{{ note.title || '未命名笔记' }}</strong>
              <span>{{ plainText(note.body) || '空白笔记' }}</span>
            </span>
          </button>
        </div>
        <EmptyState v-else compact title="还没有关联笔记" description="从这本书创建阅读笔记，引用会保留来源书籍。">
          <button class="button button--primary" type="button" @click="createLinkedNote">新建关联笔记</button>
        </EmptyState>
      </section>
    </div>

    <DialogPanel
      v-if="editing && draft"
      title="编辑书籍信息"
      description="保存后会同步更新书架、首页和搜索结果。"
      width="large"
      @close="cancelEdit"
    >
      <form class="form-grid" @submit.prevent="saveDraft">
        <label class="form-field">
          <span>书名</span>
          <input v-model="draft.title" class="field" required />
        </label>
        <label class="form-field">
          <span>作者（用逗号分隔）</span>
          <input :value="draft.authors.join(', ')" class="field" @input="draft.authors = ($event.target as HTMLInputElement).value.split(',').map((x) => x.trim()).filter(Boolean)" />
        </label>
        <label class="form-field">
          <span>出版社</span>
          <input v-model="draft.publisher" class="field" />
        </label>
        <label class="form-field">
          <span>系列</span>
          <input v-model="draft.series" class="field" />
        </label>
        <label class="form-field">
          <span>语言</span>
          <input v-model="draft.language" class="field" />
        </label>
        <label class="form-field">
          <span>阅读状态</span>
          <select v-model="draft.status" class="select">
            <option value="unread">未读</option>
            <option value="reading">阅读中</option>
            <option value="finished">已读</option>
          </select>
        </label>
        <label class="form-field">
          <span>ISBN</span>
          <input v-model="draft.isbn" class="field" />
        </label>
        <label class="form-field">
          <span>DOI</span>
          <input v-model="draft.doi" class="field" />
        </label>
        <label class="form-field form-field--full">
          <span>简介</span>
          <textarea v-model="draft.description" class="textarea"></textarea>
        </label>
        <label class="form-field form-field--full">
          <span>封面图片</span>
          <input type="file" accept="image/*" @change="onCoverFile" />
        </label>
        <div v-if="app.tags.length" class="form-field form-field--full">
          <span class="field-label">标签</span>
          <div class="option-grid">
            <label v-for="tag in app.tags" :key="tag.id" class="checkbox-line">
              <input type="checkbox" :checked="draft.tagIds.includes(tag.id)" @change="toggleDraftTag(tag.id)" />
              {{ tag.name }}
            </label>
          </div>
        </div>
        <div v-if="app.collections.length" class="form-field form-field--full">
          <span class="field-label">集合</span>
          <div class="option-grid">
            <label v-for="collection in app.collections" :key="collection.id" class="checkbox-line">
              <input type="checkbox" :checked="draft.collectionIds.includes(collection.id)" @change="toggleDraftCollection(collection.id)" />
              {{ collection.name }}
            </label>
          </div>
        </div>
      </form>
      <template #footer>
        <button class="button button--ghost" type="button" @click="cancelEdit">取消</button>
        <button class="button button--primary" type="button" @click="saveDraft">保存修改</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="deleteOpen"
      title="删除这本书？"
      :description="`“${book.title}”的书籍记录、阅读位置、标注和关联笔记引用将从书库移除。外部来源文件夹中的原文件会保留，删除墓碑会同步到其他设备。`"
      width="small"
      @close="deleteOpen = false"
    >
      <div class="delete-book-warning"><Trash2 :size="20" /><span>此操作无法仅通过本地 UI 撤销，请先导出书籍或确认已有备份。</span></div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="deleteOpen = false">取消</button>
        <button class="button button--danger" type="button" @click="confirmDelete">删除书籍</button>
      </template>
    </DialogPanel>
  </div>

  <div v-else class="page-view">
    <PageHeader title="书籍未找到" description="这本书可能已从本机书架移除，或尚未同步到当前设备。" back-label="返回书架" @back="app.navigate('bookshelf')" />
    <EmptyState title="无法打开书籍详情" description="返回书架选择现有书籍，或检查同步状态。" action-label="返回书架" @action="app.navigate('bookshelf')" />
  </div>
</template>

<style scoped>
.book-detail-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.detail-hero {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr) auto;
  gap: clamp(1.25rem, 3vw, 2.25rem);
  padding: clamp(1.25rem, 3vw, 2.1rem);
  background:
    radial-gradient(circle at 95% 5%, color-mix(in srgb, var(--accent-soft) 80%, transparent), transparent 35%),
    var(--surface);
}

.detail-hero__cover {
  width: 180px;
}

.detail-hero__copy {
  min-width: 0;
  align-self: center;
}

.detail-hero__kicker {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  color: var(--accent-strong);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.detail-hero__kicker span + span::before {
  margin-right: 0.45rem;
  content: '·';
}

.detail-hero h1 {
  overflow-wrap: anywhere;
  margin: 0.5rem 0 0;
  font-family: var(--font-display);
  font-size: clamp(2.5rem, 5vw, 4.5rem);
  font-weight: 600;
  letter-spacing: -0.045em;
  line-height: 0.98;
}

.detail-hero__authors {
  margin: 0.55rem 0 0;
  color: var(--text-secondary);
  font-size: 1rem;
}

.detail-hero__description {
  display: -webkit-box;
  overflow: hidden;
  max-width: 72ch;
  margin: 0.85rem 0 0;
  color: var(--text-secondary);
  line-height: 1.7;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}

.detail-hero__actions,
.detail-hero__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1rem;
}

.button--favorite[aria-pressed='true'] {
  color: var(--danger);
  background: var(--danger-soft);
}

.tag-color {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.detail-progress {
  display: flex;
  min-width: 150px;
  align-items: center;
  align-self: center;
  flex-direction: column;
  gap: 0.45rem;
  text-align: center;
}

.detail-progress :deep(.progress-ring__content strong) {
  color: var(--text);
  font-size: 1rem;
}

.detail-progress > span {
  color: var(--text-secondary);
  font-size: 0.74rem;
}

.detail-progress > small {
  color: var(--text-tertiary);
  font-size: 0.66rem;
}

.file-alert {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.9rem 1rem;
  border: 1px solid color-mix(in srgb, var(--warning) 36%, var(--border));
  border-radius: 14px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 8%, var(--surface));
}

.file-alert div {
  min-width: 0;
  flex: 1;
}

.file-alert p {
  margin: 0.2rem 0 0;
  color: var(--text-secondary);
  line-height: 1.55;
}

.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(280px, 0.7fr);
  gap: 1rem;
}

.detail-grid--activity {
  grid-template-columns: 1fr 1fr;
}

.metadata-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
  margin: 0;
}

.metadata-grid div {
  display: grid;
  grid-template-columns: 95px minmax(0, 1fr);
  gap: 0.5rem;
  padding: 0.65rem 0;
  border-bottom: 1px solid var(--border);
}

.metadata-grid dt {
  color: var(--text-tertiary);
  font-size: 0.73rem;
}

.metadata-grid dd {
  overflow: hidden;
  margin: 0;
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono);
}

.location-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.6rem;
}

.location-facts div {
  display: grid;
  gap: 0.15rem;
  padding: 0.75rem;
  border-radius: 12px;
  background: var(--surface-muted);
}

.location-facts span {
  color: var(--text-tertiary);
  font-size: 0.66rem;
}

.location-facts strong {
  font-family: var(--font-display);
  font-size: 1.35rem;
  font-weight: 600;
}

blockquote {
  margin: 1rem 0 0;
  padding: 0.75rem 0.9rem;
  border-left: 2px solid var(--accent);
  color: var(--text-secondary);
  background: var(--accent-wash);
  font-family: var(--font-display);
  font-size: 1.05rem;
  font-style: italic;
}

.annotation-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}

.annotation-summary span {
  padding: 0.24rem 0.5rem;
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--surface-muted);
  font-size: 0.68rem;
}

.annotation-icon {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 10px;
  color: var(--accent);
  background: var(--accent-soft);
}

.note-link {
  width: 100%;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
}

.option-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem 1.1rem;
}

.delete-book-warning {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.8rem;
  border-radius: 12px;
  color: var(--danger);
  background: var(--danger-soft);
}

@media (max-width: 900px) {
  .detail-hero {
    grid-template-columns: 145px minmax(0, 1fr);
  }

  .detail-hero__cover {
    width: 145px;
  }

  .detail-progress {
    grid-column: 1 / -1;
    flex-direction: row;
    justify-content: flex-start;
    text-align: left;
  }

  .detail-grid,
  .detail-grid--activity {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 580px) {
  .detail-hero {
    grid-template-columns: 112px minmax(0, 1fr);
    padding: 1rem;
  }

  .detail-hero__cover {
    width: 112px;
  }

  .detail-hero h1 {
    font-size: 2.2rem;
  }

  .detail-hero__description {
    grid-column: 1 / -1;
  }

  .metadata-grid {
    grid-template-columns: 1fr;
  }

  .file-alert {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}
</style>

