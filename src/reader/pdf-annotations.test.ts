import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
} from 'pdf-lib';
import {
  readPdfAnnotations,
  writePdfAnnotations,
} from './pdf-annotations';
import type { PdfAnnotationRecord } from './types';

function records(): PdfAnnotationRecord[] {
  const timestamp = new Date().toISOString();
  return [
    {
      id: 'highlight-1',
      page: 1,
      type: 'highlight',
      color: '#f4c542',
      text: 'Selected text',
      note: 'Editable highlight',
      rects: [[50, 390, 180, 410]],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'underline-1',
      page: 1,
      type: 'underline',
      color: '#79a7ff',
      text: 'Underline this',
      note: '',
      rects: [[55, 350, 190, 372]],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'note-1',
      page: 1,
      type: 'note',
      color: '#f4c542',
      text: 'Anchor',
      note: 'A text annotation',
      rects: [[220, 330, 240, 350]],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'ink-1',
      page: 1,
      type: 'ink',
      color: '#ef8fab',
      text: '',
      note: 'Ink',
      rects: [[30, 30, 160, 90]],
      ink: [
        [30, 30],
        [65, 70],
        [100, 40],
        [160, 90],
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

describe('PDF annotation round trip', () => {
  it('writes standard editable annotation objects and reads them back', async () => {
    const source = await PDFDocument.create();
    source.addPage([400, 500]);
    const sourceBytes = await source.save();

    const output = await writePdfAnnotations(sourceBytes, records());
    const readBack = await readPdfAnnotations(output);

    expect(readBack.map((record) => record.id).sort()).toEqual([
      'highlight-1',
      'ink-1',
      'note-1',
      'underline-1',
    ]);
    expect(readBack.find((record) => record.id === 'highlight-1')?.rects[0]).toEqual([
      50,
      390,
      180,
      410,
    ]);

    const parsed = await PDFDocument.load(output);
    const annots = parsed.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(4);

    const dictionaries = annots.asArray().map((reference) => parsed.context.lookup(reference, PDFDict));
    for (const dictionary of dictionaries) {
      expect(dictionary.has(PDFName.of('AP'))).toBe(true);
      expect(dictionary.has(PDFName.of('NM'))).toBe(true);
      expect(dictionary.lookup(PDFName.of('M'))).toBeTruthy();
      const flags = dictionary.lookup(PDFName.of('F'), PDFNumber).asNumber();
      expect(flags & 1024).toBe(0);
    }
    expect(dictionaries.some((dictionary) => dictionary.has(PDFName.of('QuadPoints')))).toBe(true);
    expect(dictionaries.some((dictionary) => dictionary.has(PDFName.of('InkList')))).toBe(true);
  });

  it('replaces an existing Granite annotation instead of duplicating its id', async () => {
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    const first = await writePdfAnnotations(await source.save(), records().slice(0, 1));
    const updatedRecords = records().slice(0, 1);
    updatedRecords[0].note = 'Updated note';

    const second = await writePdfAnnotations(first, updatedRecords);
    const readBack = await readPdfAnnotations(second);

    expect(readBack).toHaveLength(1);
    expect(readBack[0].note).toBe('Updated note');
  });
});

