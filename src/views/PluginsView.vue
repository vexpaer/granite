<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  Code2,
  ExternalLink,
  FileArchive,
  KeyRound,
  PackagePlus,
  PlugZap,
  ShieldOff,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Undo2,
} from 'lucide-vue-next';
import { useApp } from '../stores/app';
import DialogPanel from '../components/DialogPanel.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import type { InstalledPlugin } from '../types';
import type { PluginUiEntry } from '../services/plugin-manager';

const app = useApp();
const fileInput = ref<HTMLInputElement>();
const candidateFile = ref<File | null>(null);
const candidateManifest = ref<Record<string, unknown> | null>(null);
const candidateOrigin = ref<'local' | 'remote'>('local');
const reviewOpen = ref(false);
const permissionAccepted = ref(false);
const installing = ref(false);
const installError = ref('');
const remoteSourceUrl = ref('');
const stagingRemoteSource = ref(false);
const remoteSourceError = ref('');
const enableTarget = ref<InstalledPlugin | null>(null);
const enableAccepted = ref(false);
const expandedPlugin = ref('');
const uninstallTarget = ref<InstalledPlugin | null>(null);
const rollbackTarget = ref<InstalledPlugin | null>(null);
const revokeTarget = ref<{ plugin: InstalledPlugin; permission: string } | null>(null);
const changingSafeMode = ref(false);
const uiEntries = shallowRef<PluginUiEntry[]>([]);
let stopUiEntryWatch: (() => void) | undefined;

const permissionDescriptions: Record<string, string> = {
  'reader.observe': '观察阅读位置、活动状态和选中文字。',
  'reader.control': '控制阅读位置、翻页与阅读器动作。',
  'library.read': '读取书籍元数据、集合与标签。',
  'library.write': '修改书籍元数据、集合与标签。',
  'bookfile.read': '读取你已授权的书籍文件。',
  'bookfile.write': '写入书籍文件，可能修改原文件。',
  'annotation.read': '读取书签、高亮、批注和墨迹。',
  'annotation.write': '创建、修改或删除标注。',
  'network.request': '通过受限网络目标发送请求。',
  'storage.namespace': '使用该插件自己的持久化命名空间。',
  'sync.namespace': '读写该插件自己的同步命名空间。',
  'ui.register': '注册页面、面板、工具栏或 Widget。',
  notification: '发送系统或应用内通知。',
  'credential.use': '使用原生安全凭证执行授权操作，插件不能读取明文密钥。',
};

const installedCount = computed(() => app.plugins.length);
const enabledCount = computed(() => app.plugins.filter((plugin) => plugin.enabled).length);
const candidatePermissions = computed(() => {
  const value = candidateManifest.value?.permissions;
  return Array.isArray(value) ? value.map(String) : [];
});
const candidateDependencies = computed(() => {
  const value = candidateManifest.value?.dependencies;
  return value && typeof value === 'object' ? Object.entries(value) : [];
});
const enablePermissions = computed(() => enableTarget.value?.permissions || []);
const safeMode = computed(() => app.settings.layout.safeMode === true);
const pluginPages = computed(() =>
  uiEntries.value
    .filter(
      (entry) =>
        entry.type === 'page' &&
        app.plugins.some((plugin) => plugin.id === entry.pluginId && plugin.enabled),
    )
    .sort((left, right) => (left.order || 0) - (right.order || 0) || left.title.localeCompare(right.title, 'zh-CN')),
);

function describePermission(permission: string) {
  return permissionDescriptions[permission] || `插件声明的能力：${permission}`;
}

function manifestValue(key: string) {
  const value = candidateManifest.value?.[key];
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value ? String(value) : '未声明';
}

function contributionRouteId(entry: PluginUiEntry) {
  const colonPrefix = `${entry.pluginId}:`;
  const slashPrefix = `${entry.pluginId}/`;
  if (entry.id.startsWith(colonPrefix)) return entry.id.slice(colonPrefix.length);
  if (entry.id.startsWith(slashPrefix)) return entry.id.slice(slashPrefix.length);
  return entry.id;
}

