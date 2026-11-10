import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

test.use({ browserName: 'chromium' });

function primaryNavigation(page: Page) {
  return page.getByRole('navigation', { name: '主导航' });
}

async function importNavigationFixtures(page: Page) {
  await page.goto('/');
  await expect(primaryNavigation(page)).toBeVisible();
  await primaryNavigation(page)
    .getByRole('button', { name: '书架', exact: true })
    .click();
  await page.getByRole('button', { name: '导入书籍', exact: true }).first().click();

  await page.locator('input[type=file][accept*=".epub"]').setInputFiles(
    ['山间阅读手记.epub', 'Granite Field Notes.pdf'].map((filename) =>
      path.resolve('.cache/fixtures', filename),
    ),
  );
  await page.getByRole('button', { name: '导入 2 个文件', exact: true }).click();
  await expect(
    page.locator('.result-row').filter({ hasText: '已导入' }),
  ).toHaveCount(2);

  await primaryNavigation(page)
    .getByRole('button', { name: '书架', exact: true })
    .click();
  await expect(page.getByText('山间阅读手记', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Granite Field Notes', { exact: true }).first()).toBeVisible();
}

async function expectLibraryContext(page: Page) {
  await expect(
    page.getByPlaceholder('搜索书名、作者、ISBN 或 DOI'),
  ).toHaveValue('Granite');
  await expect(page.getByRole('combobox', { name: '排序方式' })).toHaveValue('title');
  await expect(page.getByRole('button', { name: '列表视图' })).toHaveClass(/is-active/);
  await expect(page.getByLabel('格式')).toHaveValue('pdf');
  await expect(page.getByPlaceholder('输入作者名')).toHaveValue('Granite Tests');
  await expect(
    page.getByRole('button', {
      name: '查看《Granite Field Notes》详情',
      exact: true,
    }),
  ).toBeVisible();
}

async function expectSearchContext(page: Page) {
  await expect(
    page.getByPlaceholder('输入书名、作者、笔记内容或标签'),
  ).toHaveValue('Granite');
  await expect(
    page
      .getByRole('group', { name: '搜索结果类型' })
      .getByRole('button', { name: /^书籍/ }),
  ).toHaveClass(/is-active/);
}

async function expectStatisticsContext(page: Page) {
  await expect(
    page
      .getByRole('group', { name: '统计范围' })
      .getByRole('button', { name: '周', exact: true }),
  ).toHaveClass(/is-active/);
}

test('route returns and browser reloads preserve bounded local view state', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await importNavigationFixtures(page);

  const librarySearch = page.getByPlaceholder('搜索书名、作者、ISBN 或 DOI');
  await librarySearch.fill('Granite');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await page.getByLabel('格式').selectOption('pdf');
  await page.getByPlaceholder('输入作者名').fill('Granite Tests');
  await page.getByRole('combobox', { name: '排序方式' }).selectOption('title');
  await page.getByRole('button', { name: '列表视图' }).click();
  await expectLibraryContext(page);

  await page
    .getByRole('button', {
      name: '查看《Granite Field Notes》详情',
      exact: true,
    })
    .click();
  await expect(page.locator('.book-detail-view h1')).toHaveText('Granite Field Notes');
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await expectLibraryContext(page);

  await page.reload();
  await expect(primaryNavigation(page)).toBeVisible();
  await expectLibraryContext(page);

  const globalSearch = page
    .getByRole('search')
    .getByRole('searchbox', { name: '全局搜索' });
  await globalSearch.fill('Granite');
  await globalSearch.press('Enter');
  await expect(page.getByRole('heading', { name: '全局搜索', exact: true })).toBeVisible();
  await page
    .getByRole('group', { name: '搜索结果类型' })
    .getByRole('button', { name: /^书籍/ })
    .click();
  await expectSearchContext(page);

  await page
    .locator('.search-group button')
    .filter({ hasText: 'Granite Field Notes' })
    .first()
    .click();
  await expect(page.locator('.book-detail-view h1')).toHaveText('Granite Field Notes');
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await expectSearchContext(page);

  await page.reload();
  await expect(page.getByRole('heading', { name: '全局搜索', exact: true })).toBeVisible();
  await expectSearchContext(page);

  await primaryNavigation(page)
    .getByRole('button', { name: '统计', exact: true })
    .click();
  await page
    .getByRole('group', { name: '统计范围' })
    .getByRole('button', { name: '周', exact: true })
    .click();
  await expectStatisticsContext(page);

  await primaryNavigation(page)
    .getByRole('button', { name: '主页', exact: true })
    .click();
  await primaryNavigation(page)
    .getByRole('button', { name: '统计', exact: true })
    .click();
  await expectStatisticsContext(page);

  await page.reload();
  await expect(page.getByRole('heading', { name: '统计', exact: true })).toBeVisible();
  await expectStatisticsContext(page);

  expect(pageErrors).toEqual([]);
});
