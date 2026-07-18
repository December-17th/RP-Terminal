import { describe, it, expect } from 'vitest'
import {
  parseSPresetConfig,
  projectSPreset,
  spresetBoundRegexes,
  chatSquash,
  resolveStopStrings,
  spresetUnsupportedCapabilities,
  SPRESET_REGEX_TIER_ORDER,
  type SquashChatMessage
} from '../src/shared/spreset'
import { expandMacros } from '../src/shared/macros'

/**
 * SPreset (issue 16 / WP-2.6) — clean-room from docs/research/spreset-behavior-2026-07-17.md.
 * All prose here is RPT-authored / scrambled; no third-party preset content. Each block cites the
 * spec section it pins. Only spec-VERIFIED behaviors are asserted; unverified extras are covered by
 * the diagnostic path (spresetUnsupportedCapabilities), not by guessed behavior.
 */

describe('parseSPresetConfig — config source of truth (spec §Activation)', () => {
  it('reads extensions.SPreset as the source of truth', () => {
    const cfg = parseSPresetConfig({ SPreset: { MacroNest: true, ChatSquash: { enabled: true } } })
    expect(cfg?.MacroNest).toBe(true)
    expect(cfg?.ChatSquash?.enabled).toBe(true)
  })

  it('falls back to the disabled SPresetSettings block JSON ONLY when the namespace is absent', () => {
    const block = JSON.stringify({ MacroNest: false, RegexBinding: { enabled: true, regexes: [] } })
    const cfg = parseSPresetConfig({ regex_scripts: [] }, block)
    expect(cfg?.MacroNest).toBe(false)
    expect(cfg?.RegexBinding?.enabled).toBe(true)
  })

  it('ignores the mirror block when the extensions namespace is present (namespace wins)', () => {
    const block = JSON.stringify({ MacroNest: false })
    const cfg = parseSPresetConfig({ SPreset: { MacroNest: true } }, block)
    expect(cfg?.MacroNest).toBe(true) // namespace, not the mirror
  })

  it('returns null when neither namespace nor a parseable block is present', () => {
    expect(parseSPresetConfig({ regex_scripts: [] })).toBeNull()
    expect(parseSPresetConfig({}, 'not json')).toBeNull()
    expect(parseSPresetConfig(undefined)).toBeNull()
  })
})

describe('projectSPreset — runtime flags (each feature gates on its own boolean)', () => {
  it('marks RegexBinding enabled when it carries records and is not explicitly disabled', () => {
    const p = projectSPreset(parseSPresetConfig({ SPreset: { RegexBinding: { regexes: [{ name: 'a' }] } } }))
    expect(p?.regexBindingEnabled).toBe(true)
  })

  it('leaves RegexBinding off when explicitly disabled, even with records', () => {
    const p = projectSPreset(
      parseSPresetConfig({ SPreset: { RegexBinding: { enabled: false, regexes: [{ name: 'a' }] } } })
    )
    expect(p?.regexBindingEnabled).toBe(false)
    expect(spresetBoundRegexes(parseSPresetConfig({ SPreset: { RegexBinding: { enabled: false, regexes: [{ name: 'a' }] } } }))).toHaveLength(0)
  })

  it('projects MacroNest as a tri-state (true / false / null-absent)', () => {
    expect(projectSPreset(parseSPresetConfig({ SPreset: { MacroNest: true } }))?.macroNest).toBe(true)
    expect(projectSPreset(parseSPresetConfig({ SPreset: { MacroNest: false } }))?.macroNest).toBe(false)
    expect(projectSPreset(parseSPresetConfig({ SPreset: { ChatSquash: { enabled: true } } }))?.macroNest).toBeNull()
  })
})