function pluginPageRoute(entry: PluginUiEntry) {
  return `plugin:${entry.pluginId}/${contributionRouteId(entry)}`;
}

function resetCandidate() {
  reviewOpen.value = false;
  candidateFile.value = null;
  candidateManifest.value = null;
  candidateOrigin.value = 'local';
  permissionAccepted.value = false;
  installError.value = '';
}

async function inspectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  candidateFile.value = file;
  candidateOrigin.value = 'local';
  installError.value = '';
  try {
    candidateManifest.value = await app.previewPlugin(file);
    permissionAccepted.value = false;
    reviewOpen.value = true;
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error);
    resetCandidate();
  } finally {
    input.value = '';
  }
}

async function stageRemoteSource() {
  const url = remoteSourceUrl.value.trim();
  if (!url) return;
  remoteSourceError.value = '';
  installError.value = '';
  stagingRemoteSource.value = true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('插件来源必须使用 HTTPS。');
    const staged = await app.stagePluginSource(parsed.toString());
    candidateFile.value = staged.file;
    candidateManifest.value = staged.manifest;
    candidateOrigin.value = 'remote';
    permissionAccepted.value = false;
    reviewOpen.value = true;
  } catch (error) {
    remoteSourceError.value = error instanceof Error ? error.message : String(error);
    app.error = remoteSourceError.value;
  } finally {
    stagingRemoteSource.value = false;
  }
}

async function installCandidate() {
  if (!candidateFile.value || !permissionAccepted.value) return;
  installing.value = true;
  installError.value = '';
  try {
    await app.installPlugin(candidateFile.value);
    resetCandidate();
  } catch (error) {
    installError.value = error instanceof Error ? error.message : String(error);
  } finally {
    installing.value = false;
  }
}

function requestToggle(plugin: InstalledPlugin) {
  if (plugin.enabled) {
    void app.setPluginEnabled(plugin.id, false);
    return;
  }
  enableTarget.value = plugin;
  enableAccepted.value = false;
}

async function confirmEnable() {
  if (!enableTarget.value || !enableAccepted.value) return;
  await app.setPluginEnabled(enableTarget.value.id, true);
  enableTarget.value = null;
}

async function confirmUninstall() {
  if (!uninstallTarget.value) return;
  await app.uninstallPlugin(uninstallTarget.value.id);
  uninstallTarget.value = null;
}

async function confirmRollback() {
  if (!rollbackTarget.value) return;
  try {
    await app.rollbackPlugin(rollbackTarget.value.id);
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error);
  } finally {
    rollbackTarget.value = null;
  }
}

async function confirmRevoke() {
  if (!revokeTarget.value) return;
  await app.revokePluginPermission(
    revokeTarget.value.plugin.id,
    revokeTarget.value.permission,
  );
  revokeTarget.value = null;
}

async function toggleSafeMode(enabled: boolean) {
  changingSafeMode.value = true;
  try {
    app.settings.layout.safeMode = enabled;
    if (enabled) {
      for (const plugin of app.plugins.filter((item) => item.enabled)) {
        await app.setPluginEnabled(plugin.id, false);
      }
    }
    await app.saveSettings();
    app.notify(
      enabled
        ? '安全模式已启用；第三方插件均已停止，内置核心功能保持可用'
        : '安全模式已关闭；插件仍保持禁用，可由你逐个授权启用',
    );
  } finally {
    changingSafeMode.value = false;
  }
}

function toggleExpanded(id: string) {
  expandedPlugin.value = expandedPlugin.value === id ? '' : id;
}

onMounted(async () => {
  try {
    const manager = await import('../services/plugin-manager');
    const syncEntries = () => {
      uiEntries.value = manager.pluginUiContributions.map((entry) => ({ ...entry }));
    };
    syncEntries();
    stopUiEntryWatch = watch(
      () => manager.pluginUiContributions.slice(),
      syncEntries,
      { deep: false },
    );
  } catch (error) {
    app.notify(`插件扩展目录读取失败：${String(error)}`);
  }
});

