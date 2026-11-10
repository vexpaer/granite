import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: 'chromium' });

test.beforeEach(async ({ page }) => {
  const csp = JSON.parse(readFileSync(path.resolve('src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
  await page.route('http://127.0.0.1:1421/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
  });
});

const pluginId = 'qa.granite.sandbox';
const pluginName = 'Sandbox QA Probe';
const pluginPageTitle = 'Sandbox Probe Page';
const validFixture = path.resolve(
  '.cache',
  'fixtures',
  'granite-sandbox-probe.granite.zip',
);
const tamperedFixture = path.resolve(
  '.cache',
  'fixtures',
  'granite-sandbox-probe-integrity-mismatch.granite.zip',
);

test.beforeAll(() => {
  execFileSync(
    process.execPath,
    [path.resolve('scripts', 'create-plugin-fixture.mjs')],
    { stdio: 'inherit' },
  );
});

async function openPluginCenter(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.locator('.avatar-menu__trigger').click();
  await page.getByRole('menuitem', { name: '个人资料' }).click();
  await expect(page.getByRole('heading', { name: '我的', exact: true })).toBeVisible();
  await page
    .locator('.me-group__items button')
    .filter({ hasText: '插件中心' })
    .click();
  await expect(
    page.getByRole('heading', { name: '插件中心', exact: true }),
  ).toBeVisible();
}

function pluginCard(page: Page) {
  return page.locator('.plugin-card').filter({ hasText: pluginName });
}

function dialogContaining(page: Page, text: string) {
  return page.getByRole('dialog').filter({ hasText: text });
}

async function openValidPluginPage(page: Page, expectedActivation: number) {
  const pageEntry = page
    .locator('.plugin-page-list button')
    .filter({ hasText: pluginPageTitle });
  await expect(pageEntry).toBeVisible();
  await pageEntry.click();

  const iframe = page.locator(
    `iframe[data-granite-plugin-id="${pluginId}"]`,
  );
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');

  const pluginFrame = page.frameLocator(
    `iframe[data-granite-plugin-id="${pluginId}"]`,
  );
  await expect(
    pluginFrame.getByRole('heading', { name: pluginName, exact: true }),
  ).toBeVisible();
  await expect(pluginFrame.getByTestId('storage-roundtrip')).toHaveText(
    `storage-${expectedActivation}-${expectedActivation}`,
  );
  await expect(pluginFrame.getByTestId('tauri-globals')).toHaveText(
    'tauri:undefined;internals:undefined',
  );

  const frameHandle = await iframe.elementHandle();
  const frame = await frameHandle?.contentFrame();
  expect(frame).not.toBeNull();
  const globals = await frame!.evaluate(() => {
    const candidate = globalThis as typeof globalThis & {
      __TAURI__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    };
    return {
      tauri: typeof candidate.__TAURI__,
      internals: typeof candidate.__TAURI_INTERNALS__,
    };
  });
  expect(globals).toEqual({
    tauri: 'undefined',
    internals: 'undefined',
  });
}

async function readStoredActivationCount(page: Page): Promise<number> {
  return page.evaluate(
    ({ id }) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('granite-local-preview', 1);
        open.onerror = () =>
          reject(open.error ?? new Error('IndexedDB open failed'));
        open.onsuccess = () => {
          const database = open.result;
          const request = database
            .transaction('kv', 'readonly')
            .objectStore('kv')
            .get('state');
          request.onerror = () =>
            reject(request.error ?? new Error('IndexedDB read failed'));
          request.onsuccess = () => {
            const state = request.result as
              | {
                  pluginData?: Record<string, { 'activation-count'?: unknown }>;
                }
              | undefined;
            resolve(Number(state?.pluginData?.[id]?.['activation-count']));
          };
        };
      }),
    { id: pluginId },
  );
}

