// test/yuzu/vnGate.test.ts
//
// Project Yuzu WP-S2 — unit tests for the VN acceptance gate (runVnGate) and its effect→MVU bridge. The
// world-asset index is mocked per-id (via vnPrompt's buildVnVocabulary → getIndex) so the ladder runs
// against a real vocabulary without any fs. The repair seam is INJECTED (the swappable YssRepairFn) so
// the gate's ladder logic is exercised without touching the provider.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/main/services/worldAssetService', () => ({
  getIndex: () => ({
    character: { kaede: { 立绘: { moods: { neutral: 'a.png', smile: 'b.png' } } }, yuzu: {} },
    location: { classroom: { 背景: { moods: {} } }, rooftop: { 背景: { moods: {} } } }
  })
}))
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))

import {
  runVnGate,
  effectsToMvu,
  mergeYuzuMvu,
  type YssRepairFn
} from '../../src/main/services/yuzu/vnGate'
import { parseMvuCommands } from '../../src/main/parsers/mvuParser'
import type { Scene } from '../../src/shared/yuzu/sceneSchema'
import type { GenContext } from '../../src/main/services/generation/types'
import type { RunContext } from '../../src/main/services/nodes/types'

const gen = { profileId: 'p', lorebookIds: ['book'] } as unknown as GenContext
const ctx = { signal: new AbortController().signal } as unknown as RunContext

// A repair fn that NEVER runs (used to prove the valid path takes no repair).
const noRepair: YssRepairFn = vi.fn(async () => {
  throw new Error('repair should not be called')
})

describe('runVnGate — ladder outcomes', () => {
  it('valid: a clean scene passes on the first attempt and folds its effect', async () => {
    const raw = "<| bg classroom |>\nkaede: Hi.\n<| effect _.set('好感度.kaede', 0, 5) //smiled |>\n<| end |>"
    const repair = vi.fn(noRepair)
    const r = await runVnGate(ctx, gen, raw, repair)
    expect(r.trace.outcome).toBe('valid')
    expect(r.trace.attempts).toHaveLength(1)
    expect(r.finalRaw).toBe(raw)
    expect(repair).not.toHaveBeenCalled()
    // The scene's effect bridged into an MVU command.
    expect(r.mvu.commands).toEqual([
      { op: 'set', path: '好感度.kaede', value: 5, reason: 'smiled' }
    ])
  })

  it('repaired: a structural failure triggers exactly one repair, then validates', async () => {
    const invalid = 'Just prose, no scene structure.' // no <| bg |> ⇒ missing location (structural)
    const fixed = '<| bg rooftop |>\nyuzu: Found you.\n<| end |>'
    const repair: YssRepairFn = vi.fn(async () => ({ raw: fixed }))
    const r = await runVnGate(ctx, gen, invalid, repair)
    expect(r.trace.outcome).toBe('repaired')
    expect(r.trace.attempts).toHaveLength(2)
    expect(r.trace.attempts[0].kind).toBe('initial')
    expect(r.trace.attempts[1].kind).toBe('repair')
    expect(r.trace.originalRaw).toBe(invalid)
    expect(r.finalRaw).toBe(fixed)
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it('fallback: repair produces another invalid reply → prose fallback wrapping the ORIGINAL raw', async () => {
    const invalid = 'First broken reply.'
    const repair: YssRepairFn = vi.fn(async () => ({ raw: 'Still broken.' }))
    const r = await runVnGate(ctx, gen, invalid, repair)
    expect(r.trace.outcome).toBe('fallback')
    expect(r.finalRaw).toBe(invalid) // fallback keeps the original raw as the narration body
    expect(r.scene.beats[0].line).toBe(invalid)
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it('abort during repair (repair returns null) degrades to the prose fallback, never throws', async () => {
    const invalid = 'Broken.'
    const abortingRepair: YssRepairFn = vi.fn(async () => null) // models an aborted / failed re-ask
    const r = await runVnGate(ctx, gen, invalid, abortingRepair)
    expect(r.trace.outcome).toBe('fallback')
    expect(r.finalRaw).toBe(invalid)
    expect(r.trace.attempts).toHaveLength(1) // only the initial attempt was recorded (repair produced nothing)
  })
})

describe('effect → MVU-command bridge', () => {
  it('effectsToMvu collects effects across beats IN ORDER', () => {
    const scene = {
      schemaVersion: 'yuzu-scene-2',
      scene_id: 's',
      header: { location: 'classroom', present: [] },
      beats: [
        { bg: 'classroom', effects: ["_.set('a', 1) //first"] },
        { speaker: 'kaede', line: 'Hi', effects: ["_.set('b', 2) //second"] }
      ],
      next: { choices: [] }
    } as unknown as Scene
    const mvu = effectsToMvu(scene)
    expect(mvu.commands.map((c) => c.path)).toEqual(['a', 'b']) // beat order preserved
    expect(mvu.commands[1].reason).toBe('second')
  })

  it('effectsToMvu on a scene with no effects is empty (no wrapper allocated)', () => {
    const scene = {
      schemaVersion: 'yuzu-scene-2',
      scene_id: 's',
      header: { location: 'classroom', present: [] },
      beats: [{ speaker: 'kaede', line: 'Hi' }],
      next: { choices: [] }
    } as unknown as Scene
    expect(effectsToMvu(scene).commands).toHaveLength(0)
  })

  it('mergeYuzuMvu folds scene effects FIRST, then the scene-end <UpdateVariable> block', () => {
    // effect sets hp→20 (inline), a stray classic block sets hp→99 (scene end): scene-end applies last.
    const scene = {
      schemaVersion: 'yuzu-scene-2',
      scene_id: 's',
      header: { location: 'classroom', present: [] },
      beats: [{ bg: 'classroom', effects: ["_.set('hp', 20)"] }],
      next: { choices: [] }
    } as unknown as Scene
    const effectsMvu = effectsToMvu(scene)
    const classicMvu = parseMvuCommands("<UpdateVariable>_.set('hp', 99)</UpdateVariable>")
    const merged = mergeYuzuMvu(effectsMvu, classicMvu)
    expect(merged.commands.map((c) => c.value)).toEqual([20, 99]) // effects first, scene-end last
  })
})