describe('chatSquash — role-based adjacent merge (spec §ChatSquash, VERIFIED)', () => {
  const msgs = (): SquashChatMessage[] => [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a1' }
  ]

  it('is a no-op when disabled (returns a copy, unchanged)', () => {
    const out = chatSquash(msgs(), { enabled: false })
    expect(out).toEqual(msgs())
  })

  it('merges the whole run into one message with the follow (first) role by default', () => {
    const out = chatSquash(msgs(), { enabled: true, role: 'follow' })
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('system')
    // consecutive same-role joined by \n; groups concatenated by \n (spec:1185-1194,1321-1330).
    expect(out[0].content).toBe('sys\nu1\nu2\na1')
  })

  it('targets an explicit role when set', () => {
    const out = chatSquash(msgs(), { enabled: true, role: 'user' })
    expect(out[0].role).toBe('user')
  })

  it('applies per-role affixes, macro-expanded (spec:1185-1194)', () => {
    const out = chatSquash(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' }
      ],
      {
        enabled: true,
        role: 'follow',
        user_prefix: 'H({{user}}): ',
        char_prefix: 'A({{char}}): '
      },
      (s) => expandMacros(s, { user: 'Ann', char: 'Bo' })
    )
    expect(out[0].content).toBe('H(Ann): hi\nA(Bo): yo')
  })

  it('rewrites system→user before merging when user_role_system (spec:1284-1286)', () => {
    const out = chatSquash(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' }
      ],
      { enabled: true, role: 'follow', user_role_system: true }
    )
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user') // the ex-system message became user, so follow = user
  })

  it('treats a separator-bearing message as a non-mergeable boundary + strips it (spec:1288-1319)', () => {
    const out = chatSquash(
      [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'MARK keep-me' },
        { role: 'user', content: 'b' }
      ],
      {
        enabled: true,
        role: 'follow',
        enable_squashed_separator: true,
        squashed_separator_string: 'MARK '
      }
    )
    // 'a' flushes as one; the marked message passes through un-merged (marker stripped); then 'b'.
    expect(out.map((m) => m.content)).toEqual(['a', 'keep-me', 'b'])
  })

  it('conditional-tag: strips the tag and BYPASSES the squash when the tag is absent (spec:1088-1110)', () => {
    const absent = chatSquash(
      [
        { role: 'user', content: 'x' },
        { role: 'user', content: 'y' }
      ],
      { enabled: true, role: 'follow', conditional_enabled: true, conditional_tag: '<merge>' }
    )
    expect(absent).toHaveLength(2) // bypassed — not merged

    const present = chatSquash(
      [
        { role: 'user', content: '<merge>x' },
        { role: 'user', content: 'y' }
      ],
      { enabled: true, role: 'follow', conditional_enabled: true, conditional_tag: '<merge>' }
    )
    expect(present).toHaveLength(1)
    expect(present[0].content).toBe('x\ny') // merged, tag stripped
  })
})

describe('resolveStopStrings (spec:1150-1166)', () => {
  it('parses a JSON array of stop strings when enabled', () => {
    expect(resolveStopStrings({ enabled: true, enable_stop_string: true, stop_string: '["</s>","STOP"]' })).toEqual([
      '</s>',
      'STOP'
    ])
  })
  it('falls back to a single-element array on non-JSON', () => {
    expect(resolveStopStrings({ enabled: true, enable_stop_string: true, stop_string: '###' })).toEqual(['###'])
  })
  it('is empty when the feature or its flag is off', () => {
    expect(resolveStopStrings({ enabled: false, enable_stop_string: true, stop_string: '["x"]' })).toEqual([])
    expect(resolveStopStrings({ enabled: true, enable_stop_string: false, stop_string: '["x"]' })).toEqual([])
  })
})

describe('spresetUnsupportedCapabilities — diagnostics, never executed (ADR 0017 / spec:1419-1427)', () => {
  it('flags the arbitrary-eval post-script and corpus-unused extras when ChatSquash is enabled', () => {
    const caps = spresetUnsupportedCapabilities({
      enabled: true,
      squashed_post_script: 'prompt => prompt',
      parse_clewd: true,
      re_split: true,
      separate_chat_history: true
    })
    expect(caps.sort()).toEqual(['parse-clewd', 'post-script', 're-split', 'separate-history'])
  })
  it('reports nothing when ChatSquash is disabled (corpus configs are all disabled)', () => {
    expect(
      spresetUnsupportedCapabilities({ enabled: false, squashed_post_script: 'evil()' })
    ).toEqual([])
  })
})

describe('SPRESET_REGEX_TIER_ORDER (spec §RegexBinding default [2,0,1])', () => {
  it('puts preset first, then global, then the scoped tiers', () => {
    expect(SPRESET_REGEX_TIER_ORDER.preset).toBeLessThan(SPRESET_REGEX_TIER_ORDER.global)
    expect(SPRESET_REGEX_TIER_ORDER.global).toBeLessThan(SPRESET_REGEX_TIER_ORDER.world)
    expect(SPRESET_REGEX_TIER_ORDER.world).toBeLessThan(SPRESET_REGEX_TIER_ORDER.session)
  })
})

describe('MacroNest maps onto the macro engine pass cap (spec §MacroNest)', () => {
  // A macro whose expansion yields another macro: {{getvar::wrap}} where wrap = '{{user}}'.
  const nested = '{{getvar::wrap}}'
  const ctx = { vars: { wrap: '{{user}}' }, user: 'Zed' }

  it('MacroNest:true / absent nests (RPT default) — inner macro resolves', () => {
    expect(expandMacros(nested, { ...ctx })).toBe('Zed') // default 5 passes
  })

  it('MacroNest:false → a single non-nesting pass leaves the inner macro unresolved', () => {
    // One pass expands {{getvar::wrap}} → '{{user}}', but does not re-expand it.
    expect(expandMacros(nested, { ...ctx, maxPasses: 1 })).toBe('{{user}}')
  })
})
