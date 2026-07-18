// ST 1.18.0 core-regex parity (issue 14 / WP-2.4 / ADR 0016).
//
// Fixtures are SYNTHESIZED FROM SOURCE — each grid cell cites the SillyTavern regex engine line it
// pins (public/scripts/extensions/regex/engine.js). Prose is RPT-authored / scrambled (never ST's
// own template strings — clean-room, CLAUDE.md). The truth tables here are the frozen spec for the
// phase model (both-false divergence), the replacement semantics (named captures, trimStrings,
// substituteRegex), depth bounds, and per-rule lineage.

import { afterAll, describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { applyRegexRules, type RegexLikeRule } from '../src/shared/regexTransform'
import {
  scriptRunsInPhase,
  appliesToDisplay,
  appliesToPrompt,
  REGEX_PLACEMENT,
  type RegexPhase
} from '../src/shared/regexTypes'
import {
  getWorldInfoRules,
  getReasoningRules,
  getSlashCommandRules,
  saveRegexScript,
  type RenderRegexRule
} from '../src/main/services/regexService'
import { buildPrompt } from '../src/main/services/promptBuilder'
import { createRecordBuilder } from '../src/main/services/generation/executionRecord'
import { RPTerminalCardSchema, LorebookSchema } from '../src/main/types/character'
import { getAppDir } from '../src/main/services/storageService'

// ---- pure transform helpers ------------------------------------------------
const like = (over: Partial<RegexLikeRule>): RegexLikeRule => ({
  source: 'x',
  flags: 'g',
  replace: '',
  placement: [],
  trimStrings: [],
  ...over
})
const apply = (
  text: string,
  rules: RegexLikeRule[],
  opts: Parameters<typeof applyRegexRules>[3] = {}
): string => applyRegexRules(text, rules, {}, opts)

// ============================================================================
// 1. PHASE MODEL — the both-false divergence (engine.js:348-355)
// ============================================================================
describe('phase selection — scriptRunsInPhase mirrors getRegexedString (engine.js:348-355)', () => {
  // ST fires a script on a call {isMarkdown, isPrompt} iff:
  //   (markdownOnly && isMarkdown) || (promptOnly && isPrompt) || (!md && !pr && !isMarkdown && !isPrompt)
  const ref = (
    r: { markdownOnly: boolean; promptOnly: boolean },
    p: RegexPhase
  ): boolean =>
    (r.markdownOnly && !!p.isMarkdown) ||
    (r.promptOnly && !!p.isPrompt) ||
    (!r.markdownOnly && !r.promptOnly && !p.isMarkdown && !p.isPrompt)

  const flagCombos = [
    { markdownOnly: false, promptOnly: false }, // both-false (the divergence)
    { markdownOnly: true, promptOnly: false }, // display-only
    { markdownOnly: false, promptOnly: true }, // prompt-only
    { markdownOnly: true, promptOnly: true } // both-true
  ]
  const phaseCalls: RegexPhase[] = [
    { isMarkdown: true }, // display call
    { isPrompt: true }, // prompt call
    {} // neither (commit / slash / reasoning-commit / edit)
  ]

  it('matches ST across every flag × call combination', () => {
    for (const r of flagCombos)
      for (const p of phaseCalls) expect(scriptRunsInPhase(r, p)).toBe(ref(r, p))
  })

  it('both-false fires ONLY on a neither call — NOT display, NOT prompt', () => {
    const bothFalse = { markdownOnly: false, promptOnly: false }
    expect(scriptRunsInPhase(bothFalse, { isMarkdown: true })).toBe(false)
    expect(scriptRunsInPhase(bothFalse, { isPrompt: true })).toBe(false)
    expect(scriptRunsInPhase(bothFalse, {})).toBe(true)
  })

  it('the destination helpers FOLD the commit call for committed content (chat msg / reasoning)', () => {
    // display = isMarkdown ∪ neither ; prompt = isPrompt ∪ neither → both-false & both-true reach both;
    // markdownOnly is display-only; promptOnly is prompt-only. (RPT has no destructive commit pass.)
    expect([
      appliesToDisplay({ markdownOnly: false, promptOnly: false }),
      appliesToPrompt({ markdownOnly: false, promptOnly: false })
    ]).toEqual([true, true])
    expect([
      appliesToDisplay({ markdownOnly: true, promptOnly: false }),
      appliesToPrompt({ markdownOnly: true, promptOnly: false })
    ]).toEqual([true, false])
    expect([
      appliesToDisplay({ markdownOnly: false, promptOnly: true }),
      appliesToPrompt({ markdownOnly: false, promptOnly: true })
    ]).toEqual([false, true])
    expect([
      appliesToDisplay({ markdownOnly: true, promptOnly: true }),
      appliesToPrompt({ markdownOnly: true, promptOnly: true })
    ]).toEqual([true, true])
  })
})

// ============================================================================
// 2. REPLACEMENT — named captures, trimStrings, substituteRegex (engine.js:391-465)
// ============================================================================
describe('replacement semantics', () => {
  it('substitutes named capture groups $<name> (engine.js:422-430)', () => {
    // Scrambled prose: a "glimmer/verdant" token pair.
    const out = apply('glimmer:verdant', [
      like({ source: '(?<a>\\w+):(?<b>\\w+)', replace: '$<b>-$<a>' })
    ])
    expect(out).toBe('verdant-glimmer')
  })

  it('an absent $<name> resolves to empty (engine.js:433) in a non-card replacement', () => {
    const out = apply('zephyr', [like({ source: '(?<x>\\w+)', replace: '[$<x>][$<missing>]' })])
    expect(out).toBe('[zephyr][]')
  })

  it('applies trimStrings to captured values, macro-expanded (engine.js:437-440,457-465)', () => {
    // trimStrings removed from $0 (whole match) and $1 alike; {{user}} inside a trimString expands.
    const out = applyRegexRules(
      '<<Lyra-mossgate>>',
      [like({ source: '<<(.+?)>>', replace: 'whole=$0 grp=$1', trimStrings: ['{{user}}-'] })],
      { user: 'Lyra' }
    )
    // trimString "Lyra-" stripped from both the whole match and the group.
    expect(out).toBe('whole=<<mossgate>> grp=mossgate')
  })

  it('substituteRegex RAW (1) expands {{user}}/{{char}} in the FIND pattern (engine.js:401-402)', () => {
    const out = applyRegexRules(
      'ping Br> pong',
      [like({ source: '{{char}}', flags: 'g', replace: 'X', substituteRegex: 1 })],
      { char: 'Br' }
    )
    // Find becomes /Br/ → replaces the literal "Br".
    expect(out).toBe('ping X> pong')
  })

  it('substituteRegex ESCAPED (2) matches a metachar value LITERALLY (engine.js:403-404)', () => {
    // char name contains a regex metachar '.'; ESCAPED escapes it so it matches only a literal dot.
    const out = applyRegexRules(
      'a.b axb',
      [like({ source: 'a{{char}}b', flags: 'g', replace: 'HIT', substituteRegex: 2 })],
      { char: '.' }
    )
    expect(out).toBe('HIT axb') // only "a.b" matched, "axb" untouched
  })

  it('substituteRegex NONE (0) leaves the find pattern raw', () => {
    const out = applyRegexRules(
      '{{char}} here',
      [like({ source: '\\{\\{char\\}\\}', flags: 'g', replace: 'NAME', substituteRegex: 0 })],
      { char: 'Ignored' }
    )
    expect(out).toBe('NAME here')
  })

  it('skips an invalid find pattern instead of throwing (RegexProvider null → no-op, engine.js:414)', () => {
    expect(apply('untouched', [like({ source: '(', replace: 'X' })])).toBe('untouched')
  })
})

// ============================================================================
// 3. runOnEdit gating (engine.js:356) + depth bounds (engine.js:362-371)
// ============================================================================
describe('runOnEdit gating', () => {
  it('on an edit call, a rule without runOnEdit is skipped; one with runOnEdit fires', () => {
    const rules = [
      like({ source: 'keep', replace: 'K', runOnEdit: false }),
      like({ source: 'edit', replace: 'E', runOnEdit: true })
    ]
    expect(apply('keep edit', rules, { isEdit: true })).toBe('keep E')
    // Not an edit call → both fire.
    expect(apply('keep edit', rules, {})).toBe('K E')
  })
})

describe('depth bounds are inclusive (engine.js:362-371)', () => {
  const r = like({ source: 'M', replace: 'H', minDepth: 1, maxDepth: 2 })
  it('skips depth below minDepth', () => expect(apply('M', [r], { depth: 0 })).toBe('M'))
  it('applies at minDepth (inclusive)', () => expect(apply('M', [r], { depth: 1 })).toBe('H'))
  it('applies at maxDepth (inclusive)', () => expect(apply('M', [r], { depth: 2 })).toBe('H'))
  it('skips depth above maxDepth', () => expect(apply('M', [r], { depth: 3 })).toBe('M'))
  it('ignores depth bounds entirely when no depth is supplied', () =>
    expect(apply('M', [r], {})).toBe('H'))
})

// ============================================================================
// 4. PER-RULE LINEAGE — onRuleApplied fires per rule that changed text (issue 14)
// ============================================================================
describe('per-rule lineage — onRuleApplied', () => {
  it('fires once per rule that actually changed the text, never for a no-match rule', () => {
    const hits: Array<{ id: string; before: string; after: string }> = []
    const rules: RegexLikeRule[] = [
      { ...like({ source: 'foo', replace: 'FOO' }), ...({ id: 'r1' } as any) },
      { ...like({ source: 'zzz', replace: 'ZZZ' }), ...({ id: 'r2' } as any) }, // no match
      { ...like({ source: 'bar', replace: 'BAR' }), ...({ id: 'r3' } as any) }
    ]
    applyRegexRules('foo and bar', rules, {}, {
      onRuleApplied: (rule, before, after) =>
        hits.push({ id: (rule as any).id, before, after })
    })
    expect(hits.map((h) => h.id)).toEqual(['r1', 'r3']) // r2 (no match) omitted
    expect(hits[0]).toMatchObject({ before: 'foo and bar', after: 'FOO and bar' })
    expect(hits[1]).toMatchObject({ before: 'FOO and bar', after: 'FOO and BAR' })
  })
})

// ============================================================================
// 5. SELECTORS — placement 3/5/6 phase filtering (regexService)
// ============================================================================
describe('placement selectors (world info 5 / reasoning 6 / slash 3)', () => {
  const profileId = `test-${randomUUID()}`
  const profileDir = path.join(getAppDir(), 'profiles', profileId)
  afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

  // Save one script per phase-flag, all placement 5 (world info).
  const save = (name: string, over: any): void =>
    saveRegexScript(profileId, {
      scriptName: name,
      findRegex: '/x/g',
      replaceString: '',
      placement: [REGEX_PLACEMENT.WORLD_INFO],
      ...over
    })

  it('getWorldInfoRules applies the ST isPrompt phase STRICTLY — both-false is EXCLUDED', () => {
    save('wi-both-false', {})
    save('wi-prompt-only', { promptOnly: true })
    save('wi-display-only', { markdownOnly: true })
    save('wi-both-true', { markdownOnly: true, promptOnly: true })
    const names = getWorldInfoRules(profileId)
      .map((r) => r.scriptName)
      .sort()
    // isPrompt call: promptOnly + both-true fire; both-false and display-only do NOT (the divergence fix).
    expect(names).toEqual(['wi-both-true', 'wi-prompt-only'])
  })
})

describe('reasoning (placement 6) selector folds commit like a stored message', () => {
  const profileId = `test-${randomUUID()}`
  const profileDir = path.join(getAppDir(), 'profiles', profileId)
  afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

  it('getReasoningRules keeps both-false + display rules at placement 6, drops prompt-only', () => {
    saveRegexScript(profileId, {
      scriptName: 're-both-false',
      findRegex: '/x/g',
      replaceString: '',
      placement: [REGEX_PLACEMENT.REASONING]
    })
    saveRegexScript(profileId, {
      scriptName: 're-prompt-only',
      findRegex: '/x/g',
      replaceString: '',
      placement: [REGEX_PLACEMENT.REASONING],
      promptOnly: true
    })
    // A placement-2 (AI output) rule must NOT leak into the reasoning selector.
    saveRegexScript(profileId, {
      scriptName: 're-wrong-placement',
      findRegex: '/x/g',
      replaceString: '',
      placement: [REGEX_PLACEMENT.AI_OUTPUT]
    })
    const names = getReasoningRules(profileId)
      .map((r) => r.scriptName)
      .sort()
    expect(names).toEqual(['re-both-false'])
  })
})

describe('slash command (placement 3) selector fires only both-false (neither phase)', () => {
  const profileId = `test-${randomUUID()}`
  const profileDir = path.join(getAppDir(), 'profiles', profileId)
  afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

  it('getSlashCommandRules keeps only both-false placement-3 rules', () => {
    saveRegexScript(profileId, {
      scriptName: 'sc-both-false',
      findRegex: '/x/g',
      replaceString: '',
      placement: [REGEX_PLACEMENT.SLASH_COMMAND]
    })
    saveRegexScript(profileId, {
      scriptName: 'sc-prompt-only',
      findRegex: '/x/g',
      replaceString: '',
      placement: [REGEX_PLACEMENT.SLASH_COMMAND],
      promptOnly: true
    })
    expect(getSlashCommandRules(profileId).map((r) => r.scriptName)).toEqual(['sc-both-false'])
  })
})

// ============================================================================
// 6. WORLD INFO regex WIRED at prompt assembly (world-info.js:5086)
// ============================================================================
describe('world-info regex is applied to entry content at prompt assembly', () => {
  const card = (data: any = {}): any => RPTerminalCardSchema.parse({ data: { name: 'Aria', ...data } })
  const book = (entries: any[]): any => LorebookSchema.parse({ name: 'B', entries })
  const blk = (marker: string, content = '', role = 'system'): any => ({
    identifier: marker || 'lit',
    name: marker || 'lit',
    role,
    content,
    enabled: true,
    marker: marker || 'none'
  })
  const preset = (prompts: any[]): any => ({
    name: 'P',
    parameters: { temperature: 0.9, max_tokens: 100 },
    prompts
  })
  const floor = (n: number, user: string, resp: string): any => ({
    floor: n,
    chat_id: 'c',
    timestamp: 't',
    user_message: { content: user, timestamp: 't' },
    response: { content: resp, model: '', provider: '' },
    events: [],
    variables: {}
  })

  const wiRule = (over: Partial<RenderRegexRule>): RenderRegexRule => ({
    id: 'wi',
    scriptName: 'wi',
    source: 'SECRET',
    flags: 'g',
    replace: 'REDACTED',
    placement: [REGEX_PLACEMENT.WORLD_INFO],
    disabled: false,
    markdownOnly: false,
    promptOnly: true, // isPrompt-strict: a real WI rule is promptOnly (or both-true)
    trimStrings: [],
    ...over
  })

  it('transforms activated entry content before it reaches the World Info block', () => {
    const msgs = buildPrompt({
      card: card(),
      preset: preset([blk('world_info'), blk('chat_history')]),
      lorebooks: [book([{ keys: ['gate'], content: 'The gate hides a SECRET vault.' }])],
      floors: [floor(0, '', 'hello')],
      userAction: 'open the gate',
      worldInfoRegex: [wiRule({})]
    })
    const blob = msgs.map((m) => m.content).join('\n')
    expect(blob).toContain('The gate hides a REDACTED vault.')
    expect(blob).not.toContain('SECRET')
  })

  it('a BOTH-FALSE world-info rule is filtered out upstream (getWorldInfoRules), so it never fires', () => {
    // If a both-false rule were passed to buildPrompt it WOULD match (the applier is placement-only);
    // the phase gate lives in getWorldInfoRules. Prove the selector, then prove the wiring honors it.
    const msgs = buildPrompt({
      card: card(),
      preset: preset([blk('world_info'), blk('chat_history')]),
      lorebooks: [book([{ keys: ['gate'], content: 'A SECRET waits.' }])],
      floors: [floor(0, '', 'hello')],
      userAction: 'open the gate',
      worldInfoRegex: [] // selector excluded the both-false rule → nothing to apply
    })
    expect(msgs.map((m) => m.content).join('\n')).toContain('A SECRET waits.')
  })
})

// ============================================================================
// 7. PER-RULE LINEAGE reaches the execution record via buildPrompt
// ============================================================================
describe('per-rule lineage lands in the execution record', () => {
  const card = (data: any = {}): any => RPTerminalCardSchema.parse({ data: { name: 'Aria', ...data } })
  const blk = (marker: string, content = '', role = 'system'): any => ({
    identifier: marker || 'lit',
    name: marker || 'lit',
    role,
    content,
    enabled: true,
    marker: marker || 'none'
  })
  const preset = (prompts: any[]): any => ({
    name: 'P',
    parameters: { temperature: 0.9, max_tokens: 100 },
    prompts
  })
  const floor = (n: number, user: string, resp: string): any => ({
    floor: n,
    chat_id: 'c',
    timestamp: 't',
    user_message: { content: user, timestamp: 't' },
    response: { content: resp, model: '', provider: '' },
    events: [],
    variables: {}
  })

  it("attributes a regex change to the RULE (source.kind==='regex-rule', label=scriptName)", () => {
    const rule = {
      id: 'rule-42',
      scriptName: 'tidy-name',
      source: 'FOO',
      flags: 'g',
      replace: 'BAR',
      placement: [1],
      disabled: false,
      markdownOnly: false,
      promptOnly: false,
      trimStrings: []
    }
    const b = createRecordBuilder()
    const msgs = buildPrompt({
      card: card(),
      preset: preset([blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, 'say FOO', 'ok')],
      userAction: 'FOO again',
      promptRegex: [rule as any],
      journal: b
    })
    const rec = b.finish(msgs, 0)
    const regexEntries = rec.entries.filter((e) => e.stage === 'regex')
    expect(regexEntries.length).toBe(2) // older turn + action both contained FOO
    for (const e of regexEntries) {
      expect(e.source.kind).toBe('regex-rule')
      expect(e.source.id).toBe('rule-42')
      expect(e.source.label).toBe('tidy-name')
    }
  })
})
