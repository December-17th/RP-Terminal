import { describe, it, expect } from 'vitest'
import {
  shapePreview,
  packInjections,
  rejoinTexts,
  packRejoinValue,
  type AssembledMessage,
  type PackInjection,
  type GatedInjector
} from '../../src/main/services/generation/previewSections'
import type { CompositionMeta } from '../../src/shared/workflow/compose'

// Pins the pure section-shaping the preview service depends on (agent-packs plan WP3.4). Everything here
// is import-light + side-effect-free — the SERVICE (test/generation/previewService.test.ts) covers the
// engine run; this covers the classification + attribution logic in isolation.

const msg = (role: AssembledMessage['role'], content: string): AssembledMessage => ({ role, content })

describe('rejoinTexts', () => {
  it('block lane: a plain string is one text (empty string → none)', () => {
    expect(rejoinTexts('some memory tail')).toEqual(['some memory tail'])
    expect(rejoinTexts('   ')).toEqual([])
    expect(rejoinTexts('')).toEqual([])
  })
  it('entries lane: LorebookEntry[] → each entry.content', () => {
    const entries = [{ content: 'A' }, { content: '  ' }, { content: 'B' }, { notContent: 1 }]
    expect(rejoinTexts(entries)).toEqual(['A', 'B'])
  })
  it('anything else → none', () => {
    expect(rejoinTexts(undefined)).toEqual([])
    expect(rejoinTexts(42)).toEqual([])
  })
})

describe('packRejoinValue / packInjections', () => {
  const composition: CompositionMeta = {
    packs: {
      'pack.a': {
        nodeIds: ['pack:pack.a:export'],
        entries: [],
        nodeModes: {},
        rejoinEdges: [
          {
            from: { node: 'pack:pack.a:export', port: 'entries' },
            to: { node: 'assemble', port: 'entries' },
            checkpoint: 'prompt-assembly'
          }
        ]
      }
    }
  }

  it('reads the producing node+port value from the outputs map', () => {
    const outputs = new Map<string, Record<string, unknown>>([
      ['pack:pack.a:export', { entries: [{ content: 'MEM' }] }]
    ])
    expect(packRejoinValue(outputs, { node: 'pack:pack.a:export', port: 'entries' })).toEqual([
      { content: 'MEM' }
    ])
  })

  it('produces one PackInjection per prompt-assembly rejoin, with names + texts', () => {
    const outputs = new Map<string, Record<string, unknown>>([
      ['pack:pack.a:export', { entries: [{ content: 'MEM' }] }]
    ])
    const injs = packInjections(composition, outputs, { 'pack.a': 'Pack A' })
    expect(injs).toHaveLength(1)
    expect(injs[0].packId).toBe('pack.a')
    expect(injs[0].name).toBe('Pack A')
    expect(injs[0].texts).toEqual(['MEM'])
  })

  it('ignores rejoins on other checkpoints', () => {
    const comp: CompositionMeta = {
      packs: {
        'pack.b': {
          nodeIds: [],
          entries: [],
          nodeModes: {},
          rejoinEdges: [
            {
              from: { node: 'pack:pack.b:x', port: 'y' },
              to: { node: 'parse', port: 'z' },
              checkpoint: 'reply-parsed'
            }
          ]
        }
      }
    }
    expect(packInjections(comp, new Map(), {})).toEqual([])
  })
})

