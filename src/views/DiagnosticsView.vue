<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Code2,
  Database,
  Download,
  ExternalLink,
  HeartPulse,
  Info,
  Laptop,
  PackageCheck,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Waypoints,
} from 'lucide-vue-next';
import packageInfo from '../../package.json';
import { useApp } from '../stores/app';
import { hostCall } from '../services/host';
import DialogPanel from '../components/DialogPanel.vue';
import PageHeader from '../components/PageHeader.vue';
import { formatDateTime, relativeTime } from '../components/utils';

const app = useApp();
const runtime = ref<Record<string, unknown> | null>(null);
const loading = ref(false);
const runtimeError = ref('');
const exportOpen = ref(false);
const exporting = ref(false);
const copied = ref(false);

const licenseRows = [
  { name: 'Granite', version: packageInfo.version, license: packageInfo.license, purpose: '应用本体' },
  { name: 'Vue', version: '3.5', license: 'MIT', purpose: '界面框架' },
  { name: 'Tauri', version: '2', license: 'MIT / Apache-2.0', purpose: 'Windows 与 Android 原生宿主' },
  { name: 'Cordis', version: '3', license: 'MIT', purpose: '插件运行时' },
  { name: 'PDF.js', version: '5', license: 'Apache-2.0', purpose: 'PDF 渲染与文本层' },
  { name: 'EPUB.js', version: '0.3', license: 'BSD-2-Clause', purpose: 'EPUB 阅读' },
  { name: 'Lucide', version: '0.468', license: 'ISC', purpose: '界面图标' },
  { name: 'Marked', version: '16', license: 'MIT', purpose: 'Markdown 渲染' },
  { name: 'DOMPurify', version: '3.3', license: 'MPL-2.0 / Apache-2.0', purpose: 'Markdown 清理' },
];

const runtimeRows = computed(() => {
  const value = runtime.value || {};
  return [
    { label: '应用版本', value: String(value.app_version || packageInfo.version) },
    { label: '运行平台', value: [value.platform, value.architecture].filter(Boolean).join(' · ') || '读取中' },
    { label: 'Tauri', value: String(value.tauri_version || '—') },
    { label: '原生宿主', value: value.native === true ? '已连接' : value.native === false ? '浏览器预览' : '读取中' },
    { label: '数据存储', value: String(value.database || value.note || '读取中') },
  ];
});

const providerState = computed(() => {
  const provider = app.settings.provider;
  if (!provider) return '尚未配置';
  return `${provider.type === 's3' ? 'S3-compatible' : 'WebDAV'} · ${app.syncStatus}`;
});
const pluginErrors = computed(() => app.plugins.filter((plugin) => plugin.error));
const latestSync = computed(() => app.syncHistory[0]);
const issueCount = computed(
  () =>
    pluginErrors.value.length +
    (app.error ? 1 : 0) +
    (app.conflicts.length ? 1 : 0) +
    app.roots.filter((root) => root.permission === 'denied' || root.permission === 'unavailable').length,
);

function valueOf(key: string) {
  const value = runtime.value?.[key];
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

function buildReport() {
  return {
    schema: 'granite-diagnostics-v1',
    generatedAt: new Date().toISOString(),
    runtime: runtime.value || { error: runtimeError.value || 'not loaded' },
    application: {
      version: packageInfo.version,
      license: packageInfo.license,
      route: app.route.name,
      dataSchemaVersion: app.schemaVersion,
      revision: app.revision,
      dataCounts: {
        books: app.books.length,
        notes: app.notes.length,
        annotations: app.annotations.length,
        sessions: app.sessions.length,
        tags: app.tags.length,
        collections: app.collections.length,
      },
    },
    storage: {
      rootCount: app.roots.length,
      roots: app.roots.map((root) => ({
        name: root.displayName,
        kind: root.kind,
        permission: root.permission,
        enabled: root.enabled,
        readonly: root.readonly,
        scanState: root.scanState,
      })),
      provider: app.settings.provider
        ? {
            type: app.settings.provider.type,
            name: app.settings.provider.name,
            region: app.settings.provider.region,
            bucketConfigured: Boolean(app.settings.provider.bucket),
            prefixConfigured: Boolean(app.settings.provider.prefix),
          }
        : null,
      syncStatus: app.syncStatus,
      pendingConflictCount: app.conflicts.length,
    },
    plugins: app.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      enabled: plugin.enabled,
      permissions: plugin.permissions,
      error: plugin.error || null,
    })),
    currentError: app.error || null,
    privacy: {
      excluded: [
        '书籍与笔记正文',
        '本机绝对路径和 Android SAF URI',
        'Provider 凭证及 credentialId',
        '插件 Bundle',
      ],
    },
  };
}

