import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

async function persistedLocation(page: Page, format: string) {
  return page.evaluate(async format => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('granite-local-preview', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const state = await new Promise<any>((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').get('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return state?.books.find((book: any) => book.format === format)?.location;
  }, format);
}

test('four formats restore a saved location and bookmark after reload', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('button', { name: '书架', exact: true }).click();
  await page.getByRole('button', { name: '导入书籍', exact: true }).first().click();
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles([
    path.resolve('.cache/fixtures/山间阅读手记.epub'),
    path.resolve('.cache/fixtures/Granite Field Notes.pdf'),
    path.resolve('.cache/fixtures/Granite Field Notes.txt'),
    path.resolve('src/reader/__fixtures__/Around-the-World.mobi'),
  ]);
  await page.getByRole('button', { name: '导入 4 个文件', exact: true }).click();
  await expect(page.locator('.result-row').filter({ hasText: '已导入' })).toHaveCount(4, { timeout: 20_000 });

  for (const format of ['epub', 'pdf', 'txt', 'mobi']) {
    await nav.getByRole('button', { name: '书架', exact: true }).click();
    await page.getByRole('tab', { name: /^全部/ }).click();
    const filter = page.getByRole('combobox', { name: '格式', exact: true });
    if (!await filter.isVisible()) await page.getByRole('button', { name: /^筛选/ }).click();
    await filter.selectOption(format);
    await expect(page.locator('.book-card')).toHaveCount(1);
    await page.locator('.book-card__cover').click();
    await page.getByRole('button', { name: /开始阅读|继续阅读/, exact: true }).click();
    await expect(page.locator('.reader-view')).toBeVisible();
    await expect(page.locator('.reader-loading')).toHaveCount(0, { timeout: 25_000 });
    await expect(page.locator('.reader-error')).toHaveCount(0);
    if (format === 'pdf') await expect(page.locator('.reader-pdf-page canvas').first()).toBeVisible();
    else await expect(page.locator('.reader-reflow')).toBeVisible();

    const seek = page.getByRole('slider', { name: '阅读进度，拖动圆环跳转' });
    const box = await seek.boundingBox();
    if (!box) throw new Error('阅读进度圆环不可用');
    // Six o'clock is the middle of the circular seek control.
    await seek.click({ position: { x: box.width / 2, y: box.height - 2 } });
    await expect.poll(async () => (await persistedLocation(page, format))?.progress || 0).toBeGreaterThan(0.3);
    await expect(page.locator('.reader-status__save')).toHaveText('位置已保存');
    const saved = await persistedLocation(page, format);
    await page.getByRole('button', { name: '在当前位置添加书签', exact: true }).click();
    await expect(page.getByRole('button', { name: '删除当前位置书签', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '书签已保存' })).toBeVisible();
    const label = await page.locator('.reader-status__label').innerText();

    await page.reload();
    await expect(page.locator('.reader-view')).toBeVisible();
    await expect(page.locator('.reader-loading')).toHaveCount(0, { timeout: 25_000 });
    await expect(page.locator('.reader-status__label')).toHaveText(label, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: '删除当前位置书签', exact: true })).toBeVisible();
    const restored = await persistedLocation(page, format);
    expect(restored[format === 'pdf' ? 'page' : 'chapter']).toBe(saved[format === 'pdf' ? 'page' : 'chapter']);
    await page.getByRole('button', { name: '退出阅读器', exact: true }).click();
    await nav.getByRole('button', { name: '主页', exact: true }).click();
    await expect(page.locator('.home-view')).toBeVisible();
  }
  expect(errors).toEqual([]);
});
