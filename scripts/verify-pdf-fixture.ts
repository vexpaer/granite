import fs from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writePdfAnnotations } from "../src/reader/pdf-annotations";
import type { PdfAnnotationRecord } from "../src/reader/types";
const doc = await PDFDocument.create();
const page = doc.addPage([400, 500]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText("Granite standard PDF annotation verification", {
  x: 30,
  y: 460,
  size: 14,
  font,
});
page.drawText("Highlighted passage", { x: 50, y: 400, size: 13, font });
page.drawText("Underlined passage", { x: 55, y: 360, size: 13, font });
page.drawText("Text note and ink remain editable.", {
  x: 30,
  y: 280,
  size: 13,
  font,
});
const at = new Date().toISOString();
const base = {
  page: 1,
  color: "#f4c542",
  text: "Original Granite verification text",
  note: "External reader verification",
  createdAt: at,
  updatedAt: at,
};
const annotations: PdfAnnotationRecord[] = [
  {
    ...base,
    id: "external-highlight",
    type: "highlight",
    rects: [[48, 396, 183, 414]],
  },
  {
    ...base,
    id: "external-underline",
    type: "underline",
    color: "#79a7ff",
    rects: [[53, 356, 185, 374]],
  },
  { ...base, id: "external-note", type: "note", rects: [[220, 330, 244, 354]] },
  {
    ...base,
    id: "external-ink",
    type: "ink",
    color: "#ef8fab",
    rects: [[30, 30, 160, 90]],
    ink: [
      [30, 30],
      [65, 70],
      [100, 40],
      [160, 90],
    ],
  },
];
await fs.mkdir("artifacts/verification", { recursive: true });
await fs.writeFile(
  "artifacts/verification/annotated-standard.pdf",
  await writePdfAnnotations(await doc.save(), annotations),
);
console.log(
  "Wrote original PDF with Highlight, Underline, Text and Ink annotations.",
);
