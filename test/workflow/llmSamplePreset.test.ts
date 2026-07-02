import { describe, it, expect, vi, beforeEach } from 'vitest'

// llm.sample `api_preset_id` config (context-epochs plan §4): the model call runs against a chosen
// saved api_preset's connection instead of the turn's. Reuses resilientCall's withPreset, so
// rpm_limit/max_concurrent ride the substituted connection. Unknown id -> class-B bad-preset.

const { callModel } = vi.hoisted(() => ({ callModel: vi.fn() }))
vi.mock('../../src/main/services/generation/callModel', () => ({ callModel }))

import { llmSample } from '../../src/main/services/nodes/builtin/generationNodes'
import { NodeRunFailure, RunContext } from '../../src/main/services/nodes/types'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

const apiPreset = {
  id: 'alt',
  provider: 'anthropic',
  endpoint: 'https://alt.example',
  api_key: 'k-alt',
  model: 'claude-alt',
  rpm_limit: 7,
  max_concurrent: 2
}

const gen = () => ({
  profileId: 'p1',
  chatId: 'c1',
  settings: {
    api: { provider: 'openai', endpoint: 'https://primary', api_key: 'k-primary', model: 'gpt' },
    api_presets: [apiPreset]
  }
})

beforeEach(() => {
  callModel.mockReset().mockResolvedValue({ raw: 'ok', rawUsage: null, stopped: false })
})

describe('llm.sample api_preset_id', () => {
  it('swaps the connection to the chosen api_preset before the model call', async () => {
    await llmSample.run(ctx, { gen: gen(), sendMessages: [], params: {} }, {
      id: 'n1',
      config: { api_preset_id: 'alt' }
    })
    const passedGen = callModel.mock.calls[0][0]
    expect(passedGen.settings.api).toEqual({
      provider: 'anthropic',
      endpoint: 'https://alt.example',
      api_key: 'k-alt',
      model: 'claude-alt',
      rpm_limit: 7,
      max_concurrent: 2
    })
  })

  it('no api_preset_id leaves the turn connection intact', async () => {
    await llmSample.run(ctx, { gen: gen(), sendMessages: [], params: {} }, { id: 'n1', config: {} })
    const passedGen = callModel.mock.calls[0][0]
    expect(passedGen.settings.api.provider).toBe('openai')
  })

  it('unknown api_preset_id -> class-B NodeRunFailure code bad-preset, no model call', async () => {
    let err: unknown
    try {
      await llmSample.run(ctx, { gen: gen(), sendMessages: [], params: {} }, {
        id: 'n1',
        config: { api_preset_id: 'nope' }
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect((err as NodeRunFailure).kind).toBe('B')
    expect((err as NodeRunFailure).code).toBe('bad-preset')
    expect(callModel).not.toHaveBeenCalled()
  })
})
