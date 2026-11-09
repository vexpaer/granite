import fs from "node:fs/promises";
import path from "node:path";
const origin = path.resolve("node_modules/pdfjs-dist");
const target = path.resolve("public/pdfjs");
await fs.mkdir(target, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm"])
  await fs.cp(path.join(origin, dir), path.join(target, dir), {
    recursive: true,
  });
await fs.copyFile(path.join(origin, "LICENSE"), path.join(target, "LICENSE"));
console.log("Copied offline PDF CMaps, standard fonts, WASM and licenses.");
