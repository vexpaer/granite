import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const root = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(root, 'src', 'main.js')
const templatePath = join(root, 'manifest.template.json')
const outputDirectory = join(root, 'dist')

const main = await readFile(sourcePath)
const manifest = JSON.parse(await readFile(templatePath, 'utf8'))
manifest.integrity = `sha256-${createHash('sha256').update(main).digest('base64')}`

const zip = new JSZip()
zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
zip.file(manifest.main, main)

await mkdir(outputDirectory, { recursive: true })
await writeFile(
  join(outputDirectory, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
)
await writeFile(
  join(outputDirectory, 'example.basic.granite.zip'),
  await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
)

console.log(`Built ${join(outputDirectory, 'example.basic.granite.zip')}`)
console.log(`Integrity ${manifest.integrity}`)
