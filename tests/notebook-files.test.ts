// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useApp } from '../src/stores/app';
import type { AppData, Note } from '../src/types';
import {
  addNotebookAttachmentsToZip,
  attachmentMarkdown,
  contentAddressHash,
  createNotebookAttachment,
  decodeAttachmentDataUrl,
  encodeAttachmentDataUrl,
  insertAttachmentMarkdown,
  normalizePortableAttachmentPath,
  notebookBackupDirectory,
  notebookBackupMarkdownPath,
  renderNotebookMarkdown,
  type NotebookAttachment,
} from '../src/services/notebook-files';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(async () => {
    throw new Error('Native invoke must not run in browser export tests.');
  }),
}));

type AppStore = ReturnType<typeof useApp>;

const openStores: AppStore[] = [];
let capturedBlob: Blob | undefined;
let capturedDownload = '';

function note(overrides: Partial<Note> = {}): Note {
  const at = '2026-11-09T00:00:00.000Z';
  return {
    id: 'note-backup',
    title: 'Test note',
    body: '',
    folder: 'Research/Week 1',
    tagIds: [],
    attachments: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

async function clearPreviewDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('granite-local-preview', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('kv'))
        request.result.createObjectStore('kv');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('kv')) {
        database.close();
        resolve();
        return;
      }
      const transaction = database.transaction('kv', 'readwrite');
      transaction.objectStore('kv').clear();
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    };
  });
}

function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error('Expected an ArrayBuffer.'));
        return;
      }
      resolve(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(blob);
  });
}

async function loadApp(): Promise<AppStore> {
  const { useApp: getStore } = await import('../src/stores/app');
  const app = getStore();
  openStores.push(app);
  await app.init();
  expect(app.error).toBe('');
  return app;
}

function stopStoreTimers(app: AppStore): void {
  if (app.sessionInterval) clearInterval(app.sessionInterval);
  if (app.toastTimer) clearTimeout(app.toastTimer);
}

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
  capturedBlob = undefined;
  capturedDownload = '';
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:granite-notebook-export';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    capturedDownload = this.download;
  });
  await clearPreviewDatabase();
  openStores.length = 0;
});

afterEach(async () => {
  for (const app of openStores) stopStoreTimers(app);
  sessionStorage.clear();
  await clearPreviewDatabase();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Notebook attachment paths', () => {
  it('creates a safe content-addressed path and preserves the actual bytes', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const attachment = await createNotebookAttachment(
      '../../旅行/photo.png',
      'image/png',
      bytes,
    );

    expect(attachment.name).toBe('photo.png');
    expect(attachment.path).toMatch(
      /^attachments\/sha256\/[0-9a-f]{64}\/photo\.png$/,
    );
    expect(attachment.path).not.toContain('..');
    expect(normalizePortableAttachmentPath(attachment.path)).toBe(
      attachment.path,
    );
    expect(Array.from(decodeAttachmentDataUrl(attachment.data).bytes)).toEqual(
      Array.from(bytes),
    );
    expect(contentAddressHash(attachment.path)).toBe(
      attachment.path.split('/')[2],
    );
  });

  it('rejects absolute, parent, backslash, and repeatedly encoded traversal paths', () => {
    const hash = 'a'.repeat(64);
    expect(normalizePortableAttachmentPath('../secret.txt')).toBeNull();
    expect(normalizePortableAttachmentPath('/attachments/secret.txt')).toBeNull();
    expect(
      normalizePortableAttachmentPath(
        `attachments/sha256/${hash}/%2e%2e/secret.txt`,
      ),
    ).toBeNull();
    expect(
      normalizePortableAttachmentPath(
        `attachments/sha256/${hash}/%252e%252e/secret.txt`,
      ),
    ).toBeNull();
    expect(
      normalizePortableAttachmentPath(
        `attachments/sha256/${hash}/%252525252e%252525252e/secret.txt`,
      ),
    ).toBeNull();
    expect(
      normalizePortableAttachmentPath(
        `attachments\\sha256\\${hash}\\secret.txt`,
      ),
    ).toBeNull();
  });

  it('uses the content hash to avoid same-name collisions and deduplicates identical files', async () => {
    const first = await createNotebookAttachment(
      'diagram.png',
      'image/png',
      new Uint8Array([1, 2, 3]),
    );
    const collision = await createNotebookAttachment(
      'diagram.png',
      'image/png',
      new Uint8Array([3, 2, 1]),
    );
    const duplicate = await createNotebookAttachment(
      './newname/diagram.png',
      'image/png',
      new Uint8Array([1, 2, 3]),
    );

    expect(collision.path).not.toBe(first.path);
    expect(duplicate.path).toBe(first.path);
  });
});