async function loadRuntime() {
  loading.value = true;
  runtimeError.value = '';
  try {
    runtime.value = await hostCall<Record<string, unknown>>('diagnostics');
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(buildReport(), null, 2));
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1800);
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error);
  }
}

async function exportReport() {
  exporting.value = true;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(buildReport(), null, 2));
    await hostCall('backup.export', {
      filename: `Granite-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      bytes: Array.from(bytes),
    });
    exportOpen.value = false;
    app.notify('已保存脱敏诊断报告');
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error);
  } finally {
    exporting.value = false;
  }
}

onMounted(loadRuntime);
</script>

<template>
  <div class="diagnostics-view page-view">
    <PageHeader
      title="关于与诊断"
      description="查看真实运行环境、数据状态、插件错误和脱敏诊断信息。内容只在本机生成，由你主动导出。"
      back-label="返回上一页"
      @back="app.back()"
    >
      <template #actions>
        <button class="button button--secondary" type="button" :disabled="loading" @click="loadRuntime">
          <RefreshCw :size="16" :class="{ 'is-spinning': loading }" />{{ loading ? '读取中' : '刷新状态' }}
        </button>
        <button class="button button--primary" type="button" @click="exportOpen = true">
          <Download :size="16" />导出诊断报告
        </button>
      </template>
    </PageHeader>

    <section class="about-herald surface-card">
      <div class="about-herald__mark">G</div>
      <div>
        <h2>Granite</h2>
        <p>安静、本地优先、可由插件扩展的数字书房。</p>
        <span>v{{ packageInfo.version }} · {{ packageInfo.license }}</span>
      </div>
      <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer noopener">
        查看许可证<ExternalLink :size="13" />
      </a>
    </section>

    <section class="health-grid">
      <article class="surface-card">
        <span class="health-icon" :class="{ 'health-icon--warning': issueCount }">
          <HeartPulse :size="21" />
        </span>
        <div>
          <strong>{{ issueCount ? `${issueCount} 项需要查看` : '核心状态正常' }}</strong>
          <p>{{ issueCount ? '包含同步、插件、书库权限或最近错误。' : '未发现插件错误、同步冲突或不可用书库。' }}</p>
        </div>
      </article>
      <article class="surface-card">
        <span class="health-icon"><Database :size="21" /></span>
        <div>
          <strong>{{ app.books.length }} 本书 · {{ app.notes.length }} 篇笔记</strong>
          <p>{{ app.annotations.length }} 条标注 · {{ app.sessions.length }} 个阅读会话</p>
        </div>
      </article>
      <article class="surface-card">
        <span class="health-icon"><Waypoints :size="21" /></span>
        <div>
          <strong>{{ providerState }}</strong>
          <p>{{ latestSync ? `${relativeTime(latestSync.at)} · ${latestSync.status}` : '尚未产生同步记录' }}</p>
        </div>
      </article>
    </section>

    <div class="diagnostics-columns">
      <section class="surface-card section-card">
        <div class="section-heading">
          <h2>运行环境</h2>
          <span class="section-state"><CheckCircle2 v-if="!runtimeError" :size="14" />{{ runtimeError ? '读取失败' : '已读取' }}</span>
        </div>
        <div v-if="runtimeError" class="runtime-error" role="alert">
          <AlertTriangle :size="17" />{{ runtimeError }}
        </div>
        <dl v-else class="runtime-list">
          <div v-for="row in runtimeRows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </div>
        </dl>
      </section>

      <section class="surface-card section-card">
        <div class="section-heading">
          <h2>当前状态</h2>
          <span class="section-state"><Laptop :size="14" />本机</span>
        </div>
        <div class="state-list">
          <div><span><Database :size="16" />数据版本</span><strong>Schema {{ app.schemaVersion }} · Revision {{ app.revision }}</strong></div>
          <div><span><ShieldCheck :size="16" />书库权限</span><strong>{{ app.roots.filter((root) => root.permission === 'granted').length }} / {{ app.roots.length }} 可访问</strong></div>
          <div><span><PlugZap :size="16" />插件</span><strong>{{ app.plugins.filter((plugin) => plugin.enabled).length }} 启用 · {{ pluginErrors.length }} 错误</strong></div>
          <div><span><Info :size="16" />待处理冲突</span><strong>{{ app.conflicts.length }}</strong></div>
        </div>
      </section>
    </div>

    <section class="surface-card section-card">
      <div class="section-heading">
        <h2>最近问题</h2>
        <button type="button" @click="app.navigate('sync')">打开同步与存储</button>
      </div>
      <div v-if="app.error || pluginErrors.length || app.conflicts.length" class="issue-list">
        <article v-if="app.error">
          <AlertTriangle :size="17" />
          <div><strong>应用最近错误</strong><p>{{ app.error }}</p></div>
        </article>
        <article v-for="plugin in pluginErrors" :key="plugin.id">
          <PlugZap :size="17" />
          <div><strong>{{ plugin.name }} 插件错误</strong><p>{{ plugin.error }}</p></div>
        </article>
        <article v-if="app.conflicts.length">
          <Waypoints :size="17" />
          <div><strong>{{ app.conflicts.length }} 个同步冲突</strong><p>双方版本仍保留，等待你确认。</p></div>
          <button class="button button--secondary button--small" type="button" @click="app.navigate('conflicts')">查看冲突</button>
        </article>
      </div>
      <div v-else class="no-issues">
        <CheckCircle2 :size="22" />
        <div><strong>没有记录的运行错误</strong><p>此区域只显示应用和插件当前真实保存的错误状态。</p></div>
      </div>
    </section>

    <section class="surface-card section-card">
      <div class="section-heading">
        <h2>开源与第三方组件</h2>
        <span>{{ licenseRows.length }} 项</span>
      </div>
      <div class="license-list">
        <div v-for="item in licenseRows" :key="item.name">
          <span class="license-icon"><Code2 :size="16" /></span>
          <span><strong>{{ item.name }}</strong><small>{{ item.purpose }}</small></span>
          <span>v{{ item.version }}</span>
          <code>{{ item.license }}</code>
        </div>
      </div>
      <p class="license-note">版本号表示当前主版本；完整依赖许可证随源代码与发布包中的许可证文件提供。</p>
    </section>

    <section class="privacy-card surface-card">
      <ShieldCheck :size="22" />
      <div>
        <h2>诊断报告默认脱敏</h2>
        <p>不会包含书籍与笔记正文、书库绝对路径、SAF URI、Provider 凭证、credentialId 或插件 Bundle。导出使用系统保存对话框，位置由你选择。</p>
      </div>
      <div class="privacy-actions">
        <button class="button button--secondary" type="button" @click="copyReport">
          <Clipboard :size="15" />{{ copied ? '已复制' : '复制摘要' }}
        </button>
        <button class="button button--primary" type="button" @click="exportOpen = true">
          <Download :size="15" />导出报告
        </button>
      </div>
    </section>

    <DialogPanel
      v-if="exportOpen"
      title="导出脱敏诊断报告？"
      description="报告用于排查兼容性、权限、同步和插件问题，不会上传或自动发送。"
      width="small"
      @close="exportOpen = false"
    >
      <ul class="export-contents">
        <li><PackageCheck :size="16" /><span><strong>包含</strong>应用版本、平台、数据计数、插件状态、书库权限与脱敏 Provider 状态。</span></li>
        <li><ShieldCheck :size="16" /><span><strong>不包含</strong>书籍与笔记正文、绝对路径、SAF URI、凭证、credentialId 和插件 Bundle。</span></li>
      </ul>
      <template #footer>
        <button class="button button--ghost" type="button" @click="exportOpen = false">取消</button>
        <button class="button button--primary" type="button" :disabled="exporting" @click="exportReport">
          <Download :size="15" />{{ exporting ? '正在保存' : '选择保存位置' }}
        </button>
      </template>
    </DialogPanel>
  </div>
</template>

<style scoped>
.diagnostics-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.is-spinning {
  animation: spin 0.8s linear infinite;
}

.about-herald {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.2rem 1.35rem;
  background:
    radial-gradient(circle at 85% 0, var(--accent-soft), transparent 35%),
    var(--surface);
}

.about-herald__mark {
  display: grid;
  width: 58px;
  height: 58px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  border-radius: 18px;
  color: #fff;
  background: linear-gradient(145deg, var(--lavender), var(--accent-strong));
  font-family: var(--font-display);
  font-size: 2.3rem;
  font-style: italic;
}

.about-herald div:nth-child(2) {
  min-width: 0;
  flex: 1;
}

.about-herald h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 2rem;
  font-weight: 600;
}

.about-herald p {
  margin: 0.1rem 0;
  color: var(--text-secondary);
}

.about-herald span {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.64rem;
}

.about-herald a {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.7rem;
  text-decoration: none;
}

.health-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.7rem;
}

.health-grid article {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.9rem;
}

.health-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 11px;
  color: var(--success);
  background: color-mix(in srgb, var(--success) 10%, var(--surface-elevated));
}

.health-icon--warning {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, var(--surface-elevated));
}

.health-grid article div {
  min-width: 0;
}

.health-grid strong {
  display: block;
  overflow: hidden;
  font-size: 0.76rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.health-grid p {
  overflow: hidden;
  margin: 0.15rem 0 0;
  color: var(--text-secondary);
  font-size: 0.66rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diagnostics-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.section-state {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--text-tertiary);
  font-size: 0.66rem;
}

.runtime-list {
  margin: 0;
}

.runtime-list div {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 0.6rem;
  padding: 0.62rem 0;
  border-bottom: 1px solid var(--border);
}

.runtime-list div:last-child {
  border-bottom: 0;
}

.runtime-list dt {
  color: var(--text-tertiary);
  font-size: 0.67rem;
}

.runtime-list dd {
  overflow: hidden;
  margin: 0;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.66rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-error {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  padding: 0.7rem;
  border-radius: 10px;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 0.7rem;
}

.state-list {
  display: grid;
}

.state-list > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 0.62rem 0;
  border-bottom: 1px solid var(--border);
}

.state-list > div:last-child {
  border-bottom: 0;
}

.state-list span {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.state-list strong {
  font-size: 0.68rem;
  text-align: right;
}

.issue-list {
  display: grid;
  gap: 0.45rem;
}

.issue-list article {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--warning) 24%, var(--border));
  border-radius: 11px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 5%, var(--surface-elevated));
}

.issue-list article > div {
  min-width: 0;
  flex: 1;
}

.issue-list strong {
  color: var(--text);
  font-size: 0.72rem;
}

.issue-list p {
  overflow-wrap: anywhere;
  margin: 0.12rem 0 0;
  color: var(--text-secondary);
  font-size: 0.67rem;
}

.no-issues {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.85rem;
  border-radius: 12px;
  color: var(--success);
  background: color-mix(in srgb, var(--success) 7%, var(--surface-elevated));
}

.no-issues p {
  margin: 0.15rem 0 0;
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.license-list {
  display: grid;
}

.license-list > div {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 70px 150px;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--border);
}

.license-list > div:last-child {
  border-bottom: 0;
}

.license-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 8px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.license-list > div > span:nth-child(2) {
  display: grid;
  gap: 0.08rem;
}

.license-list strong {
  font-size: 0.7rem;
}

.license-list small,
.license-list > div > span:nth-child(3) {
  color: var(--text-secondary);
  font-size: 0.64rem;
}

.license-list code {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.62rem;
}

.license-note {
  margin: 0.7rem 0 0;
  color: var(--text-tertiary);
  font-size: 0.64rem;
  line-height: 1.55;
}

.privacy-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.8rem;
  padding: 1.1rem 1.2rem;
  border-color: color-mix(in srgb, var(--success) 25%, var(--border));
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--success) 5%, var(--surface)), var(--surface));
}

.privacy-card > svg {
  color: var(--success);
}

.privacy-card h2 {
  margin: 0;
  font-size: 0.8rem;
}

.privacy-card p {
  max-width: 88ch;
  margin: 0.2rem 0 0;
  color: var(--text-secondary);
  font-size: 0.68rem;
  line-height: 1.55;
}

.privacy-actions {
  display: flex;
  gap: 0.45rem;
}

.export-contents {
  display: grid;
  gap: 0.55rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.export-contents li {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.55;
}

.export-contents li > svg {
  flex: 0 0 auto;
  margin-top: 0.15rem;
  color: var(--accent);
}

.export-contents strong {
  color: var(--text);
}

@media (max-width: 850px) {
  .health-grid,
  .diagnostics-columns {
    grid-template-columns: 1fr;
  }

  .privacy-card {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .privacy-actions {
    grid-column: 1 / -1;
  }
}

@media (max-width: 560px) {
  .about-herald {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .about-herald a {
    width: 100%;
    padding-left: calc(58px + 1rem);
  }

  .license-list > div {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .license-list code {
    grid-column: 2;
  }

  .privacy-actions {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
