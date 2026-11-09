import { describe, expect, it } from 'vitest'
import {
  buildBacklinkIndex,
  noteMarkdownPath,
  parseWikiLinks,
  renameNote,
} from './index'

describe('Markdown wikilinks and backlinks', () => {
  it('ignores links inside fenced and inline code', () => {
    const markdown = [
      '[[Projects/Granite#Roadmap|Granite]] and ![[cover.png]]',
      '`[[inline-code]]`',
      '```md',
      '[[fenced-code]]',
      '```',
    ].join('\n')

    expect(parseWikiLinks(markdown)).toEqual([
      expect.objectContaining({
        target: 'Projects/Granite',
        heading: 'Roadmap',
        alias: 'Granite',
        embed: false,
      }),
      expect.objectContaining({
        target: 'cover.png',
        embed: true,
      }),
    ])
  })

  it('resolves relative links and creates backlink indexes', () => {
    const notes = [
      {
        id: 'source',
        title: 'Source',
        folder: 'Projects',
        body: 'See [[Target#Part 2]] and [[Missing]].',
      },
      {
        id: 'target',
        title: 'Target',
        folder: 'Projects',
        body: '',
      },
    ]

    const index = buildBacklinkIndex(notes)
    expect(index.byNoteId.target).toEqual([
      expect.objectContaining({
        sourceNoteId: 'source',
        sourcePath: 'Projects/Source',
        resolvedNoteId: 'target',
      }),
    ])
    expect(index.unresolved).toHaveLength(1)
  })

  it('renames a note and updates only links that resolve to it', () => {
    const notes = [
      {
        id: 'source',
        title: 'Source',
        folder: 'Projects',
        body: '[[Target|kept alias]] and [[Other]]',
      },
      {
        id: 'target',
        title: 'Target',
        folder: 'Projects',
        body: '',
      },
      {
        id: 'other',
        title: 'Other',
        folder: 'Projects',
        body: '',
      },
    ]

    const result = renameNote(notes, 'target', 'Renamed')
    expect(result.updatedLinks).toBe(1)
    expect(result.notes[0]?.body).toBe('[[Renamed|kept alias]] and [[Other]]')
    expect(noteMarkdownPath(result.notes[1]!)).toBe('Projects/Renamed.md')
  })
})