onBeforeUnmount(() => {
  stopUiEntryWatch?.();
});
</script>

<template>
  <div class="plugins-view page-view">
    <PageHeader title="插件中心" description="插件默认禁用。安装前检查来源、兼容性、许可证、完整性与权限；禁用或卸载默认保留插件数据。">
      <template #actions>
        <button class="button button--primary" type="button" @click="fileInput?.click()"><PackagePlus :size="16" />从本地安装</button>
      </template>
    </PageHeader>
    <input ref="fileInput" class="sr-only" type="file" accept=".zip,.granite,application/zip" @change="inspectFile" />

    <section class="plugin-summary">
      <article class="surface-card">
        <Boxes :size="20" />
        <span><strong>{{ installedCount }}</strong>已安装插件</span>
      </article>
      <article class="surface-card">
        <PlugZap :size="20" />
        <span><strong>{{ enabledCount }}</strong>当前已启用</span>
      </article>
      <article class="surface-card">
        <ShieldCheck :size="20" />
        <span><strong>默认禁用</strong>权限审查后启用</span>
      </article>
    </section>

    <form class="remote-install-card surface-card" @submit.prevent="stageRemoteSource">
      <ExternalLink :size="25" />
      <div class="remote-install-card__main">
        <h2>从 HTTPS 地址安装</h2>
        <p>只下载你明确输入的地址。Granite 会先验证主机、大小、清单、SRI 完整性和兼容性，再打开同一份权限审查。</p>
        <label class="form-field">
          <span class="sr-only">插件包 HTTPS 地址</span>
          <input
            v-model="remoteSourceUrl"
            class="field"
            type="url"
            inputmode="url"
            autocomplete="off"
            placeholder="https://example.com/plugin.granite"
          />
        </label>
        <p v-if="remoteSourceError" class="remote-source-error" role="alert">
          <AlertTriangle :size="14" />{{ remoteSourceError }}
        </p>
      </div>
      <button class="button button--secondary" type="submit" :disabled="stagingRemoteSource || !remoteSourceUrl.trim()">
        {{ stagingRemoteSource ? '正在获取并校验' : '获取并审查' }}
      </button>
    </form>

    <section class="local-install-card surface-card">
      <FileArchive :size="25" />
      <div>
        <h2>本地插件包</h2>
        <p>支持包含 manifest.json 与预构建 ESM Bundle 的 ZIP。第三方来源不会被视为官方认证；Granite 会在写入前校验包结构和声明完整性。</p>
      </div>
      <button class="button button--secondary" type="button" @click="fileInput?.click()">选择插件包</button>
    </section>

    <section class="surface-card section-card plugin-pages-card">
      <div class="section-heading">
        <h2>插件页面</h2>
        <span class="muted">{{ pluginPages.length }} 个入口</span>
      </div>
      <div v-if="pluginPages.length" class="plugin-page-list">
        <button
          v-for="entry in pluginPages"
          :key="entry.id"
          type="button"
          @click="app.navigate(pluginPageRoute(entry))"
        >
          <span class="plugin-page-list__icon"><Code2 :size="17" /></span>
          <span>
            <strong>{{ entry.title }}</strong>
            <small>{{ entry.pluginId }}</small>
          </span>
          <ArrowUpRight :size="16" />
        </button>
      </div>
      <div v-else class="plugin-pages-empty">
        启用声明了页面的插件后，入口会显示在这里。插件页面不会占用四个核心导航项。
      </div>
    </section>

    <section class="surface-card section-card plugin-list-card">
      <div class="section-heading">
        <h2>已安装</h2>
        <span class="muted">{{ enabledCount }} 个启用</span>
      </div>
      <div v-if="app.plugins.length" class="plugin-list">
        <article v-for="plugin in app.plugins" :key="plugin.id" class="plugin-card" :class="{ 'plugin-card--enabled': plugin.enabled, 'plugin-card--error': plugin.error }">
          <div class="plugin-card__icon"><Code2 :size="20" /></div>
          <div class="plugin-card__main">
            <div class="plugin-card__title">
              <h3>{{ plugin.name }}</h3>
              <span>v{{ plugin.version }}</span>
              <span v-if="plugin.enabled" class="plugin-state plugin-state--enabled"><CheckCircle2 :size="12" />已启用</span>
              <span v-else class="plugin-state">已禁用</span>
            </div>
            <p>{{ plugin.description || '此插件未声明说明。' }}</p>
            <div class="plugin-card__meta">
              <span>{{ plugin.id }}</span>
              <span>{{ plugin.permissions.length }} 项权限</span>
              <button type="button" @click="toggleExpanded(plugin.id)">{{ expandedPlugin === plugin.id ? '收起权限' : '查看权限与详情' }}</button>
            </div>
            <div v-if="plugin.error" class="plugin-error"><AlertTriangle :size="15" />{{ plugin.error }}</div>
            <div v-if="expandedPlugin === plugin.id" class="plugin-details">
              <dl>
                <div><dt>作者</dt><dd>{{ String(plugin.manifest?.author || '未声明') }}</dd></div>
                <div><dt>许可证</dt><dd>{{ String(plugin.manifest?.license || '未声明') }}</dd></div>
                <div><dt>API</dt><dd>{{ String(plugin.manifest?.apiVersion || '未声明') }}</dd></div>
                <div><dt>存储位置</dt><dd>应用插件数据命名空间</dd></div>
              </dl>
              <ul>
                <li v-for="permission in plugin.permissions" :key="permission">
                  <KeyRound :size="13" />
                  <span><code>{{ permission }}</code>{{ describePermission(permission) }}</span>
                  <button
                    class="permission-revoke"
                    type="button"
                    :aria-label="`撤销 ${plugin.name} 的权限 ${permission}`"
                    @click="revokeTarget = { plugin, permission }"
                  >
                    撤销
                  </button>
                </li>
              </ul>
              <a v-if="plugin.manifest?.repository" :href="String(plugin.manifest.repository)" target="_blank" rel="noreferrer noopener"><ExternalLink :size="13" />打开插件来源</a>
              <button
                v-if="app.pluginData[`backup:${plugin.id}`]"
                class="plugin-rollback"
                type="button"
                @click="rollbackTarget = plugin"
              >
                <Undo2 :size="13" />恢复上一版本
              </button>
              <button class="plugin-uninstall" type="button" @click="uninstallTarget = plugin">
                <Trash2 :size="13" />卸载插件
              </button>
            </div>
          </div>
          <label class="switch-control">
            <input type="checkbox" :checked="plugin.enabled" :aria-label="`${plugin.enabled ? '禁用' : '启用'} ${plugin.name}`" @change="requestToggle(plugin)" />
            <span></span>
          </label>
        </article>
      </div>
      <EmptyState
        v-else
        title="还没有安装插件"
        description="Granite 核心功能无需插件即可使用。安装第三方插件前，请核对来源、完整性与权限。"
        action-label="选择本地插件包"
        @action="fileInput?.click()"
      >
        <template #icon><PlugZap :size="24" /></template>
      </EmptyState>
    </section>

    <section class="permission-principles surface-card">
      <ShieldAlert :size="19" />
      <div>
        <strong>插件没有隐式权限</strong>
        <p>撤销权限后，运行中的插件不能继续访问对应能力。明文凭证不会暴露给插件；完整 Vue 页面同样受 Host API 与 Tauri capability 限制。</p>
      </div>
    </section>

    <section class="safe-mode-card surface-card" :class="{ 'is-active': safeMode }">
      <span class="safe-mode-card__icon"><ShieldOff :size="20" /></span>
      <div>
        <strong>安全模式</strong>
        <p>启用后会立即停止所有已启用插件，并在下次启动时只允许内置插件运行。应用数据与插件命名空间数据都会保留。</p>
      </div>
      <label class="safe-mode-switch">
        <input
          type="checkbox"
          :checked="safeMode"
          :disabled="changingSafeMode"
          aria-label="安全模式"
          @change="toggleSafeMode(($event.target as HTMLInputElement).checked)"
        />
        <span></span>
        <small>{{ changingSafeMode ? '保存中' : safeMode ? '已启用' : '已关闭' }}</small>
      </label>
    </section>

    <DialogPanel
      v-if="reviewOpen && candidateManifest"
      title="审查并安装插件"
      description="安装后会保持禁用；启用前仍需确认权限。"
      width="large"
      @close="resetCandidate"
    >
      <div class="manifest-review">
        <div class="manifest-review__herald">
          <FileArchive :size="24" />
          <div><strong>{{ String(candidateManifest.name || '未命名插件') }}</strong><span>v{{ String(candidateManifest.version || '?') }} · {{ candidateFile?.name }}</span></div>
        </div>
        <dl>
          <div><dt>来源</dt><dd>{{ candidateOrigin === 'remote' ? manifestValue('source') : candidateFile?.name }}</dd></div>
          <div><dt>文件大小</dt><dd>{{ candidateFile ? `${Math.ceil(candidateFile.size / 1024)} KB` : '—' }}</dd></div>
          <div><dt>作者</dt><dd>{{ manifestValue('author') }}</dd></div>
          <div><dt>许可证</dt><dd>{{ manifestValue('license') }}</dd></div>
          <div><dt>API 版本</dt><dd>{{ manifestValue('apiVersion') }}</dd></div>
          <div><dt>目标平台</dt><dd>{{ manifestValue('platforms') }}</dd></div>
          <div><dt>完整性声明</dt><dd>{{ manifestValue('integrity') }}</dd></div>
          <div><dt>仓库</dt><dd>{{ manifestValue('repository') }}</dd></div>
        </dl>
        <section>
          <h3>依赖</h3>
          <p v-if="!candidateDependencies.length">此插件没有声明额外依赖。</p>
          <div v-else class="dependency-list">
            <span v-for="[name, version] in candidateDependencies" :key="name">{{ name }} <code>{{ String(version) }}</code></span>
          </div>
        </section>
        <section>
          <h3>申请权限</h3>
          <p v-if="!candidatePermissions.length">此插件没有声明权限。仍会默认禁用。</p>
          <ul v-else class="permission-list">
            <li v-for="permission in candidatePermissions" :key="permission"><KeyRound :size="15" /><span><code>{{ permission }}</code><small>{{ describePermission(permission) }}</small></span></li>
          </ul>
        </section>
        <label class="permission-confirm">
          <input v-model="permissionAccepted" type="checkbox" />
          <span>我已核对插件来源、许可证、完整性与上述权限，并理解第三方插件代码可能访问其获准的能力。</span>
        </label>
        <div v-if="installError" class="plugin-install-error" role="alert">
          <AlertTriangle :size="16" />{{ installError }}
        </div>
      </div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="resetCandidate">取消</button>
        <button class="button button--primary" type="button" :disabled="!permissionAccepted || installing" @click="installCandidate">
          {{ installing ? '安装中' : '确认并安装（默认禁用）' }}
        </button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="enableTarget"
      :title="`启用 ${enableTarget.name}`"
      description="已安装不等于已授权。启用前请再次核对本次插件声明的权限。"
      @close="enableTarget = null"
    >
      <div class="enable-plugin-summary">
        <strong>{{ enableTarget.name }} v{{ enableTarget.version }}</strong>
        <span>{{ String(enableTarget.manifest?.author || '作者未声明') }} · {{ String(enableTarget.manifest?.license || '许可证未声明') }}</span>
      </div>
      <ul v-if="enablePermissions.length" class="permission-list">
        <li v-for="permission in enablePermissions" :key="permission"><KeyRound :size="15" /><span><code>{{ permission }}</code><small>{{ describePermission(permission) }}</small></span></li>
      </ul>
      <p v-else class="muted">此插件未声明权限。</p>
      <label class="permission-confirm">
        <input v-model="enableAccepted" type="checkbox" />
        <span>允许该插件使用上述已声明能力，直到我撤销或禁用插件。</span>
      </label>
      <template #footer>
        <button class="button button--ghost" type="button" @click="enableTarget = null">取消</button>
        <button class="button button--primary" type="button" :disabled="!enableAccepted" @click="confirmEnable">确认启用</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="revokeTarget"
      :title="`撤销 ${revokeTarget.plugin.name} 的权限？`"
      description="权限撤销后不能继续使用对应能力。Granite 会先停止插件；再次启用时也需要重新确认现有权限。"
      width="small"
      @close="revokeTarget = null"
    >
      <div class="permission-revoke-summary">
        <KeyRound :size="18" />
        <span><code>{{ revokeTarget.permission }}</code><small>{{ describePermission(revokeTarget.permission) }}</small></span>
      </div>
      <p class="revoke-note">插件命名空间数据不会被删除。</p>
      <template #footer>
        <button class="button button--ghost" type="button" @click="revokeTarget = null">取消</button>
        <button class="button button--danger" type="button" @click="confirmRevoke">撤销权限并停止插件</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="uninstallTarget"
      :title="`卸载 ${uninstallTarget.name}？`"
      description="插件代码会从当前设备移除，插件命名空间数据默认保留，便于以后重新安装时恢复。"
      width="small"
      @close="uninstallTarget = null"
    >
      <div class="uninstall-summary">
        <Trash2 :size="18" />
        <span>版本 v{{ uninstallTarget.version }} · {{ uninstallTarget.permissions.length }} 项已允许权限</span>
      </div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="uninstallTarget = null">取消</button>
        <button class="button button--danger" type="button" @click="confirmUninstall">卸载并保留数据</button>
      </template>
    </DialogPanel>

    <DialogPanel
      v-if="rollbackTarget"
      :title="`恢复 ${rollbackTarget.name} 的上一版本？`"
      description="当前插件会先停用，再恢复本机保存的上一版本。插件命名空间数据保持不变，恢复后的版本默认禁用。"
      width="small"
      @close="rollbackTarget = null"
    >
      <div class="uninstall-summary">
        <Undo2 :size="18" />
        <span>当前 v{{ rollbackTarget.version }} · 恢复后可重新审查权限再启用</span>
      </div>
      <template #footer>
        <button class="button button--ghost" type="button" @click="rollbackTarget = null">取消</button>
        <button class="button button--secondary" type="button" @click="confirmRollback">恢复上一版本</button>
      </template>
    </DialogPanel>
  </div>
