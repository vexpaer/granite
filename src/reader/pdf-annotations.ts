import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFPage,
} from 'pdf-lib';
import type { PdfAnnotationRecord } from './types';

const GRANITE_ANNOTATION_CREATOR = 'Granite';
const ANNOTATION_DATE = PDFName.of('M');
const ANNOTATION_ID = PDFName.of('NM');
const ANNOTATION_CREATOR = PDFName.of('T');
const ANNOTATION_ANNOTS = PDFName.of('Annots');

export interface WritePdfAnnotationsOptions {
  removeMissingGraniteAnnotations?: boolean;
}

function pdfDate(date = new Date()): PDFString {
  return PDFString.fromDate(date);
}

function textString(value: string): PDFHexString {
  return PDFHexString.fromText(value);
}

function decodeStringObject(value: unknown): string {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return '';
}

function numberValue(value: unknown): number | undefined {
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}

function colorFromHex(value: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return [1, 0.78, 0.16];
  const number = Number.parseInt(match[1], 16);
  return [
    ((number >> 16) & 0xff) / 255,
    ((number >> 8) & 0xff) / 255,
    (number & 0xff) / 255,
  ];
}

function hexFromColor(color: unknown): string {
  if (!(color instanceof PDFArray) || color.size() < 3) return '#f4c542';
  const channels = [0, 1, 2].map((index) => {
    const value = numberValue(color.get(index)) ?? 1;
    return Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

function normalizeRect(rect: number[]): [number, number, number, number] | null {
  if (rect.length === 4) {
    const [a, b, c, d] = rect;
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  }
  if (rect.length >= 8 && rect.length % 2 === 0) {
    const xs = rect.filter((_, index) => index % 2 === 0);
    const ys = rect.filter((_, index) => index % 2 === 1);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return null;
}

function normalizedRects(record: PdfAnnotationRecord): Array<[number, number, number, number]> {
  const rects = record.rects.map(normalizeRect).filter((rect): rect is [number, number, number, number] => Boolean(rect));
  if (rects.length) return rects;
  if (record.type === 'ink' && record.ink?.length) {
    const points = normalizePoints(record.ink);
    if (points.length) {
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      return [[
        Math.min(...xs) - 3,
        Math.min(...ys) - 3,
        Math.max(...xs) + Math.max(3, width * 0.05),
        Math.max(...ys) + Math.max(3, height * 0.05),
      ]];
    }
  }
  return [[0, 0, 24, 24]];
}

function normalizePoints(values: number[][]): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (const value of values) {
    if (value.length === 2 && value.every(Number.isFinite)) {
      points.push([value[0], value[1]]);
      continue;
    }
    if (value.length >= 4 && value.length % 2 === 0) {
      for (let index = 0; index < value.length; index += 2) {
        if (Number.isFinite(value[index]) && Number.isFinite(value[index + 1])) {
          points.push([value[index], value[index + 1]]);
        }
      }
    }
  }
  return points;
}

function quadPoints(rects: Array<[number, number, number, number]>): number[] {
  return rects.flatMap(([left, bottom, right, top]) => [
    left,
    top,
    right,
    top,
    left,
    bottom,
    right,
    bottom,
  ]);
}

function annotationArray(doc: PDFDocument, page: PDFPage): PDFArray {
  const existing = page.node.lookupMaybe(ANNOTATION_ANNOTS, PDFArray);
  if (existing) return existing;
  const created = doc.context.obj([]);
  page.node.set(ANNOTATION_ANNOTS, created);
  return created;
}

function removeAnnotationIds(
  doc: PDFDocument,
  page: PDFPage,
  predicate: (id: string, creator: string) => boolean,
): void {
  const annots = page.node.lookupMaybe(ANNOTATION_ANNOTS, PDFArray);
  if (!annots) return;
  for (let index = annots.size() - 1; index >= 0; index -= 1) {
    const dictionary = doc.context.lookupMaybe(annots.get(index), PDFDict);
    if (!dictionary) continue;
    const id = decodeStringObject(dictionary.lookup(ANNOTATION_ID));
    const creator = decodeStringObject(dictionary.lookup(ANNOTATION_CREATOR));
    if (predicate(id, creator)) annots.remove(index);
  }
}

function addAppearance(
  doc: PDFDocument,
  dictionary: PDFDict,
  record: PdfAnnotationRecord,
  bbox: [number, number, number, number],
): void {
  const [left, bottom, right, top] = bbox;
  const width = Math.max(1, right - left);
  const height = Math.max(1, top - bottom);
  const [red, green, blue] = colorFromHex(record.color);
  const localRects = normalizedRects(record).map(([x1, y1, x2, y2]) => [
    x1 - left,
    y1 - bottom,
    x2 - left,
    y2 - bottom,
  ] as const);

  let content = '';
  if (record.type === 'highlight') {
    const polygonCommands = localRects
      .map(([x1, y1, x2, y2]) => `${x1} ${y1} m ${x2} ${y1} l ${x2} ${y2} l ${x1} ${y2} l h`)
      .join('\n');
    content = `q\n/GS0 gs\n${red} ${green} ${blue} rg\n${polygonCommands}\nf\nQ`;
  } else if (record.type === 'underline') {
    const commands = localRects
      .map(([x1, y1, x2]) => {
        const thickness = Math.max(0.8, Math.min(2.2, height * 0.08));
        return `${x1} ${y1} m ${x2} ${y1} l S`;
      })
      .join('\n');
    content = `q\n${red} ${green} ${blue} RG\n1.4 w\n${commands}\nQ`;
  } else if (record.type === 'ink') {
    const points = normalizePoints(record.ink && record.ink.length ? record.ink : record.rects)
      .map(([x, y]) => `${x - left} ${y - bottom}`);
    if (points.length) {
      content = `q\n${red} ${green} ${blue} RG\n1.6 w\n1 J\n1 j\n${points[0]} m\n${points.slice(1).map((point) => `${point} l`).join('\n')}\nS\nQ`;
    }
  } else {
    const size = Math.max(14, Math.min(22, Math.min(width, height)));
    content = [
      'q',
      `${red} ${green} ${blue} rg`,
      `0 0 ${size} ${size} re f`,
      '0.18 0.17 0.14 RG 0.8 w',
      `0 0 ${size} ${size} re S`,
      '0.18 0.17 0.14 rg',
      `${size * 0.26} ${size * 0.55} m`,
      `${size * 0.74} ${size * 0.55} l`,
      `${size * 0.74} ${size * 0.7} l`,
      `${size * 0.26} ${size * 0.7} l h f`,
      `${size * 0.3} ${size * 0.31} m`,
      `${size * 0.7} ${size * 0.31} l`,
      `${size * 0.7} ${size * 0.43} l`,
      `${size * 0.3} ${size * 0.43} l h f`,
      'Q',
    ].join('\n');
  }

  const graphicsState = doc.context.obj({
    Type: 'ExtGState',
    BM: 'Multiply',
    ca: record.type === 'highlight' ? 0.32 : 0.9,
    CA: record.type === 'highlight' ? 0.32 : 0.9,
  });
  const resources = doc.context.obj({
    ExtGState: {
      GS0: doc.context.register(graphicsState),
    },
  });
  const appearance = doc.context.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, width, height],
    Resources: resources,
  });
  dictionary.set(PDFName.of('AP'), doc.context.obj({ N: doc.context.register(appearance) }));
}

function addAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  record: PdfAnnotationRecord,
): void {
  const rects = normalizedRects(record);
  const bounds = rects.reduce(
    (current, rect) => [
      Math.min(current[0], rect[0]),
      Math.min(current[1], rect[1]),
      Math.max(current[2], rect[2]),
      Math.max(current[3], rect[3]),
    ],
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  ) as [number, number, number, number];
  const [red, green, blue] = colorFromHex(record.color);
  const subtype = {
    highlight: 'Highlight',
    underline: 'Underline',
    note: 'Text',
    ink: 'Ink',
  }[record.type];
  const dictionary = doc.context.obj({
    Type: 'Annot',
    Subtype: subtype,
    Rect: bounds,
    C: [red, green, blue],
    CA: record.type === 'highlight' ? 0.32 : 1,
    F: 4,
    Border: [0, 0, 1],
    M: pdfDate(new Date(record.updatedAt)),
    NM: PDFString.of(record.id),
    T: textString(GRANITE_ANNOTATION_CREATOR),
    Contents: textString(record.note || record.text || ''),
    Subj: textString(subtype),
    P: page.ref,
  });

  if (record.type === 'highlight' || record.type === 'underline') {
    dictionary.set(PDFName.of('QuadPoints'), doc.context.obj(quadPoints(rects)));
  }
  if (record.type === 'note') {
    dictionary.set(PDFName.of('Name'), PDFName.of('Comment'));
    dictionary.set(PDFName.of('Open'), doc.context.obj(false));
  }
  if (record.type === 'ink') {
    const points = normalizePoints(record.ink && record.ink.length ? record.ink : record.rects);
    dictionary.set(
      PDFName.of('InkList'),
      doc.context.obj([doc.context.obj(points.flatMap(([x, y]) => [x, y]))]),
    );
  }

  addAppearance(doc, dictionary, record, bounds);
  const annotationRef = doc.context.register(dictionary);
  annotationArray(doc, page).push(annotationRef);
}

