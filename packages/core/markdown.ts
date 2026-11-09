export interface WikiLink {
  raw: string
  target: string
  heading?: string
  alias?: string
  embed: boolean
  start: number
  end: number
}

export interface MarkdownNoteDocument {
  id: string
  title: string
  folder: string
  body: string
}

export interface WikiLinkOccurrence extends WikiLink {
  sourceNoteId: string
  sourcePath: string
  resolvedNoteId?: string
}

export interface BacklinkIndex {
  byTarget: Record<string, WikiLinkOccurrence[]>
  byNoteId: Record<string, WikiLinkOccurrence[]>
  unresolved: WikiLinkOccurrence[]
}

export interface RenameWikiLinksOptions {
  caseSensitive?: boolean
  preserveAlias?: boolean
}

export interface RenameNoteResult {
  notes: MarkdownNoteDocument[]
  updatedLinks: number
}

interface MaskedMarkdown {
  masked: string
  original: string
}

function notePath(note: Pick<MarkdownNoteDocument, 'title' | 'folder'>): string {
  const folder = normalizeFolder(note.folder)
  const title = note.title.replace(/\.md$/i, '')
  return folder ? `${folder}/${title}` : title
}

function normalizeFolder(folder: string): string {
  return folder
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/')
}

function normalizeTarget(target: string): string {
  return target
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.md$/i, '')
    .replace(/\/+/g, '/')
}

function relativeTarget(sourceFolder: string, target: string): string {
  const normalizedTarget = normalizeTarget(target)
  if (!sourceFolder || normalizedTarget.includes('/')) return normalizedTarget
  return `${normalizeFolder(sourceFolder)}/${normalizedTarget}`
}

function blankRange(characters: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' '
  }
}

function maskMarkdown(markdown: string): MaskedMarkdown {
  const characters = markdown.split('')
  let fence: { marker: string; length: number } | undefined

  let offset = 0
  for (const line of markdown.split(/(?<=\n)/)) {
    const content = line.replace(/\r?\n$/, '')
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(content)
    if (fence) {
      blankRange(characters, offset, offset + line.length)
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = undefined
      }
    } else if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length }
      blankRange(characters, offset, offset + line.length)
    } else {
      for (let index = 0; index < content.length; ) {
        if (content[index] !== '`') {
          index += 1
          continue
        }
        let runEnd = index
        while (content[runEnd] === '`') runEnd += 1
        const ticks = content.slice(index, runEnd)
        const closing = content.indexOf(ticks, runEnd)
        if (closing < 0) {
          index = runEnd
          continue
        }
        blankRange(characters, offset + index, offset + closing + ticks.length)
        index = closing + ticks.length
      }
    }
    offset += line.length
  }

  return { masked: characters.join(''), original: markdown }
}

export function parseWikiLinks(markdown: string): WikiLink[] {
  const { masked, original } = maskMarkdown(markdown)
  const links: WikiLink[] = []
  const expression = /(!)?\[\[([^\]\n]+)\]\]/g

  for (const match of masked.matchAll(expression)) {
    const start = match.index
    const end = start + match[0].length
    const inner = original.slice(start + (match[1] ? 3 : 2), end - 2)
    const pipe = inner.indexOf('|')
    const targetAndHeading = pipe < 0 ? inner : inner.slice(0, pipe)
    const alias = pipe < 0 ? undefined : inner.slice(pipe + 1).trim()
    const hash = targetAndHeading.indexOf('#')
    const target = (hash < 0 ? targetAndHeading : targetAndHeading.slice(0, hash)).trim()
    const heading = hash < 0 ? undefined : targetAndHeading.slice(hash + 1).trim()
    if (!target) continue
    links.push({
      raw: original.slice(start, end),
      target: normalizeTarget(target),
      ...(heading ? { heading } : {}),
      ...(alias ? { alias } : {}),
      embed: Boolean(match[1]),
      start,
      end,
    })
  }

  return links
}

export const extractWikiLinks = parseWikiLinks

export function resolveWikiLink(
  link: Pick<WikiLink, 'target'>,
  source: Pick<MarkdownNoteDocument, 'id' | 'folder'>,
  notes: readonly MarkdownNoteDocument[],
): MarkdownNoteDocument | undefined {
  const target = normalizeTarget(link.target)
  if (!target) return undefined
  const relative = relativeTarget(source.folder, target).toLowerCase()

  const relativeMatch = notes.find(
    (note) => note.id !== source.id && notePath(note).toLowerCase() === relative,
  )
  if (relativeMatch) return relativeMatch

  if (target.includes('/')) {
    return notes.find(
      (note) => note.id !== source.id && notePath(note).toLowerCase() === target.toLowerCase(),
    )
  }

  const titleMatches = notes.filter(
    (note) => note.id !== source.id && note.title.replace(/\.md$/i, '').toLowerCase() === target.toLowerCase(),
  )
  return titleMatches.length === 1 ? titleMatches[0] : undefined
}

