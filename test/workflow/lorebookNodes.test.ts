import { describe, it, expect, vi, beforeEach } from 'vitest'

// Lorebook selection/fetch nodes (context-epochs plan §2): deterministic per-call lorebook subsets
// on a `Lore` wire (no keyword scan). lorebook.select filters books + entries; lorebook.entries
// fetches contents; tool.lorebookSearch gains a `books` input + an `entries` output.

const svc = vi.hoisted(() => ({ matchAcross: vi.fn() }))
vi.mock('../../src/main/services/lorebookService', () => ({ matchAcross: svc.matchAcross }))

import {
  lorebookSelect,
  lorebookEntries
} from '../../src/main/services/nodes/builtin/lorebookNodes'
import { toolLorebookSearch } from '../../src/main/services/nodes/builtin/toolNodes'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown> = {}) => ({
  id,
  config: impl.configSchema ? (impl.configSchema.parse(rawConfig) as Record<string, unknown>) : {}
})

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  keys: [],
  content: '',
  enabled: true,
  constant: false,
  comment: '',
  ...over
})

const gen = () => ({
  profileId: 'p1',
  chatId: 'c1',
  maxRecursion: 0,
  lorebooks: [
    {
      name: 'Setting',
      entries: [
        entry({ comment: '世界规则', content: 'The world spins.', constant: true }),
        entry({ comment: '战斗规则', content: 'Combat is d20.' }),
        entry({ comment: 'disabled one', content: 'hidden', enabled: false })
      ]
    },
    {
      name: 'Combat Rules',
      entries: [entry({ comment: 'extra rule', content: 'Flanking grants advantage.' })]
    }
  ]
})

beforeEach(() => {
  svc.matchAcross.mockReset()
})

describe('lorebook.select', () => {
  it('empty config: all books, deep-copied (mutating output does not touch gen.lorebooks)', () => {
    const g = gen()
    const r = lorebookSelect.run(ctx, { gen: g }, meta(lorebookSelect, 'n1'))
    const books = (r.outputs as { books: any[] }).books
    expect(books).toHaveLength(2)
    // deep copy: distinct book + entries objects
    expect(books[0]).not.toBe(g.lorebooks[0])
    expect(books[0].entries[0]).not.toBe(g.lorebooks[0].entries[0])
    books[0].entries[0].content = 'MUTATED'
    expect(g.lorebooks[0].entries[0].content).toBe('The world spins.')
  })

  it('books filter (contains, case-insensitive) narrows which books are kept', () => {
    const r = lorebookSelect.run(ctx, { gen: gen() }, meta(lorebookSelect, 'n1', { books: 'setting' }))
    const books = (r.outputs as { books: any[] }).books
    expect(books.map((b) => b.name)).toEqual(['Setting'])
  })

  it('entries filter keeps entries whose comment matches ANY term', () => {
    const r = lorebookSelect.run(
      ctx,
      { gen: gen() },
      meta(lorebookSelect, 'n1', { entries: '世界' })
    )
    const books = (r.outputs as { books: any[] }).books
    const comments = books.flatMap((b) => b.entries.map((e: any) => e.comment))
    // disabled entries are NOT dropped by select (that's lorebook.entries' job) — only comment filter
    expect(comments).toEqual(['世界规则'])
  })

  it('exclude_entries drops matching entries AFTER the keep filter (the 世界推进 "not 战斗规则" case)', () => {
    const r = lorebookSelect.run(
      ctx,
      { gen: gen() },
      meta(lorebookSelect, 'n1', { exclude_entries: '战斗' })
    )
    const books = (r.outputs as { books: any[] }).books
    const comments = books.flatMap((b) => b.entries.map((e: any) => e.comment))
    expect(comments).toContain('世界规则')
    expect(comments).not.toContain('战斗规则')
  })
})

describe('lorebook.entries', () => {
  it('unwired books falls back to gen.lorebooks; block joins RAW contents; skips disabled', () => {
    const r = lorebookEntries.run(ctx, { gen: gen() }, meta(lorebookEntries, 'n1'))
    const out = r.outputs as { block: string; entries: Array<{ comment: string; content: string }> }
    // disabled entry ('hidden') is skipped; order preserved
    expect(out.block).toBe('The world spins.\n\nCombat is d20.\n\nFlanking grants advantage.')
    expect(out.entries.map((e) => e.comment)).toEqual(['世界规则', '战斗规则', 'extra rule'])
  })

  it('constant_only keeps only constant entries', () => {
    const r = lorebookEntries.run(
      ctx,
      { gen: gen() },
      meta(lorebookEntries, 'n1', { constant_only: true })
    )
    const out = r.outputs as { block: string; entries: unknown[] }
    expect(out.block).toBe('The world spins.')
    expect(out.entries).toHaveLength(1)
  })

  it('filter matches comment substrings', () => {
    const r = lorebookEntries.run(
      ctx,
      { gen: gen() },
      meta(lorebookEntries, 'n1', { filter: '战斗,extra' })
    )
    const out = r.outputs as { block: string }
    expect(out.block).toBe('Combat is d20.\n\nFlanking grants advantage.')
  })

  it('max_chars caps the block length', () => {
    const r = lorebookEntries.run(
      ctx,
      { gen: gen() },
      meta(lorebookEntries, 'n1', { max_chars: 5 })
    )
    expect((r.outputs as { block: string }).block).toBe('The w')
  })

  it('a wired books subset is used instead of gen.lorebooks', () => {
    const subset = [{ name: 'X', entries: [entry({ comment: 'c', content: 'only this' })] }]
    const r = lorebookEntries.run(
      ctx,
      { gen: gen(), books: subset },
      meta(lorebookEntries, 'n1')
    )
    expect((r.outputs as { block: string }).block).toBe('only this')
  })
})

describe('tool.lorebookSearch — new books input + entries output', () => {
  it('honors a wired books input and still applies the config book_filter', () => {
    svc.matchAcross.mockReturnValue([{ comment: 'r', content: 'hit' }])
    const wired = [
      { name: 'Setting', entries: [] },
      { name: 'Combat Rules', entries: [] }
    ]
    const r = toolLorebookSearch.run(
      ctx,
      { gen: gen(), query: 'q', books: wired },
      meta(toolLorebookSearch, 'n1', { book_filter: 'combat' })
    )
    // matchAcross received ONLY the config-filtered subset of the WIRED books (Combat Rules).
    const passedBooks = svc.matchAcross.mock.calls[0][0]
    expect(passedBooks.map((b: any) => b.name)).toEqual(['Combat Rules'])
    const out = r.outputs as { block: string; entries: Array<{ comment: string; content: string }> }
    expect(out.block).toBe('hit')
    // entries output mirrors the block
    expect(out.entries).toEqual([{ comment: 'r', content: 'hit' }])
  })

  it('entries output matches the block for multiple hits', () => {
    svc.matchAcross.mockReturnValue([
      { comment: 'a', content: 'alpha' },
      { comment: 'b', content: 'beta' }
    ])
    const r = toolLorebookSearch.run(ctx, { gen: gen(), query: 'q' }, meta(toolLorebookSearch, 'n1'))
    const out = r.outputs as { block: string; entries: Array<{ content: string }> }
    expect(out.block).toBe('alpha\n\nbeta')
    expect(out.entries.map((e) => e.content).join('\n\n')).toBe(out.block)
  })
})
