import { describe, it, expect } from 'vitest'
import {
  tokenTotal,
  sectionLabelKey,
  sourceChip,
  omittedReasonKey,
  type PreviewSectionData
} from '../src/renderer/src/components/workspace/previewDisplay'
import en from '../src/renderer/src/i18n/locales/en'
import zh from '../src/renderer/src/i18n/locales/zh'

// Pins the pure Preview-pane derivations the Agents view renders (agent-packs plan WP3.4). The codebase
// has no jsdom renderer harness (vitest runs under Node), so per WP convention the display LOGIC is
// extracted into previewDisplay.ts and covered here; the view adds only labels + DOM.

const section = (over: Partial<PreviewSectionData>): PreviewSectionData => ({
  id: 'history',
  label: 'history',
  source: { kind: 'narrator' },
  tokens: 10,
  estimated: true,
  text: 't',
  ...over
})

describe('tokenTotal', () => {
  it('sums section tokens and reports estimated when any part is', () => {
    const t = tokenTotal([section({ tokens: 10 }), section({ tokens: 5, estimated: true })])
    expect(t.total).toBe(15)
    expect(t.estimated).toBe(true)
  })
  it('estimated=false only when NO section is estimated', () => {
    const t = tokenTotal([section({ tokens: 3, estimated: false }), section({ tokens: 4, estimated: false })])
    expect(t).toEqual({ total: 7, estimated: false })
  })
  it('empty → zero, not estimated', () => {
    expect(tokenTotal([])).toEqual({ total: 0, estimated: false })
  })
})

describe('sectionLabelKey', () => {
  it('maps known ids to preview.section.<id>', () => {
    expect(sectionLabelKey('history')).toBe('preview.section.history')
    expect(sectionLabelKey('packInject')).toBe('preview.section.packInject')
    expect(sectionLabelKey('action')).toBe('preview.section.action')
  })
  it('unknown id falls back to preview.section.other', () => {
    expect(sectionLabelKey('bogus')).toBe('preview.section.other')
  })
})

describe('sourceChip', () => {
  it('pack source → a pack chip carrying the name verbatim', () => {
    const chip = sourceChip({ kind: 'pack', packId: 'p', name: 'Memory Keeper' })
    expect(chip.isPack).toBe(true)
    expect(chip.name).toBe('Memory Keeper')
  })
  it('non-pack source → a kind chip with a label key', () => {
    expect(sourceChip({ kind: 'narrator' })).toEqual({
      isPack: false,
      name: '',
      labelKey: 'preview.source.narrator'
    })
  })
})

describe('omittedReasonKey', () => {
  it('maps a reason to its key', () => {
    expect(omittedReasonKey('gate')).toBe('preview.omitted.reason.gate')
    expect(omittedReasonKey('empty')).toBe('preview.omitted.reason.empty')
  })
})

// Every key these derivations produce must exist in BOTH locales (CLAUDE.md i18n rule). We check the
// raw maps (not translate(), which falls back to en for a zh-missing key and would hide the gap).
describe('i18n coverage — every derived key present in en + zh', () => {
  const kinds = ['system', 'persona', 'card', 'worldInfo', 'history', 'memory', 'packInject', 'action', 'other']
  const sourceKinds = ['narrator', 'lorebook', 'memory']
  const reasons = ['gate', 'empty', 'budget'] as const

  const keys: string[] = [
    ...kinds.map(sectionLabelKey),
    ...sourceKinds.map((sk) => `preview.source.${sk}`),
    ...reasons.map(omittedReasonKey),
    // Static pane keys the view also uses.
    'preview.title',
    'preview.subtitle',
    'preview.refresh',
    'preview.generatedAt',
    'preview.totalTokens',
    'preview.totalTokensEst',
    'preview.est',
    'preview.expand',
    'preview.collapse',
    'preview.omittedTitle',
    'preview.omittedNote',
    'preview.noChatTitle',
    'preview.noChatBody',
    'preview.errorTitle',
    'preview.errorBody',
    'preview.emptyTitle',
    'preview.emptyBody'
  ]

  for (const [name, dict] of [
    ['en', en],
    ['zh', zh]
  ] as const) {
    it(`every preview key present in ${name}`, () => {
      for (const k of keys) {
        expect(Object.prototype.hasOwnProperty.call(dict, k), `${k} missing in ${name}`).toBe(true)
      }
    })
  }
})
