import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';

const fixturePath = path.resolve('.cache/fixtures/Granite Field Notes.pdf');

test.use({ channel: 'msedge' });

interface StoredPdf {
  bookId: string;
  rootId: string;
  relativePath: string;
  storedSha256: string;
  storedSize: number;
  currentBytes: number[];
  backupBytes: number[] | null;
}

interface PdfAnnotation {
  id: string;
  type: string;
  contents: string;
  hasAppearance: boolean;
  hasQuadPoints: boolean;
  hasInkList: boolean;
  flags: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodedPdfText(value: unknown): string {
  if (value instanceof PDFHexString || value instanceof PDFString) return value.decodeText();
  return '';
}

async function inspectPdf(bytes: Uint8Array): Promise<{
  pageCount: number;
  annotations: PdfAnnotation[];
}> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const annotations: PdfAnnotation[] = [];

  for (const page of document.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index += 1) {
      const dictionary = document.context.lookupMaybe(annots.get(index), PDFDict);
      if (!dictionary) continue;
      const creator = decodedPdfText(dictionary.lookup(PDFName.of('T')));
      if (creator !== 'Granite') continue;
      const subtype = dictionary.lookup(PDFName.of('Subtype'), PDFName).asString().replace(/^\//, '');
      annotations.push({
        id: decodedPdfText(dictionary.lookup(PDFName.of('NM'))),
        type: subtype,
        contents: decodedPdfText(dictionary.lookup(PDFName.of('Contents'))),
        hasAppearance: dictionary.has(PDFName.of('AP')),
        hasQuadPoints: dictionary.has(PDFName.of('QuadPoints')),
        hasInkList: dictionary.has(PDFName.of('InkList')),
        flags: dictionary.lookup(PDFName.of('F'), PDFNumber).asNumber(),
      });
    }
  }

  return { pageCount: document.getPageCount(), annotations };
}

async function readStoredPdf(page: Page): Promise<StoredPdf | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('granite-local-preview', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = <T,>(key: string) => new Promise<T | undefined>((resolve, reject) => {
      const request = database.transaction('kv').objectStore('kv').get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
    const state = await read<{
      books: Array<{
        id: string;
        format: string;
        rootId: string;
        relativePath: string;
        sha256: string;
        size: number;
      }>;
    }>('state');
    const book = state?.books.find((item) => item.format === 'pdf');
    if (!book) return null;
    const key = `${book.rootId}/${book.relativePath}`;
    const current = await read<Uint8Array | ArrayBuffer | number[]>(key);
    const backup = await read<Uint8Array | ArrayBuffer | number[]>(`${key}.backup`);
    const toBytes = (value: Uint8Array | ArrayBuffer | number[] | undefined) =>
      value == null
        ? null
        : Array.from(value instanceof Uint8Array
          ? value
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value);
    const currentBytes = toBytes(current);
    if (!currentBytes) return null;
    return {
      bookId: book.id,
      rootId: book.rootId,
      relativePath: book.relativePath,
      storedSha256: book.sha256,
      storedSize: book.size,
      currentBytes,
      backupBytes: toBytes(backup),
    };
  });
}