function recordFromDictionary(
  dictionary: PDFDict,
  pageNumber: number,
): PdfAnnotationRecord | null {
  const id = decodeStringObject(dictionary.lookup(ANNOTATION_ID));
  if (!id) return null;
  const subtype = decodeStringObject(dictionary.lookup(PDFName.of('Subtype')))
    || dictionary.lookup(PDFName.of('Subtype'), PDFName).asString().replace(/^\//, '');
  const subtypeMap: Record<string, PdfAnnotationRecord['type']> = {
    Highlight: 'highlight',
    Underline: 'underline',
    Text: 'note',
    Ink: 'ink',
  };
  const type = subtypeMap[subtype];
  if (!type) return null;
  const rects: number[][] = [];
  const quad = dictionary.lookupMaybe(PDFName.of('QuadPoints'), PDFArray);
  if (quad) {
    const numbers = quad.asArray().map(numberValue);
    for (let index = 0; index + 7 < numbers.length; index += 8) {
      const values = numbers.slice(index, index + 8) as number[];
      const xs = values.filter((_, valueIndex) => valueIndex % 2 === 0);
      const ys = values.filter((_, valueIndex) => valueIndex % 2 === 1);
      rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  }
  const inkList = dictionary.lookupMaybe(PDFName.of('InkList'), PDFArray);
  const inkStroke = inkList?.lookupMaybe(0, PDFArray);
  const ink = inkStroke
    ? [inkStroke.asArray().map(numberValue).filter((value): value is number => value != null)]
    : undefined;
  const date = decodeStringObject(dictionary.lookup(PDFName.of('M')));
  return {
    id,
    page: pageNumber,
    type,
    color: hexFromColor(dictionary.lookup(PDFName.of('C'))),
    text: '',
    note: decodeStringObject(dictionary.lookup(PDFName.of('Contents'))),
    rects,
    ...(ink ? { ink } : {}),
    createdAt: date || new Date(0).toISOString(),
    updatedAt: date || new Date(0).toISOString(),
  };
}

export async function writePdfAnnotations(
  source: Uint8Array,
  records: PdfAnnotationRecord[],
  options: WritePdfAnnotationsOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  const pages = doc.getPages();
  const ids = new Set(records.map((record) => record.id));

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    removeAnnotationIds(doc, page, (id, creator) => {
      if (!id) return false;
      if (ids.has(id)) return true;
      return Boolean(options.removeMissingGraniteAnnotations && creator === GRANITE_ANNOTATION_CREATOR);
    });
  }

  for (const record of records) {
    const page = pages[record.page - 1];
    if (!page) throw new Error(`PDF 第 ${record.page} 页不存在`);
    addAnnotation(doc, page, record);
  }

  const output = await doc.save({ useObjectStreams: false });
  await PDFDocument.load(output, { updateMetadata: false });
  return output;
}

export async function removePdfAnnotations(
  source: Uint8Array,
  ids: string[],
): Promise<Uint8Array> {
  const idSet = new Set(ids);
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  for (const page of doc.getPages()) {
    removeAnnotationIds(doc, page, (id) => idSet.has(id));
  }
  const output = await doc.save({ useObjectStreams: false });
  await PDFDocument.load(output, { updateMetadata: false });
  return output;
}

export async function readPdfAnnotations(source: Uint8Array): Promise<PdfAnnotationRecord[]> {
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  const records: PdfAnnotationRecord[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.lookupMaybe(ANNOTATION_ANNOTS, PDFArray);
    if (!annots) return;
    for (let index = 0; index < annots.size(); index += 1) {
      const dictionary = doc.context.lookupMaybe(annots.get(index), PDFDict);
      if (!dictionary) continue;
      const creator = decodeStringObject(dictionary.lookup(ANNOTATION_CREATOR));
      if (creator !== GRANITE_ANNOTATION_CREATOR) continue;
      const record = recordFromDictionary(dictionary, pageIndex + 1);
      if (record) records.push(record);
    }
  });
  return records;
}

export function annotationRectFromPoints(points: number[]): number[] {
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