export function buildBacklinkIndex(notes: readonly MarkdownNoteDocument[]): BacklinkIndex {
  const byTarget: Record<string, WikiLinkOccurrence[]> = {}
  const byNoteId: Record<string, WikiLinkOccurrence[]> = {}
  const unresolved: WikiLinkOccurrence[] = []

  for (const note of notes) {
    for (const link of parseWikiLinks(note.body)) {
      const resolved = resolveWikiLink(link, note, notes)
      const occurrence: WikiLinkOccurrence = {
        ...link,
        sourceNoteId: note.id,
        sourcePath: notePath(note),
        ...(resolved ? { resolvedNoteId: resolved.id } : {}),
      }
      ;(byTarget[link.target] ??= []).push(occurrence)
      if (resolved) (byNoteId[resolved.id] ??= []).push(occurrence)
      else unresolved.push(occurrence)
    }
  }

  for (const entries of Object.values(byTarget)) {
    entries.sort((left, right) =>
      left.sourcePath === right.sourcePath
        ? left.start - right.start
        : left.sourcePath.localeCompare(right.sourcePath),
    )
  }
  for (const entries of Object.values(byNoteId)) {
    entries.sort((left, right) =>
      left.sourcePath === right.sourcePath
        ? left.start - right.start
        : left.sourcePath.localeCompare(right.sourcePath),
    )
  }

  return { byTarget, byNoteId, unresolved }
}

function replaceLinkTarget(
  link: WikiLink,
  nextTarget: string,
  options: RenameWikiLinksOptions,
): string {
  const embedPrefix = link.embed ? '!' : ''
  const heading = link.heading ? `#${link.heading}` : ''
  const alias =
    options.preserveAlias === false
      ? ''
      : link.alias
        ? `|${link.alias}`
        : ''
  return `${embedPrefix}[[${nextTarget}${heading}${alias}]]`
}

export function renameWikiLinks(
  markdown: string,
  oldTarget: string,
  newTarget: string,
  options: RenameWikiLinksOptions = {},
): string {
  const normalize = (value: string) =>
    options.caseSensitive === false ? normalizeTarget(value).toLowerCase() : normalizeTarget(value)
  const previous = normalize(oldTarget)
  const replacement = normalizeTarget(newTarget)
  const links = parseWikiLinks(markdown)
  let output = markdown

  for (const link of [...links].sort((left, right) => right.start - left.start)) {
    const candidates = new Set([normalize(link.target)])
    if (link.target.includes('/')) {
      const basename = link.target.slice(link.target.lastIndexOf('/') + 1)
      candidates.add(normalize(basename))
    }
    if (!candidates.has(previous)) continue

    const relativeReplacement = newTarget.includes('/')
      ? replacement
      : replacement.slice(replacement.lastIndexOf('/') + 1)
    output =
      output.slice(0, link.start) +
      replaceLinkTarget(link, relativeReplacement, options) +
      output.slice(link.end)
  }

  return output
}

export function renameNote(
  notes: readonly MarkdownNoteDocument[],
  noteId: string,
  newTitle: string,
): RenameNoteResult {
  const target = notes.find((note) => note.id === noteId)
  if (!target) throw new Error(`note not found: ${noteId}`)

  const cleanedTitle = newTitle.trim().replace(/\.md$/i, '')
  if (!cleanedTitle) throw new TypeError('note title cannot be empty')
  const oldPath = notePath(target)
  const oldTitle = target.title.replace(/\.md$/i, '')
  const renamed: MarkdownNoteDocument = { ...target, title: cleanedTitle }
  const newPath = notePath(renamed)
  let updatedLinks = 0

  const updated = notes.map((note) => {
    if (note.id === noteId) return renamed
    const links = parseWikiLinks(note.body)
    if (!links.length) return { ...note }

    let body = note.body
    for (const link of [...links].sort((left, right) => right.start - left.start)) {
      const resolved = resolveWikiLink(link, note, notes)
      if (resolved?.id !== noteId) continue
      const resolvedUsesPath = link.target.includes('/')
      const replacement = resolvedUsesPath ? newPath : cleanedTitle
      body =
        body.slice(0, link.start) +
        replaceLinkTarget(link, replacement, { preserveAlias: true }) +
        body.slice(link.end)
      updatedLinks += 1
    }
    return { ...note, body }
  })

  void oldPath
  void oldTitle
  return { notes: updated, updatedLinks }
}

export function noteMarkdownPath(note: Pick<MarkdownNoteDocument, 'title' | 'folder'>): string {
  return `${notePath(note)}.md`
}
