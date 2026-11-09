// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { Book } from '../types';
import { parseEpub } from './epub';
import { parseMobi } from './mobi';
import { parseReflowBook, sniffFormat } from './format';
import { sanitizeHtml } from './sanitize';
import { readPdfAnnotations } from './pdf-annotations';

const workspace = path.resolve(import.meta.dirname, '../..');
const fixtureDir = path.join(workspace, '.cache', 'fixtures');

function fixtureBook(filename: string, format: Book['format']): Book {
  const size = fs.statSync(path.join(fixtureDir, filename)).size;
  const at = '2026-11-09T00:00:00.000Z';
  return {
    id: `fixture-${format}`,
    title: filename,
    authors: [],
    format,
    sha256: '',
    size,
    rootId: 'fixture',
    relativePath: filename,
    managed: false,
    available: true,
    status: 'unread',
    favorite: false,
    tagIds: [],
    collectionIds: [],
    createdAt: at,
    updatedAt: at,
  };
}

function fixture(filename: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(fixtureDir, filename)));
}

beforeAll(() => {
  const required = [
    '山间阅读手记.epub',
    'Granite Field Notes.pdf',
    'Granite Field Notes.txt',
  ];
  if (required.some((name) => !fs.existsSync(path.join(fixtureDir, name)))) {
    execFileSync(process.execPath, [path.join(workspace, 'scripts/create-fixtures.mjs')], {
      cwd: workspace,
      stdio: 'pipe',
    });
  }
});

describe('reader format fixtures', () => {
  it('parses the original EPUB spine, nested resources, navigation, and text', async () => {
    const bytes = fixture('山间阅读手记.epub');
    expect(sniffFormat(bytes, 'fixture.epub')).toBe('epub');
    const parsed = await parseEpub(bytes);
    expect(parsed.chapters).toHaveLength(6);
    expect(parsed.chapters[0]?.title).toContain('第1章');
    expect(parsed.chapters[0]?.text).toContain('窗外的山峰');
    expect(parsed.toc).toHaveLength(6);
    expect(parsed.toc[5]?.label).toContain('第6章');
    expect(parsed.chapters.every((chapter) => chapter.html.length > 100)).toBe(true);
    parsed.destroy?.();
  });

  it('detects and parses the original TXT fixture with chapter offsets and search text', async () => {
    const bytes = fixture('Granite Field Notes.txt');
    const book = fixtureBook('Granite Field Notes.txt', 'txt');
    expect(sniffFormat(bytes, book.relativePath)).toBe('txt');
    const parsed = await parseReflowBook(book, bytes, {
      fontFamily: 'serif',
      fontSize: 20,
      lineHeight: 1.9,
      paragraphSpacing: 16,
      margin: 32,
      width: 760,
      theme: 'paper',
      mode: 'scroll',
      encoding: 'auto',
      keepAwake: false,
      wheelThreshold: 100,
    });
    expect(parsed.format).toBe('txt');
    expect(parsed.chapters.length).toBeGreaterThanOrEqual(40);
    expect(parsed.toc[0]?.label).toContain('Chapter 1');
    expect(parsed.chapters[0]?.text).toContain('A quiet room opens');
  });

  it('recognizes the original PDF fixture and preserves an empty Granite annotation layer', async () => {
    const bytes = fixture('Granite Field Notes.pdf');
    expect(sniffFormat(bytes, 'fixture.pdf')).toBe('pdf');
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBe(12);
    await expect(readPdfAnnotations(bytes)).resolves.toEqual([]);
  });

  it('parses the Gutenberg MOBI fixture with its title, metadata, and searchable content', async () => {
    const bytes = new Uint8Array(
      fs.readFileSync(path.join(import.meta.dirname, '__fixtures__', 'Around-the-World.mobi')),
    );
    expect(sniffFormat(bytes, 'Around-the-World.mobi')).toBe('mobi');
    const parsed = await parseMobi(bytes);
    expect(parsed.format).toBe('mobi');
    expect(parsed.title).toMatch(/Around the World in Eighty Days/i);
    expect(parsed.authors.join(' ')).toMatch(/Verne/i);
    expect(parsed.chapters.length).toBeGreaterThan(0);
    expect(parsed.chapters.some((chapter) => chapter.text.length > 1_000)).toBe(true);
    expect(parsed.chapters.some((chapter) => /Fogg/i.test(chapter.text))).toBe(true);
    expect(parsed.toc.length).toBeGreaterThan(0);
    parsed.destroy?.();
  });

  it('removes executable EPUB-style content without exposing dangerous URLs', async () => {
    const sanitized = await sanitizeHtml(
      '<p onclick="alert(1)">Safe<script>alert(2)</script><a href="javascript:alert(3)">link</a></p>',
    );
    expect(sanitized.html).toContain('Safe');
    expect(sanitized.html).not.toMatch(/script|onclick|javascript:/i);
  });
});