describe('shapePreview — section classification', () => {
  const messages: AssembledMessage[] = [
    msg('system', 'Name: Char\nDescription: a guide'),
    msg('system', "[Alice's Persona]\nA curious traveller"),
    msg('system', 'World Info:\nThe kingdom of X'),
    msg('user', 'USER_0'),
    msg('assistant', 'ASSISTANT_0'),
    msg('user', 'the pending action')
  ]
  const tokensPerMessage = messages.map((m) => m.content.length)

  it('classifies card / persona / worldInfo / history / action by prefix + role', () => {
    const { sections } = shapePreview({ messages, tokensPerMessage, injections: [], gatedInjectors: [] })
    const ids = sections.map((s) => s.id)
    expect(ids).toEqual(['card', 'persona', 'worldInfo', 'history', 'history', 'action'])
    // Every section carries an estimated token count > 0 and narrator source (no packs here).
    expect(sections.every((s) => s.estimated)).toBe(true)
    expect(sections.every((s) => s.source.kind === 'narrator')).toBe(true)
    // The action is the LAST user message.
    expect(sections[5].text).toBe('the pending action')
  })

  it('classifies a RAW (header-less) persona block as persona via personaText match', () => {
    const raw: AssembledMessage[] = [
      msg('system', 'Name: Char\nDescription: a guide'),
      msg('system', 'A curious traveller'), // persona at a marker — emitted raw, no header
      msg('user', 'the pending action')
    ]
    const { sections } = shapePreview({
      messages: raw,
      tokensPerMessage: raw.map((m) => m.content.length),
      injections: [],
      gatedInjectors: [],
      personaText: 'A curious traveller'
    })
    expect(sections.map((s) => s.id)).toEqual(['card', 'persona', 'action'])
    // Without personaText it would fall back to generic `system`.
    const { sections: noHint } = shapePreview({
      messages: raw,
      tokensPerMessage: raw.map((m) => m.content.length),
      injections: [],
      gatedInjectors: []
    })
    expect(noHint[1].id).toBe('system')
  })

  it.each(['user', 'assistant'] as const)(
    'classifies a %s-role raw persona marker as persona',
    (role) => {
      const raw: AssembledMessage[] = [
        msg(role, 'A curious traveller'),
        msg('user', 'the pending action')
      ]
      const { sections } = shapePreview({
        messages: raw,
        tokensPerMessage: raw.map((m) => m.content.length),
        injections: [],
        gatedInjectors: [],
        personaText: 'A curious traveller'
      })

      expect(sections.map((s) => s.id)).toEqual(['persona', 'action'])
    }
  )

  it('classifies a same-role merged custom envelope carrying the raw persona as persona', () => {
    const merged: AssembledMessage[] = [
      msg('assistant', '<persona_context>\nA curious traveller\n</persona_context>'),
      msg('user', 'the pending action')
    ]
    const { sections } = shapePreview({
      messages: merged,
      tokensPerMessage: merged.map((m) => m.content.length),
      injections: [],
      gatedInjectors: [],
      personaText: 'A curious traveller'
    })

    expect(sections.map((s) => s.id)).toEqual(['persona', 'action'])
  })

  it('does not attribute an authored sentence that merely contains the persona text', () => {
    const authored: AssembledMessage[] = [
      msg('system', 'Instruction: remember A curious traveller is nearby.'),
      msg('user', 'the pending action')
    ]
    const { sections } = shapePreview({
      messages: authored,
      tokensPerMessage: authored.map((m) => m.content.length),
      injections: [],
      gatedInjectors: [],
      personaText: 'A curious traveller'
    })

    expect(sections.map((s) => s.id)).toEqual(['system', 'action'])
  })

  it('token counts ride tokensPerMessage', () => {
    const { sections } = shapePreview({ messages, tokensPerMessage, injections: [], gatedInjectors: [] })
    expect(sections[0].tokens).toBe(messages[0].content.length)
  })
})

describe('shapePreview — pack attribution + omitted', () => {
  it('a message carrying a pack injection is a packInject section attributed to the pack', () => {
    const messages: AssembledMessage[] = [
      msg('system', 'World Info:\nThe kingdom\n\nMEMORY_EXPORT[a;b]'),
      msg('user', 'go')
    ]
    const injections: PackInjection[] = [
      {
        packId: 'pack.mem',
        name: 'Memory',
        checkpoint: 'prompt-assembly',
        from: { node: 'pack:pack.mem:export', port: 'entries' },
        texts: ['MEMORY_EXPORT[a;b]']
      }
    ]
    const { sections, omitted } = shapePreview({
      messages,
      tokensPerMessage: [10, 2],
      injections,
      gatedInjectors: []
    })
    const packSection = sections.find((s) => s.source.kind === 'pack')
    expect(packSection).toBeDefined()
    expect(packSection!.id).toBe('packInject')
    expect(packSection!.source.packId).toBe('pack.mem')
    expect(packSection!.source.name).toBe('Memory')
    // Matched → not omitted.
    expect(omitted).toEqual([])
  })

  it('a pack whose branch produced NO text → omitted-empty', () => {
    const injections: PackInjection[] = [
      {
        packId: 'pack.mem',
        name: 'Memory',
        checkpoint: 'prompt-assembly',
        from: { node: 'pack:pack.mem:export', port: 'entries' },
        texts: []
      }
    ]
    const { omitted } = shapePreview({
      messages: [msg('user', 'go')],
      tokensPerMessage: [2],
      injections,
      gatedInjectors: []
    })
    expect(omitted).toHaveLength(1)
    expect(omitted[0].reason).toBe('empty')
    expect(omitted[0].source?.packId).toBe('pack.mem')
  })

  it('a gate-closed injector → omitted-gate', () => {
    const gatedInjectors: GatedInjector[] = [{ packId: 'pack.off', name: 'Disabled Pack' }]
    const { omitted } = shapePreview({
      messages: [msg('user', 'go')],
      tokensPerMessage: [2],
      injections: [],
      gatedInjectors
    })
    expect(omitted).toHaveLength(1)
    expect(omitted[0].reason).toBe('gate')
    expect(omitted[0].label).toBe('Disabled Pack')
    expect(omitted[0].source?.packId).toBe('pack.off')
  })

  it('a pack that produced text but it never reached the prompt → omitted-empty (honest)', () => {
    const injections: PackInjection[] = [
      {
        packId: 'pack.x',
        name: 'X',
        checkpoint: 'prompt-assembly',
        from: { node: 'pack:pack.x:e', port: 'entries' },
        texts: ['UNMATCHED_TEXT']
      }
    ]
    const { sections, omitted } = shapePreview({
      messages: [msg('system', 'World Info:\nnothing here'), msg('user', 'go')],
      tokensPerMessage: [5, 2],
      injections,
      gatedInjectors: []
    })
    expect(sections.some((s) => s.source.kind === 'pack')).toBe(false)
    expect(omitted.some((o) => o.reason === 'empty' && o.source?.packId === 'pack.x')).toBe(true)
  })
})