async function storedAnnotationTypes(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('granite-local-preview', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const state = await new Promise<{
      books: Array<{ id: string; format: string }>;
      annotations: Array<{ bookId: string; type: string }>;
    } | undefined>((resolve, reject) => {
      const request = database.transaction('kv').objectStore('kv').get('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const book = state?.books.find((item) => item.format === 'pdf');
    return state && book
      ? state.annotations
        .filter((annotation) => annotation.bookId === book.id)
        .map((annotation) => annotation.type)
        .sort()
      : [];
  });
}

async function ensureToolbar(page: Page): Promise<void> {
  const selectTool = page.getByRole('button', { name: '文本选择工具', exact: true });
  if (!await selectTool.isVisible()) {
    const viewport = page.viewportSize() || { width: 1440, height: 960 };
    await page.locator('.reader-pdf').click({
      position: { x: viewport.width / 2, y: viewport.height / 2 },
    });
  }
  await expect(selectTool).toBeVisible();
}

async function selectText(page: Page, expectedText: string): Promise<void> {
  await ensureToolbar(page);
  await page.getByRole('button', { name: '文本选择工具', exact: true }).click();
  const textSpan = page
    .locator('.reader-pdf-page[data-page-number="1"] .textLayer span')
    .filter({ hasText: expectedText })
    .first();
  await expect(textSpan).toBeVisible();
  const box = await textSpan.boundingBox();
  if (!box || box.width < 12 || box.height < 4) {
    throw new Error(`无法定位 PDF 文本选择区域：${expectedText}`);
  }
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3, y, { steps: 12 });
  await page.mouse.up();

  const menu = page.getByRole('dialog', { name: '选中文字操作' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('.reader-selection-menu__quote')).toContainText(expectedText);
}

async function annotateSelection(
  page: Page,
  text: string,
  type: 'highlight' | 'underline' | 'note',
  note = '',
): Promise<void> {
  await selectText(page, text);
  const menu = page.getByRole('dialog', { name: '选中文字操作' });
  if (type === 'highlight' || type === 'underline') {
    await menu.getByRole('button', {
      name: type === 'highlight' ? '高亮' : '下划线',
      exact: true,
    }).click();
  } else {
    await menu.getByRole('button', { name: '批注', exact: true }).click();
    await menu.getByRole('textbox').fill(note);
    await menu.getByRole('button', { name: '添加批注', exact: true }).click();
  }
  await expect(menu).toBeHidden();
}

test('browser UI writes four standard PDF annotations, persists a safe copy, and exports the real file', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const originalBytes = new Uint8Array(await fs.readFile(fixturePath));
  const original = await inspectPdf(originalBytes);
  expect(original.pageCount).toBe(12);
  expect(original.annotations).toEqual([]);

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '书架', exact: true }).click();
  await page.getByRole('button', { name: '导入书籍', exact: true }).first().click();
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles(fixturePath);
  await page.getByRole('button', { name: '导入 1 个文件', exact: true }).click();
  await expect(page.locator('.result-row').filter({ hasText: '已导入' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await page.locator('.result-row').first().getByRole('button', { name: '查看书籍' }).click();
  await page.getByRole('button', { name: '开始阅读', exact: true }).click();

  await expect(page.locator('.reader-view')).toBeVisible();
  await expect(page.locator('.reader-pdf-page[data-page-number="1"] canvas')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.reader-pdf-page[data-page-number="1"] .textLayer span').first())
    .toBeVisible({ timeout: 30_000 });

  await annotateSelection(page, 'A quiet room opens onto the mountains.', 'highlight');
  await annotateSelection(page, 'Reading makes space for an unfamiliar idea.', 'underline');
  await annotateSelection(
    page,
    'A quiet room opens onto the mountains.',
    'note',
    'E2E editable text note',
  );

  await ensureToolbar(page);
  await page.getByRole('button', { name: '墨迹工具', exact: true }).click();
  const firstPage = page.locator('.reader-pdf-page[data-page-number="1"]');
  const pageBox = await firstPage.boundingBox();
  if (!pageBox) throw new Error('无法定位 PDF 第一页');
  const inkStart = {
    x: pageBox.x + pageBox.width * 0.7,
    y: Math.max(180, pageBox.y + pageBox.height * 0.18),
  };
  await page.mouse.move(inkStart.x, inkStart.y);
  await page.mouse.down();
  await page.mouse.move(inkStart.x + 70, inkStart.y + 36, { steps: 8 });
  await page.mouse.move(inkStart.x + 145, inkStart.y + 12, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => storedAnnotationTypes(page), { timeout: 20_000 }).toEqual([
    'highlight',
    'ink',
    'note',
    'underline',
  ]);
  await expect.poll(async () => {
    const stored = await readStoredPdf(page);
    if (!stored) return -1;
    try {
      return (await inspectPdf(Uint8Array.from(stored.currentBytes))).annotations.length;
    } catch {
      return -1;
    }
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toBe(4);

  await ensureToolbar(page);
  await page.getByRole('button', { name: '标注和书签', exact: true }).click();
  const annotationPanel = page.getByRole('dialog').filter({ hasText: '书签与标注' });
  await expect(annotationPanel).toBeVisible();
  await expect(annotationPanel.locator('.reader-annotation-card--highlight')).toHaveCount(1);
  await expect(annotationPanel.locator('.reader-annotation-card--underline')).toHaveCount(1);
  await expect(annotationPanel.locator('.reader-annotation-card--note')).toHaveCount(1);
  await expect(annotationPanel.locator('.reader-annotation-card--ink')).toHaveCount(1);
  await annotationPanel.getByRole('button', { name: '关闭面板', exact: true }).click();

  const stored = await readStoredPdf(page);
  expect(stored).not.toBeNull();
  if (!stored || !stored.backupBytes) throw new Error('PDF 安全写回没有生成 IndexedDB 备份');
  const storedBytes = Uint8Array.from(stored.currentBytes);
  const backupBytes = Uint8Array.from(stored.backupBytes);
  expect(sha256(storedBytes)).not.toBe(sha256(originalBytes));
  expect(sha256(backupBytes)).not.toBe(sha256(storedBytes));
  expect(stored.storedSha256).toBe(sha256(storedBytes));
  expect(stored.storedSize).toBe(storedBytes.byteLength);
  expect((await inspectPdf(backupBytes)).pageCount).toBe(12);

  await ensureToolbar(page);
  await page.getByRole('button', { name: '退出阅读器', exact: true }).click();
  const exportButton = page.getByRole('button', { name: '导出书籍', exact: true });
  await expect(exportButton).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await exportButton.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('浏览器未生成可读取的 PDF 下载文件');
  const exportedPath = testInfo.outputPath('granite-annotated-export.pdf');
  await download.saveAs(exportedPath);
  const exportedBytes = new Uint8Array(await fs.readFile(exportedPath));

  expect(sha256(exportedBytes)).toBe(sha256(storedBytes));
  expect(sha256(exportedBytes)).toBe(stored.storedSha256);
  const exported = await inspectPdf(exportedBytes);
  expect(exported.pageCount).toBe(12);
  expect(exported.annotations.map((annotation) => annotation.type).sort()).toEqual([
    'Highlight',
    'Ink',
    'Text',
    'Underline',
  ]);
  expect(new Set(exported.annotations.map((annotation) => annotation.id)).size).toBe(4);
  expect(exported.annotations.find((annotation) => annotation.type === 'Text')?.contents)
    .toBe('E2E editable text note');
  for (const annotation of exported.annotations) {
    expect(annotation.hasAppearance).toBe(true);
    expect(annotation.flags & 1024).toBe(0);
  }
  expect(exported.annotations.filter((annotation) => annotation.hasQuadPoints)).toHaveLength(2);
  expect(exported.annotations.find((annotation) => annotation.type === 'Ink')?.hasInkList)
    .toBe(true);

  const testPython=process.env.GRANITE_TEST_PYTHON || path.resolve('.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const externalReport = JSON.parse(execFileSync(testPython, [
    '-c',
    [
      'import json, sys, pymupdf',
      'doc = pymupdf.open(sys.argv[1])',
      'items = []',
      'for page in doc:',
      '    for annot in page.annots() or []:',
      '        items.append({"page": page.number + 1, "type": annot.type[1], "content": annot.info.get("content", ""), "rect": list(annot.rect)})',
      'print(json.dumps({"pages": doc.page_count, "annotations": items}))',
    ].join('\n'),
    exportedPath,
  ], { encoding: 'utf8' })) as {
    pages: number;
    annotations: Array<{ page: number; type: string; content: string; rect: number[] }>;
  };
  expect(externalReport.pages).toBe(12);
  expect(externalReport.annotations.map((annotation) => annotation.type).sort()).toEqual([
    'Highlight',
    'Ink',
    'Text',
    'Underline',
  ]);
  for (const annotation of externalReport.annotations) {
    expect(annotation.page).toBe(1);
    expect(annotation.rect[2]).toBeGreaterThan(annotation.rect[0]);
    expect(annotation.rect[3]).toBeGreaterThan(annotation.rect[1]);
  }
  expect(pageErrors).toEqual([]);
});
