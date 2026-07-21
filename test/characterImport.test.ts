import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  collectBundledRegex,
  collectBundledPresets,
  collectBundledLorebooks,
  collectBundledScripts,
  collectBundledTableTemplates,
  summarizeCardBundle,
  hasBundle,
  parseCardFile,
  buildWorldCardExport
} from '../src/main/services/characterService'
import { RPTerminalCardSchema, LorebookSchema } from '../src/main/types/character'

const tmpFiles: string[] = []
const writeJson = (obj: unknown): string => {
  const p = path.join(
    os.tmpdir(),
    `rpt-card-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  )
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
    const c = card({
      regex_scripts: [regexRule('keep')],
      rp_terminal: { regex: [regexRule('also')] }
    })
    // The schema must NOT drop these unknown keys — that is the losslessness fix.
    expect((c.data.extensions as any).regex_scripts).toHaveLength(1)
    expect((c.data.extensions as any).rp_terminal.regex).toHaveLength(1)
  })

  it('ignores non-object entries and missing slots', () => {
    expect(collectBundledRegex(card({}))).toEqual([])
    expect(
      collectBundledRegex(card({ regex_scripts: ['nope', null, regexRule('ok')] }))
    ).toHaveLength(1)
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

describe('collectBundledScripts', () => {
  it('reads Tavern Helper scripts from extensions.tavern_helper.scripts, filtering non-objects', () => {
    const c = card({
      tavern_helper: {
        scripts: [
          { type: 'script', name: 'a', content: '//a' },
          null,
          'nope',
          { type: 'script', name: 'b', content: '//b' }
        ],
        variables: {}
      }
    })
    expect(collectBundledScripts(c).map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('returns [] when the card carries no TH scripts (native rp_terminal.scripts are not here)', () => {
    expect(collectBundledScripts(card({}))).toEqual([])
    expect(
      collectBundledScripts(card({ rp_terminal: { scripts: [{ name: 's', code: '' }] } }))
    ).toEqual([])
  })
})

describe('collectBundledTableTemplates', () => {
  it('reads table_templates[] from rp_terminal, filtering non-objects', () => {
    const c = card({
      rp_terminal: {
        table_templates: [{ mate: { type: 'chatSheets', version: 2 } }, 3, null]
      }
    })
    expect(collectBundledTableTemplates(c)).toHaveLength(1)
    expect(collectBundledTableTemplates(card({}))).toEqual([])
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
      lorebooks: 0,
      tableTemplates: 0
    })
    expect(hasBundle(s)).toBe(false)
  })

  it('counts a cartridge-backed Yuzu surface and requires card trust', () => {
    const s = summarizeCardBundle({
      card: card({
        rp_terminal: {
          yuzu: {
            version: 1,
            surface: { entry: 'card-code:yuzu/index.html' }
          }
        }
      }),
      lorebook: null
    } as any)

    expect(s.scripts).toBe(0)
    expect(s.cardCodeSurfaces).toBe(1)
    expect(s.requiresTrust).toBe(true)
    expect(hasBundle(s)).toBe(true)
  })

  it('counts bundled table templates, which alone warrants the confirm', () => {
    const withTt = summarizeCardBundle({
      card: card({
        rp_terminal: { table_templates: [{ mate: { type: 'chatSheets', version: 2 } }] }
      }),
      lorebook: null
    } as any)
    expect(withTt.tableTemplates).toBe(1)
    expect(hasBundle(withTt)).toBe(true)
  })
})

describe('parseCardFile (lossless)', () => {
  it('strictly validates bundled Agents + role recommendations while preserving a legacy workflows[] key losslessly (M5c-2: dropped from the schema, still round-trips as an unknown key)', () => {
    const file = writeJson({
      spec: 'chara_card_v3',
      data: {
        name: 'Agent World',
        extensions: {
          rp_terminal: {
            agents: [textAgentForCard('Card Narrator')],
            agent_role_recommendations: { 'classic.narrator': 'Card Narrator' },
            workflows: [{ id: 'legacy-readable' }]
          }
        }
      }
    })
    const parsed = parseCardFile(file)!
    const rpt = parsed.card.data.extensions.rp_terminal!
    expect(rpt.agents?.[0].name).toBe('Card Narrator')
    expect(rpt.agent_role_recommendations).toEqual({ 'classic.narrator': 'Card Narrator' })
    // Round-trip lossless pin: `workflows` is no longer in RPTerminalExtSchema, but parseCardFile
    // preserves the entire extensions object, so the unknown key survives at runtime.
    expect((rpt as Record<string, unknown>).workflows).toEqual([{ id: 'legacy-readable' }])
  })

  it('rejects malformed bundled Agents instead of silently retaining them through catchall', () => {
    const file = writeJson({
      name: 'Broken Agent World',
      extensions: {
        rp_terminal: {
          agents: [{ format: 'rpt-agent', formatVersion: 1, name: 'Broken' }]
        }
      }
    })
    expect(parseCardFile(file)).toBeNull()
  })

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
    const file = writeJson({
      name: 'Raw',
      description: 'hi',
      extensions: { regex_scripts: [regexRule('r')] }
    })
    const parsed = parseCardFile(file)!
    expect(parsed.card.data.name).toBe('Raw')
    expect(parsed.card.data.description).toBe('hi')
    expect(collectBundledRegex(parsed.card)).toHaveLength(1)
  })

  it('returns null for unreadable input', () => {
    expect(parseCardFile(path.join(os.tmpdir(), 'nope.json'))).toBeNull()
  })
})

const textAgentForCard = (name: string) => ({
  format: 'rpt-agent',
  formatVersion: 1,
  name,
  prompt: [{ role: 'system', content: 'Narrate.' }],
  result: { mode: 'text' }
})

describe('buildWorldCardExport (S4) — round-trips with import', () => {
  it('folds book + world regex back onto the card and re-imports identically', () => {
    const src = card({
      depth_prompt: { prompt: 'keep', depth: 4 }, // unknown ST key must survive export+import
      rp_terminal: {
        scripts: [{ name: 'ui', code: 'x' }],
        ui_layout: [{ type: 'StatBar', path: 'hp' }],
        agent: { prompts: { system: 'be terse' } }
      }
    })
    const book = LorebookSchema.parse({
      name: 'Book',
      entries: [{ keys: ['town'], content: 'A town.' }]
    })
    const worldRegex = [regexRule('beautify')]

    const exported = buildWorldCardExport(src, book, worldRegex)
    expect(exported.spec).toBe('chara_card_v3')
    expect(exported.data.extensions.rp_terminal.world_card).toBe('1.0') // stamped

    // Re-import the exported JSON and assert the world reproduces.
    const file = writeJson(exported)
    const reimported = parseCardFile(file)!
    const ext = reimported.card.data.extensions as any
    expect(ext.rp_terminal.scripts).toEqual([{ name: 'ui', code: 'x' }])
    expect(ext.rp_terminal.agent.prompts.system).toBe('be terse')
    expect(ext.depth_prompt).toEqual({ prompt: 'keep', depth: 4 })
    expect(collectBundledRegex(reimported.card)).toHaveLength(1)
    expect(reimported.lorebook?.entries[0].keys).toEqual(['town'])
  })

  it('does not mutate the source card and omits empty book/regex', () => {
    const src = card({ rp_terminal: { world_card: '2.0' } })
    const before = JSON.stringify(src)
    const exported = buildWorldCardExport(src, null, [])
    expect(JSON.stringify(src)).toBe(before) // deep-cloned, source untouched
    expect(exported.data.extensions.rp_terminal.world_card).toBe('2.0') // preserves existing marker
    expect(exported.data.character_book).toBeUndefined()
    expect(exported.data.extensions.regex_scripts).toBeUndefined()
  })
})
