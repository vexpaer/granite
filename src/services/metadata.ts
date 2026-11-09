import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import type { Book, Format } from "../types";
export async function extractMetadata(
  name: string,
  bytes: Uint8Array,
): Promise<Partial<Book>> {
  const format = name.split(".").pop()?.toLowerCase() as Format;
  if (!["epub", "pdf", "txt", "mobi"].includes(format))
    throw new Error("支持 EPUB、PDF、TXT 和 MOBI 文件。");
  if (!bytes.length) throw new Error("文件为空。");
  const meta: Partial<Book> = {
    format,
    title: name.replace(/\.[^.]+$/, ""),
    authors: [],
  };
  if (format === "epub") {
    const zip = await JSZip.loadAsync(bytes);
    const container = zip.file("META-INF/container.xml");
    if (!container) throw new Error("EPUB 缺少 container.xml。");
    const parser = new DOMParser();
    const xml = parser.parseFromString(
      await container.async("string"),
      "application/xml",
    );
    const opfPath = xml
      .getElementsByTagName("rootfile")[0]
      ?.getAttribute("full-path");
    if (!opfPath || !zip.file(opfPath)) throw new Error("EPUB 缺少书籍清单。");
    const opf = parser.parseFromString(
      await zip.file(opfPath)!.async("string"),
      "application/xml",
    );
    const content = (tag: string) =>
      Array.from(opf.getElementsByTagNameNS("*", tag))
        .map((n) => n.textContent?.trim() || "")
        .filter(Boolean);
    meta.title = content("title")[0] || meta.title;
    meta.authors = content("creator");
    meta.language = content("language")[0];
    meta.publisher = content("publisher")[0];
    meta.description = content("description")[0];
    const coverId = Array.from(opf.getElementsByTagName("meta"))
      .find((n) => n.getAttribute("name") === "cover")
      ?.getAttribute("content");
    const item = Array.from(opf.getElementsByTagName("item")).find(
      (n) =>
        n.getAttribute("id") === coverId ||
        n.getAttribute("properties")?.includes("cover-image"),
    );
    if (item) {
      const base = opfPath.includes("/")
        ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
        : "";
      const href = item.getAttribute("href") || "";
      const file = zip.file(base + href);
      if (file) {
        const encoded = await file.async("base64");
        meta.cover = `data:${item.getAttribute("media-type") || "image/jpeg"};base64,${encoded}`;
      }
    }
  } else if (format === "pdf") {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    meta.title = doc.getTitle() || meta.title;
    meta.authors = doc.getAuthor() ? [doc.getAuthor()!] : [];
    meta.description = doc.getSubject();
  } else if (format === "mobi") {
    const header = new TextDecoder("ascii").decode(bytes.slice(60, 68));
    if (header !== "BOOKMOBI")
      throw new Error("不是可识别的 MOBI 文件（或文件已损坏）。");
    const { initMobiFile } = await import("@lingo-reader/mobi-parser");
    const mobi = await initMobiFile(bytes);
    try {
      const parsed = mobi.getMetadata();
      meta.title = parsed.title || meta.title;
      meta.authors = parsed.author || [];
    } finally {
      mobi.destroy();
    }
  } else if (bytes.includes(0) && bytes[0] !== 0xff && bytes[0] !== 0xfe) {
    throw new Error("文件可能不是纯文本，请检查格式或编码。");
  }
  return meta;
}
