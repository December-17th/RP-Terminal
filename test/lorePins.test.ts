import { describe, it, expect } from 'vitest'
import { buildPinBlock, buildScanText } from '../src/main/services/promptBuilder'
import { matchAcross } from '../src/main/services/lorebookService'
import { LorebookSchema } from '../src/main/types/character'

// --- tiny factories (RPT-authored fixture content only) -------------------
const book = (entries: any[]): any => LorebookSchema.parse({ name: 'B', entries })

// A latest-floor variable snapshot in MVU shape.
const vars = {
  stat_data: {
    location: '王都',
    party: ['艾莉亚', '尤兹'],
    hp: 42,
    alerted: true,
    inventory: { gold: 10 }, // object → skip
    log: Array.from({ length: 9 }, (_, i) => `e${i}`) // 9 elements → skip
  }
}

describe('buildPinBlock', () => {
  it('emits a delimited, config-ordered block with last-segment labels', () => {
    expect(buildPinBlock(vars, ['stat_data.location', 'stat_data.party'])).toBe(
      '\n[PINS] location: 王都 | party: 艾莉亚, 尤兹'
    )
  })

  it('stringifies number and boolean scalars', () => {
    expect(buildPinBlock(vars, ['stat_data.hp', 'stat_data.alerted'])).toBe(
      '\n[PINS] hp: 42 | alerted: true'
    )
  })

  it('skips missing paths, object values, and long arrays — no throw, no block', () => {
    expect(() =>
      buildPinBlock(vars, ['stat_data.nope', 'stat_data.inventory', 'stat_data.log'])
    ).not.toThrow()
    expect(buildPinBlock(vars, ['stat_data.nope', 'stat_data.inventory', 'stat_data.log'])).toBe('')
  })

  it('returns "" when pin_paths is undefined or empty (scan text unchanged)', () => {
    expect(buildPinBlock(vars, undefined)).toBe('')
    expect(buildPinBlock(vars, [])).toBe('')
  })

  it('is byte-stable across two builds with identical state', () => {
    const paths = ['stat_data.location', 'stat_data.party', 'stat_data.hp']
    expect(buildPinBlock(vars, paths)).toBe(buildPinBlock(JSON.parse(JSON.stringify(vars)), paths))
  })

  it('drops one bad path but keeps the resolvable ones', () => {
    expect(buildPinBlock(vars, ['stat_data.inventory', 'stat_data.location'])).toBe(
      '\n[PINS] location: 王都'
    )
  })
})

describe('context pins feed the lore matcher', () => {
  // Conversation that never names 王都 or the party members.
  const scan = buildScanText(
    [
      {
        floor: 1,
        chat_id: 'c',
        timestamp: 't',
        user_message: { content: 'We keep walking.', timestamp: 't' },
        response: { content: 'The road stretches on.', model: '', provider: '' },
        events: [],
        variables: {}
      } as any
    ],
    'What now?',
    3
  )

  it('a keyed entry absent from conversation fires via a pinned scalar', () => {
    const lb = book([{ keys: ['王都'], content: 'The capital city lore.' }])
    // Without pins the keyword is nowhere in scan text.
    expect(matchAcross([lb], scan)).toHaveLength(0)
    // With the pin appended, the entry fires.
    const pinned = scan + buildPinBlock(vars, ['stat_data.location'])
    expect(matchAcross([lb], pinned)).toHaveLength(1)
  })

  it('pin + selective secondary key are both satisfied from pin values', () => {
    const lb = book([
      { keys: ['王都'], secondary_keys: ['尤兹'], selective: true, content: 'Escort in the capital.' }
    ])
    // Primary pinned but secondary absent → no fire.
    expect(matchAcross([lb], scan + buildPinBlock(vars, ['stat_data.location']))).toHaveLength(0)
    // Both primary and secondary present in the pin values → fires.
    const pinned = scan + buildPinBlock(vars, ['stat_data.location', 'stat_data.party'])
    expect(matchAcross([lb], pinned)).toHaveLength(1)
  })

  it('a regex key matches against a pinned value (pins + WP-L2 compose)', () => {
    const lb = book([{ keys: ['/王都/'], content: 'Capital lore via regex key.' }])
    const pinned = scan + buildPinBlock(vars, ['stat_data.location'])
    expect(matchAcross([lb], pinned)).toHaveLength(1)
  })

  it('when nothing resolves, scan text is unchanged and no entry fires spuriously', () => {
    const lb = book([{ keys: ['王都'], content: 'x' }])
    const pinned = scan + buildPinBlock(vars, ['stat_data.inventory', 'stat_data.log'])
    expect(pinned).toBe(scan)
    expect(matchAcross([lb], pinned)).toHaveLength(0)
  })

  it('the pin block is matcher-only: buildScanText never contains [PINS]', () => {
    // Structural guarantee — the block is concatenated only in buildGenContext onto the scan text
    // that feeds matchAcross; the prompt builder (buildPrompt) consumes matched entries, not scan
    // text, so [PINS] cannot reach the assembled prompt. buildScanText itself carries none of it.
    expect(scan).not.toContain('[PINS]')
  })
})
