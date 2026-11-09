import fs from "node:fs/promises";
await fs.mkdir(".cache/qa-dist", { recursive: true });
await fs.cp("dist", ".cache/qa-dist", { recursive: true });
console.log("Frozen production build copied for browser integration tests.");
