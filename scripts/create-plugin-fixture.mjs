import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const outputDirectory = path.resolve('.cache', 'fixtures');
const pluginId = 'qa.granite.sandbox';
const pageId = `${pluginId}:page`;
const validFilename = 'granite-sandbox-probe.granite.zip';
const tamperedFilename = 'granite-sandbox-probe-integrity-mismatch.granite.zip';

const bundle =
  `/* Original Granite E2E fixture. MIT licensed. */\n` +
  `export async function activate(api) {\n` +
  `  api.permissions.assert('storage.namespace');\n` +
  `  api.permissions.assert('ui.register');\n` +
  `  const root = document.getElementById('app');\n` +
  `  if (!root) throw new Error('sandbox root is missing');\n` +
  `  const stored = await api.storage.get('activation-count');\n` +
  `  const previous = Number(stored ?? 0);\n` +
  `  const activationCount = Number.isFinite(previous) ? previous + 1 : 1;\n` +
  `  await api.storage.set('activation-count', activationCount);\n` +
  `  const readBack = Number(await api.storage.get('activation-count'));\n` +
  `  await api.ui.register({\n` +
  `    id: ${JSON.stringify(pageId)},\n` +
  `    type: 'page',\n` +
  `    slot: 'settings.pages',\n` +
  `    title: 'Sandbox Probe Page',\n` +
  `    order: 10\n` +
  `  });\n` +
  `  const heading = document.createElement('h1');\n` +
  `  heading.textContent = 'Sandbox QA Probe';\n` +
  `  const storage = document.createElement('output');\n` +
  `  storage.dataset.testid = 'storage-roundtrip';\n` +
  `  storage.textContent = 'storage-' + activationCount + '-' + readBack;\n` +
  `  const tauri = document.createElement('p');\n` +
  `  tauri.dataset.testid = 'tauri-globals';\n` +
  `  tauri.textContent = 'tauri:' + typeof globalThis.__TAURI__ + ';internals:' + typeof globalThis.__TAURI_INTERNALS__;\n` +
  `  root.replaceChildren(heading, storage, tauri);\n` +
  `  document.title = 'Sandbox QA Probe';\n` +
  `  return async () => {\n` +
  `    const cleanup = document.createElement('p');\n` +
  `    cleanup.textContent = 'Sandbox stopped';\n` +
  `    document.getElementById('app')?.replaceChildren(cleanup);\n` +
  `  };\n` +
  `}\n` +
  `export async function deactivate() {}\n`;

const integrity = `sha384-${createHash('sha384').update(bundle).digest('base64')}`;
const manifest = {
  schemaVersion: 1,
  id: pluginId,
  name: 'Sandbox QA Probe',
  version: '1.2.3',
  apiVersion: '^1.0.0',
  main: 'main.js',
  dependencies: {},
  optionalDependencies: {},
  permissions: ['storage.namespace', 'ui.register'],
  permissionScopes: {
    'storage.namespace': ['activation-count'],
    'ui.register': ['settings.pages'],
  },
  contributes: [
    {
      id: pageId,
      type: 'page',
      slot: 'settings.pages',
      title: 'Sandbox Probe Page',
    },
  ],
  platforms: ['windows', 'android'],
  author: 'Granite QA',
  license: 'MIT',
  repository: 'https://example.invalid/granite/sandbox-probe',
  integrity,
  source: {
    kind: 'local',
    uri: 'https://example.invalid/granite/sandbox-probe',
    publisher: 'Granite QA',
  },
  trust: 'untrusted',
  ui: {
    kind: 'iframe',
  },
  description: 'Original minimal ESM package for Granite plugin runtime E2E coverage.',
};

const license = `MIT License

Copyright (c) 2026 Granite QA

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const sourceNotice =
  'Original synthetic Granite QA fixture. It has no third-party source, assets, or runtime imports.\n';

async function packagePlugin(bundleSource) {
  const zip = new JSZip();
  zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  zip.file(manifest.main, bundleSource);
  zip.file('LICENSE.txt', license);
  zip.file('SOURCE.txt', sourceNotice);
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(
  path.join(outputDirectory, validFilename),
  await packagePlugin(bundle),
);
await fs.writeFile(
  path.join(outputDirectory, tamperedFilename),
  await packagePlugin(`${bundle}\n// Changed after the manifest SRI was calculated.\n`),
);

console.log(`Plugin fixture written: ${path.join(outputDirectory, validFilename)}`);
console.log(
  `Integrity-mismatch fixture written: ${path.join(outputDirectory, tamperedFilename)}`,
);
console.log(`Plugin ID: ${pluginId}`);
console.log(`Bundle integrity: ${integrity}`);