test('installs, reviews, enables, runs, disables, revokes, and uninstalls an isolated ESM plugin', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) =>
    message.type() === 'error' ? consoleErrors.push(message.text()) : undefined,
  );

  await openPluginCenter(page);
  const topLevelTauri = await page.evaluate(() => {
    const candidate = globalThis as typeof globalThis & {
      __TAURI__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    };
    return {
      tauri: typeof candidate.__TAURI__,
      internals: typeof candidate.__TAURI_INTERNALS__,
    };
  });
  expect(topLevelTauri).toEqual({
    tauri: 'undefined',
    internals: 'undefined',
  });

  await page
    .locator('input[type=file][accept*=".granite"]')
    .setInputFiles(validFixture);
  const review = dialogContaining(page, '审查并安装插件');
  await expect(review).toBeVisible();
  await expect(review.getByText(pluginName, { exact: true })).toBeVisible();
  await expect(review.getByText('MIT', { exact: true })).toBeVisible();
  await expect(review.getByText(/^sha384-/)).toBeVisible();
  await expect(review.getByText('storage.namespace', { exact: true })).toBeVisible();
  await expect(review.getByText('ui.register', { exact: true })).toBeVisible();
  await review.getByRole('checkbox').check();
  await review
    .getByRole('button', { name: '确认并安装（默认禁用）' })
    .click();
  await expect(review).toBeHidden();

  let card = pluginCard(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByText('已禁用', { exact: true })).toBeVisible();
  await expect(
    card.getByRole('checkbox', { name: `启用 ${pluginName}` }),
  ).not.toBeChecked();

  await card
    .getByRole('checkbox', { name: `启用 ${pluginName}` })
    .check({ force: true });
  const enableDialog = dialogContaining(page, `启用 ${pluginName}`);
  await expect(enableDialog).toBeVisible();
  await expect(
    enableDialog.getByText('storage.namespace', { exact: true }),
  ).toBeVisible();
  await expect(
    enableDialog.getByText('ui.register', { exact: true }),
  ).toBeVisible();
  const enableAccepted = enableDialog.getByRole('checkbox');
  const enableButton = enableDialog.getByRole('button', { name: '确认启用' });
  await enableAccepted.check();
  await enableButton.click();
  await expect(enableDialog).toBeHidden({ timeout: 15_000 });

  card = pluginCard(page);
  await expect(card.locator('.plugin-error')).toHaveCount(0);
  await expect(card.getByText('已启用', { exact: true })).toBeVisible();
  await openValidPluginPage(page, 1);

  await page.getByRole('button', { name: '返回上一页' }).click();
  card = pluginCard(page);
  await card
    .getByRole('checkbox', { name: `禁用 ${pluginName}` })
    .uncheck({ force: true });
  await expect(
    card.getByRole('checkbox', { name: `启用 ${pluginName}` }),
  ).not.toBeChecked();
  await expect(
    page.locator('.plugin-page-list button').filter({ hasText: pluginPageTitle }),
  ).toHaveCount(0);
  await expect(
    page.locator(`iframe[data-granite-plugin-id="${pluginId}"]`),
  ).toHaveCount(0);

  await card
    .getByRole('checkbox', { name: `启用 ${pluginName}` })
    .check({ force: true });
  const reenableDialog = dialogContaining(page, `启用 ${pluginName}`);
  await reenableDialog.getByRole('checkbox').check();
  await reenableDialog.getByRole('button', { name: '确认启用' }).click();
  await expect(reenableDialog).toBeHidden();
  await openValidPluginPage(page, 2);

  await page.getByRole('button', { name: '返回上一页' }).click();
  card = pluginCard(page);
  await card.getByRole('button', { name: '查看权限与详情' }).click();
  await card
    .getByRole('button', {
      name: `撤销 ${pluginName} 的权限 storage.namespace`,
    })
    .click();
  const revokeDialog = dialogContaining(page, `撤销 ${pluginName} 的权限？`);
  await expect(revokeDialog).toBeVisible();
  await revokeDialog
    .getByRole('button', { name: '撤销权限并停止插件' })
    .click();
  await expect(revokeDialog).toBeHidden();

  await expect(
    card.getByRole('checkbox', { name: `启用 ${pluginName}` }),
  ).not.toBeChecked();
  await expect(
    card.getByText('storage.namespace', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('.plugin-page-list button').filter({ hasText: pluginPageTitle }),
  ).toHaveCount(0);
  await expect(
    page.locator(`iframe[data-granite-plugin-id="${pluginId}"]`),
  ).toHaveCount(0);

  await card.getByRole('button', { name: '卸载插件' }).click();
  const uninstallDialog = dialogContaining(page, `卸载 ${pluginName}？`);
  await expect(uninstallDialog).toBeVisible();
  await uninstallDialog
    .getByRole('button', { name: '卸载并保留数据' })
    .click();
  await expect(uninstallDialog).toBeHidden();
  await expect(pluginCard(page)).toHaveCount(0);
  await expect(page.getByText('还没有安装插件', { exact: true })).toBeVisible();
  expect(await readStoredActivationCount(page)).toBe(2);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('rejects a plugin whose prebuilt bundle does not match its declared SRI', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await openPluginCenter(page);
  await page
    .locator('input[type=file][accept*=".granite"]')
    .setInputFiles(tamperedFixture);

  const error = page.locator('.global-error');
  await expect(error).toContainText('plugin bundle integrity verification failed');
  await expect(
    dialogContaining(page, '审查并安装插件'),
  ).toBeHidden();
  await expect(pluginCard(page)).toHaveCount(0);
  await expect(page.getByText('还没有安装插件', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
