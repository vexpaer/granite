<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudCog,
  CloudOff,
  Database,
  FolderOpen,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import { hostCall } from '../services/host';
import DialogPanel from '../components/DialogPanel.vue';
import PageHeader from '../components/PageHeader.vue';
import ProgressRing from '../components/ProgressRing.vue';
import { formatDateTime, relativeTime } from '../components/utils';
import type { ProviderProfile } from '../types';

const app = useApp();
const providerOpen = ref(false);
const removeOpen = ref(false);
const secret = ref('');
const savingProvider = ref(false);
const savingPolicy = ref(false);
const providerDraft = ref<ProviderProfile>({
  id: crypto.randomUUID(),
  type: 'webdav',
  name: '',
  endpoint: '',
  username: '',
  prefix: 'Granite',
  credentialId: crypto.randomUUID(),
});

const provider = computed(() => app.settings.provider);
const isSyncing = computed(() => ['syncing', 'preparing', 'uploading', 'downloading'].some((value) => String(app.syncStatus).toLowerCase().includes(value)));
const statusTone = computed(() => {
  const status = String(app.syncStatus).toLowerCase();
  if (status.includes('error') || status.includes('fail') || status.includes('offline')) return 'danger';
  if (status.includes('success') || app.syncHistory[0]?.status === 'success') return 'success';
  if (status === 'unconfigured') return 'muted';
  return 'accent';
});
const statusLabel = computed(() => {
  if (!provider.value) return '尚未配置 Provider';
  const status = String(app.syncStatus);
  return {
    unconfigured: '尚未配置',
    idle: '等待同步',
    syncing: '正在同步',
    cancelled: '已取消',
    error: '同步失败',
  }[status] || status;
});
const history = computed(() => [...app.syncHistory].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));

function openProviderEditor(type?: ProviderProfile['type']) {
  providerDraft.value = provider.value
    ? JSON.parse(JSON.stringify(provider.value))
    : {
        id: crypto.randomUUID(),
        type: type || 'webdav',
        name: '',
        endpoint: '',
        username: '',
        prefix: 'Granite',
        credentialId: crypto.randomUUID(),
      };
  secret.value = '';
  providerOpen.value = true;
}

function setProviderType(type: ProviderProfile['type']) {
  providerDraft.value.type = type;
  providerDraft.value.name = providerDraft.value.name || (type === 'webdav' ? 'WebDAV' : 'S3-compatible');
}

async function saveProvider() {
  savingProvider.value = true;
  try {
    if (secret.value) {
      await hostCall('credential.set', {
        id: providerDraft.value.credentialId,
        secret: secret.value,
      });
    }
    app.settings.provider = JSON.parse(JSON.stringify(providerDraft.value));
    await app.saveSettings();
    secret.value = '';
    providerOpen.value = false;
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error);
  } finally {
    savingProvider.value = false;
  }
}

async function removeProvider() {
  if (provider.value) {
    try {
      await hostCall('credential.delete', { id: provider.value.credentialId });
    } catch {
      // Removing the local provider binding must not be blocked by a stale native credential.
    }
  }
  app.settings.provider = undefined;
  app.syncStatus = 'unconfigured';
  await app.saveSettings();
  removeOpen.value = false;
}

function toggleSelection(list: 'syncBookIds' | 'syncCollectionIds', id: string) {
  const current = app.settings[list];
  app.settings[list] = current.includes(id)
    ? current.filter((value) => value !== id)
    : [...current, id];
}

async function savePolicy() {
  savingPolicy.value = true;
  try {
    await app.saveSettings();
  } finally {
    savingPolicy.value = false;
  }
}
</script>