</template>

<style scoped>
.plugins-view {
  display: grid;
  gap: 1rem;
  padding-bottom: 2rem;
}

.plugin-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.plugin-summary article {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.9rem 1rem;
  color: var(--text-secondary);
}

.plugin-summary article > svg {
  color: var(--accent);
}

.plugin-summary article > span {
  display: grid;
  gap: 0.1rem;
  font-size: 0.75rem;
}

.plugin-summary strong {
  color: var(--text);
  font-size: 0.82rem;
}

.remote-install-card,
.local-install-card {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 1rem 1.2rem;
  border-style: dashed;
}

.remote-install-card > svg,
.local-install-card > svg {
  flex: 0 0 auto;
  color: var(--accent);
}

.remote-install-card__main,
.local-install-card div {
  min-width: 0;
  flex: 1;
}

.remote-install-card h2,
.local-install-card h2 {
  margin: 0;
  font-size: 0.85rem;
}

.remote-install-card p,
.local-install-card p {
  max-width: 90ch;
  margin: 0.2rem 0 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.55;
}

.remote-install-card .form-field {
  margin-top: 0.7rem;
}

.remote-source-error,
.plugin-install-error {
  display: flex;
  align-items: flex-start;
  gap: 0.35rem;
  padding: 0.55rem;
  border-radius: 8px;
  color: var(--danger) !important;
  background: var(--danger-soft);
}