describe('Notebook preview and Markdown insertion', () => {
  it('inserts image Markdown for raster images and ordinary links for SVG or documents', async () => {
    const png = await createNotebookAttachment(
      'scan.png',
      'image/png',
      new Uint8Array([1, 2, 3]),
    );
    const svg = await createNotebookAttachment(
      'drawing.svg',
      'image/svg+xml',
      new TextEncoder().encode('<svg><script>alert(1)</script></svg>'),
    );
    const pdf = await createNotebookAttachment(
      'paper.pdf',
      'application/pdf',
      new TextEncoder().encode('%PDF-1.7'),
    );

    expect(attachmentMarkdown(png)).toBe(
      `![scan.png](${png.path})`,
    );
    expect(attachmentMarkdown(svg)).toBe(
      `[drawing.svg](${svg.path})`,
    );
    expect(attachmentMarkdown(pdf)).toBe(
      `[paper.pdf](${pdf.path})`,
    );

    const body = insertAttachmentMarkdown('BeforeAfter', png, 6);
    expect(body).toContain('Before\n\n![scan.png]');
    expect(body).toContain(png.path);
    expect(body).toContain('\n\nAfter');
  });

  it('resolves declared raster data and strips script, SVG content, javascript links, and unknown local images', async () => {
    const png = await createNotebookAttachment(
      'safe.png',
      'image/png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    const svg = await createNotebookAttachment(
      'unsafe.svg',
      'image/svg+xml',
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    );
    const unknownHash = 'b'.repeat(64);
    const markdown = [
      attachmentMarkdown(png),
      `![svg attempt](${svg.path})`,
      `[download svg](${svg.path})`,
      `![unknown](attachments/sha256/${unknownHash}/missing.png)`,
      '[danger](javascript:alert(1))',
      '<svg onload="alert(1)"><script>alert(1)</script></svg>',
      '<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+" onerror="alert(1)">',
    ].join('\n\n');

    const html = renderNotebookMarkdown(markdown, [png, svg]);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const images = [...parsed.querySelectorAll('img')];

    expect(images[0]?.getAttribute('src')).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(images.some((image) => image.getAttribute('src')?.includes('svg'))).toBe(
      false,
    );
    expect(images.at(-1)?.hasAttribute('src')).toBe(false);
    expect(
      [...parsed.querySelectorAll('a')].some((anchor) =>
        anchor.getAttribute('href')?.startsWith('#attachment:'),
      ),
    ).toBe(true);
    expect(
      [...parsed.querySelectorAll('a')].some((anchor) =>
        anchor.getAttribute('href')?.startsWith('javascript:'),
      ),
    ).toBe(false);
    expect(parsed.querySelector('svg')).toBeNull();
    expect(parsed.querySelector('script')).toBeNull();
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onload');
  });
});