<template>
  <div class="sync-view page-view">
    <PageHeader title="同步与存储" description="书籍文件与同步元数据共用同一个 Provider。本机路径和凭证不会进入同步文档。">
      <template #actions>
        <button v-if="app.conflicts.length" class="button button--secondary" type="button" @click="app.navigate('conflicts')">
          <AlertTriangle :size="16" />处理 {{ app.conflicts.length }} 个冲突
        </button>
        <button v-if="isSyncing" class="button button--danger" type="button" @click="app.cancelSync()"><X :size="16" />取消同步</button>
        <button v-else class="button button--primary" type="button" :disabled="!provider || app.busy" @click="app.sync()"><RefreshCw :size="16" />立即同步</button>
      </template>
    </PageHeader>

    <section class="sync-hero surface-card" :class="`sync-hero--${statusTone}`">
      <div class="sync-hero__icon">
        <CloudOff v-if="statusTone === 'danger'" :size="23" />
        <CloudCog v-else-if="isSyncing" :size="23" />
        <CheckCircle2 v-else-if="statusTone === 'success'" :size="23" />
        <Cloud v-else :size="23" />
      </div>
      <div class="sync-hero__copy">
        <h2>{{ statusLabel }}</h2>
        <p v-if="provider">{{ provider.name }} · {{ provider.type === 's3' ? 'S3-compatible' : 'WebDAV' }} · {{ provider.endpoint }}</p>
        <p v-else>配置 WebDAV 或 S3-compatible Provider 后，可在设备之间同步。Granite 不要求官方账户。</p>
      </div>
      <div v-if="isSyncing" class="sync-progress">
        <ProgressRing :value="app.syncProgress * 100" :size="76" :stroke="6" :label="`同步进度 ${Math.round(app.syncProgress * 100)}%`">
          <strong>{{ Math.round(app.syncProgress * 100) }}%</strong>
        </ProgressRing>
      </div>
      <button v-if="!provider" class="button button--primary" type="button" @click="openProviderEditor()"><Plus :size="16" />配置 Provider</button>
    </section>

    <div class="sync-layout">
      <section class="surface-card section-card">
        <div class="section-heading"><h2>存储 Provider</h2><button v-if="provider" type="button" @click="openProviderEditor()">编辑</button></div>
        <div v-if="provider" class="provider-card">
          <div class="provider-card__top">
            <span class="provider-type">{{ provider.type === 's3' ? 'S3' : 'WebDAV' }}</span>
            <strong>{{ provider.name }}</strong>
            <span class="status-dot" :class="statusTone === 'success' ? 'status-dot--success' : statusTone === 'danger' ? 'status-dot--danger' : 'status-dot--warning'"></span>
          </div>
          <dl>
            <div><dt>Endpoint</dt><dd>{{ provider.endpoint }}</dd></div>
            <div v-if="provider.username"><dt>账户</dt><dd>{{ provider.username }}</dd></div>
            <div v-if="provider.region"><dt>Region</dt><dd>{{ provider.region }}</dd></div>
            <div v-if="provider.bucket"><dt>Bucket</dt><dd>{{ provider.bucket }}</dd></div>
            <div><dt>同步前缀</dt><dd>{{ provider.prefix || 'Granite' }}</dd></div>
            <div><dt>凭证</dt><dd><ShieldCheck :size="14" />由原生安全存储管理</dd></div>
          </dl>
          <div class="provider-card__actions">
            <button class="button button--secondary button--small" type="button" @click="openProviderEditor()"><KeyRound :size="14" />更新凭证</button>
            <button class="button button--ghost button--small danger" type="button" @click="removeOpen = true"><Trash2 :size="14" />移除 Provider</button>
          </div>
        </div>
        <div v-else class="provider-empty">
          <Cloud :size="25" />
          <h3>选择一个 Provider</h3>
          <p>书籍原文件和同步元数据共用此连接；不会允许混用两个 Provider。</p>
          <div class="inline-actions">
            <button class="button button--primary" type="button" @click="openProviderEditor('webdav')">配置 WebDAV</button>
            <button class="button button--secondary" type="button" @click="openProviderEditor('s3')">配置 S3-compatible</button>
          </div>
        </div>
      </section>

      <section class="surface-card section-card">
        <div class="section-heading"><h2>本地书库</h2><button type="button" @click="app.navigate('settings', 'library')">管理</button></div>
        <div v-if="app.roots.length" class="data-list">
          <div v-for="root in app.roots" :key="root.id" class="data-row">
            <span class="root-icon"><FolderOpen :size="16" /></span>
            <div class="data-row__body">
              <strong>{{ root.displayName }} <span v-if="root.isDefault" class="tag-chip tag-chip--soft">默认</span></strong>
              <span>{{ root.permission }} · {{ root.enabled ? '参与扫描' : '已暂停扫描' }}</span>
            </div>
          </div>
        </div>
        <div v-else class="mini-empty">尚未关联本地书库文件夹。</div>
        <p class="storage-note"><ShieldCheck :size="14" />本机绝对路径或 SAF URI 只保存在当前设备，不进入 Provider 同步文档。</p>
      </section>
    </div>

    <section class="surface-card section-card">
      <div class="section-heading"><h2>同步策略</h2><span class="muted">切换策略不会删除云端文件</span></div>
      <div class="policy-grid" role="radiogroup" aria-label="同步策略">
        <label v-for="policy in [
          { id: 'full', title: '全量同步', detail: '同步元数据与全部书籍文件。' },
          { id: 'metadata', title: '仅元数据', detail: '只同步进度、笔记、标签和设置。' },
          { id: 'selected', title: '指定内容', detail: '仅同步选中的书籍与集合。' },
          { id: 'on-demand', title: '元数据优先', detail: '打开书籍时按需下载文件。' },
        ]" :key="policy.id" :class="{ 'is-active': app.settings.syncPolicy === policy.id }">
          <input v-model="app.settings.syncPolicy" type="radio" name="sync-policy" :value="policy.id" />
          <span><strong>{{ policy.title }}</strong><small>{{ policy.detail }}</small></span>
        </label>
      </div>
      <div v-if="app.settings.syncPolicy === 'selected'" class="selected-sync-content">
        <div class="selector-column">
          <h3>书籍</h3>
          <div v-if="app.books.length" class="selector-list">
            <label v-for="book in app.books" :key="book.id" class="checkbox-line">
              <input type="checkbox" :checked="app.settings.syncBookIds.includes(book.id)" @change="toggleSelection('syncBookIds', book.id)" />
              <span>{{ book.title }}</span>
            </label>
          </div>
          <p v-else>书架为空。</p>
        </div>
        <div class="selector-column">
          <h3>集合</h3>
          <div v-if="app.collections.length" class="selector-list">
            <label v-for="collection in app.collections" :key="collection.id" class="checkbox-line">
              <input type="checkbox" :checked="app.settings.syncCollectionIds.includes(collection.id)" @change="toggleSelection('syncCollectionIds', collection.id)" />
              <span>{{ collection.name }}</span>
            </label>
          </div>
          <p v-else>尚无集合。</p>
        </div>
      </div>
      <div class="policy-footer">
        <span><ShieldCheck :size="14" />未下载不代表删除；删除操作通过墓碑传播。</span>
        <button class="button button--primary" type="button" :disabled="savingPolicy" @click="savePolicy">{{ savingPolicy ? '保存中' : '保存策略' }}</button>
      </div>
    </section>

    <div class="sync-layout sync-layout--bottom">
      <section class="surface-card section-card">
        <div class="section-heading"><h2>同步历史</h2><span>{{ history.length }} 条</span></div>
        <div v-if="history.length" class="data-list">
          <div v-for="item in history" :key="item.id" class="data-row">
            <span class="history-icon" :class="`history-icon--${item.status}`">
              <CheckCircle2 v-if="item.status === 'success'" :size="16" />
              <AlertTriangle v-else-if="item.status === 'error'" :size="16" />
              <X v-else :size="16" />
            </span>
            <div class="data-row__body">
              <strong>{{ item.message }}</strong>
              <span>{{ formatDateTime(item.at) }} · {{ relativeTime(item.at) }}</span>
            </div>
            <span class="tag-chip">{{ item.status }}</span>
          </div>
        </div>
        <div v-else class="mini-empty">还没有同步历史。</div>
      </section>

      <section class="surface-card section-card">
        <div class="section-heading"><h2>冲突与恢复</h2><span>{{ app.conflicts.length }}</span></div>
        <div v-if="app.conflicts.length" class="conflict-prompt">
          <AlertTriangle :size="24" />
          <strong>{{ app.conflicts.length }} 个对象等待确认</strong>
          <p>双方版本都会保留，只有确认后才写入解决结果。</p>
          <button class="button button--primary" type="button" @click="app.navigate('conflicts')">查看并处理</button>
        </div>
        <div v-else class="no-conflict">
          <CheckCircle2 :size="24" />
          <strong>没有待处理冲突</strong>
          <p>同步冲突会显示来源设备、时间和双方内容。</p>
        </div>
      </section>
    </div>

    <DialogPanel
      v-if="providerOpen"
      :title="provider ? '编辑 Provider' : '配置 Provider'"
      description="凭证交给原生安全存储；应用设置只保存 credentialId，不保存明文秘密。"
      @close="providerOpen = false"
    >
      <form class="provider-form form-grid" @submit.prevent="saveProvider">
        <div class="provider-type-choice form-field--full">
          <button type="button" :class="{ 'is-active': providerDraft.type === 'webdav' }" @click="setProviderType('webdav')">WebDAV<small>Nextcloud、坚果云、群晖与通用 WebDAV</small></button>
          <button type="button" :class="{ 'is-active': providerDraft.type === 's3' }" @click="setProviderType('s3')">S3-compatible<small>AWS S3、R2、MinIO、Backblaze B2 等</small></button>
        </div>
        <label class="form-field">
          <span>显示名称</span>
          <input v-model="providerDraft.name" class="field" required placeholder="例如：个人 WebDAV" />
        </label>
        <label class="form-field">
          <span>Endpoint</span>
          <input v-model="providerDraft.endpoint" class="field" type="url" required placeholder="https://" />
        </label>
        <template v-if="providerDraft.type === 'webdav'">
          <label class="form-field">
            <span>用户名</span>
            <input v-model="providerDraft.username" class="field" autocomplete="username" />
          </label>
        </template>
        <template v-else>
          <label class="form-field">
            <span>Region</span>
            <input v-model="providerDraft.region" class="field" />
          </label>
          <label class="form-field">
            <span>Bucket</span>
            <input v-model="providerDraft.bucket" class="field" />
          </label>
          <label class="form-field">
            <span>Access Key ID</span>
            <input v-model="providerDraft.accessKeyId" class="field" autocomplete="off" />
          </label>
        </template>
        <label class="form-field">
          <span>同步前缀</span>
          <input v-model="providerDraft.prefix" class="field" placeholder="Granite" />
        </label>
        <label class="form-field">
          <span>{{ providerDraft.type === 'webdav' ? '应用专用密码' : 'Secret Access Key' }}</span>
          <input v-model="secret" class="field" type="password" autocomplete="new-password" :required="!provider" :placeholder="provider ? '留空则保留现有凭证' : '仅在保存时传入原生安全存储'" />
        </label>
        <div class="credential-note form-field--full"><ShieldCheck :size="17" /><span>秘密字段不会写入应用设置、同步备份或日志。浏览器预览不提供系统凭证存储。</span></div>
      </form>
      <template #footer>
        <button class="button button--ghost" type="button" @click="providerOpen = false">取消</button>
        <button class="button button--primary" type="button" :disabled="savingProvider" @click="saveProvider">{{ savingProvider ? '保存中' : '保存 Provider' }}</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="removeOpen"
      title="移除 Provider？"
      description="本地和云端数据不会被删除；同步将暂停，直到配置新的 Provider。"
      width="small"
      @close="removeOpen = false"
    >
      <div class="remove-provider-note"><Database :size="19" /><span>原生凭证也会从当前设备的安全存储中移除。</span></div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="removeOpen = false">取消</button>
        <button class="button button--danger" type="button" @click="removeProvider">移除 Provider</button>
      </template>
    </DialogPanel>
  </div>
