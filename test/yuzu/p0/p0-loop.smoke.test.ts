import { describe, it, expect } from 'vitest'
import { fixtureContext } from '../../../src/shared/yuzu/p0/fixtureContext'
import {
  runP0Batch,
  type CallProvider,
  type RunRecord
} from '../../../src/shared/yuzu/p0/runP0Batch'
import { summarize } from '../../../src/shared/yuzu/p0/metrics'

/**
 * Normal-suite smoke test for the P0 pipeline: a FAKE callProvider drives every outcome path
 * (valid / repaired / fallback) plus the extraction observations. No network, no Electron.
 */

const validScene = {
  scene_id: 's1',
  header: { location: 'classroom', present: ['yuzu', 'kaede'], mood: 'tense' },
  beats: [
    {
      bg: 'classroom',
      audio: { music: 'bgm_main', ambience: 'amb_school' },
      sprites: [{ actor: 'kaede', expression: 'worried', position: 'center' }],
      speaker: 'yuzu',
      line: 'Kaede, wait — can we talk?',
      effects: [{ type: 'affinity_change', args: { actor: 'kaede', delta: 1 } }]
    }
  ],
  next: {
    kind: 'choice',
    choices: [
      { text: 'Apologize first', intent: 'reconcile' },
      { text: 'Ask why she left', intent: 'confront' }
    ]
  }
}
const validJson = JSON.stringify(validScene)

// Same scene but with an unknown location id — passes the schema, fails the vocab cross-check.
const unknownAssetJson = JSON.stringify({
  ...validScene,
  header: { ...validScene.header, location: 'library' }
})

// A <think>-wrapped + fenced valid scene: extract must strip both and still succeed.
const thinkFencedJson = `<think>Let me plan the beat and the choice.</think>\n\`\`\`json\n${validJson}\n\`\`\``

type FakeSettings = { key: string }
type FakeParams = Record<string, never>

describe('P0 loop smoke (fake provider)', () => {
  it('drives valid / repaired / fallback outcomes and the extract observations', async () => {
    const scripts: Record<string, string[]> = {
      clean: [validJson],
      wrapped: [thinkFencedJson],
      repairable: [unknownAssetJson, validJson], // first fails vocab, repair is valid
      garbage: ['I cannot help with that.', 'still nothing parseable here'] // both attempts unparseable
    }
    const counters: Record<string, number> = {}
    const callProvider: CallProvider<FakeSettings, FakeParams> = async (settings) => {
      const arr = scripts[settings.key]
      const i = counters[settings.key] ?? 0
      counters[settings.key] = i + 1
      return arr[Math.min(i, arr.length - 1)]
    }

    const seen: RunRecord[] = []
    const { records, readout } = await runP0Batch<FakeSettings, FakeParams>({
      ctx: fixtureContext,
      runsPerProvider: 1,
      callProvider,
      onRecord: (r) => seen.push(r),
      providers: [
        { name: 'clean', model: 'fake', settings: { key: 'clean' }, params: {} },
        { name: 'wrapped', model: 'fake', settings: { key: 'wrapped' }, params: {} },
        { name: 'repairable', model: 'fake', settings: { key: 'repairable' }, params: {} },
        { name: 'garbage', model: 'fake', settings: { key: 'garbage' }, params: {} }
      ]
    })

    expect(seen).toEqual(records) // onRecord streamed every record
    const byName = Object.fromEntries(records.map((r) => [r.providerName, r]))

    // (a) clean valid, no transforms applied
    expect(byName.clean.outcome).toBe('valid')
    expect(byName.clean.attempt1.applied).toEqual([])
    expect(byName.clean.repair).toBeUndefined()

    // (b) think-wrapped + fenced valid
    expect(byName.wrapped.outcome).toBe('valid')
    expect(byName.wrapped.attempt1.applied).toEqual(['think', 'fence'])
    expect(byName.wrapped.attempt1.failures).toEqual(
      expect.arrayContaining(['THINK_WRAPPED', 'FENCED'])
    )

    // (c) vocab-violating first reply, valid repair
    expect(byName.repairable.outcome).toBe('repaired')
    expect(byName.repairable.attempt1.ok).toBe(false)
    expect(byName.repairable.attempt1.failures).toContain('UNKNOWN_ASSET_ID')
    expect(byName.repairable.repair?.ok).toBe(true)

    // (d) unrepairable garbage on both attempts, degrade to prose fallback
    expect(byName.garbage.outcome).toBe('fallback')
    expect(byName.garbage.attempt1.failures).toContain('NO_JSON_FOUND')
    expect(byName.garbage.fallbackScene?.beats[0].speaker).toBe('narration')

    // readout has one group per provider, each a single run
    expect(readout.total).toBe(4)
    expect(readout.providers).toHaveLength(4)
  })

  it('summarize aggregates counts and percentages correctly', () => {
    const attempt = (ok: boolean, failures: string[] = []): RunRecord['attempt1'] => ({
      raw: '{}',
      latencyMs: 100,
      applied: [],
      ok,
      failures: failures as RunRecord['attempt1']['failures']
    })
    const mk = (outcome: RunRecord['outcome']): RunRecord => ({
      ts: '2026-07-16T00:00:00.000Z',
      providerName: 'prov',
      model: 'm1',
      attempt1: attempt(outcome === 'valid'),
      repair: outcome === 'valid' ? undefined : attempt(outcome === 'repaired'),
      outcome
    })
    const records: RunRecord[] = [
      ...Array.from({ length: 5 }, () => mk('valid')),
      ...Array.from({ length: 3 }, () => mk('repaired')),
      ...Array.from({ length: 2 }, () => mk('fallback'))
    ]

    const readout = summarize(records)
    expect(readout.total).toBe(10)
    expect(readout.providers).toHaveLength(1)
    const p = readout.providers[0]
    expect(p.total).toBe(10)
    expect(p.validFirstTry).toEqual({ n: 5, pct: 50 })
    expect(p.repaired).toEqual({ n: 3, pct: 30 })
    expect(p.fallback).toEqual({ n: 2, pct: 20 })
    expect(p.latency.medianMs).toBe(100)
  })
})