.plugin-pages-card {
  min-height: 0;
}

.plugin-page-list {
  display: grid;
  gap: 0.4rem;
}

.plugin-page-list button {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem;
  border: 1px solid var(--border);
  border-radius: 11px;
  color: var(--text);
  background: var(--surface-elevated);
  text-align: left;
}

.plugin-page-list button:hover {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  background: var(--accent-wash);
}

.plugin-page-list__icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.plugin-page-list button > span:nth-child(2) {
  display: grid;
  min-width: 0;
  gap: 0.1rem;
}

.plugin-page-list strong,
.plugin-page-list small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-page-list strong {
  font-size: 0.78rem;
}

.plugin-page-list small {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.plugin-page-list button > svg {
  color: var(--text-tertiary);
}

.plugin-pages-empty {
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.6;
}

.plugin-list-card {
  min-height: 260px;
}

.plugin-list {
  display: grid;
  gap: 0.55rem;
}

.plugin-card {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: start;
  gap: 0.75rem;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface-elevated);
}

.plugin-card--enabled {
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
  background: color-mix(in srgb, var(--accent-wash) 50%, var(--surface-elevated));
}

.plugin-card--error {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
}

.plugin-card__icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 12px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.plugin-card__main {
  min-width: 0;
}

.plugin-card__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.plugin-card__title h3 {
  margin: 0;
  font-size: 0.86rem;
}

