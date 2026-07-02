import { describe, it, expect, vi, beforeEach } from 'vitest'

// prompt.preset composer (context-epochs plan §3): prompt.assemble with wireable ingredient ports.
// Node-level behavior (override mapping, scan-skip, bad-preset) is verified against a mocked
// assemble module; the assemblePrompt/buildPrompt override plumbing itself is covered by
// promptBuilder.test.ts + the untouched generateParity gate.

const assembleSvc = vi.hoisted(() => ({
  matchWorldInfo: vi.fn(() => [{ comment: 'matched' }]),
  assemblePrompt: vi.fn(() => ({ sendMessages: [{ role: 'user', content: 'x' }], params: { max_tokens: 1 } }))
}))
vi.mock('../../src/main/services/generation/assemble', () => assembleSvc)

const presetSvc = vi.hoisted(() => ({ getPresetById: vi.fn() }))
vi.mock('../../src/main/services/presetService', () => presetSvc)

import { promptPreset } from '../../src/main/services/nodes/builtin/presetNodes'
import { promptAssemble } from '../../src/main/services/nodes/builtin/generationNodes'
import { NodeRunFailure, RunContext, NodeImpl } from '../../src/main/services/nodes/types'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown> = {}) => ({
  id,
  config: impl.configSchema ? (impl.configSchema.parse(rawConfig) as Record<string, unknown>) : {}
})

const gen = { profileId: 'p1', chatId: 'c1', userAction: 'act' } as any

beforeEach(() => {
  assembleSvc.matchWorldInfo.mockClear()
  assembleSvc.assemblePrompt.mockClear()
  presetSvc.getPresetById.mockReset()
})

describe('prompt.preset — no ports wired', () => {
  it('delegates to matchWorldInfo + assemblePrompt exactly as prompt.assemble does (empty overrides, memory "")', () => {
    const rP = promptPreset.run(ctx, { gen }, meta(promptPreset, 'n1'))
    // matchWorldInfo ran (no worldInfo override); assemblePrompt got the matched entries, '' memory,
    // and an EMPTY overrides object.
    expect(assembleSvc.matchWorldInfo).toHaveBeenCalledWith(gen)
    expect(assembleSvc.assemblePrompt).toHaveBeenCalledWith(gen, [{ comment: 'matched' }], '', {})

    // prompt.assemble on the same gen (its `block` is the memory arg — '' here) yields the SAME output.
    assembleSvc.assemblePrompt.mockClear()
    const rA = promptAssemble.run(ctx, { gen, block: '' })
    expect(rP.outputs).toEqual(rA.outputs)
  })
})

describe('prompt.preset — preset_id', () => {
  it('resolves the preset and passes it as an override', () => {
    const preset = { name: 'Alt', parameters: { max_tokens: 42 }, prompts: [] }
    presetSvc.getPresetById.mockReturnValue(preset)
    promptPreset.run(ctx, { gen }, meta(promptPreset, 'n1', { preset_id: 'alt' }))
    expect(presetSvc.getPresetById).toHaveBeenCalledWith('p1', 'alt')
    const overrides = assembleSvc.assemblePrompt.mock.calls[0][3]
    expect(overrides.preset).toBe(preset)
  })

  it('unknown preset_id -> class-B NodeRunFailure code bad-preset (no fallback)', () => {
    presetSvc.getPresetById.mockReturnValue(null)
    let err: unknown
    try {
      promptPreset.run(ctx, { gen }, meta(promptPreset, 'n1', { preset_id: 'nope' }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect((err as NodeRunFailure).kind).toBe('B')
    expect((err as NodeRunFailure).code).toBe('bad-preset')
    expect(assembleSvc.assemblePrompt).not.toHaveBeenCalled()
  })
})

describe('prompt.preset — history / action overrides', () => {
  it('a wired history + action flow into overrides verbatim', () => {
    const history = [{ role: 'user' as const, content: 'H' }]
    promptPreset.run(ctx, { gen, history, action: 'the pending action' }, meta(promptPreset, 'n1'))
    const overrides = assembleSvc.assemblePrompt.mock.calls[0][3]
    expect(overrides.history).toBe(history)
    expect(overrides.action).toBe('the pending action')
  })
})

describe('prompt.preset — worldInfo override skips the scan', () => {
  it('a wired worldInfo replaces the block AND skips matchWorldInfo (matched: [])', () => {
    promptPreset.run(ctx, { gen, worldInfo: 'WI' }, meta(promptPreset, 'n1'))
    expect(assembleSvc.matchWorldInfo).not.toHaveBeenCalled()
    const [, matched, memory, overrides] = assembleSvc.assemblePrompt.mock.calls[0]
    expect(matched).toEqual([])
    expect(memory).toBe('')
    expect(overrides.worldInfo).toBe('WI')
  })

  it('an empty-string worldInfo still counts as wired (skips the scan)', () => {
    promptPreset.run(ctx, { gen, worldInfo: '' }, meta(promptPreset, 'n1'))
    expect(assembleSvc.matchWorldInfo).not.toHaveBeenCalled()
    const overrides = assembleSvc.assemblePrompt.mock.calls[0][3]
    expect(overrides.worldInfo).toBe('')
  })
})

describe('prompt.preset — memory port', () => {
  it('a wired memory string is passed as the memory block', () => {
    promptPreset.run(ctx, { gen, memory: 'recalled' }, meta(promptPreset, 'n1'))
    expect(assembleSvc.assemblePrompt.mock.calls[0][2]).toBe('recalled')
  })
})
