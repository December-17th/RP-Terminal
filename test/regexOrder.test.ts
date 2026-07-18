import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { getAllRules, setScriptScope } from '../src/main/services/regexService'
import { getAppDir } from '../src/main/services/storageService'

/**
 * Rule APPLICATION order must follow SillyTavern's script priority, not the regex dir's
 * filename order (files are named by random UUID, so filename order is arbitrary).
 * ST (public/scripts/extensions/regex/engine.js, SCRIPT_TYPES: "ORDER MATTERS"):
 *   GLOBAL → PRESET → SCOPED (character), each tier in list order.
 * We map our scopes onto those tiers: global → preset → world → session.
 *
 * Regression: a card's world-scoped beautification regex (pasting ~165KB of HTML per match)
 * sorted BEFORE the preset-scoped cleanup regex by filename, so the cleanup's backtracking
 * pattern ran over a 500KB string — a ~50s per-render stall (minutes per session load).
 * In tier order the cleanup runs on the small raw text first: 49s → 11ms.
 */

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
const regexDir = path.join(profileDir, 'regex')
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

const writeScript = (file: string, name: string): void => {
  fs.mkdirSync(regexDir, { recursive: true })
  fs.writeFileSync(
    path.join(regexDir, file),
    JSON.stringify([{ scriptName: name, findRegex: '/a/g', replaceString: 'b' }]),
    'utf-8'
  )
}

describe('getAllRules application order (ST tier priority)', () => {
  it('orders global → preset → world → session regardless of filename order', () => {
    // Filenames chosen so plain filename order is the exact REVERSE of tier order.
    writeScript('a-session.json', 'session-rule')
    writeScript('b-world.json', 'world-rule')
    writeScript('c-preset.json', 'preset-rule')
    writeScript('d-global.json', 'global-rule')
    setScriptScope(profileId, 'a-session.json', 'session', 'chat-1')
    setScriptScope(profileId, 'b-world.json', 'world', 'card-A')
    setScriptScope(profileId, 'c-preset.json', 'preset', 'preset-1')
    // d-global.json stays global (no meta entry)

    const names = getAllRules(profileId).map((r) => r.scriptName)
    expect(names).toEqual(['global-rule', 'preset-rule', 'world-rule', 'session-rule'])
  })

  it('keeps file order within a tier', () => {
    writeScript('e-global2.json', 'global-rule-2')
    const names = getAllRules(profileId).map((r) => r.scriptName)
    expect(names.slice(0, 2)).toEqual(['global-rule', 'global-rule-2'])
  })

  // SPreset RegexBinding (issue 16): the `preset-first` ordering MODE runs preset-bound regex ahead of
  // global/character — spec §RegexBinding default `[2,0,1]` = preset → global → character. This is an
  // explicit ordering-mode selection in getAllRules, NOT a monkeypatch, and leaves `st-default` intact.
  it('preset-first mode runs preset ahead of global/world/session (SPreset RegexBinding)', () => {
    const names = getAllRules(profileId, undefined, 'preset-first').map((r) => r.scriptName)
    // preset first, then the two globals (file order preserved), then world, then session.
    expect(names).toEqual([
      'preset-rule',
      'global-rule',
      'global-rule-2',
      'world-rule',
      'session-rule'
    ])
    // st-default is unchanged (global first) — the mode selection does not mutate the standing order.
    expect(getAllRules(profileId).map((r) => r.scriptName)[0]).toBe('global-rule')
  })
})