.plugin-card__title > span:not(.plugin-state) {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.plugin-state {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.12rem 0.35rem;
  border-radius: 999px;
  color: var(--text-tertiary);
  background: var(--surface-muted);
  font-size: 0.75rem;
}

.plugin-state--enabled {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 10%, var(--surface-elevated));
}

.plugin-card__main > p {
  margin: 0.25rem 0 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.plugin-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.55rem;
  margin-top: 0.45rem;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.plugin-card__meta button,
.plugin-details a {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0;
  border: 0;
  color: var(--accent-strong);
  background: transparent;
  font-size: 0.75rem;
  text-decoration: none;
}

.plugin-error {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem;
  border-radius: 8px;
  margin-top: 0.5rem;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 0.75rem;
}

.plugin-details {
  display: grid;
  gap: 0.6rem;
  padding: 0.7rem;
  border-radius: 10px;
  margin-top: 0.6rem;
  background: var(--surface-muted);
}

.plugin-details dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.3rem 0.8rem;
  margin: 0;
}

.plugin-details dl div {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr);
  gap: 0.35rem;
}

.plugin-details dt {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.plugin-details dd {
  overflow: hidden;
  margin: 0;
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-details ul,
.permission-list {
  display: grid;
  gap: 0.4rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.plugin-details li,
.permission-list li {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.permission-revoke {
  flex: 0 0 auto;
  padding: 0.15rem 0.35rem;
  border: 0;
  border-radius: 6px;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 0.75rem;
}

.plugin-uninstall {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0;
  border: 0;
  color: var(--danger);
  background: transparent;
  font-size: 0.75rem;
}

.plugin-rollback {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0;
  border: 0;
  color: var(--accent-strong);
  background: transparent;
  font-size: 0.75rem;
}

.plugin-details li > span,
.permission-list li > span {
  display: grid;
  gap: 0.1rem;
}

code {
  color: var(--accent-strong);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.switch-control {
  position: relative;
  display: block;
  width: 40px;
  height: 23px;
}

.switch-control input {
  position: absolute;
  opacity: 0;
}

.switch-control span {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--surface-strong);
  transition: background var(--motion-fast);
}

.switch-control span::after {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(30, 25, 40, 0.25);
  content: '';
  transition: transform var(--motion-fast);
}

.switch-control input:checked + span {
  background: var(--accent);
}

.switch-control input:checked + span::after {
  transform: translateX(17px);
}

.switch-control input:focus-visible + span {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.permission-principles {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  padding: 0.9rem 1rem;
  color: var(--text-secondary);
}

.permission-principles > svg {
  flex: 0 0 auto;
  color: var(--warning);
}

.permission-principles p {
  margin: 0.2rem 0 0;
  font-size: 0.75rem;
  line-height: 1.55;
}

.safe-mode-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.95rem 1rem;
}

.safe-mode-card.is-active {
  border-color: color-mix(in srgb, var(--warning) 28%, var(--border));
  background: color-mix(in srgb, var(--warning) 5%, var(--surface));
}

.safe-mode-card__icon {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 11px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.safe-mode-card.is-active .safe-mode-card__icon {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, var(--surface-elevated));
}

.safe-mode-card strong {
  font-size: 0.78rem;
}

.safe-mode-card p {
  max-width: 86ch;
  margin: 0.16rem 0 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.55;
}

.safe-mode-switch {
  position: relative;
  display: grid;
  width: 48px;
  justify-items: center;
  gap: 0.25rem;
}

.safe-mode-switch input {
  position: absolute;
  opacity: 0;
}

.safe-mode-switch > span {
  position: relative;
  width: 42px;
  height: 24px;
  border-radius: 999px;
  background: var(--surface-strong);
}

.safe-mode-switch > span::after {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(30, 25, 40, 0.25);
  content: '';
  transition: transform var(--motion-fast);
}

.safe-mode-switch input:checked + span {
  background: var(--warning);
}

.safe-mode-switch input:checked + span::after {
  transform: translateX(18px);
}

.safe-mode-switch input:focus-visible + span {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.safe-mode-switch small {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  white-space: nowrap;
}

.manifest-review {
  display: grid;
  gap: 1rem;
}

.manifest-review__herald,
.enable-plugin-summary {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.8rem;
  border-radius: 12px;
  background: var(--surface-muted);
}

.permission-revoke-summary,
.uninstall-summary {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.8rem;
  border-radius: 11px;
  color: var(--danger);
  background: var(--danger-soft);
}

.permission-revoke-summary > span {
  display: grid;
  gap: 0.15rem;
}

.permission-revoke-summary small {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.revoke-note {
  margin: 0.7rem 0 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.manifest-review__herald > svg {
  color: var(--accent);
}

.manifest-review__herald div {
  display: grid;
}

.manifest-review__herald span,
.enable-plugin-summary span {
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.manifest-review dl {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  margin: 0;
}

.manifest-review dl div {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 0.4rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}

.manifest-review dt {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.manifest-review dd {
  overflow: hidden;
  margin: 0;
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.manifest-review section h3 {
  margin: 0 0 0.45rem;
  font-size: 0.76rem;
}

.manifest-review section p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.dependency-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.dependency-list span {
  padding: 0.3rem 0.5rem;
  border-radius: 7px;
  background: var(--surface-muted);
  font-size: 0.75rem;
}

.permission-list {
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 11px;
}

.permission-list small {
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.permission-confirm {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--warning) 25%, var(--border));
  border-radius: 11px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--warning) 7%, var(--surface-elevated));
  font-size: 0.75rem;
  line-height: 1.55;
}

.permission-confirm input {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  margin-top: 0.15rem;
  accent-color: var(--accent);
}

.plugin-install-error {
  margin-top: 0.65rem;
  font-size: 0.75rem;
  line-height: 1.55;
}

.enable-plugin-summary {
  display: grid;
  margin-bottom: 0.75rem;
}

@media (max-width: 760px) {
  .plugin-summary {
    grid-template-columns: 1fr;
  }

  .local-install-card {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .remote-install-card {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .remote-install-card .button,
  .local-install-card .button {
    width: 100%;
  }

  .plugin-card {
    grid-template-columns: 38px minmax(0, 1fr) auto;
  }

  .plugin-details dl,
  .manifest-review dl {
    grid-template-columns: 1fr;
  }

  .safe-mode-card {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .safe-mode-switch {
    grid-column: 2;
    justify-self: start;
  }
}
</style>