</template>

<style scoped>
.sync-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.sync-hero {
  display: flex;
  min-height: 145px;
  align-items: center;
  gap: 1rem;
  padding: 1.35rem;
  background:
    radial-gradient(circle at 95% 0, color-mix(in srgb, var(--accent-soft) 80%, transparent), transparent 34%),
    var(--surface);
}

.sync-hero__icon {
  display: grid;
  width: 52px;
  height: 52px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 16px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.sync-hero--success .sync-hero__icon {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, var(--surface-elevated));
}

.sync-hero--danger .sync-hero__icon {
  color: var(--danger);
  background: var(--danger-soft);
}

.sync-hero__copy {
  min-width: 0;
  flex: 1;
}

.sync-hero h2 {
  margin: 0.25rem 0 0;
  font-family: var(--font-display);
  font-size: 2rem;
  font-weight: 600;
}

.sync-hero p {
  overflow: hidden;
  margin: 0.2rem 0 0;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-progress :deep(.progress-ring__content strong) {
  color: var(--text);
  font-size: 0.8rem;
}

.sync-layout {
  display: grid;
  grid-template-columns: 1.4fr 0.7fr;
  gap: 1rem;
}

.sync-layout--bottom {
  grid-template-columns: 1fr 1fr;
}

.provider-card {
  display: grid;
  gap: 0.75rem;
}

.provider-card__top {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}

.provider-type {
  padding: 0.2rem 0.4rem;
  border-radius: 6px;
  color: var(--accent-strong);
  background: var(--accent-soft);
  font-size: 0.75rem;
  font-weight: 750;
}

.provider-card__top strong {
  flex: 1;
}

.provider-card dl {
  display: grid;
  gap: 0;
  margin: 0;
}

.provider-card dl div {
  display: grid;
  grid-template-columns: 95px minmax(0, 1fr);
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}

.provider-card dt {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.provider-card dd {
  display: flex;
  overflow: hidden;
  align-items: center;
  gap: 0.3rem;
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.provider-empty,
.mini-empty,
.no-conflict {
  display: grid;
  min-height: 190px;
  place-items: center;
  align-content: center;
  gap: 0.5rem;
  padding: 1rem;
  border: 1px dashed var(--border-strong);
  border-radius: 14px;
  color: var(--text-secondary);
  text-align: center;
}

.provider-empty h3 {
  margin: 0;
  color: var(--text);
  font-family: var(--font-display);
  font-size: 1.45rem;
  font-weight: 600;
}

.provider-empty p {
  max-width: 50ch;
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.6;
}

.root-icon,
.history-icon {
  display: grid;
  width: 33px;
  height: 33px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.storage-note,
.policy-footer > span {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--text-tertiary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.policy-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.6rem;
}

.policy-grid label {
  display: flex;
  min-height: 92px;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.8rem;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-elevated);
}

.policy-grid label.is-active {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
  background: var(--accent-wash);
}

.policy-grid input {
  margin-top: 0.2rem;
  accent-color: var(--accent);
}

.policy-grid label > span {
  display: grid;
  gap: 0.2rem;
}

.policy-grid strong {
  font-size: 0.75rem;
}

.policy-grid small {
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.selected-sync-content {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  padding: 1rem 0;
  border-top: 1px solid var(--border);
  margin-top: 1rem;
}

.selector-column h3 {
  margin: 0 0 0.5rem;
  font-size: 0.76rem;
}

.selector-list {
  display: grid;
  max-height: 190px;
  gap: 0.4rem;
  overflow-y: auto;
}

.selector-list .checkbox-line {
  font-size: 0.75rem;
}

.policy-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  margin-top: 1rem;
}

.history-icon--success {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, var(--surface-elevated));
}

.history-icon--error {
  color: var(--danger);
  background: var(--danger-soft);
}

.history-icon--cancelled {
  color: var(--warning);
}

.conflict-prompt {
  display: grid;
  min-height: 190px;
  place-items: center;
  align-content: center;
  gap: 0.45rem;
  padding: 1rem;
  border-radius: 13px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 8%, var(--surface-elevated));
  text-align: center;
}

.conflict-prompt p,
.no-conflict p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.no-conflict {
  color: var(--success);
}

.provider-type-choice {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
}

.provider-type-choice button {
  display: grid;
  gap: 0.25rem;
  padding: 0.8rem;
  border: 1px solid var(--border);
  border-radius: 11px;
  color: var(--text);
  background: var(--surface-muted);
  text-align: left;
}

.provider-type-choice button.is-active {
  border-color: var(--accent);
  background: var(--accent-wash);
}

.provider-type-choice small {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.credential-note {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  padding: 0.7rem;
  border-radius: 10px;
  color: var(--text-secondary);
  background: var(--surface-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.remove-provider-note {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.75rem;
  border-radius: 10px;
  color: var(--danger);
  background: var(--danger-soft);
}

@media (max-width: 900px) {
  .sync-layout,
  .sync-layout--bottom {
    grid-template-columns: 1fr;
  }

  .policy-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 560px) {
  .sync-hero {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .sync-hero > .button {
    width: 100%;
  }

  .policy-grid,
  .selected-sync-content,
  .provider-type-choice {
    grid-template-columns: 1fr;
  }

  .policy-footer {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>