describe('Notebook attachment backup layout', () => {
  it('stores actual attachment bytes beside the Markdown with a working note-relative link', async () => {
    const attachment = await createNotebookAttachment(
      'result.png',
      'image/png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
    );
    const current = note({
      body: `# Research\n\n${attachmentMarkdown(attachment)}`,
      attachments: [attachment],
    });
    const zip = new JSZip();
    const markdownPath = notebookBackupMarkdownPath(current);
    const attachmentDirectory = notebookBackupDirectory(current);

    zip.file(markdownPath, current.body);
    await addNotebookAttachmentsToZip(zip, current, attachmentDirectory);

    expect(markdownPath).toBe(
      'notebook/Research/Week 1/Test-note-note-backup.md',
    );
    expect(current.body).toContain(`](` + attachment.path + `)`);
    const archiveEntry = await zip
      .file(`${attachmentDirectory}/${attachment.path}`)!
      .async('uint8array');
    expect(Array.from(archiveEntry)).toEqual(
      Array.from(decodeAttachmentDataUrl(attachment.data).bytes),
    );
  });

  it('blocks traversal in the note folder and conflicting archive paths', async () => {
    expect(() =>
      notebookBackupMarkdownPath(note({ folder: '../outside' })),
    ).toThrow(/路径穿越/);

    const firstData = encodeAttachmentDataUrl(
      new TextEncoder().encode('first'),
      'text/plain',
    );
    const secondData = encodeAttachmentDataUrl(
      new TextEncoder().encode('second'),
      'text/plain',
    );
    const first: NotebookAttachment = {
      name: 'shared.txt',
      path: 'attachments/shared.txt',
      data: firstData,
    };
    const second: NotebookAttachment = {
      ...first,
      data: secondData,
    };
    const zip = new JSZip();

    await addNotebookAttachmentsToZip(
      zip,
      note({ attachments: [first] }),
      'notebook/Research',
    );
    await expect(
      addNotebookAttachmentsToZip(
        zip,
        note({ id: 'other-note', attachments: [second] }),
        'notebook/Research',
      ),
    ).rejects.toThrow(/路径冲突/);
  });

  it('rejects attachment data that does not match its content address', async () => {
    const attachment = await createNotebookAttachment(
      'verified.txt',
      'text/plain',
      new TextEncoder().encode('original'),
    );
    const tampered: NotebookAttachment = {
      ...attachment,
      data: encodeAttachmentDataUrl(
        new TextEncoder().encode('tampered'),
        'text/plain',
      ),
    };

    await expect(
      addNotebookAttachmentsToZip(
        new JSZip(),
        note({ attachments: [tampered] }),
        'notebook',
      ),
    ).rejects.toThrow(/内容地址不一致/);
  });
});

describe('Notebook export integration', () => {
  it('keeps the existing plain Markdown export when no attachments are declared', async () => {
    const app = await loadApp();
    const current = note({ body: '# Plain note\n' });
    await app.saveNote(current);

    await app.exportNote(current);

    expect(app.error).toBe('');
    expect(capturedDownload).toBe('Test note.md');
    expect(new TextDecoder().decode(await readBlob(capturedBlob!))).toBe(
      current.body,
    );
  });

  it('exports a single note as a ZIP with its Markdown and actual attachment bytes', async () => {
    const app = await loadApp();
    const attachment = await createNotebookAttachment(
      'figure.png',
      'image/png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]),
    );
    const current = note({
      body: `# Figure\n\n${attachmentMarkdown(attachment)}`,
      attachments: [attachment],
    });
    await app.saveNote(current);

    await app.exportNote(current);

    expect(app.error).toBe('');
    expect(capturedDownload).toBe('Test-note.zip');
    const zip = await JSZip.loadAsync(await readBlob(capturedBlob!));
    expect(zip.file('Test-note.md')).toBeTruthy();
    expect(
      Array.from(
        await zip.file(attachment.path)!.async('uint8array'),
      ),
    ).toEqual(
      Array.from(decodeAttachmentDataUrl(attachment.data).bytes),
    );
  });

  it('includes attachment files and note-relative links in the full backup', async () => {
    const app = await loadApp();
    const attachment = await createNotebookAttachment(
      'dataset.csv',
      'text/csv',
      new TextEncoder().encode('a,b\n1,2\n'),
    );
    const current = note({
      body: `# Dataset\n\n${attachmentMarkdown(attachment)}`,
      attachments: [attachment],
    });
    await app.saveNote(current);

    await app.exportBackup();

    expect(app.error).toBe('');
    const zip = await JSZip.loadAsync(await readBlob(capturedBlob!));
    const markdownPath = notebookBackupMarkdownPath(current);
    const markdown = await zip.file(markdownPath)!.async('string');
    const manifest = JSON.parse(
      await zip.file('granite-backup.json')!.async('string'),
    ) as AppData;
    expect(markdown).toContain(`](${attachment.path})`);
    expect(manifest.notes[0]?.attachments?.[0]?.data).toBe(attachment.data);
    expect(
      Array.from(
        await zip
          .file(`${notebookBackupDirectory(current)}/${attachment.path}`)!
          .async('uint8array'),
      ),
    ).toEqual(
      Array.from(decodeAttachmentDataUrl(attachment.data).bytes),
    );
  });
});
