import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  collectBundledRegex,
  collectBundledPresets,
  collectBundledLorebooks,
  summarizeCardBundle,
  hasBundle,
  parseCardFile
} from '../src/main/services/characterService'
import { RPTerminalCardSchema } from '../src/main/types/character'

const tmpFiles: string[] = []
const writeJson = (obj: unknown): string => {
  const p = path.join(os.tmpdir(), `rpt-card-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(p, JSON.stringify(obj), 'utf-8')
  tmpFiles.push(p)
  return p
}
afterEach(() => {
  while (tmpFiles.length) fs.rmSync(tmpFiles.pop()!, { force: true })
})

const regexRule = (name: string) => ({
  id: name,
  scriptName: name,
  findRegex: '/x/g',
  replaceString: 'y',
  placement: [2]
})

// Build a card through the real schema so we exercise the catchall (lossless) path.
const card = (ext: Record<string, unknown>) =>
  RPTerminalCardSchema.parse({ data: { name: 'World', extensions: ext } })

describe('collectBundledRegex', () => {
  it('pulls from both extensions.regex_scripts and rp_terminal.regex', () => {
    const c = card({
      regex_scripts: [regexRule('st-a'), regexRule('st-b')],
      rp_terminal: { regex: [regexRule('rpt-a')] }
    })
    expect(collectBundledRegex(c).map((r) => r.scriptName)).toEqual(['st-a', 'st-b', 'rpt-a'])
  })

  it('preserves the regex slots through Zod parsing (catchall, not stripped)', () => {
    const c = card({ regex_scripts: [regexRule('keep')], rp_terminal: { regex: [regexRule('also')] } })
    // The schema must NOT drop these unknown keys — that is the losslessness fix.
    expect((c.data.extensions as any).regex_scripts).toHaveLength(1)
    expect((c.data.extensions as any).rp_terminal.regex).toHaveLength(1)
  })

  it('ignores non-object entries and missing slots', () => {
    expect(collectBundledRegex(card({}))).toEqual([])
    expect(collectBundledRegex(card({ regex_scripts: ['nope', null, regexRule('ok')] }))).toHaveLength(1)
  })
})

describe('collectBundledPresets / collectBundledLorebooks', () => {
  it('reads presets[] and lorebooks[] from rp_terminal, filtering non-objects', () => {
    const c = card({
      rp_terminal: {
        presets: [{ name: 'P1', parameters: {}, prompts: [] }, null, 'nope'],
        lorebooks: [{ name: 'Extra', entries: [] }]
      }
    })
    expect(collectBundledPresets(c)).toHaveLength(1)
    expect(collectBundledLorebooks(c)).toHaveLength(1)
    expect(collectBundledPresets(card({}))).toEqual([])
    expect(collectBundledLorebooks(card({}))).toEqual([])
  })
})

describe('summarizeCardBundle + hasBundle', () => {
  it('counts regex, presets, lorebooks, scripts, ui widgets and flags a World Card', () => {
    const parsed = {
      card: card({
        regex_scripts: [regexRule('a'), regexRule('b')],
        rp_terminal: {
          world_card: '1.0',
          scripts: [{ name: 's', code: '' }],
          ui_layout: [{ type: 'StatBar', path: 'hp' }],
          presets: [{ name: 'P', parameters: {}, prompts: [] }],
          lorebooks: [{ name: 'Extra', entries: [] }],
          plugins: [{ manifest: {} }]
        }
      }),
      lorebook: { name: 'L', entries: [{ keys: ['k'], content: 'c' } as any] }
    }
    const s = summarizeCardBundle(parsed as any)
    expect(s).toMatchObject({
      name: 'World',
      isWorldCard: true,
      regexScripts: 2,
      loreEntries: 1,
      scripts: 1,
      uiWidgets: 1,
      presets: 1,
      lorebooks: 1,
      pluginsSkipped: 1
    })
    expect(hasBundle(s)).toBe(true)
  })

  it('a plain card (no bundle) does not warrant the install confirm', () => {
    const s = summarizeCardBundle({ card: card({}), lorebook: null } as any)
    expect(s).toMatchObject({
      isWorldCard: false,
      regexScripts: 0,
      scripts: 0,
      uiWidgets: 0,
      presets: 0,
      lorebooks: 0
    })
    expect(hasBundle(s)).toBe(false)
  })
})

describe('parseCardFile (lossless)', () => {
  it('preserves the full extensions object from a wrapped v3 card', () => {
    const file = writeJson({
      spec: 'chara_card_v3',
      data: {
        name: 'Aria',
        extensions: {
          regex_scripts: [regexRule('beautify')],
          depth_prompt: { prompt: 'keep me', depth: 4 }, // unknown ST key must survive
          rp_terminal: { world_card: '1.0', regex: [regexRule('extra')] }
        },
        character_book: { name: 'Book', entries: [{ keys: ['town'], content: 'A town.' }] }
      }
    })
    const parsed = parseCardFile(file)!
    expect(parsed.card.data.name).toBe('Aria')
    const ext = parsed.card.data.extensions as any
    expect(ext.regex_scripts).toHaveLength(1)
    expect(ext.depth_prompt).toEqual({ prompt: 'keep me', depth: 4 })
    expect(ext.rp_terminal.world_card).toBe('1.0')
    // character_book is routed to the lorebook store, normalized here.
    expect(parsed.lorebook?.entries[0].keys).toEqual(['town'])
    expect(collectBundledRegex(parsed.card)).toHaveLength(2)
  })

  it('imports an unwrapped raw JSON card (no spec field)', () => {
    const file = writeJson({ name: 'Raw', description: 'hi', extensions: { regex_scripts: [regexRule('r')] } })
    const parsed = parseCardFile(file)!
    expect(parsed.card.data.name).toBe('Raw')
    expect(parsed.card.data.description).toBe('hi')
    expect(collectBundledRegex(parsed.card)).toHaveLength(1)
  })

  it('returns null for unreadable input', () => {
    expect(parseCardFile(path.join(os.tmpdir(), 'nope.json'))).toBeNull()
  })
})
